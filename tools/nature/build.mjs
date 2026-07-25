#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  geometryBounds,
  haversineMeters,
  validateCanonicalEntity,
  validateGeometry,
} from "../../assets/js/nature/domain.mjs";
import { ingestLegacyRepository } from "./lib/legacy-adapter.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTPUT_ROOT = path.join(REPO_ROOT, "assets", "data", "nature");
const PACKAGE_ROOT = path.join(OUTPUT_ROOT, "packages");
const SEED_PATH = path.join(REPO_ROOT, "data", "seeds", "nature-routes.v1.json");
const SOURCE_REGISTRY_PATH = path.join(REPO_ROOT, "data", "sources", "registry.v1.json");
const JURISDICTION_REGISTRY_PATH = path.join(REPO_ROOT, "data", "jurisdictions", "registry.v1.json");

const DEFAULT_BUDGETS = Object.freeze({
  manifestBytes: 64_000,
  regionalPackageBytes: 2_500_000,
  initialNatureDataBytes: 64_000,
  searchP95Milliseconds: 50,
  mapInteractionP95Milliseconds: 100,
  maxVisiblePointFeatures: 5_000,
  maxVisibleRouteFeatures: 1_000,
});

export async function buildNatureData(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const outputRoot = options.outputRoot || OUTPUT_ROOT;
  const packageRoot = path.join(outputRoot, "packages");
  const seedPath = options.seedPath || path.join(repoRoot, "data", "seeds", "nature-routes.v1.json");
  const sourceRegistryPath = options.sourceRegistryPath
    || path.join(repoRoot, "data", "sources", "registry.v1.json");
  const jurisdictionRegistryPath = options.jurisdictionRegistryPath
    || path.join(repoRoot, "data", "jurisdictions", "registry.v1.json");
  const budgets = { ...DEFAULT_BUDGETS, ...(options.budgets || {}) };
  for (const budgetName of [
    "manifestBytes",
    "regionalPackageBytes",
    "initialNatureDataBytes",
  ]) {
    if (!Number.isSafeInteger(budgets[budgetName]) || budgets[budgetName] <= 0) {
      throw new TypeError(`${budgetName} must be a positive safe integer`);
    }
  }

  const [sourceRegistry, jurisdictionRegistry, seedInput] = await Promise.all([
    readJson(sourceRegistryPath),
    readJson(jurisdictionRegistryPath),
    readJson(seedPath),
  ]);
  const sourceIds = validateSourceRegistry(sourceRegistry);
  const jurisdictionIds = validateJurisdictionRegistry(jurisdictionRegistry);
  const adapters = options.adapters || [
    {
      id: "legacy-repository",
      run: () => ingestLegacyRepository(repoRoot),
    },
    {
      id: "canonical-seeds",
      run: async () => ({
        adapterId: "canonical-seeds",
        records: seedInput.entities,
        redirects: {},
        inventories: [{ source: path.relative(repoRoot, seedPath), records: seedInput.entities.length }],
      }),
    },
  ];
  const ingestion = await runIsolatedAdapters(adapters);
  const normalized = normalizeAndValidateRecords(
    ingestion.results.flatMap((result) => result.records),
    { sourceIds, jurisdictionIds },
  );
  const records = dedupeByStableId(normalized.records);
  const delivery = applySensitivityPolicy(records);
  const deliveredIds = new Set(delivery.records.map((record) => record.id));
  const deliveryValidationErrors = normalized.validationErrors
    .filter((error) => deliveredIds.has(error.id));
  const qualityReport = buildQualityReport(
    delivery.records,
    deliveryValidationErrors,
    ingestion.failures,
  );
  const coverageReport = buildCoverageReport(
    delivery.records,
    jurisdictionRegistry,
    sourceRegistry,
  );
  const allRedirects = Object.assign(
    {},
    ...ingestion.results.map((result) => result.redirects || {}),
  );
  const redirects = Object.fromEntries(
    Object.entries(allRedirects).filter(([, targetId]) => deliveredIds.has(targetId)),
  );
  const inventories = ingestion.results.flatMap((result) => result.inventories || []);

  const staged = path.join(outputRoot, ".staging");
  await rm(staged, { recursive: true, force: true });
  await mkdir(path.join(staged, "packages"), { recursive: true });

  const packageDefinitions = groupByDeliveryRegion(delivery.records);
  const manifestPackages = [];
  for (const [regionId, entities] of [...packageDefinitions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const shards = shardRegionalPackage(regionId, entities, budgets.regionalPackageBytes);
    for (const shard of shards) {
      const relativeUrl = `assets/data/nature/packages/${regionId}/${shard.contentHash.slice(0, 16)}.json`;
      const stagedPath = path.join(
        staged,
        "packages",
        regionId,
        `${shard.contentHash.slice(0, 16)}.json`,
      );
      await mkdir(path.dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, shard.serialized, "utf8");
      const bytes = Buffer.byteLength(shard.serialized);
      if (bytes > budgets.regionalPackageBytes) {
        throw new Error(
          `Regional package ${regionId} shard ${shard.shardIndex}/${shard.shardCount} `
          + `is ${bytes} bytes, above the ${budgets.regionalPackageBytes}-byte budget`,
        );
      }
      manifestPackages.push({
        regionId,
        shardIndex: shard.shardIndex,
        shardCount: shard.shardCount,
        url: relativeUrl,
        contentHash: `sha256:${shard.contentHash}`,
        bytes,
        bounds: combinedBounds(shard.entities),
        jurisdictionIds: [...new Set(shard.entities.flatMap((entity) => entity.jurisdictionIds))].sort(),
        entityCounts: countBy(shard.entities, (entity) => entity.entityType),
        completeEstablishedRoutes: shard.entities.filter((entity) => entity.entityType === "TrailRoute"
          && entity.routeNature === "established"
          && entity.geometryCompleteness === "complete").length,
        attributionSourceIds: [...new Set(shard.entities.flatMap((entity) =>
          entity.sourceAssertions.map((assertion) => assertion.sourceId)))].sort(),
      });
    }
  }

  const manifestCore = {
    schemaVersion: "1.0.0",
    artifactType: "nature-package-manifest",
    generated: true,
    packages: manifestPackages,
    budgets,
  };
  const manifestHash = sha256(canonicalJson(manifestCore));
  const manifest = { ...manifestCore, buildId: manifestHash.slice(0, 16) };
  const manifestSerialized = `${canonicalJson(manifest)}\n`;
  const manifestBytes = Buffer.byteLength(manifestSerialized);
  if (manifestBytes > budgets.manifestBytes) {
    await rm(staged, { recursive: true, force: true });
    throw new Error(
      `Nature manifest is ${manifestBytes} bytes, above the `
      + `${budgets.manifestBytes}-byte manifest budget`,
    );
  }
  if (manifestBytes > budgets.initialNatureDataBytes) {
    await rm(staged, { recursive: true, force: true });
    throw new Error(
      `Initial nature data is ${manifestBytes} bytes, above the `
      + `${budgets.initialNatureDataBytes}-byte budget`,
    );
  }
  const generatedArtifacts = {
    "manifest.v1.json": manifest,
    "quality-report.v1.json": qualityReport,
    "coverage-report.v1.json": coverageReport,
    "sensitivity-report.v1.json": delivery.report,
    "legacy-id-redirects.v1.json": {
      schemaVersion: "1.0.0",
      generated: true,
      redirects: sortObject(redirects),
    },
    "ingestion-report.v1.json": {
      schemaVersion: "1.0.0",
      generated: true,
      adapters: ingestion.results.map((result) => ({
        id: result.adapterId,
        status: "succeeded",
        records: result.records.length,
        unmatchedCacheKeys: [...(result.unmatchedCacheKeys || [])],
      })),
      failures: ingestion.failures,
      inventories,
    },
  };
  for (const [filename, document] of Object.entries(generatedArtifacts)) {
    await writeFile(path.join(staged, filename), `${canonicalJson(document)}\n`, "utf8");
  }

  if (normalized.validationErrors.length && !options.allowInvalid) {
    await rm(staged, { recursive: true, force: true });
    throw new Error(
      `Canonical validation failed for ${normalized.validationErrors.length} records; `
      + `first error: ${normalized.validationErrors[0].id}: ${normalized.validationErrors[0].errors.join("; ")}`,
    );
  }
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  for (const filename of Object.keys(generatedArtifacts)) {
    await writeFile(
      path.join(outputRoot, filename),
      await readFile(path.join(staged, filename)),
    );
  }
  await mkdir(packageRoot, { recursive: true });
  await copyTree(path.join(staged, "packages"), packageRoot);
  await rm(staged, { recursive: true, force: true });

  return {
    records: delivery.records.length,
    processedRecords: records.length,
    withheldRecords: delivery.report.counts.withheld,
    packages: manifestPackages.length,
    manifestBytes,
    buildId: manifest.buildId,
    validationErrors: normalized.validationErrors,
    adapterFailures: ingestion.failures,
    qualityReport,
    coverageReport,
    sensitivityReport: delivery.report,
  };
}

export async function runIsolatedAdapters(adapters) {
  const results = [];
  const failures = [];
  for (const adapter of adapters) {
    try {
      const result = await adapter.run();
      if (!result || !Array.isArray(result.records)) {
        throw new TypeError("adapter result must contain a records array");
      }
      results.push({ adapterId: adapter.id, ...result });
    } catch (error) {
      failures.push({
        adapterId: adapter.id,
        message: error?.message || String(error),
        isolated: true,
      });
    }
  }
  if (!results.length) throw new Error("Every nature-data adapter failed; refusing to replace output");
  return { results, failures };
}

function normalizeAndValidateRecords(records, registries) {
  const validationErrors = [];
  const normalized = [];
  for (const record of records) {
    const errors = validateCanonicalEntity(record);
    const unknownSources = (record.sourceAssertions || [])
      .map((assertion) => assertion.sourceId)
      .filter((sourceId) => !registries.sourceIds.has(sourceId));
    if (unknownSources.length) errors.push(`unknown source IDs: ${[...new Set(unknownSources)].join(", ")}`);
    const unknownJurisdictions = (record.jurisdictionIds || [])
      .filter((jurisdictionId) => !registries.jurisdictionIds.has(jurisdictionId));
    if (unknownJurisdictions.length) {
      errors.push(`unknown jurisdiction IDs: ${[...new Set(unknownJurisdictions)].join(", ")}`);
    }
    if (errors.length) validationErrors.push({ id: record?.id || "(missing)", errors });
    normalized.push(record);
  }
  return { records: normalized, validationErrors };
}

function validateSourceRegistry(registry) {
  if (registry?.schemaVersion !== "1.0.0" || !Array.isArray(registry.sources)) {
    throw new Error("Source registry must use schemaVersion 1.0.0 and contain sources");
  }
  const ids = new Set();
  for (const source of registry.sources) {
    const required = [
      "id", "name", "owner", "authorityTier", "jurisdictionIds", "themes",
      "homepage", "retrieval", "licence", "updateCadence", "authentication",
      "rateLimits", "schemaAssumptions", "knownGaps", "failureBehaviour",
      "lastSuccessfulRefresh", "redistribution",
    ];
    const missing = required.filter((field) => !(field in source));
    if (missing.length) throw new Error(`Source ${source.id || "(missing)"} lacks ${missing.join(", ")}`);
    if (ids.has(source.id)) throw new Error(`Duplicate source ID: ${source.id}`);
    if (source.authentication?.secretBrowserSafe !== false) {
      throw new Error(`Source ${source.id} must not mark secrets browser-safe`);
    }
    if (source.failureBehaviour?.isolateSource !== true) {
      throw new Error(`Source ${source.id} must isolate failures`);
    }
    ids.add(source.id);
  }
  return ids;
}

function validateJurisdictionRegistry(registry) {
  if (registry?.schemaVersion !== "1.0.0" || !Array.isArray(registry.jurisdictions)) {
    throw new Error("Jurisdiction registry must use schemaVersion 1.0.0 and contain jurisdictions");
  }
  const ids = new Set(["ALPS"]);
  for (const jurisdiction of registry.jurisdictions) {
    if (!jurisdiction.id || !jurisdiction.name || !jurisdiction.kind
        || typeof jurisdiction.inScope !== "boolean") {
      throw new Error("Each jurisdiction requires id, name, kind and boolean inScope");
    }
    if (ids.has(jurisdiction.id)) throw new Error(`Duplicate jurisdiction ID: ${jurisdiction.id}`);
    ids.add(jurisdiction.id);
  }
  return ids;
}

function dedupeByStableId(records) {
  const byId = new Map();
  for (const record of records) {
    const prior = byId.get(record.id);
    if (prior && canonicalJson(prior) !== canonicalJson(record)) {
      throw new Error(`Conflicting canonical records share ID ${record.id}`);
    }
    byId.set(record.id, record);
  }
  return [...byId.values()];
}

function groupByDeliveryRegion(records) {
  const packages = new Map();
  for (const record of records) {
    const regions = Array.isArray(record.deliveryRegions) && record.deliveryRegions.length
      ? record.deliveryRegions
      : ["global-support"];
    for (const region of regions) {
      if (!packages.has(region)) packages.set(region, []);
      packages.get(region).push(record);
    }
  }
  return packages;
}

const OPTIONAL_DELIVERY_REFERENCE_FIELDS = Object.freeze([
  "accessPointIds",
  "transportConnectionIds",
  "priceIds",
  "stageIds",
  "variantIds",
  "segmentIds",
  "restrictionRefs",
  "hazardRefs",
  "conditionRefs",
  "permitRequirementIds",
  "openingScheduleIds",
]);

export function applySensitivityPolicy(records) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const actionCounts = {
    publish: 0,
    coarsen: 0,
    redact: 0,
    exclude: 0,
    invalid: 0,
  };
  const outcomeCounts = {
    published: 0,
    coarsened: 0,
    withheldExclude: 0,
    withheldRedact: 0,
    withheldCoarsenMissingPublicGeometry: 0,
    withheldCoarsenInvalidPublicGeometry: 0,
    withheldCoarsenUnchangedGeometry: 0,
    withheldReferenceClosure: 0,
    withheldInvalidPolicy: 0,
  };
  const candidates = [];
  const candidateOutcomes = new Map();

  for (const record of records) {
    const action = record?.sensitivity?.action;
    if (Object.hasOwn(actionCounts, action) && action !== "invalid") {
      actionCounts[action] += 1;
    } else {
      actionCounts.invalid += 1;
      outcomeCounts.withheldInvalidPolicy += 1;
      continue;
    }
    if (action === "exclude") {
      outcomeCounts.withheldExclude += 1;
      continue;
    }
    if (action === "redact") {
      outcomeCounts.withheldRedact += 1;
      continue;
    }
    if (action === "publish") {
      candidates.push(structuredClone(record));
      candidateOutcomes.set(record.id, "published");
      continue;
    }

    const publicGeometry = record.sensitivity.publicGeometry;
    if (!publicGeometry) {
      outcomeCounts.withheldCoarsenMissingPublicGeometry += 1;
      continue;
    }
    const geometryErrors = validateGeometry(publicGeometry, []);
    if (geometryErrors.length) {
      outcomeCounts.withheldCoarsenInvalidPublicGeometry += 1;
      continue;
    }
    if (canonicalJson(publicGeometry) === canonicalJson(record.geometry)) {
      outcomeCounts.withheldCoarsenUnchangedGeometry += 1;
      continue;
    }
    const coarsened = coarsenedDeliveryRecord(record, publicGeometry);
    if (validateCanonicalEntity(coarsened).length) {
      outcomeCounts.withheldCoarsenInvalidPublicGeometry += 1;
      continue;
    }
    candidates.push(coarsened);
    candidateOutcomes.set(record.id, "coarsened");
  }

  const byId = new Map(candidates.map((record) => [record.id, record]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, record] of byId) {
      const recordOutcome = candidateOutcomes.get(id);
      const unsafeReference = requiredDeliveryReferences(record).some((referenceId) =>
        !byId.has(referenceId)
        || (candidateOutcomes.get(referenceId) === "coarsened"
          && recordOutcome !== "coarsened"));
      if (unsafeReference) {
        byId.delete(id);
        candidateOutcomes.delete(id);
        outcomeCounts.withheldReferenceClosure += 1;
        changed = true;
      }
    }
  }

  const deliveredIds = new Set(byId.keys());
  const deliveryRecords = candidates
    .filter((record) => deliveredIds.has(record.id))
    .map((record) => pruneOptionalDeliveryReferences(record, deliveredIds));
  for (const record of deliveryRecords) {
    outcomeCounts[candidateOutcomes.get(record.id)] += 1;
  }

  const report = {
    schemaVersion: "1.0.0",
    artifactType: "nature-sensitivity-report",
    generated: true,
    counts: {
      processed: records.length,
      delivered: deliveryRecords.length,
      withheld: records.length - deliveryRecords.length,
      actions: actionCounts,
      outcomes: outcomeCounts,
    },
  };
  return { records: deliveryRecords, report };
}

function coarsenedDeliveryRecord(record, publicGeometry) {
  const delivered = structuredClone(record);
  delivered.geometry = structuredClone(publicGeometry);
  delivered.sensitivity = { ...delivered.sensitivity };
  delete delivered.sensitivity.publicGeometry;
  delivered.quality = { ...delivered.quality };
  delivered.quality.geometryConfidence = Math.min(
    Number.isFinite(delivered.quality.geometryConfidence)
      ? delivered.quality.geometryConfidence
      : 0.2,
    0.2,
  );
  delivered.quality.flags = [...new Set([
    ...(delivered.quality.flags || []),
    "coarsened_for_sensitivity",
  ])].sort();
  for (const field of ["legacy", "preciseGeometry", "sourceGeometry", "rawGeometry"]) {
    delete delivered[field];
  }
  delivered.sourceAssertions = delivered.sourceAssertions.map((assertion) => {
    const copy = { ...assertion };
    if (assertion.fieldPath === "/geometry"
        || assertion.fieldPath.startsWith("/geometry/")
        || assertion.fieldPath === "/legacy"
        || assertion.fieldPath.startsWith("/legacy/")
        || assertion.fieldPath === "/sensitivity/publicGeometry"
        || assertion.fieldPath.startsWith("/sensitivity/publicGeometry/")) {
      delete copy.value;
      delete copy.originalClassification;
    }
    return copy;
  });
  return delivered;
}

function requiredDeliveryReferences(record) {
  const references = [];
  if (typeof record.parentRouteId === "string") references.push(record.parentRouteId);
  for (const field of ["endpointIds", "linkedEntityIds"]) {
    if (Array.isArray(record[field])) references.push(...record[field]);
  }
  return references;
}

function pruneOptionalDeliveryReferences(record, deliveredIds) {
  const delivered = structuredClone(record);
  for (const field of OPTIONAL_DELIVERY_REFERENCE_FIELDS) {
    if (Array.isArray(delivered[field])) {
      delivered[field] = delivered[field].filter((referenceId) => deliveredIds.has(referenceId));
    }
  }
  return delivered;
}

export function shardRegionalPackage(regionId, entities, budgetBytes) {
  if (typeof regionId !== "string" || !regionId) {
    throw new TypeError("regionId must be a non-empty string");
  }
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
    throw new TypeError("budgetBytes must be a positive safe integer");
  }
  const sortedEntities = [...entities].sort((left, right) => left.id.localeCompare(right.id));
  if (!sortedEntities.length) return [];

  // The maximum possible shard count/index is used while partitioning. Its JSON
  // representation is never shorter than the final values, so the final exact
  // documents cannot grow because shard metadata became known later.
  const conservativeShardCount = sortedEntities.length;
  const conservativeShardIndex = conservativeShardCount - 1;
  const chunks = [];
  let start = 0;
  while (start < sortedEntities.length) {
    let low = start + 1;
    let high = sortedEntities.length;
    let bestEnd = start;
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const artifact = createRegionPackageArtifact(
        regionId,
        sortedEntities.slice(start, end),
        conservativeShardIndex,
        conservativeShardCount,
      );
      if (Buffer.byteLength(artifact.serialized) <= budgetBytes) {
        bestEnd = end;
        low = end + 1;
      } else {
        high = end - 1;
      }
    }
    if (bestEnd === start) {
      const oversized = createRegionPackageArtifact(
        regionId,
        [sortedEntities[start]],
        conservativeShardIndex,
        conservativeShardCount,
      );
      throw new Error(
        `Entity ${sortedEntities[start].id} cannot fit regional package budget: `
        + `${Buffer.byteLength(oversized.serialized)} > ${budgetBytes} bytes`,
      );
    }
    chunks.push(sortedEntities.slice(start, bestEnd));
    start = bestEnd;
  }

  const shardCount = chunks.length;
  return chunks.map((chunk, shardIndex) => {
    const artifact = createRegionPackageArtifact(regionId, chunk, shardIndex, shardCount);
    const bytes = Buffer.byteLength(artifact.serialized);
    if (bytes > budgetBytes) {
      throw new Error(
        `Regional package ${regionId} shard ${shardIndex}/${shardCount} `
        + `is ${bytes} bytes, above the ${budgetBytes}-byte budget`,
      );
    }
    return artifact;
  });
}

function createRegionPackageArtifact(regionId, entities, shardIndex, shardCount) {
  const packageCore = {
    schemaVersion: "1.0.0",
    artifactType: "nature-region-package",
    generated: true,
    regionId,
    shardIndex,
    shardCount,
    entities,
  };
  const contentHash = sha256(canonicalJson(packageCore));
  const packageDocument = {
    ...packageCore,
    contentHash: `sha256:${contentHash}`,
  };
  return {
    regionId,
    shardIndex,
    shardCount,
    entities,
    contentHash,
    packageDocument,
    serialized: `${canonicalJson(packageDocument)}\n`,
  };
}

function buildQualityReport(records, validationErrors, adapterFailures) {
  const flags = countBy(
    records.flatMap((record) => record.quality?.flags || []),
    (flag) => flag,
  );
  const routeRecords = records.filter((record) => record.entityType === "TrailRoute");
  const duplicateCandidates = findNearDuplicateCandidates(records);
  return {
    schemaVersion: "1.0.0",
    generated: true,
    summary: {
      records: records.length,
      validRecords: records.length - validationErrors.length,
      invalidRecords: validationErrors.length,
      adapterFailures: adapterFailures.length,
      establishedRoutesWithCompleteGeometry: routeRecords.filter((route) =>
        route.routeNature === "established" && route.geometryCompleteness === "complete").length,
      routesWithOverviewOnlyGeometry: routeRecords.filter((route) =>
        route.geometryCompleteness === "overview_only").length,
      recordsWithMissingAttribution: records.filter((record) =>
        (record.media || []).some((media) => media.attributionStatus === "missing")).length,
      recordsWithUnknownLegalAccess: records.filter((record) =>
        record.access?.legal === "unknown" || record.legalAccess === "unknown").length,
      nearDuplicateCandidates: duplicateCandidates.length,
    },
    entityCounts: countBy(records, (record) => record.entityType),
    qualityFlags: flags,
    validationErrors,
    adapterFailures,
    duplicateCandidates: duplicateCandidates.slice(0, 500),
    interpretation: "Counts measure processed inventory, not geographic completeness.",
  };
}

function buildCoverageReport(records, jurisdictionRegistry, sourceRegistry) {
  const recordCounts = countBy(
    records.flatMap((record) => record.jurisdictionIds),
    (id) => id,
  );
  const routeCounts = countBy(
    records.filter((record) => record.entityType === "TrailRoute")
      .flatMap((record) => record.jurisdictionIds),
    (id) => id,
  );
  const completeRouteCounts = countBy(
    records.filter((record) => record.entityType === "TrailRoute"
      && record.routeNature === "established"
      && record.geometryCompleteness === "complete")
      .flatMap((record) => record.jurisdictionIds),
    (id) => id,
  );
  return {
    schemaVersion: "1.0.0",
    generated: true,
    statusVocabulary: [...jurisdictionRegistry.coverageStatuses],
    jurisdictions: jurisdictionRegistry.jurisdictions.map((jurisdiction) => ({
      id: jurisdiction.id,
      name: jurisdiction.name,
      scope: jurisdiction.kind,
      inScope: jurisdiction.inScope,
      overallStatus: jurisdiction.overallStatus,
      legacyInventoryPresent: Boolean(jurisdiction.legacyInventoryPresent),
      coverageDimensions: jurisdictionRegistry.coverageProfiles[jurisdiction.coverageProfile],
      recordCount: recordCounts[jurisdiction.id] || 0,
      trailRouteCount: routeCounts[jurisdiction.id] || 0,
      completeEstablishedRouteCount: completeRouteCounts[jurisdiction.id] || 0,
      caveats: jurisdiction.caveats || [],
    })),
    registeredSourceCount: sourceRegistry.sources.length,
    statement: "A successful import or non-zero record count does not upgrade a coverage status.",
  };
}

function findNearDuplicateCandidates(records) {
  const points = records.filter((record) => record.geometry?.type === "Point");
  const buckets = new Map();
  for (const record of points) {
    const normalizedName = String(record.names?.[0]?.value || "").toLocaleLowerCase("und");
    const key = `${record.entityType}\0${normalizedName}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }
  const candidates = [];
  for (const bucket of buckets.values()) {
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const distanceMeters = haversineMeters(
          bucket[left].geometry.coordinates,
          bucket[right].geometry.coordinates,
        );
        if (distanceMeters <= 250) {
          candidates.push({
            leftId: bucket[left].id,
            rightId: bucket[right].id,
            distanceMeters: Math.round(distanceMeters),
          });
        }
      }
    }
  }
  return candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

function combinedBounds(records) {
  const bounds = records.map((record) => geometryBounds(record.geometry)).filter(Boolean);
  if (!bounds.length) return null;
  return bounds.reduce((out, item) => [
    Math.min(out[0], item[0]),
    Math.min(out[1], item[1]),
    Math.max(out[2], item[2]),
    Math.max(out[3], item[3]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}

function countBy(items, selector) {
  const out = {};
  for (const item of items) {
    const key = selector(item);
    out[key] = (out[key] || 0) + 1;
  }
  return sortObject(out);
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
  );
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function copyTree(source, target) {
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(source, { withFileTypes: true }));
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyTree(from, to);
    } else {
      await writeFile(to, await readFile(from));
    }
  }
}

async function main() {
  const result = await buildNatureData();
  const manifestStats = await stat(path.join(OUTPUT_ROOT, "manifest.v1.json"));
  console.log(
    `Nature data: ${result.records} records, ${result.packages} regional packages, `
    + `manifest ${manifestStats.size} bytes, build ${result.buildId}`,
  );
  if (result.adapterFailures.length) {
    console.warn(`Isolated adapter failures: ${result.adapterFailures.length}`);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

export {
  JURISDICTION_REGISTRY_PATH,
  OUTPUT_ROOT,
  PACKAGE_ROOT,
  SEED_PATH,
  SOURCE_REGISTRY_PATH,
};

