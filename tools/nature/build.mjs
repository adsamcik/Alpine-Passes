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
import {
  NPS_HARDING_SUPERSEDED_SEED_IDS,
  ingestNpsPublicTrails,
} from "./lib/nps-public-trails-adapter.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTPUT_ROOT = path.join(REPO_ROOT, "assets", "data", "nature");
const PACKAGE_ROOT = path.join(OUTPUT_ROOT, "packages");
const SPATIAL_ROOT = path.join(OUTPUT_ROOT, "spatial");
const SEED_PATH = path.join(REPO_ROOT, "data", "seeds", "nature-routes.v1.json");
const SOURCE_REGISTRY_PATH = path.join(REPO_ROOT, "data", "sources", "registry.v1.json");
const JURISDICTION_REGISTRY_PATH = path.join(REPO_ROOT, "data", "jurisdictions", "registry.v1.json");

// Zoom 8 cells are about 156 km wide at the equator: fine enough for explicit
// viewport delivery while keeping the deterministic index compact.
export const NATURE_SPATIAL_CELL_ZOOM = 8;
export const MAX_SPATIAL_CELLS_PER_ENTITY = 4_096;

const DEFAULT_BUDGETS = Object.freeze({
  manifestBytes: 64_000,
  regionalPackageBytes: 2_500_000,
  spatialIndexBytes: 2_000_000,
  spatialCellPackageBytes: 1_000_000,
  viewportRequestBytes: 8_000_000,
  initialNatureDataBytes: 10_064_000,
  searchP95Milliseconds: 50,
  mapInteractionP95Milliseconds: 100,
  maxVisiblePointFeatures: 5_000,
  maxVisibleRouteFeatures: 1_000,
});

export function normalizeReportPath(value) {
  return String(value).replaceAll("\\", "/");
}

export async function buildNatureData(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const outputRoot = options.outputRoot || OUTPUT_ROOT;
  const packageRoot = path.join(outputRoot, "packages");
  const spatialRoot = path.join(outputRoot, "spatial");
  const seedPath = options.seedPath || path.join(repoRoot, "data", "seeds", "nature-routes.v1.json");
  const sourceRegistryPath = options.sourceRegistryPath
    || path.join(repoRoot, "data", "sources", "registry.v1.json");
  const jurisdictionRegistryPath = options.jurisdictionRegistryPath
    || path.join(repoRoot, "data", "jurisdictions", "registry.v1.json");
  const budgets = { ...DEFAULT_BUDGETS, ...(options.budgets || {}) };
  for (const budgetName of [
    "manifestBytes",
    "regionalPackageBytes",
    "spatialIndexBytes",
    "spatialCellPackageBytes",
    "viewportRequestBytes",
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
  const supersededCanonicalSeedIds = new Set(NPS_HARDING_SUPERSEDED_SEED_IDS);
  const canonicalSeedRecords = seedInput.entities.filter((record) =>
    !supersededCanonicalSeedIds.has(record.id));
  const adapters = options.adapters || [
    {
      id: "legacy-repository",
      run: () => ingestLegacyRepository(repoRoot),
    },
    {
      id: "nps-public-trails",
      run: () => ingestNpsPublicTrails(repoRoot),
    },
    {
      id: "canonical-seeds",
      run: async () => ({
        adapterId: "canonical-seeds",
        records: canonicalSeedRecords,
        redirects: {},
        inventories: [{
          source: normalizeReportPath(path.relative(repoRoot, seedPath)),
          records: canonicalSeedRecords.length,
          sourceRecords: seedInput.entities.length,
          supersededRecordIds: [...NPS_HARDING_SUPERSEDED_SEED_IDS],
        }],
      }),
    },
  ];
  const ingestion = await runIsolatedAdapters(adapters);
  const normalized = normalizeAndValidateRecords(
    ingestion.results.flatMap((result) => result.records),
    { sourceIds, jurisdictionIds },
  );
  const records = dedupeByStableId(normalized.records);
  const governance = applyPublicationGovernance(records, sourceIds, {
    includeUnapprovedPreviews: options.includeUnapprovedPreviews === true,
  });
  const delivery = applySensitivityPolicy(governance.records);
  const deliveredIds = new Set(delivery.records.map((record) => record.id));
  const deliveryValidationErrors = normalized.validationErrors
    .filter((error) => deliveredIds.has(error.id));
  const qualityReport = buildQualityReport(
    delivery.records,
    deliveryValidationErrors,
    ingestion.failures,
    governance.report,
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
  await mkdir(path.join(staged, "spatial", "index"), { recursive: true });
  await mkdir(path.join(staged, "spatial", "cells"), { recursive: true });

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

  const spatialCellDefinitions = groupBySpatialCell(
    delivery.records,
    NATURE_SPATIAL_CELL_ZOOM,
  );
  const spatialCells = [];
  let spatialPackageCount = 0;
  for (const [cellId, cell] of spatialCellDefinitions) {
    const shards = shardSpatialCellPackage(
      cell,
      cell.entities,
      budgets.spatialCellPackageBytes,
    );
    const packages = [];
    for (const shard of shards) {
      const hashPrefix = shard.contentHash.slice(0, 16);
      const relativeUrl = `assets/data/nature/spatial/cells/${cell.zoom}/${cell.x}/${cell.y}/${hashPrefix}.json`;
      const stagedPath = path.join(
        staged,
        "spatial",
        "cells",
        String(cell.zoom),
        String(cell.x),
        String(cell.y),
        `${hashPrefix}.json`,
      );
      await mkdir(path.dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, shard.serialized, "utf8");
      const bytes = Buffer.byteLength(shard.serialized);
      if (bytes > budgets.spatialCellPackageBytes) {
        throw new Error(
          `Spatial cell package ${cellId} shard ${shard.shardIndex}/${shard.shardCount} `
          + `is ${bytes} bytes, above the ${budgets.spatialCellPackageBytes}-byte budget`,
        );
      }
      packages.push({
        shardIndex: shard.shardIndex,
        shardCount: shard.shardCount,
        url: relativeUrl,
        contentHash: `sha256:${shard.contentHash}`,
        bytes,
        entityCount: shard.entities.length,
      });
      spatialPackageCount += 1;
    }
    spatialCells.push({
      cellId,
      zoom: cell.zoom,
      x: cell.x,
      y: cell.y,
      entityCount: cell.entities.length,
      packages,
    });
  }

  const spatialIndexCore = {
    schemaVersion: "1.0.0",
    artifactType: "nature-spatial-index",
    generated: true,
    zoom: NATURE_SPATIAL_CELL_ZOOM,
    cellCount: spatialCells.length,
    packageCount: spatialPackageCount,
    cells: spatialCells,
  };
  const spatialIndexHash = sha256(canonicalJson(spatialIndexCore));
  const spatialIndex = {
    ...spatialIndexCore,
    contentHash: `sha256:${spatialIndexHash}`,
  };
  const spatialIndexSerialized = `${canonicalJson(spatialIndex)}\n`;
  const spatialIndexBytes = Buffer.byteLength(spatialIndexSerialized);
  if (spatialIndexBytes > budgets.spatialIndexBytes) {
    await rm(staged, { recursive: true, force: true });
    throw new Error(
      `Nature spatial index is ${spatialIndexBytes} bytes, above the `
      + `${budgets.spatialIndexBytes}-byte spatial index budget`,
    );
  }
  const spatialIndexHashPrefix = spatialIndexHash.slice(0, 16);
  await writeFile(
    path.join(staged, "spatial", "index", `${spatialIndexHashPrefix}.json`),
    spatialIndexSerialized,
    "utf8",
  );
  const spatialIndexReference = {
    zoom: NATURE_SPATIAL_CELL_ZOOM,
    url: `assets/data/nature/spatial/index/${spatialIndexHashPrefix}.json`,
    contentHash: `sha256:${spatialIndexHash}`,
    bytes: spatialIndexBytes,
    cellCount: spatialCells.length,
    packageCount: spatialPackageCount,
  };

  const sourceReleaseNoticeCore = buildSourceReleaseNotice(
    delivery.records,
    sourceRegistry,
    {
      allowUnapproved: options.includeUnapprovedPreviews === true,
    },
  );
  const sourceReleaseNoticeHash = sha256(canonicalJson(sourceReleaseNoticeCore));
  const sourceReleaseNotice = {
    ...sourceReleaseNoticeCore,
    contentHash: `sha256:${sourceReleaseNoticeHash}`,
  };
  const sourceReleaseNoticeBytes = Buffer.byteLength(
    `${canonicalJson(sourceReleaseNotice)}\n`,
  );
  const sourceReleaseNoticeReference = {
    url: "assets/data/nature/source-release-notice.v1.json",
    contentHash: `sha256:${sourceReleaseNoticeHash}`,
    bytes: sourceReleaseNoticeBytes,
    sourceCount: sourceReleaseNotice.sources.length,
    releaseEligible: sourceReleaseNotice.releaseEligible,
    mediaCount: sourceReleaseNotice.media.length,
  };

  const manifestCore = {
    schemaVersion: "1.0.0",
    artifactType: "nature-package-manifest",
    generated: true,
    packages: manifestPackages,
    spatialIndex: spatialIndexReference,
    budgets,
    sourceReleaseNotice: sourceReleaseNoticeReference,
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
  const initialNatureDataUpperBoundBytes = manifestBytes
    + spatialIndexBytes
    + budgets.viewportRequestBytes;
  if (initialNatureDataUpperBoundBytes > budgets.initialNatureDataBytes) {
    await rm(staged, { recursive: true, force: true });
    throw new Error(
      `Initial nature data upper bound is ${initialNatureDataUpperBoundBytes} bytes, above the `
      + `${budgets.initialNatureDataBytes}-byte budget`,
    );
  }
  const generatedArtifacts = {
    "manifest.v1.json": manifest,
    "quality-report.v1.json": qualityReport,
    "coverage-report.v1.json": coverageReport,
    "sensitivity-report.v1.json": delivery.report,
    "source-release-notice.v1.json": sourceReleaseNotice,
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
  await rm(spatialRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  for (const filename of Object.keys(generatedArtifacts)) {
    await writeFile(
      path.join(outputRoot, filename),
      await readFile(path.join(staged, filename)),
    );
  }
  await mkdir(packageRoot, { recursive: true });
  await copyTree(path.join(staged, "packages"), packageRoot);
  await mkdir(spatialRoot, { recursive: true });
  await copyTree(path.join(staged, "spatial"), spatialRoot);
  await rm(staged, { recursive: true, force: true });

  return {
    records: delivery.records.length,
    processedRecords: records.length,
    withheldRecords: delivery.report.counts.withheld,
    packages: manifestPackages.length,
    spatialCells: spatialCells.length,
    spatialPackages: spatialPackageCount,
    spatialIndexBytes,
    manifestBytes,
    initialNatureDataUpperBoundBytes,
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

export function validateSourceRegistry(registry) {
  if (registry?.schemaVersion !== "1.0.0" || !Array.isArray(registry.sources)) {
    throw new Error("Source registry must use schemaVersion 1.0.0 and contain sources");
  }
  const policy = registry.dataUsePolicy;
  if (policy?.zeroPaidRights?.licenceFees !== "prohibited"
      || policy?.zeroPaidRights?.restrictiveRights !== "prohibited"
      || policy?.zeroPaidRights?.unknownRights !== "fail_closed"
      || policy?.publicationRules?.publishableDisposition !== "approved"
      || policy?.publicationRules?.blockedDisposition !== "blocked"
      || !Array.isArray(policy?.mediaRules)
      || !policy.mediaRules.length) {
    throw new Error("Source registry dataUsePolicy must enforce the MIT boundary and fail-closed zero-paid rights");
  }

  const allowedDispositions = new Set(["approved", "lead_only", "link_only", "blocked"]);
  const allowedRightsCosts = new Set(["no_fee", "paid", "unknown"]);
  const allowedUses = new Set([
    "discovery", "fact_evidence", "bulk_ingest", "geometry", "media",
    "runtime_api", "dynamic_status",
  ]);
  const sourcesById = new Map();
  for (const source of registry.sources) {
    const required = [
      "id", "name", "owner", "authorityTier", "jurisdictionIds", "themes",
      "homepage", "retrieval", "licence", "updateCadence", "authentication",
      "rateLimits", "schemaAssumptions", "knownGaps", "failureBehaviour",
      "lastSuccessfulRefresh", "publicationDisposition", "rightsCost", "approvedUses", "redistribution",
    ];
    const missing = required.filter((field) => !(field in source));
    if (missing.length) throw new Error(`Source ${source.id || "(missing)"} lacks ${missing.join(", ")}`);
    if (sourcesById.has(source.id)) throw new Error(`Duplicate source ID: ${source.id}`);
    if (!allowedDispositions.has(source.publicationDisposition)) {
      throw new Error(`Source ${source.id} has unsupported publicationDisposition`);
    }
    if (!allowedRightsCosts.has(source.rightsCost)) {
      throw new Error(`Source ${source.id} has unsupported rightsCost`);
    }
    if (!Array.isArray(source.approvedUses)
        || source.approvedUses.some((use) => !allowedUses.has(use))) {
      throw new Error(`Source ${source.id} has unsupported approvedUses`);
    }
    if (source.publicationDisposition === "approved") {
      if (!source.approvedUses.length
          || source.rightsCost !== "no_fee"
          || source.licence?.commercialUse !== "allowed"
          || !["allowed", "allowed_with_attribution"].includes(source.redistribution)) {
        throw new Error(`Approved source ${source.id} must have no-fee commercial redistribution rights and approved uses`);
      }
    } else if (source.publicationDisposition === "blocked") {
      if (source.approvedUses.length) {
        throw new Error(`Blocked source ${source.id} cannot have approved uses`);
      }
    } else if (source.approvedUses.some((use) => use !== "discovery")) {
      throw new Error(`Discovery-only source ${source.id} may only declare discovery use`);
    }
    if (source.publicationDisposition !== "approved" && !source.governanceRationale) {
      throw new Error(`Non-approved source ${source.id} requires a governance rationale`);
    }
    if (source.authentication?.secretBrowserSafe !== false) {
      throw new Error(`Source ${source.id} must not mark secrets browser-safe`);
    }
    if (source.failureBehaviour?.isolateSource !== true) {
      throw new Error(`Source ${source.id} must isolate failures`);
    }
    sourcesById.set(source.id, source);
  }
  return sourcesById;
}

export function applyPublicationGovernance(records, sourcesById, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const includeUnapprovedPreviews = options.includeUnapprovedPreviews === true;
  const governed = [];
  let removedMediaItems = 0;
  let recordsWithMediaRemoved = 0;
  let recordsWithheldForRights = 0;
  const withheldBySourceId = {};

  for (const input of records) {
    const record = markUnverifiedDiscoveryPreview(input, sourcesById);
    let removedFromRecord = 0;
    if (record.media !== undefined) {
      if (!Array.isArray(record.media)) {
        throw new Error(`Governance validation failed for ${record.id}: media must be an array`);
      }
      const acceptedMedia = [];
      for (const media of record.media) {
        if (mediaRightsErrors(media, sourcesById).length) {
          removedFromRecord += 1;
        } else {
          acceptedMedia.push(media);
        }
      }
      if (acceptedMedia.length) record.media = acceptedMedia;
      else delete record.media;
    }
    if (removedFromRecord && record.legacy?.compactRecord
        && Object.hasOwn(record.legacy.compactRecord, "bp")) {
      delete record.legacy.compactRecord.bp;
    }
    removedMediaItems += removedFromRecord;
    if (removedFromRecord) recordsWithMediaRemoved += 1;

    const governanceErrors = validateRecordGovernance(record, sourcesById);
    if (governanceErrors.length) {
      throw new Error(`Governance validation failed for ${record.id}: ${governanceErrors.join("; ")}`);
    }
    const nonApprovedSourceIds = [...governanceSourceIds(record)].filter((sourceId) =>
      sourcesById.get(sourceId)?.publicationDisposition !== "approved");
    if (nonApprovedSourceIds.length && !includeUnapprovedPreviews) {
      recordsWithheldForRights += 1;
      for (const sourceId of nonApprovedSourceIds) {
        withheldBySourceId[sourceId] = (withheldBySourceId[sourceId] || 0) + 1;
      }
    } else {
      governed.push(record);
    }
  }

  return {
    records: governed,
    report: {
      removedMediaItems,
      recordsWithMediaRemoved,
      recordsWithheldForRights,
      withheldBySourceId: sortObject(withheldBySourceId),
      includeUnapprovedPreviews,
      interpretation: includeUnapprovedPreviews
        ? "Explicit preview mode includes unapproved records only as labeled migration leads; it is not a redistributable release build."
        : "Public delivery excludes every record that references a non-approved source; media also requires an approved media use and complete per-file rights metadata.",
    },
  };
}

export function validateRecordGovernance(record, sourcesById) {
  const errors = [];
  const assertions = record.sourceAssertions || [];
  const assertionSources = [];
  for (const assertion of assertions) {
    const source = sourcesById.get(assertion.sourceId);
    if (!source) continue;
    assertionSources.push(source);
    if (source.rightsCost === "paid") {
      errors.push(`paid-rights source ${source.id} is referenced`);
      continue;
    }
    if (source.publicationDisposition === "blocked") {
      errors.push(`blocked source ${source.id} is referenced`);
      continue;
    }
    if (source.publicationDisposition !== "approved") {
      if (!source.approvedUses.includes("discovery")) {
        errors.push(`source ${source.id} is not approved even for discovery`);
      }
      if (assertion.verificationStatus !== "unverified"
          || assertion.evidenceKind === "verified_official") {
        errors.push(`discovery-only source ${source.id} may provide only unverified lead assertions`);
      }
      continue;
    }
    const requiredUse = assertion.fieldPath === "/geometry"
      || assertion.fieldPath.startsWith("/geometry/") ? "geometry" : "fact_evidence";
    if (!source.approvedUses.includes(requiredUse)) {
      errors.push(`approved source ${source.id} lacks ${requiredUse} use for ${assertion.fieldPath}`);
    }
  }

  for (const sourceId of governanceSourceIds(record)) {
    const source = sourcesById.get(sourceId);
    if (source?.rightsCost === "paid") {
      errors.push(`paid-rights source ${source.id} is referenced`);
    } else if (source?.publicationDisposition === "blocked") {
      errors.push(`blocked source ${source.id} is referenced`);
    }
  }

  const hasApprovedAssertion = assertionSources.some((source) =>
    source.publicationDisposition === "approved");
  const hasDiscoveryOnlyAssertion = assertionSources.some((source) =>
    source.publicationDisposition === "lead_only" || source.publicationDisposition === "link_only");
  if (hasDiscoveryOnlyAssertion) {
    const flags = new Set(record.quality?.flags || []);
    if (!flags.has("discovery_lead") || !flags.has("unverified_migration_preview")) {
      errors.push("discovery-only evidence must be labeled as an unverified migration/discovery preview");
    }
  }
  if (!hasApprovedAssertion
      && record.quality?.verificationStatus !== "unverified") {
    errors.push("a verified record cannot rely solely on discovery-only evidence");
  }

  for (const media of record.media || []) {
    errors.push(...mediaRightsErrors(media, sourcesById));
  }
  if (record.entityType === "MediaAsset") {
    const sourceId = assertions.length === 1 ? assertions[0].sourceId : null;
    errors.push(...mediaRightsErrors({ ...record, sourceId }, sourcesById));
  }
  return [...new Set(errors)];
}

function markUnverifiedDiscoveryPreview(input, sourcesById) {
  const nonApproved = (input.sourceAssertions || []).some((assertion) => {
    const source = sourcesById.get(assertion.sourceId);
    return source && source.publicationDisposition !== "approved";
  });
  if (!nonApproved || !input.quality) return structuredClone(input);
  const record = structuredClone(input);
  record.quality.flags = [...new Set([
    ...(record.quality.flags || []),
    "discovery_lead",
    "unverified_migration_preview",
  ])].sort();
  const marker = "Unverified migration/discovery preview; not a verified production fact.";
  if (!record.quality.notes?.includes(marker)) {
    record.quality.notes = record.quality.notes
      ? `${record.quality.notes} ${marker}`
      : marker;
  }
  return record;
}

function governanceSourceIds(record) {
  return new Set([
    ...(record.sourceAssertions || []).map((assertion) => assertion.sourceId),
    ...(record.originalSourceIds || []).map((source) => source.sourceId),
    record.sensitivity?.authoritySourceId,
    record.authoritySourceId,
  ].filter(Boolean));
}

function mediaRightsErrors(media, sourcesById) {
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    return ["media item must be an object"];
  }
  const errors = [];
  const source = sourcesById.get(media.sourceId);
  if (!source || source.publicationDisposition !== "approved"
      || !source.approvedUses.includes("media")) {
    errors.push(`media source ${media.sourceId || "(missing)"} is not approved for media use`);
  }
  for (const field of [
    "url", "sourcePageUrl", "creator", "licenceId", "licenceUrl",
    "licenceVersion", "attribution", "modifications",
  ]) {
    if (typeof media[field] !== "string" || !media[field].trim()) {
      errors.push(`media.${field} is required for per-file rights`);
    }
  }
  if (media.reviewStatus !== "approved") {
    errors.push("media.reviewStatus must be approved");
  }
  if (typeof media.reviewedAt !== "string"
      || !media.reviewedAt.trim()
      || !Number.isFinite(Date.parse(media.reviewedAt))) {
    errors.push("media.reviewedAt must be a valid nonempty date");
  }
  for (const permission of [
    "display", "commercialUse", "redistribution", "modificationsAllowed",
  ]) {
    if (media[permission] !== true) {
      errors.push(`media.${permission} must be explicitly true`);
    }
  }
  return errors;
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

const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;

export function geometrySpatialCellIds(geometry, zoom = NATURE_SPATIAL_CELL_ZOOM) {
  validateSpatialZoom(zoom);
  if (!geometry || typeof geometry !== "object") {
    throw new TypeError("geometry must be a GeoJSON geometry object");
  }
  if (geometry.type === "Point") {
    const { x, y } = webMercatorCell(geometry.coordinates, zoom);
    return [`${zoom}/${x}/${y}`];
  }

  const positions = spatialGeometryPositions(geometry);
  if (!positions.length) throw new TypeError("geometry must contain valid positions");
  const latitudes = positions.map((position) => position[1]);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const northCell = webMercatorCell([0, north], zoom).y;
  const southCell = webMercatorCell([0, south], zoom).y;
  const cellIds = new Set();
  for (const [west, east] of minimumLongitudeIntervals(positions)) {
    const westCell = webMercatorCell([west, 0], zoom).x;
    const eastCell = webMercatorCell([east, 0], zoom).x;
    for (let x = westCell; x <= eastCell; x += 1) {
      for (let y = northCell; y <= southCell; y += 1) {
        cellIds.add(`${zoom}/${x}/${y}`);
        if (cellIds.size > MAX_SPATIAL_CELLS_PER_ENTITY) {
          throw new RangeError(
            `Geometry covers more than ${MAX_SPATIAL_CELLS_PER_ENTITY} spatial cells`,
          );
        }
      }
    }
  }
  return [...cellIds].sort((left, right) => left.localeCompare(right));
}

export function groupBySpatialCell(records, zoom = NATURE_SPATIAL_CELL_ZOOM) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  validateSpatialZoom(zoom);
  const cells = new Map();
  for (const record of records) {
    for (const cellId of geometrySpatialCellIds(record.geometry, zoom)) {
      const [, xText, yText] = cellId.split("/");
      if (!cells.has(cellId)) {
        cells.set(cellId, {
          cellId,
          zoom,
          x: Number(xText),
          y: Number(yText),
          entitiesById: new Map(),
        });
      }
      const cell = cells.get(cellId);
      const prior = cell.entitiesById.get(record.id);
      if (prior && canonicalJson(prior) !== canonicalJson(record)) {
        throw new Error(`Conflicting canonical records share ID ${record.id} in cell ${cellId}`);
      }
      cell.entitiesById.set(record.id, record);
    }
  }
  return new Map(
    [...cells.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([cellId, cell]) => [cellId, {
        cellId,
        zoom: cell.zoom,
        x: cell.x,
        y: cell.y,
        entities: [...cell.entitiesById.values()].sort((left, right) =>
          left.id.localeCompare(right.id)),
      }]),
  );
}

function webMercatorCell(position, zoom) {
  if (!Array.isArray(position)
      || position.length < 2
      || !Number.isFinite(position[0])
      || !Number.isFinite(position[1])
      || position[0] < -180
      || position[0] > 180
      || position[1] < -90
      || position[1] > 90) {
    throw new TypeError("position must be a valid [longitude, latitude] pair");
  }
  const tileCount = 2 ** zoom;
  const longitude = Math.min(180, Math.max(-180, position[0]));
  const latitude = Math.min(
    WEB_MERCATOR_MAX_LATITUDE,
    Math.max(-WEB_MERCATOR_MAX_LATITUDE, position[1]),
  );
  const latitudeRadians = latitude * Math.PI / 180;
  return {
    x: Math.min(
      tileCount - 1,
      Math.max(0, Math.floor((longitude + 180) / 360 * tileCount)),
    ),
    y: Math.min(
      tileCount - 1,
      Math.max(
        0,
        Math.floor(
          (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * tileCount,
        ),
      ),
    ),
  };
}

function spatialGeometryPositions(geometry) {
  const positions = [];
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2
        && Number.isFinite(value[0])
        && Number.isFinite(value[1])
        && value[0] >= -180
        && value[0] <= 180
        && value[1] >= -90
        && value[1] <= 90) {
      positions.push(value);
      return;
    }
    for (const nested of value) visit(nested);
  };
  visit(geometry.coordinates);
  return positions;
}

function minimumLongitudeIntervals(positions) {
  const rawLongitudes = positions.map((position) => position[0]);
  const rawWest = Math.min(...rawLongitudes);
  const rawEast = Math.max(...rawLongitudes);
  const rawSpan = rawEast - rawWest;
  if (rawSpan <= 180 || (rawWest === -180 && rawEast === 180)) {
    return [[rawWest, rawEast]];
  }

  const wrapped = [...new Set(rawLongitudes.map((longitude) =>
    (longitude + 360) % 360))].sort((left, right) => left - right);
  if (wrapped.length < 2) return [[rawWest, rawEast]];
  let largestGap = -1;
  let gapIndex = -1;
  for (let index = 0; index < wrapped.length; index += 1) {
    const next = index + 1 < wrapped.length ? wrapped[index + 1] : wrapped[0] + 360;
    const gap = next - wrapped[index];
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = index;
    }
  }
  const wrappedSpan = 360 - largestGap;
  if (wrappedSpan >= rawSpan) return [[rawWest, rawEast]];
  const start = wrapped[(gapIndex + 1) % wrapped.length];
  const end = wrapped[gapIndex];
  const west = start > 180 ? start - 360 : start;
  const east = end > 180 ? end - 360 : end;
  return west <= east
    ? [[west, east]]
    : [[west, 180], [-180, east]];
}

function validateSpatialZoom(zoom) {
  if (!Number.isSafeInteger(zoom) || zoom < 0 || zoom > 22) {
    throw new TypeError("zoom must be a safe integer from 0 through 22");
  }
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

export function shardSpatialCellPackage(cell, entities, budgetBytes) {
  validateSpatialCell(cell);
  if (!Array.isArray(entities)) throw new TypeError("entities must be an array");
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
    throw new TypeError("budgetBytes must be a positive safe integer");
  }
  const sortedEntities = dedupeByStableId(entities)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!sortedEntities.length) return [];

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
      const artifact = createSpatialCellPackageArtifact(
        cell,
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
      const oversized = createSpatialCellPackageArtifact(
        cell,
        [sortedEntities[start]],
        conservativeShardIndex,
        conservativeShardCount,
      );
      throw new Error(
        `Entity ${sortedEntities[start].id} cannot fit spatial cell package budget: `
        + `${Buffer.byteLength(oversized.serialized)} > ${budgetBytes} bytes`,
      );
    }
    chunks.push(sortedEntities.slice(start, bestEnd));
    start = bestEnd;
  }

  const shardCount = chunks.length;
  return chunks.map((chunk, shardIndex) => {
    const artifact = createSpatialCellPackageArtifact(cell, chunk, shardIndex, shardCount);
    const bytes = Buffer.byteLength(artifact.serialized);
    if (bytes > budgetBytes) {
      throw new Error(
        `Spatial cell package ${cell.cellId} shard ${shardIndex}/${shardCount} `
        + `is ${bytes} bytes, above the ${budgetBytes}-byte budget`,
      );
    }
    return artifact;
  });
}

function createSpatialCellPackageArtifact(cell, entities, shardIndex, shardCount) {
  const packageCore = {
    schemaVersion: "1.0.0",
    artifactType: "nature-spatial-cell-package",
    generated: true,
    cellId: cell.cellId,
    zoom: cell.zoom,
    x: cell.x,
    y: cell.y,
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
    cellId: cell.cellId,
    zoom: cell.zoom,
    x: cell.x,
    y: cell.y,
    shardIndex,
    shardCount,
    entities,
    contentHash,
    packageDocument,
    serialized: `${canonicalJson(packageDocument)}\n`,
  };
}

function validateSpatialCell(cell) {
  if (!cell || typeof cell !== "object") {
    throw new TypeError("cell must be an object");
  }
  validateSpatialZoom(cell.zoom);
  const tileCount = 2 ** cell.zoom;
  if (!Number.isSafeInteger(cell.x)
      || !Number.isSafeInteger(cell.y)
      || cell.x < 0
      || cell.y < 0
      || cell.x >= tileCount
      || cell.y >= tileCount
      || cell.cellId !== `${cell.zoom}/${cell.x}/${cell.y}`) {
    throw new TypeError("cell must have a valid Web Mercator XYZ identity");
  }
}

export function buildSourceReleaseNotice(records, sourceRegistry, options = {}) {
  const allowUnapproved = options.allowUnapproved === true;
  if (!Array.isArray(records)) {
    throw new TypeError("records must be an array");
  }
  if (!sourceRegistry || !Array.isArray(sourceRegistry.sources)) {
    throw new TypeError("sourceRegistry.sources must be an array");
  }
  const sourcesById = new Map(sourceRegistry.sources.map((source) => [source.id, source]));
  const recordIdsBySource = new Map();
  const assertionCounts = {};
  const media = [];

  for (const record of records) {
    const recordSourceIds = new Set(governanceSourceIds(record));
    for (const mediaItem of record.media || []) {
      if (mediaItem?.sourceId) recordSourceIds.add(mediaItem.sourceId);
      media.push({ recordId: record.id, ...structuredClone(mediaItem) });
    }
    for (const sourceId of recordSourceIds) {
      const source = sourcesById.get(sourceId);
      if (!source) throw new Error(`Public release record ${record.id} references missing source ${sourceId}`);
      if (source.publicationDisposition !== "approved" && !allowUnapproved) {
        throw new Error(
          `Public release record ${record.id} references non-approved source ${sourceId}`,
        );
      }
      const recordIds = recordIdsBySource.get(sourceId) || new Set();
      recordIds.add(record.id);
      recordIdsBySource.set(sourceId, recordIds);
    }
    for (const assertion of record.sourceAssertions || []) {
      assertionCounts[assertion.sourceId] = (assertionCounts[assertion.sourceId] || 0) + 1;
    }
  }

  const sources = [...recordIdsBySource.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((sourceId) => ({
      ...structuredClone(sourcesById.get(sourceId)),
      deliveredRecordCount: recordIdsBySource.get(sourceId).size,
      deliveredAssertionCount: assertionCounts[sourceId] || 0,
    }));
  media.sort((left, right) =>
    left.recordId.localeCompare(right.recordId)
    || String(left.url || "").localeCompare(String(right.url || "")));

  return {
    schemaVersion: "1.0.0",
    artifactType: "nature-source-release-notice",
    generated: true,
    releaseEligible: !allowUnapproved,
    scope: allowUnapproved
      ? "NON-RELEASE PREVIEW: exact sources and per-file media metadata referenced by explicitly included migration/discovery previews."
      : "Exact approved sources and per-file media metadata referenced by redistributable public delivery records.",
    recordCount: records.length,
    sources,
    media,
  };
}

function buildQualityReport(records, validationErrors, adapterFailures, governanceReport) {
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
      recordsInUnverifiedMigrationPreview: records.filter((record) =>
        (record.quality?.flags || []).includes("unverified_migration_preview")).length,
      recordsWithheldForRights: governanceReport.recordsWithheldForRights,
      mediaItemsRemovedByGovernance: governanceReport.removedMediaItems,
      recordsWithUnknownLegalAccess: records.filter((record) =>
        record.access?.legal === "unknown" || record.legalAccess === "unknown").length,
      nearDuplicateCandidates: duplicateCandidates.length,
    },
    entityCounts: countBy(records, (record) => record.entityType),
    qualityFlags: flags,
    validationErrors,
    adapterFailures,
    mediaGovernance: governanceReport,
    duplicateCandidates: duplicateCandidates.slice(0, 500),
    interpretation: "Record counts measure redistributable public delivery after rights and sensitivity gates, not processed inventory or geographic completeness.",
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
  const includeUnapprovedPreviews = process.argv.includes("--include-unapproved-previews");
  const result = await buildNatureData({ includeUnapprovedPreviews });
  if (includeUnapprovedPreviews) {
    console.warn("NON-RELEASE BUILD: unapproved migration/discovery previews are included.");
  }
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
