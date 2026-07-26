import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENTITY_TYPES,
  flattenPositions,
  lineDistanceMeters,
  validateCanonicalEntity,
} from "../assets/js/nature/domain.mjs";
import {
  buildSearchDocument,
  discoveryAssessment,
  rankDiscovery,
  searchEntities,
} from "../assets/js/nature/discovery.mjs";
import {
  applyPublicationGovernance,
  buildNatureData,
  canonicalJson,
  validateRecordGovernance,
  validateSourceRegistry,
} from "../tools/nature/build.mjs";
import { ingestLegacyRepository } from "../tools/nature/lib/legacy-adapter.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_ROOT = path.join(REPO_ROOT, "assets", "data", "nature");
const COVERAGE_STATUSES = [
  "Verified broad coverage",
  "Verified partial coverage",
  "Source available but not yet ingested",
  "Structurally supported but unpopulated",
  "Unknown",
  "Excluded, with reason",
];
const ACCESS_MODES = new Set([
  "car",
  "foot",
  "hiking",
  "transit",
  "ferry",
  "cable_transport",
  "bicycle",
]);
const ACTIVITY_TYPES = new Set([
  "walking",
  "hiking",
  "scrambling",
  "via_ferrata",
  "snowshoe",
  "winter_walking",
  "scenic_driving",
  "accessible_nature",
]);
const REFERENCE_ARRAY_FIELDS = [
  "accessPointIds",
  "transportConnectionIds",
  "priceIds",
  "linkedEntityIds",
  "endpointIds",
  "stageIds",
  "variantIds",
  "segmentIds",
  "restrictionRefs",
  "hazardRefs",
  "conditionRefs",
  "permitRequirementIds",
  "openingScheduleIds",
];

test("versioned taxonomy is internally closed and covers every delivered classification", async () => {
  const [taxonomy, schema, { entities }] = await Promise.all([
    readJson("data/taxonomy/nature-travel.v1.json"),
    readJson("schemas/nature-domain.schema.json"),
    loadGeneratedEntities(),
  ]);

  assert.equal(taxonomy.schemaVersion, "1.0.0");
  assert.equal(taxonomy.taxonomyId, "itinera-nature-travel");
  const taxonomyEntityTypes = taxonomy.entityFamilies.flatMap((family) => family.entityTypes);
  assert.deepEqual([...new Set(taxonomyEntityTypes)].sort(), [...ENTITY_TYPES].sort());
  assert.deepEqual(schema.$defs.entityType.enum, ENTITY_TYPES);
  assert.deepEqual(taxonomy.activities, [...ACTIVITY_TYPES]);
  assert.deepEqual(taxonomy.accessModes, [...ACCESS_MODES]);

  const keys = taxonomy.classificationGroups.flatMap((group) => group.normalizedKeys);
  assert.equal(new Set(keys).size, keys.length, "normalized keys must be globally unique");
  assert.ok(keys.every((key) => /^[a-z][a-z0-9_]*$/.test(key)));
  const keySet = new Set(keys);
  const aliases = new Map();
  for (const alias of taxonomy.classificationAliases) {
    assert.match(alias.alias, /^[a-z][a-z0-9_]*$/);
    assert.equal(aliases.has(alias.alias), false, `duplicate alias ${alias.alias}`);
    assert.ok(keySet.has(alias.target), `unknown alias target ${alias.target}`);
    aliases.set(alias.alias, alias.target);
  }
  for (const forbidden of taxonomy.hiddenDiscoveryPolicy.classificationKeysForbidden) {
    assert.equal(keySet.has(forbidden), false);
    assert.equal(aliases.has(forbidden), false);
  }
  for (const entity of entities) {
    for (const classification of entity.classifications || []) {
      assert.ok(
        keySet.has(classification.normalized) || aliases.has(classification.normalized),
        `${entity.id} has an ungoverned classification ${classification.normalized}`,
      );
    }
  }
  assert.deepEqual(taxonomy.coverageStatuses, COVERAGE_STATUSES);
  assert.deepEqual(taxonomy.sensitivity.actions, ["publish", "coarsen", "redact", "exclude"]);
  assert.match(
    taxonomy.sensitivity.deliveryRules.coarsen,
    /publicGeometry.*valid.*replaces/i,
  );
});

test("every generated package and entity satisfies canonical delivery invariants", async () => {
  const [{ manifest, packages, entities }, sourceRegistry, jurisdictionRegistry] = await Promise.all([
    loadGeneratedEntities(),
    readJson("data/sources/registry.v1.json"),
    readJson("data/jurisdictions/registry.v1.json"),
  ]);
  const sourceIds = new Set(sourceRegistry.sources.map((source) => source.id));
  const jurisdictionIds = new Set([
    "ALPS",
    ...jurisdictionRegistry.jurisdictions.map((jurisdiction) => jurisdiction.id),
  ]);

  assert.equal(manifest.schemaVersion, "1.0.0");
  assert.equal(manifest.artifactType, "nature-package-manifest");
  assert.equal(packages.length, manifest.packages.length);
  assert.equal(new Set(entities.map((entity) => entity.id)).size, entities.length);
  for (const { entry, document, raw, bytes } of packages) {
    assert.equal(document.schemaVersion, "1.0.0");
    assert.equal(document.artifactType, "nature-region-package");
    assert.equal(document.regionId, entry.regionId);
    assert.equal(document.shardIndex, entry.shardIndex);
    assert.equal(document.shardCount, entry.shardCount);
    assert.equal(bytes, entry.bytes);
    assert.equal(Buffer.byteLength(raw), entry.bytes);
    assert.ok(bytes <= manifest.budgets.regionalPackageBytes);
    assert.equal(document.sensitivity, undefined);
  }

  for (const entity of entities) {
    assert.deepEqual(validateCanonicalEntity(entity), [], entity.id);
    assert.ok(entity.sourceAssertions.every((assertion) => sourceIds.has(assertion.sourceId)));
    assert.ok(entity.jurisdictionIds.every((id) => jurisdictionIds.has(id)));
    assert.ok(entity.summary === undefined || typeof entity.summary === "string");
    assert.ok(entity.activities === undefined
      || entity.activities.every((activity) => ACTIVITY_TYPES.has(activity)));
    assert.ok(entity.access?.modes === undefined
      || entity.access.modes.every((mode) => ACCESS_MODES.has(mode)));
    assert.ok(entity.accessModes === undefined
      || entity.accessModes.every((mode) => ACCESS_MODES.has(mode)));
    assert.ok(!Object.hasOwn(entity.sensitivity, "publicGeometry"));
    if (entity.sensitivity.action === "coarsen") {
      assert.ok(entity.quality.flags.includes("coarsened_for_sensitivity"));
      assert.ok(entity.quality.geometryConfidence <= 0.2);
    } else {
      assert.equal(entity.sensitivity.action, "publish");
    }
  }
});

test("source and jurisdiction registries satisfy their schemas and target-territory contract", async () => {
  const [sourceRegistry, sourceSchema, jurisdictionRegistry, jurisdictionSchema] = await Promise.all([
    readJson("data/sources/registry.v1.json"),
    readJson("schemas/source-registry.schema.json"),
    readJson("data/jurisdictions/registry.v1.json"),
    readJson("schemas/jurisdiction-registry.schema.json"),
  ]);

  assertRegistryTopLevel(sourceRegistry, sourceSchema);
  assertRegistryTopLevel(jurisdictionRegistry, jurisdictionSchema);
  assert.equal(sourceRegistry.dataUsePolicy.zeroPaidRights.licenceFees, "prohibited");
  assert.equal(sourceRegistry.dataUsePolicy.zeroPaidRights.unknownRights, "fail_closed");
  assert.deepEqual(jurisdictionRegistry.coverageStatuses, COVERAGE_STATUSES);
  const dimensionSet = new Set(jurisdictionRegistry.dimensions);
  assert.equal(dimensionSet.size, jurisdictionRegistry.dimensions.length);
  for (const [profileId, profile] of Object.entries(jurisdictionRegistry.coverageProfiles)) {
    assert.deepEqual(Object.keys(profile).sort(), [...dimensionSet].sort(), profileId);
    assert.ok(Object.values(profile).every((status) => COVERAGE_STATUSES.includes(status)));
  }

  const sourceProperties = sourceSchema.$defs.source.properties;
  const sourceRequired = sourceSchema.$defs.source.required;
  const sourceIds = new Set();
  for (const source of sourceRegistry.sources) {
    assertObjectShape(source, sourceRequired, Object.keys(sourceProperties), `source ${source.id}`);
    assert.match(source.id, /^[a-z0-9][a-z0-9._-]+$/);
    assert.equal(sourceIds.has(source.id), false);
    sourceIds.add(source.id);
    assert.ok(sourceProperties.authorityTier.enum.includes(source.authorityTier));
    assert.ok(source.themes.every((theme) => sourceProperties.themes.items.enum.includes(theme)));
    assert.doesNotThrow(() => new URL(source.homepage));
    assertObjectShape(
      source.retrieval,
      sourceProperties.retrieval.required,
      Object.keys(sourceProperties.retrieval.properties),
      `${source.id}.retrieval`,
    );
    assert.ok(sourceProperties.retrieval.properties.method.enum.includes(source.retrieval.method));
    assertObjectShape(
      source.licence,
      sourceProperties.licence.required,
      Object.keys(sourceProperties.licence.properties),
      `${source.id}.licence`,
    );
    assert.equal(source.authentication.secretBrowserSafe, false);
    assert.equal(source.failureBehaviour.isolateSource, true);
    assert.ok(sourceProperties.rightsCost.enum.includes(source.rightsCost));
    assert.ok(sourceProperties.redistribution.enum.includes(source.redistribution));
    if (source.publicationDisposition === "approved") {
      assert.equal(source.rightsCost, "no_fee", source.id);
    } else if (source.id === "protected-planet-blocked") {
      assert.equal(source.rightsCost, "paid");
    } else {
      assert.equal(source.rightsCost, "unknown", source.id);
    }
  }

  const jurisdictionProperties = jurisdictionSchema.$defs.jurisdiction.properties;
  const jurisdictionRequired = jurisdictionSchema.$defs.jurisdiction.required;
  const jurisdictionIds = new Set(jurisdictionRegistry.jurisdictions.map((item) => item.id));
  assert.equal(jurisdictionIds.size, jurisdictionRegistry.jurisdictions.length);
  for (const jurisdiction of jurisdictionRegistry.jurisdictions) {
    assertObjectShape(
      jurisdiction,
      jurisdictionRequired,
      Object.keys(jurisdictionProperties),
      `jurisdiction ${jurisdiction.id}`,
    );
    assert.ok(jurisdictionProperties.kind.enum.includes(jurisdiction.kind));
    assert.ok(COVERAGE_STATUSES.includes(jurisdiction.overallStatus));
    assert.ok(Object.hasOwn(jurisdictionRegistry.coverageProfiles, jurisdiction.coverageProfile));
    assert.ok(Object.hasOwn(jurisdictionRegistry.sourceProfiles, jurisdiction.sourceProfile));
    assert.ok(jurisdiction.parentId === null || jurisdictionIds.has(jurisdiction.parentId));
    if (!jurisdiction.inScope) {
      assert.equal(jurisdiction.overallStatus, "Excluded, with reason");
      assert.equal(jurisdiction.coverageProfile, "excluded");
      assert.ok(jurisdiction.exclusionReason);
    }
    for (const url of jurisdiction.discoveryUrls || []) assert.doesNotThrow(() => new URL(url));
  }
  for (const [profileId, profileSourceIds] of Object.entries(jurisdictionRegistry.sourceProfiles)) {
    for (const sourceId of profileSourceIds) {
      assert.ok(sourceIds.has(sourceId), `${profileId} references unknown source ${sourceId}`);
    }
  }
  for (const source of sourceRegistry.sources) {
    for (const jurisdictionId of source.jurisdictionIds) {
      assert.ok(jurisdictionIds.has(jurisdictionId), `${source.id}: ${jurisdictionId}`);
    }
  }

  assert.deepEqual(idsByKind(jurisdictionRegistry, "eu_member_state"), [
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR",
    "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
  ]);
  assert.deepEqual(idsByKind(jurisdictionRegistry, "uk_nation"), [
    "GB-ENG", "GB-NIR", "GB-SCT", "GB-WLS",
  ]);
  assert.deepEqual(idsByKind(jurisdictionRegistry, "us_state"), [
    "US-AK", "US-AL", "US-AR", "US-AZ", "US-CA", "US-CO", "US-CT", "US-DE", "US-FL",
    "US-GA", "US-HI", "US-IA", "US-ID", "US-IL", "US-IN", "US-KS", "US-KY", "US-LA",
    "US-MA", "US-MD", "US-ME", "US-MI", "US-MN", "US-MO", "US-MS", "US-MT", "US-NC",
    "US-ND", "US-NE", "US-NH", "US-NJ", "US-NM", "US-NV", "US-NY", "US-OH", "US-OK",
    "US-OR", "US-PA", "US-RI", "US-SC", "US-SD", "US-TN", "US-TX", "US-UT", "US-VA",
    "US-VT", "US-WA", "US-WI", "US-WV", "US-WY",
  ]);
  assert.deepEqual(idsByKind(jurisdictionRegistry, "us_federal_district"), ["US-DC"]);
  assert.deepEqual(idsByKind(jurisdictionRegistry, "canada_province"), [
    "CA-AB", "CA-BC", "CA-MB", "CA-NB", "CA-NL",
    "CA-NS", "CA-ON", "CA-PE", "CA-QC", "CA-SK",
  ]);
  assert.deepEqual(idsByKind(jurisdictionRegistry, "canada_territory"), [
    "CA-NT", "CA-NU", "CA-YT",
  ]);
  assert.deepEqual(
    idsByKind(jurisdictionRegistry, "japan_prefecture"),
    Array.from({ length: 47 }, (_, index) => `JP-${String(index + 1).padStart(2, "0")}`),
  );
  assert.equal(idsByKind(jurisdictionRegistry, "swiss_canton").length, 26);
  assert.deepEqual(idsByKind(jurisdictionRegistry, "norway_special_package"), [
    "SJ-JAN-MAYEN", "SJ-SVALBARD",
  ]);
  assert.deepEqual(idsByKind(jurisdictionRegistry, "eu_outermost_region"), [
    "ES-CN", "FR-GF", "FR-GP", "FR-MF", "FR-MQ", "FR-RE", "FR-YT", "PT-20", "PT-30",
  ]);
  for (const futureKind of [
    "indigenous_authority",
    "protected_area_authority",
    "municipality",
    "other_subnational",
    "cross_border_region",
  ]) {
    assert.ok(jurisdictionProperties.kind.enum.includes(futureKind));
  }
});

test("publication governance enforces rights cost and per-file media clearance", async () => {
  const registry = await readJson("data/sources/registry.v1.json");
  const sources = validateSourceRegistry(registry);
  assert.equal(sources.size, registry.sources.length);

  const paidApproved = structuredClone(registry);
  const approvedSource = paidApproved.sources.find((source) =>
    source.publicationDisposition === "approved");
  approvedSource.rightsCost = "paid";
  assert.throws(
    () => validateSourceRegistry(paidApproved),
    /no-fee commercial redistribution rights/,
  );

  const lead = fixturePlace("place:lead-governance", "Lead governance", "publish", [8, 46], {
    media: [{ sourceId: "wikimedia-commons", url: "https://example.test/unknown.jpg" }],
  });
  const governedLead = applyPublicationGovernance([lead], sources);
  assert.equal(governedLead.report.removedMediaItems, 1);
  assert.equal(governedLead.records[0].media, undefined);
  assert.ok(governedLead.records[0].quality.flags.includes("discovery_lead"));
  assert.ok(governedLead.records[0].quality.flags.includes("unverified_migration_preview"));

  const verifiedLead = structuredClone(lead);
  verifiedLead.sourceAssertions[0].verificationStatus = "verified";
  verifiedLead.quality.verificationStatus = "verified";
  assert.ok(validateRecordGovernance(verifiedLead, sources).some((error) =>
    error.includes("only unverified lead assertions")));

  const paidReference = structuredClone(lead);
  paidReference.sourceAssertions[0].sourceId = "protected-planet-blocked";
  assert.ok(validateRecordGovernance(paidReference, sources).some((error) =>
    error.includes("paid-rights source protected-planet-blocked")));

  const mediaSources = new Map(sources);
  mediaSources.set("fixture-cleared-media", {
    ...sources.get("osm-global"),
    id: "fixture-cleared-media",
    publicationDisposition: "approved",
    rightsCost: "no_fee",
    approvedUses: ["media"],
  });
  const clearedMedia = {
    sourceId: "fixture-cleared-media",
    url: "https://images.example.test/place.jpg",
    sourcePageUrl: "https://images.example.test/place",
    creator: "Example Creator",
    licenceId: "CC-BY-4.0",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    licenceVersion: "4.0",
    attribution: "Example Creator, CC BY 4.0",
    modifications: "None",
    reviewStatus: "approved",
    reviewedAt: "2026-07-26",
    display: true,
    commercialUse: true,
    redistribution: true,
    modificationsAllowed: true,
  };
  const mediaRecord = fixturePlace("place:cleared-media", "Cleared media", "publish", [8, 46], {
    media: [clearedMedia, { ...clearedMedia, reviewedAt: "not-a-date" }],
  });
  const governedMedia = applyPublicationGovernance([mediaRecord], mediaSources);
  assert.equal(governedMedia.report.removedMediaItems, 1);
  assert.deepEqual(governedMedia.records[0].media, [clearedMedia]);

  for (const permission of [
    "display", "commercialUse", "redistribution", "modificationsAllowed",
  ]) {
    const rejected = fixturePlace(`place:media-${permission}`, permission, "publish", [8, 46], {
      media: [{ ...clearedMedia, [permission]: false }],
    });
    const result = applyPublicationGovernance([rejected], mediaSources);
    assert.equal(result.report.removedMediaItems, 1, permission);
    assert.equal(result.records[0].media, undefined, permission);
  }
});

test("entity, source, jurisdiction, classification, and relationship references are closed", async () => {
  const [{ entities }, sourceRegistry, jurisdictionRegistry, taxonomy] = await Promise.all([
    loadGeneratedEntities(),
    readJson("data/sources/registry.v1.json"),
    readJson("data/jurisdictions/registry.v1.json"),
    readJson("data/taxonomy/nature-travel.v1.json"),
  ]);
  const entityIds = new Set(entities.map((entity) => entity.id));
  const sourceIds = new Set(sourceRegistry.sources.map((source) => source.id));
  const jurisdictionIds = new Set([
    "ALPS",
    ...jurisdictionRegistry.jurisdictions.map((item) => item.id),
  ]);
  const classificationIds = new Set([
    ...taxonomy.classificationGroups.flatMap((group) => group.normalizedKeys),
    ...taxonomy.classificationAliases.map((alias) => alias.alias),
  ]);

  for (const entity of entities) {
    const assertionIds = new Set(entity.sourceAssertions.map((assertion) => assertion.id).filter(Boolean));
    for (const assertion of entity.sourceAssertions) assert.ok(sourceIds.has(assertion.sourceId));
    for (const jurisdictionId of entity.jurisdictionIds) assert.ok(jurisdictionIds.has(jurisdictionId));
    for (const classification of entity.classifications || []) {
      assert.ok(classificationIds.has(classification.normalized));
      if (classification.sourceAssertionId) {
        assert.ok(assertionIds.has(classification.sourceAssertionId));
      }
    }
    for (const field of REFERENCE_ARRAY_FIELDS) {
      for (const referenceId of entity[field] || []) {
        assert.ok(entityIds.has(referenceId), `${entity.id}.${field}: ${referenceId}`);
      }
    }
    if (entity.parentRouteId) assert.ok(entityIds.has(entity.parentRouteId));
    if (entity.sensitivity.authoritySourceId) {
      assert.ok(sourceIds.has(entity.sensitivity.authoritySourceId));
    }
    if (entity.authoritySourceId) assert.ok(sourceIds.has(entity.authoritySourceId));
  }
});

test("legacy inventory status remains Unknown and price-cache migration is count-preserving", async () => {
  const [jurisdictions, cache, ingestionReport, { entities }] = await Promise.all([
    readJson("data/jurisdictions/registry.v1.json"),
    readJson("assets/data/poi-prices.json"),
    readJson("assets/data/nature/ingestion-report.v1.json"),
    loadGeneratedEntities(),
  ]);
  const legacyJurisdictions = jurisdictions.jurisdictions
    .filter((jurisdiction) => jurisdiction.legacyInventoryPresent);
  assert.ok(legacyJurisdictions.length > 0);
  assert.ok(legacyJurisdictions.every((jurisdiction) =>
    jurisdiction.legacyInventoryStatus === "Unknown"
      && jurisdiction.overallStatus === "Unknown"));

  const cacheKeys = Object.keys(cache.entries).sort();
  const prices = entities.filter((entity) => entity.entityType === "Price");
  assert.equal(cacheKeys.length, 313);
  assert.equal(prices.length, cacheKeys.length);
  assert.deepEqual(prices.map((price) => price.legacy.cacheKey).sort(), cacheKeys);
  assert.ok(prices.every((price) =>
    price.quality.verificationStatus === "unverified"
      && price.sourceAssertions.every((assertion) =>
        assertion.verificationStatus === "unverified")));
  const inventory = ingestionReport.inventories.find((item) =>
    item.source === "assets/data/poi-prices.json");
  assert.equal(inventory.records, cacheKeys.length);
  assert.equal(inventory.matchedRecords, cacheKeys.length);
  assert.equal(inventory.unmatchedRecords, 0);
  assert.deepEqual(inventory.unmatchedCacheKeys, []);
});

test("legacy hidden-gem tags remain explicitly unverified quieter leads", async () => {
  const { records } = await ingestLegacyRepository(REPO_ROOT);
  const quieterLeads = records.filter((record) => record.discovery?.lane === "quieter_lead");
  assert.equal(quieterLeads.length, 327);
  assert.ok(quieterLeads.every((record) =>
    !Object.hasOwn(record.discovery, "evidenceQuality")
      && !Object.hasOwn(record.discovery, "access")
      && !Object.hasOwn(record.discovery, "legacyScore")
      && record.discovery.visitorProminence === 0));
  assert.ok(quieterLeads.every((record) =>
    discoveryAssessment(record, { hiddenOnly: true }).lane === "quieter_lead"
      && discoveryAssessment(record, { hiddenOnly: true }).eligible === false));

  const ordinary = rankDiscovery(quieterLeads.slice(0, 3));
  assert.equal(ordinary.length, 3);
  assert.ok(ordinary.every((assessment) =>
    assessment.lane === "quieter_lead"
      && assessment.uncertainties.some((reason) => reason.includes("not a quality claim"))));
});

test("sensitive delivery is fail-closed, coarsened, reference-safe, and count-only", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "itinera-sensitive-build-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  const exactGeometry = { type: "Point", coordinates: [12.345678, 46.123456] };
  const publicGeometry = { type: "Point", coordinates: [12.3, 46.1] };
  const published = fixturePlace("place:public-parent", "Public Parent", "publish", [8, 46], {
    accessPointIds: [
      "place:excluded",
      "access:exact-child",
      "price:exact-child",
      "place:excluded-dependent",
    ],
  });
  const redacted = fixturePlace("place:redacted", "Never Report Redacted", "redact", [9.876543, 46]);
  const excluded = fixturePlace("place:excluded", "Never Report Excluded", "exclude", [10.876543, 46]);
  const coarsened = fixturePlace(
    "place:coarsened",
    "Public Coarsened Name",
    "coarsen",
    exactGeometry.coordinates,
    {
      legacy: { preciseCoordinates: exactGeometry.coordinates },
      sensitivity: {
        action: "coarsen",
        reason: "Sensitive fixture.",
        publicGeometry,
      },
    },
  );
  coarsened.sourceAssertions[0].fieldPath = "/geometry";
  coarsened.sourceAssertions[0].value = exactGeometry;
  const missingPublic = fixturePlace(
    "place:coarsen-missing",
    "Never Report Missing",
    "coarsen",
    [13.876543, 46],
  );
  const invalidPublic = fixturePlace(
    "place:coarsen-invalid",
    "Never Report Invalid",
    "coarsen",
    [14.876543, 46],
    {
      sensitivity: {
        action: "coarsen",
        reason: "Invalid public geometry fixture.",
        publicGeometry: { type: "Point", coordinates: [181, 91] },
      },
    },
  );
  const samePublic = fixturePlace(
    "place:coarsen-same",
    "Never Report Same",
    "coarsen",
    [15.876543, 46],
    {
      sensitivity: {
        action: "coarsen",
        reason: "Unchanged geometry fixture.",
        publicGeometry: { type: "Point", coordinates: [15.876543, 46] },
      },
    },
  );
  const exactAccessChild = fixturePlace(
    "access:exact-child",
    "Never Report Exact Access Child",
    "publish",
    [12.345679, 46.123457],
    {
      entityType: "AccessPoint",
      accessModes: ["car", "foot"],
      legalAccess: "unknown",
      linkedEntityIds: [coarsened.id],
    },
  );
  const exactPriceChild = fixturePlace(
    "price:exact-child",
    "Never Report Exact Price Child",
    "publish",
    [12.34568, 46.123458],
    {
      entityType: "Price",
      amount: 10,
      currency: "CHF",
      priceKind: "fixed",
      linkedEntityIds: [coarsened.id],
    },
  );
  const excludedDependent = fixturePlace(
    "place:excluded-dependent",
    "Never Report Excluded Dependent",
    "publish",
    [10.876544, 46],
    { linkedEntityIds: [excluded.id] },
  );
  const records = [
    published,
    redacted,
    excluded,
    coarsened,
    missingPublic,
    invalidPublic,
    samePublic,
    exactAccessChild,
    exactPriceChild,
    excludedDependent,
  ];
  const redirects = Object.fromEntries(records.map((record) => [`legacy-${record.id}`, record.id]));
  const result = await buildNatureData({
    repoRoot: REPO_ROOT,
    outputRoot,
    adapters: [{
      id: "sensitivity-fixture",
      async run() {
        return {
          records,
          redirects,
          inventories: [{ source: "count-only-fixture", records: records.length }],
        };
      },
    }],
  });

  assert.equal(result.processedRecords, 10);
  assert.equal(result.records, 2);
  assert.equal(result.withheldRecords, 8);
  const { manifest, entities, packages } = await loadGeneratedEntities(outputRoot);
  assert.deepEqual(entities.map((entity) => entity.id).sort(), [
    "place:coarsened",
    "place:public-parent",
  ]);
  assert.equal(packages.length, 1);
  const publicParent = entities.find((entity) => entity.id === published.id);
  assert.deepEqual(publicParent.accessPointIds, []);
  const publicCoarsened = entities.find((entity) => entity.id === coarsened.id);
  assert.deepEqual(publicCoarsened.geometry, publicGeometry);
  assert.equal(publicCoarsened.sensitivity.action, "coarsen");
  assert.equal(Object.hasOwn(publicCoarsened.sensitivity, "publicGeometry"), false);
  assert.equal(Object.hasOwn(publicCoarsened, "legacy"), false);
  assert.ok(publicCoarsened.quality.flags.includes("coarsened_for_sensitivity"));
  assert.equal(publicCoarsened.quality.geometryConfidence, 0.2);
  assert.equal(Object.hasOwn(publicCoarsened.sourceAssertions[0], "value"), false);

  const report = await readJsonFrom(outputRoot, "sensitivity-report.v1.json");
  assert.deepEqual(report.counts.actions, {
    coarsen: 4,
    exclude: 1,
    invalid: 0,
    publish: 4,
    redact: 1,
  });
  assert.deepEqual(report.counts, {
    actions: report.counts.actions,
    delivered: 2,
    outcomes: {
      coarsened: 1,
      published: 1,
      withheldCoarsenInvalidPublicGeometry: 1,
      withheldCoarsenMissingPublicGeometry: 1,
      withheldCoarsenUnchangedGeometry: 1,
      withheldExclude: 1,
      withheldInvalidPolicy: 0,
      withheldRedact: 1,
      withheldReferenceClosure: 3,
    },
    processed: 10,
    withheld: 8,
  });
  assert.deepEqual(Object.keys(report).sort(), [
    "artifactType", "counts", "generated", "schemaVersion",
  ]);

  const allOutput = (await outputFiles(outputRoot)).map(([, contents]) => contents).join("\n");
  for (const withheld of records.filter((record) =>
    ![published.id, coarsened.id].includes(record.id))) {
    assert.equal(allOutput.includes(withheld.id), false, withheld.id);
    assert.equal(allOutput.includes(withheld.names[0].value), false, withheld.id);
  }
  for (const preciseToken of ["12.345678", "12.345679", "12.34568", "46.123456"]) {
    assert.equal(allOutput.includes(preciseToken), false, preciseToken);
  }
  assert.ok(Buffer.byteLength(`${canonicalJson(manifest)}\n`) <= manifest.budgets.manifestBytes);
  const redirectDocument = await readJsonFrom(outputRoot, "legacy-id-redirects.v1.json");
  assert.deepEqual(Object.values(redirectDocument.redirects).sort(), [
    "place:coarsened",
    "place:public-parent",
  ]);
});

test("manifest budget is an exact build gate", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "itinera-manifest-budget-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const record = fixturePlace("place:budget", "Budget Fixture", "publish", [8, 46]);
  await assert.rejects(
    buildNatureData({
      repoRoot: REPO_ROOT,
      outputRoot,
      budgets: {
        manifestBytes: 128,
        initialNatureDataBytes: 64_000,
        regionalPackageBytes: 100_000,
      },
      adapters: [{
        id: "budget-fixture",
        async run() {
          return { records: [record], redirects: {}, inventories: [] };
        },
      }],
    }),
    /above the 128-byte manifest budget/,
  );
});

test("multilingual search finds endonyms, romanization, translations, and diacritics", () => {
  const entities = [
    searchFixture("place:ontake", [
      { language: "ja", script: "Jpan", value: "御嶽山", kind: "primary" },
      { language: "ja-Latn", script: "Latn", value: "Ontake-san", kind: "romanized" },
      { language: "en", value: "Mount Ontake", kind: "translated" },
    ]),
    searchFixture("place:snezka", [
      { language: "cs", value: "Sněžka", kind: "primary" },
      { language: "de", value: "Schneekoppe", kind: "alternate" },
    ]),
    searchFixture("place:gaelic", [
      { language: "gd", value: "Sìdh Chailleann", kind: "primary" },
      { language: "en", value: "Schiehallion", kind: "translated" },
    ]),
  ];
  const documents = entities.map(buildSearchDocument);
  for (const [query, expectedId] of [
    ["御嶽山", "place:ontake"],
    ["Ontake san", "place:ontake"],
    ["Mount Ontake", "place:ontake"],
    ["snezka", "place:snezka"],
    ["Schneekoppe", "place:snezka"],
    ["Sidh Chailleann", "place:gaelic"],
    ["Schiehallion", "place:gaelic"],
  ]) {
    const results = searchEntities(entities, query, { documents });
    assert.equal(results[0]?.entity.id, expectedId, query);
  }
});

test("hidden discovery cannot promote obscurity without evidence, access, and sensitivity safeguards", () => {
  const strong = discoveryFixture("place:strong", {
    lane: "quieter_verified",
    distinctiveness: 0.9,
    regionalUniqueness: 0.8,
    evidenceQuality: 0.85,
    visitorProminence: 0.15,
    routeCompatibility: 0.8,
    seasonSuitability: 0.8,
    itineraryVariety: 0.75,
  });
  const eligible = discoveryAssessment(strong, {
    hiddenOnly: true,
    accessModes: ["foot"],
  });
  assert.equal(eligible.eligible, true);
  assert.ok(eligible.reasons.length > 0);

  const obscureOnly = discoveryFixture("place:obscure-only", {
    distinctiveness: 0.2,
    evidenceQuality: 0.25,
    visitorProminence: 0.01,
  });
  const obscureAssessment = discoveryAssessment(obscureOnly, {
    hiddenOnly: true,
    accessModes: ["foot"],
  });
  assert.equal(obscureAssessment.eligible, false);
  assert.ok(obscureAssessment.exclusions.some((reason) => reason.includes("obscurity")));

  const unknownAccess = structuredClone(strong);
  unknownAccess.id = "place:unknown-access";
  unknownAccess.access.legal = "unknown";
  const unknownAssessment = discoveryAssessment(unknownAccess, {
    hiddenOnly: true,
    accessModes: ["foot"],
  });
  assert.equal(unknownAssessment.eligible, false);
  assert.equal(unknownAssessment.lane, "quieter_lead");
  assert.ok(unknownAssessment.score < eligible.score);
  assert.ok(unknownAssessment.uncertainties.some((reason) => reason.includes("not verified")));
  assert.equal(discoveryAssessment(unknownAccess, {
    hiddenOnly: true,
    accessModes: ["foot"],
    requireVerifiedAccess: true,
  }).eligible, false);

  const privatePlace = structuredClone(strong);
  privatePlace.id = "place:private";
  privatePlace.access.legal = "private";
  assert.equal(discoveryAssessment(privatePlace, { hiddenOnly: true }).eligible, false);

  const redacted = structuredClone(strong);
  redacted.id = "place:redacted-discovery";
  redacted.sensitivity = { action: "redact", reason: "Sensitive fixture." };
  assert.equal(discoveryAssessment(redacted, { hiddenOnly: true }).eligible, false);
});

test("delivered route geometry preserves first-class line and establishment invariants", async () => {
  const { entities } = await loadGeneratedEntities();
  const routes = entities.filter((entity) => entity.entityType === "TrailRoute");
  assert.ok(routes.length >= 30);
  for (const route of routes) {
    assert.ok(["LineString", "MultiLineString"].includes(route.geometry.type), route.id);
    assert.ok(flattenPositions(route.geometry).length >= 2, route.id);
    assert.ok(lineDistanceMeters(route.geometry) > 0, route.id);
    assert.equal(typeof route.navigationSuitability, "boolean");
    if (route.routeNature === "established") {
      assert.equal(route.geometryCompleteness, "complete", route.id);
    }
    if (route.routeNature === "scenic_drive") {
      assert.ok(route.activities.includes("scenic_driving"), route.id);
    }
    assert.deepEqual(validateCanonicalEntity(route), [], route.id);
  }
});

test("package and manifest bytes meet authored budgets and shard metadata is complete", async () => {
  const { manifest, packages } = await loadGeneratedEntities();
  const manifestBytes = (await stat(path.join(GENERATED_ROOT, "manifest.v1.json"))).size;
  const spatialIndexBytes = (await stat(
    path.join(REPO_ROOT, ...manifest.spatialIndex.url.split("/")),
  )).size;
  assert.ok(manifestBytes <= manifest.budgets.manifestBytes);
  assert.equal(spatialIndexBytes, manifest.spatialIndex.bytes);
  assert.ok(spatialIndexBytes <= manifest.budgets.spatialIndexBytes);
  assert.ok(
    manifestBytes + spatialIndexBytes + manifest.budgets.viewportRequestBytes
      <= manifest.budgets.initialNatureDataBytes,
    "manifest + spatial index + maximum initial viewport package bytes must fit the initial budget",
  );
  const regionGroups = Map.groupBy(manifest.packages, (entry) => entry.regionId);
  for (const [regionId, entries] of regionGroups) {
    const sorted = [...entries].sort((left, right) => left.shardIndex - right.shardIndex);
    assert.deepEqual(
      sorted.map((entry) => entry.shardIndex),
      Array.from({ length: sorted.length }, (_, index) => index),
      regionId,
    );
    assert.ok(sorted.every((entry) =>
      entry.shardCount === sorted.length
        && entry.bytes <= manifest.budgets.regionalPackageBytes));
  }
  assert.ok(packages.every(({ bytes }) => bytes <= manifest.budgets.regionalPackageBytes));
});

test("benchmark report separates deterministic gates from observational timing and memory", async () => {
  const report = await readJson("data/benchmarks/nature-pipeline.v1.json");
  assert.equal(report.schemaVersion, "1.0.0");
  assert.equal(report.artifactType, "nature-pipeline-benchmark");
  assert.equal(report.corpus.currentEntities, 4_019);
  assert.equal(report.corpus.syntheticActiveRegionEntities, 5_000);
  assert.equal(report.reproducibility.syntheticFixture.entityCount, 5_000);
  assert.ok(report.environment.runtime.node);
  assert.ok(report.environment.hardware.cpuModel);
  assert.ok(report.deliverySizes.manifest.rawBytes > 0);
  assert.ok(report.deliverySizes.manifest.gzipBytes > 0);
  assert.equal(
    report.deliverySizes.initialNatureData.rawBytesUpperBound,
    report.deliverySizes.manifest.rawBytes
      + report.deliverySizes.spatialIndex.rawBytes
      + report.deliverySizes.initialNatureData.viewportCellRawBytesLimit,
  );
  assert.ok(
    report.deliverySizes.initialNatureData.rawBytesUpperBound
      <= report.deliverySizes.initialNatureData.budgetBytes,
  );
  assert.match(report.deliverySizes.initialNatureData.accounting, /upper bound/i);
  assert.equal(
    report.deliverySizes.regionalPackageTotals.rawBytes,
    report.deliverySizes.regionalPackages.reduce((total, item) => total + item.rawBytes, 0),
  );
  assert.equal(
    report.deliverySizes.regionalPackageTotals.gzipBytes,
    report.deliverySizes.regionalPackages.reduce((total, item) => total + item.gzipBytes, 0),
  );
  assert.ok(report.budgetEvaluation.authoredDeterministic.every((check) =>
    check.enforced === true && check.passed === true));
  assert.ok(report.budgetEvaluation.observational.every((check) =>
    check.observational === true && check.enforced === false));
  for (const result of [
    report.indexedSearch.current,
    report.indexedSearch.syntheticActiveRegion,
  ]) {
    assert.ok(result.p50Milliseconds <= result.p95Milliseconds);
    assert.ok(result.p95Milliseconds <= result.maximumMilliseconds);
  }
  assert.equal(report.processMemory.observational, true);
  assert.equal(report.processMemory.enforced, false);
  assert.ok(report.limitations.length >= 5);
});

test("two full rebuilds are byte-for-byte deterministic", async (t) => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "itinera-governance-build-a-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "itinera-governance-build-b-"));
  t.after(async () => {
    await Promise.all([
      rm(firstRoot, { recursive: true, force: true }),
      rm(secondRoot, { recursive: true, force: true }),
    ]);
  });

  const first = await buildNatureData({ repoRoot: REPO_ROOT, outputRoot: firstRoot });
  const second = await buildNatureData({ repoRoot: REPO_ROOT, outputRoot: secondRoot });
  assert.equal(first.buildId, second.buildId);
  assert.equal(first.records, second.records);
  assert.deepEqual(await outputFiles(firstRoot), await outputFiles(secondRoot));
});

function fixturePlace(id, name, action, coordinates, extra = {}) {
  const sensitivity = extra.sensitivity || {
    action,
    reason: `${action} fixture policy.`,
  };
  return {
    schemaVersion: "1.0.0",
    id,
    entityType: "Place",
    jurisdictionIds: ["CH"],
    names: [{ language: "en", value: name, kind: "primary" }],
    geometry: { type: "Point", coordinates },
    sourceAssertions: [{
      id: `${id}:source`,
      sourceId: "manual-seed-routes",
      sourceRecordId: id,
      fieldPath: "/",
      evidenceKind: "maintainer_curated",
      verificationStatus: "unverified",
      confidence: 0.4,
      observedAt: null,
      validFrom: null,
      validUntil: null,
      retrievedAt: null,
      notes: "Synthetic governance fixture.",
    }],
    quality: {
      confidence: 0.4,
      verificationStatus: "unverified",
      assessedAt: "2026-07-26",
      geometryConfidence: 0.8,
      accessConfidence: 0.2,
      freshness: "unknown",
      flags: ["test_fixture"],
    },
    sensitivity,
    deliveryRegions: ["sensitivity-fixture"],
    ...Object.fromEntries(
      Object.entries(extra).filter(([key]) => key !== "sensitivity"),
    ),
  };
}

function searchFixture(id, names) {
  return {
    id,
    names,
    classifications: [{ normalized: "mountain", original: "mountain", system: "test" }],
    jurisdictionIds: ["JP"],
    geometry: { type: "Point", coordinates: [138, 36] },
  };
}

function discoveryFixture(id, discovery) {
  return {
    id,
    names: [{ language: "en", value: id, kind: "primary" }],
    geometry: { type: "Point", coordinates: [8, 46] },
    quality: {
      confidence: discovery.evidenceQuality ?? 0.8,
      verificationStatus: "verified",
      flags: [],
    },
    sensitivity: { action: "publish" },
    access: { legal: "legal", modes: ["foot"] },
    discovery,
  };
}

function idsByKind(registry, kind) {
  return registry.jurisdictions
    .filter((jurisdiction) => jurisdiction.kind === kind)
    .map((jurisdiction) => jurisdiction.id)
    .sort();
}

function assertRegistryTopLevel(registry, schema) {
  assertObjectShape(
    registry,
    schema.required,
    Object.keys(schema.properties),
    schema.title,
  );
  assert.equal(registry.schemaVersion, schema.properties.schemaVersion.const);
}

function assertObjectShape(value, required, allowed, label) {
  for (const field of required) {
    assert.ok(Object.hasOwn(value, field), `${label} lacks ${field}`);
  }
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(value)) {
    assert.ok(allowedSet.has(field), `${label} has unknown field ${field}`);
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(REPO_ROOT, relativePath), "utf8"));
}

async function readJsonFrom(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function loadGeneratedEntities(root = GENERATED_ROOT) {
  const manifest = await readJsonFrom(root, "manifest.v1.json");
  const packages = [];
  const entities = [];
  for (const entry of manifest.packages) {
    const filename = path.basename(entry.url);
    const packagePath = path.join(root, "packages", entry.regionId, filename);
    const raw = await readFile(packagePath, "utf8");
    const document = JSON.parse(raw);
    const bytes = Buffer.byteLength(raw);
    packages.push({ entry, document, raw, bytes });
    entities.push(...document.entities);
  }
  return { manifest, packages, entities };
}

async function outputFiles(root) {
  const output = [];
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else output.push([relative, await readFile(absolute, "utf8")]);
    }
  }
  await visit(root);
  return output;
}
