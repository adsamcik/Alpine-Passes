import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractAssignedArray } from "../../leisure/lib/extract.mjs";
import {
  SCHEMA_VERSION,
  haversineMeters,
  normalizeSearchText,
  stableId,
} from "../../../assets/js/nature/domain.mjs";

const POI_INPUTS = Object.freeze([
  ["assets/js/swiss-pois.js", "SWISS_POIS", "CH"],
  ["assets/js/french-pois.js", "FRENCH_POIS", "FR"],
  ["assets/js/italy-pois.js", "ITALY_POIS", "IT"],
  ["assets/js/austrian-pois.js", "AUSTRIAN_POIS", "AT"],
  ["assets/js/japan-pois.js", "JAPAN_POIS", "JP"],
  ["assets/js/uk-pois.js", "UK_POIS", "GB"],
  ["assets/js/irish-pois.js", "IRISH_POIS", "IE"],
]);

const PRICE_CACHE_PATH = "assets/data/poi-prices.json";

const PASS_INPUTS = Object.freeze([
  ["assets/js/passes-data.js", "ALPS_RAW", "ALPS"],
  ["assets/js/japan-passes.js", "JAPAN_PASSES", "JP"],
  ["assets/js/uk-ireland-passes.js", "UK_IRELAND_PASSES", "GB-IE"],
]);

const DRIVE_INPUTS = Object.freeze([
  ["assets/js/japan-scenic-drives.js", "JAPAN_SCENIC_DRIVES", "JP"],
  ["assets/js/uk-ireland-scenic-drives.js", "UK_IRELAND_SCENIC_DRIVES", "GB-IE"],
]);

const NATURE_CATEGORIES = new Set([
  "mountain-summit",
  "alpine-lake",
  "waterfall-gorge",
  "glacier",
  "geology-cave",
  "volcano",
  "viewpoint-panorama",
]);

const JP_PREFECTURES = new Map([
  ["hokkaido", "JP-01"], ["aomori", "JP-02"], ["iwate", "JP-03"], ["miyagi", "JP-04"],
  ["akita", "JP-05"], ["yamagata", "JP-06"], ["fukushima", "JP-07"], ["ibaraki", "JP-08"],
  ["tochigi", "JP-09"], ["gunma", "JP-10"], ["saitama", "JP-11"], ["chiba", "JP-12"],
  ["tokyo", "JP-13"], ["kanagawa", "JP-14"], ["niigata", "JP-15"], ["toyama", "JP-16"],
  ["ishikawa", "JP-17"], ["fukui", "JP-18"], ["yamanashi", "JP-19"], ["nagano", "JP-20"],
  ["gifu", "JP-21"], ["shizuoka", "JP-22"], ["aichi", "JP-23"], ["mie", "JP-24"],
  ["shiga", "JP-25"], ["kyoto", "JP-26"], ["osaka", "JP-27"], ["hyogo", "JP-28"],
  ["hyōgo", "JP-28"], ["nara", "JP-29"], ["wakayama", "JP-30"], ["tottori", "JP-31"],
  ["shimane", "JP-32"], ["okayama", "JP-33"], ["hiroshima", "JP-34"], ["yamaguchi", "JP-35"],
  ["tokushima", "JP-36"], ["kagawa", "JP-37"], ["ehime", "JP-38"], ["kochi", "JP-39"],
  ["kōchi", "JP-39"], ["fukuoka", "JP-40"], ["saga", "JP-41"], ["nagasaki", "JP-42"],
  ["kumamoto", "JP-43"], ["oita", "JP-44"], ["ōita", "JP-44"], ["miyazaki", "JP-45"],
  ["kagoshima", "JP-46"], ["okinawa", "JP-47"],
]);

export async function ingestLegacyRepository(repoRoot) {
  const priceCache = await readPriceCache(repoRoot);
  const priceCacheEntries = priceCache.entries;
  const matchedPriceCacheKeys = new Set();
  const records = [];
  const redirects = {};
  const inventories = [];
  let passOrdinal = 0;
  let poiOrdinal = 0;
  let driveOrdinal = 0;

  for (const [relativePath, variable, fallbackJurisdiction] of PASS_INPUTS) {
    const items = await readAssignedArray(repoRoot, relativePath, variable);
    inventories.push({ source: relativePath, variable, records: items.length });
    for (const item of items) {
      passOrdinal += 1;
      const normalized = normalizeLegacyPass(item, {
        relativePath,
        fallbackJurisdiction,
        ordinal: passOrdinal,
      });
      records.push(...normalized.records);
      redirects[`p${passOrdinal}`] = normalized.entity.id;
    }
  }

  for (const [relativePath, variable, fallbackJurisdiction] of POI_INPUTS) {
    const items = await readAssignedArray(repoRoot, relativePath, variable);
    inventories.push({ source: relativePath, variable, records: items.length });
    for (const item of items) {
      poiOrdinal += 1;
      const cacheKey = typeof item.n === "string"
        && Object.prototype.hasOwnProperty.call(priceCacheEntries, item.n)
        ? item.n
        : null;
      const cacheMatch = cacheKey ? {
        key: cacheKey,
        record: priceCacheEntries[cacheKey],
        defaultCurrency: priceCache.default_currency,
        lastRefreshedAt: priceCache.last_refreshed_at,
      } : null;
      const normalized = normalizeLegacyPoi(item, {
        relativePath,
        fallbackJurisdiction,
        ordinal: poiOrdinal,
      }, cacheMatch);
      if (cacheKey) matchedPriceCacheKeys.add(cacheKey);
      records.push(...normalized.records);
      redirects[`poi${poiOrdinal}`] = normalized.entity.id;
    }
  }

  const unmatchedCacheKeys = Object.keys(priceCacheEntries)
    .filter((key) => !matchedPriceCacheKeys.has(key))
    .sort((left, right) => left.localeCompare(right));
  inventories.push({
    source: PRICE_CACHE_PATH,
    schemaVersion: priceCache.schema_version,
    lastRefreshedAt: priceCache.last_refreshed_at ?? null,
    records: Object.keys(priceCacheEntries).length,
    matchedRecords: matchedPriceCacheKeys.size,
    unmatchedRecords: unmatchedCacheKeys.length,
    unmatchedCacheKeys,
    unmatchedCacheEntries: Object.fromEntries(
      unmatchedCacheKeys.map((key) => [key, cloneJson(priceCacheEntries[key])]),
    ),
  });

  for (const [relativePath, variable, fallbackJurisdiction] of DRIVE_INPUTS) {
    const items = await readAssignedArray(repoRoot, relativePath, variable);
    inventories.push({ source: relativePath, variable, records: items.length });
    for (const item of items) {
      driveOrdinal += 1;
      const entity = normalizeLegacyDrive(item, {
        relativePath,
        fallbackJurisdiction,
        ordinal: driveOrdinal,
      });
      records.push(entity);
      redirects[`scenic-drive-${driveOrdinal}`] = entity.id;
    }
  }

  return {
    adapterId: "legacy-repository",
    records,
    redirects,
    inventories,
    unmatchedCacheKeys,
  };
}

async function readPriceCache(repoRoot) {
  const document = JSON.parse(await readFile(path.join(repoRoot, PRICE_CACHE_PATH), "utf8"));
  if (!document || typeof document !== "object" || Array.isArray(document)
      || !document.entries || typeof document.entries !== "object"
      || Array.isArray(document.entries)) {
    throw new TypeError(`${PRICE_CACHE_PATH} must contain an entries object`);
  }
  return document;
}

async function readAssignedArray(repoRoot, relativePath, variable) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  return extractAssignedArray(source, variable).value;
}

function normalizeLegacyPass(raw, context) {
  const jurisdictionIds = legacyJurisdictions(raw, context.fallbackJurisdiction);
  const name = stringOr(raw.n, `Legacy pass ${context.ordinal}`);
  const id = stableId("legacy-pass", `${context.relativePath}:${context.ordinal}`, name);
  const sourceRecordId = `${path.basename(context.relativePath)}#${context.ordinal}`;
  const entity = {
    ...commonEnvelope({
      id,
      entityType: "NaturalFeature",
      name,
      language: raw.wl,
      wikiTitle: raw.wt,
      jurisdictionIds,
      geometry: pointGeometry(raw.lo, raw.la),
      sourceId: "legacy-alps-osm",
      sourceRecordId,
      sourcePath: context.relativePath,
      confidence: legacyConfidence(raw.cf),
      flags: [
        "legacy_inventory",
        "legacy_provenance_incomplete",
        "sensitivity_not_assessed",
        "point_representation",
      ],
    }),
    classifications: [{
      system: "itinera-legacy",
      original: "mountain-pass",
      normalized: "mountain_pass",
    }],
    discovery: legacyDiscoveryMetadata(raw),
    summary: stringOrNull(raw.td),
    rationale: stringOrNull(raw.rs),
    elevationMeters: finiteOrNull(raw.e),
    activities: ["scenic_driving"],
    access: {
      legal: "unknown",
      modes: ["car"],
    },
    legacy: {
      ordinalId: `p${context.ordinal}`,
      sourcePath: context.relativePath,
      compactRecord: raw,
    },
    deliveryRegions: regionsForJurisdictions(jurisdictionIds),
  };
  const accessPoints = [];
  for (const [side, pair] of [["A", raw.bA], ["B", raw.bB]]) {
    if (!validLegacyLatLon(pair)) continue;
    const accessId = stableId("legacy-access", `${id}:${side}`);
    accessPoints.push({
      ...commonEnvelope({
        id: accessId,
        entityType: "AccessPoint",
        name: `${name} ${side} gateway`,
        language: raw.wl,
        jurisdictionIds,
        geometry: pointGeometry(pair[1], pair[0]),
        sourceId: "legacy-alps-osm",
        sourceRecordId: `${sourceRecordId}:gateway-${side}`,
        sourcePath: context.relativePath,
        confidence: 0.34,
        flags: [
          "legacy_inventory",
          "legal_access_unknown",
          "stopping_permission_unknown",
        ],
      }),
      accessModes: ["car"],
      legalAccess: "unknown",
      linkedEntityIds: [id],
      parking: {
        stoppingAllowed: null,
        spaces: null,
        opensLocal: null,
        closesLocal: null,
        fee: null,
      },
      deliveryRegions: regionsForJurisdictions(jurisdictionIds),
    });
  }
  entity.accessPointIds = accessPoints.map((point) => point.id);
  return { entity, records: [entity, ...accessPoints] };
}

function normalizeLegacyPoi(raw, context, cacheMatch = null) {
  const jurisdictionIds = legacyJurisdictions(raw, context.fallbackJurisdiction);
  const name = stringOr(raw.n, `Legacy place ${context.ordinal}`);
  const id = stableId("legacy-place", `${context.relativePath}:${context.ordinal}`, name);
  const entityType = raw.cat === "national-park"
    ? "ProtectedArea"
    : NATURE_CATEGORIES.has(raw.cat) ? "NaturalFeature" : "Place";
  const sourceRecordId = `${path.basename(context.relativePath)}#${context.ordinal}`;
  const flags = [
    "legacy_inventory",
    "legacy_provenance_incomplete",
    "sensitivity_not_assessed",
  ];
  if ((raw.themes || []).includes("hike-required")) {
    flags.push("route_geometry_missing", "critical_access_unknown");
  }
  const accessModes = Array.isArray(raw.access)
    ? raw.access.map(normalizeAccessMode).filter(Boolean)
    : [];
  const legalAccess = raw.carStatus === "no-road" ? "restricted" : "unknown";
  const entity = {
    ...commonEnvelope({
      id,
      entityType,
      name,
      language: raw.wl,
      wikiTitle: raw.wt,
      jurisdictionIds,
      geometry: pointGeometry(raw.lo, raw.la),
      sourceId: "legacy-curated-pois",
      sourceRecordId,
      sourcePath: context.relativePath,
      confidence: legacyConfidence(raw.cf, 0.31),
      flags,
    }),
    classifications: [{
      system: "itinera-legacy",
      original: stringOr(raw.cat, "generic"),
      normalized: normalizeCategory(raw.cat),
    }],
    themes: stringArray(raw.themes),
    discovery: legacyDiscoveryMetadata(raw),
    summary: stringOrNull(raw.td),
    rationale: stringOrNull(raw.rs),
    elevationMeters: finiteOrNull(raw.e),
    seasons: stringArray(raw.season),
    typicalVisitMinutes: Number.isFinite(raw.dur) ? Math.round(raw.dur * 60) : null,
    notabilityScore: finiteOrNull(raw.sc),
    activities: accessModes.includes("hiking") || (raw.themes || []).includes("hike-required")
      ? ["hiking"]
      : accessModes.includes("foot") ? ["walking"] : [],
    access: {
      legal: legalAccess,
      modes: [...new Set(accessModes)],
      original: raw.access ?? null,
      carStatus: raw.carStatus ?? null,
    },
    media: raw.bp ? [{
      url: raw.bp,
      licenceStatus: "unknown",
      attributionStatus: "missing",
    }] : [],
    legacy: {
      ordinalId: `poi${context.ordinal}`,
      sourcePath: context.relativePath,
      compactRecord: raw,
    },
    deliveryRegions: regionsForJurisdictions(jurisdictionIds),
  };
  if (entity.summary === null) delete entity.summary;
  if (entity.rationale === null) delete entity.rationale;
  const records = [entity];
  if (cacheMatch) {
    const price = normalizeLegacyPrice(entity, raw, context, cacheMatch);
    entity.priceIds = [price.id];
    entity.sourceAssertions.push(
      priceCacheAssertion(`${entity.id}:price-ids`, "/priceIds", cacheMatch),
    );
    const cachedAccess = cacheAccessMetadata(cacheMatch.record);
    if (Object.keys(cachedAccess).length) {
      entity.cacheAccess = cachedAccess;
      entity.sourceAssertions.push(
        priceCacheAssertion(`${entity.id}:cache-access`, "/cacheAccess", cacheMatch),
      );
    }
    entity.originalSourceIds = appendOriginalSource(
      entity.originalSourceIds,
      "legacy-poi-price-cache",
      cacheSourceRecordId(cacheMatch.key),
    );
    entity.quality.flags = [...new Set([
      ...entity.quality.flags,
      "legacy_price_cache",
      "price_currentness_unverified",
    ])].sort();
    records.push(price);
  }

  const accessPoint = normalizeLegacyPoiParking(entity, raw, context, cacheMatch);
  if (accessPoint) {
    entity.accessPointIds = [accessPoint.id];
    if (cacheMatch?.record?.parking) {
      entity.sourceAssertions.push(
        priceCacheAssertion(`${entity.id}:access-point-ids`, "/accessPointIds", cacheMatch),
      );
    }
    records.push(accessPoint);
  }
  return { entity, records };
}

function normalizeLegacyPrice(entity, raw, context, cacheMatch) {
  const cacheRecord = cacheMatch.record;
  const amount = priceAmount(cacheRecord);
  const priceKind = priceKindFromCache(cacheRecord);
  const explicitCurrency = currencyCode(cacheRecord.currency);
  const currency = priceKind === "free"
    ? null
    : explicitCurrency || (amount !== null ? currencyCode(cacheMatch.defaultCurrency) : null);
  const priceId = stableId("legacy-price", `${entity.id}:${cacheMatch.key}`);
  const sourceRecordId = cacheSourceRecordId(cacheMatch.key);
  const parentSourceRecordId = `${path.basename(context.relativePath)}#${context.ordinal}`;
  const price = {
    ...commonEnvelope({
      id: priceId,
      entityType: "Price",
      name: `${entity.names[0].value} admission price`,
      language: raw.wl,
      wikiTitle: null,
      jurisdictionIds: entity.jurisdictionIds,
      geometry: cloneJson(entity.geometry),
      sourceId: "legacy-poi-price-cache",
      sourceRecordId,
      sourcePath: PRICE_CACHE_PATH,
      confidence: priceCacheConfidence(cacheRecord),
      flags: [
        "legacy_inventory",
        "legacy_price_cache",
        "price_currentness_unverified",
        "tariff_incomplete",
      ],
    }),
    amount,
    currency,
    priceKind,
    linkedEntityIds: [entity.id],
    audience: "adult",
    cacheMetadata: {
      originalKind: cacheRecord.kind ?? null,
      asOf: cacheRecord.as_of ?? null,
      sourceKind: cacheRecord.source_kind ?? null,
      sourceUrl: stringOrNull(cacheRecord.source_url),
      verifiedAt: cacheRecord.verified_at ?? null,
      notes: stringOrNull(cacheRecord.notes),
    },
    legacy: {
      cacheKey: cacheMatch.key,
      cacheRecord: cloneJson(cacheRecord),
    },
    deliveryRegions: [...entity.deliveryRegions],
  };
  price.sourceAssertions = [
    priceCacheAssertion(`${priceId}:source`, "/", cacheMatch),
    priceCacheAssertion(`${priceId}:price-kind`, "/priceKind", cacheMatch),
    priceCacheAssertion(`${priceId}:amount`, "/amount", cacheMatch),
    priceCacheAssertion(`${priceId}:currency`, "/currency", cacheMatch),
    assertion(
      `${priceId}:geometry`,
      "legacy-curated-pois",
      "/geometry",
      parentSourceRecordId,
      entity.quality.geometryConfidence,
      context.relativePath,
    ),
  ];
  price.originalSourceIds = [
    { sourceId: "legacy-poi-price-cache", recordId: sourceRecordId },
    { sourceId: "legacy-curated-pois", recordId: parentSourceRecordId },
  ];
  return price;
}

function normalizeLegacyPoiParking(entity, raw, context, cacheMatch) {
  const rawParking = raw.parking && typeof raw.parking === "object" ? raw.parking : null;
  const cachedParking = cacheMatch?.record?.parking
    && typeof cacheMatch.record.parking === "object"
    ? cacheMatch.record.parking
    : null;
  const rawHasGeometry = validLatLonObject(rawParking);
  const cacheHasGeometry = validLatLonObject(cachedParking);
  if (!rawHasGeometry && !cacheHasGeometry) return null;

  const geometrySource = cacheHasGeometry ? cachedParking : rawParking;
  const sourceRecordId = `${path.basename(context.relativePath)}#${context.ordinal}`;
  const accessId = stableId("legacy-access", `${entity.id}:parking`);
  const parkingName = stringOrNull(cachedParking?.name)
    || stringOrNull(rawParking?.n)
    || `${entity.names[0].value} parking`;
  const accessPoint = {
    ...commonEnvelope({
      id: accessId,
      entityType: "AccessPoint",
      name: parkingName,
      language: raw.wl,
      jurisdictionIds: entity.jurisdictionIds,
      geometry: pointGeometry(geometrySource.lo, geometrySource.la),
      sourceId: cacheHasGeometry ? "legacy-poi-price-cache" : "legacy-curated-pois",
      sourceRecordId: cacheHasGeometry
        ? cacheSourceRecordId(cacheMatch.key)
        : `${sourceRecordId}:parking`,
      sourcePath: cacheHasGeometry ? PRICE_CACHE_PATH : context.relativePath,
      confidence: cacheHasGeometry
        ? Math.min(priceCacheConfidence(cacheMatch.record), 0.32)
        : 0.32,
      flags: [
        "legacy_inventory",
        "stopping_permission_unknown",
        ...(cachedParking ? ["legacy_price_cache", "cache_parking_unverified"] : []),
      ],
    }),
    accessModes: ["car", "foot"],
    legalAccess: "unknown",
    linkedEntityIds: [entity.id],
    parking: {
      name: parkingName,
      stoppingAllowed: null,
      spaces: integerOrNull(cachedParking?.spaces ?? rawParking?.spaces),
      opensLocal: null,
      closesLocal: null,
      fee: null,
      costText: stringOrNull(cachedParking?.cost),
      currency: currencyCode(cachedParking?.currency),
      sourceUrl: stringOrNull(cachedParking?.url)
        || stringOrNull(cacheMatch?.record?.source_url),
      notes: stringOrNull(cachedParking?.notes),
      sourceConfidence: stringOrNull(cachedParking?.confidence),
    },
    legacy: {
      poiParking: rawParking ? cloneJson(rawParking) : null,
      cacheParking: cachedParking ? cloneJson(cachedParking) : null,
    },
    deliveryRegions: [...entity.deliveryRegions],
  };
  const sourceAssertions = [];
  const originalSourceIds = [];
  if (rawParking) {
    sourceAssertions.push(assertion(
      `${accessId}:legacy-parking`,
      "legacy-curated-pois",
      "/parking",
      `${sourceRecordId}:parking`,
      0.32,
      context.relativePath,
    ));
    originalSourceIds.push({
      sourceId: "legacy-curated-pois",
      recordId: `${sourceRecordId}:parking`,
    });
  }
  if (cachedParking) {
    sourceAssertions.push(
      priceCacheAssertion(`${accessId}:cached-parking`, "/parking", cacheMatch),
    );
    if (cacheHasGeometry) {
      sourceAssertions.push(
        priceCacheAssertion(`${accessId}:geometry`, "/geometry", cacheMatch),
      );
    }
    originalSourceIds.push({
      sourceId: "legacy-poi-price-cache",
      recordId: cacheSourceRecordId(cacheMatch.key),
    });
  } else if (rawHasGeometry) {
    sourceAssertions.push(assertion(
      `${accessId}:geometry`,
      "legacy-curated-pois",
      "/geometry",
      `${sourceRecordId}:parking`,
      0.32,
      context.relativePath,
    ));
  }
  accessPoint.sourceAssertions = sourceAssertions;
  accessPoint.originalSourceIds = originalSourceIds;
  return accessPoint;
}

function priceKindFromCache(record) {
  if (record.kind === "free") return "free";
  if (nonnegativeNumberOrNull(record.from_adult) !== null) return "from";
  if (record.kind === "varies") return "range";
  return "unknown";
}

function priceAmount(record) {
  if (record.kind === "free") return 0;
  return nonnegativeNumberOrNull(record.from_adult);
}

function nonnegativeNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function currencyCode(value) {
  const currency = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function cacheAccessMetadata(record) {
  const out = {};
  for (const key of ["url", "car_status", "entrance", "getting_there", "operational"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) out[key] = cloneJson(record[key]);
  }
  return out;
}

function priceCacheAssertion(id, fieldPath, cacheMatch) {
  const record = cacheMatch.record;
  const details = [
    `source_kind=${record.source_kind ?? "unknown"}`,
    record.source_url ? `source_url=${record.source_url}` : null,
    record.verified_at ? `cache_verified_at=${record.verified_at}` : null,
  ].filter(Boolean).join("; ");
  return {
    id,
    sourceId: "legacy-poi-price-cache",
    sourceRecordId: cacheSourceRecordId(cacheMatch.key),
    fieldPath,
    evidenceKind: priceCacheEvidenceKind(record),
    verificationStatus: "unverified",
    confidence: priceCacheConfidence(record),
    observedAt: null,
    validFrom: null,
    validUntil: null,
    retrievedAt: dateTimeOrNull(cacheMatch.lastRefreshedAt),
    notes: `Migrated from ${PRICE_CACHE_PATH}; ${details}; preserved without upgrading verification.`,
  };
}

function priceCacheEvidenceKind(record) {
  if (record.source_kind === "manual") return "maintainer_curated";
  if (record.source_kind === "wikidata") return "third_party_claim";
  return "unknown";
}

function priceCacheConfidence(record) {
  if (record.source_kind === "manual") return 0.31;
  if (record.source_kind === "wikidata") return 0.27;
  return 0.22;
}

function cacheSourceRecordId(key) {
  return `poi-prices.json#${key}`;
}

function appendOriginalSource(items, sourceId, recordId) {
  const next = [...(items || [])];
  if (!next.some((item) => item.sourceId === sourceId && item.recordId === recordId)) {
    next.push({ sourceId, recordId });
  }
  return next;
}

function validLatLonObject(value) {
  return value && typeof value === "object" && validLegacyLatLon([value.la, value.lo]);
}

function integerOrNull(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function dateTimeOrNull(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function legacyDiscoveryMetadata(raw) {
  const themes = stringArray(raw?.themes);
  const lane = themes.includes("hidden-gem")
    ? "quieter_lead"
    : themes.includes("iconic") ? "iconic" : "general";
  const metadata = { lane };
  if (Number.isFinite(raw?.sc)) {
    metadata.distinctiveness = Math.max(0, Math.min(1, raw.sc / 10));
  }
  if (themes.includes("hidden-gem")) metadata.visitorProminence = 0;
  else if (themes.includes("iconic")) metadata.visitorProminence = 1;
  return metadata;
}

function normalizeLegacyDrive(raw, context) {
  const jurisdictionIds = legacyJurisdictions(raw, context.fallbackJurisdiction);
  const name = stringOr(raw.n, `Legacy scenic drive ${context.ordinal}`);
  const id = stableId("legacy-scenic-drive", `${context.relativePath}:${context.ordinal}`, name);
  const coordinates = (raw.waypoints || [])
    .filter((point) => Number.isFinite(point?.la) && Number.isFinite(point?.lo))
    .map((point) => [point.lo, point.la]);
  const journeyShape = coordinates.length >= 2
    && haversineMeters(coordinates[0], coordinates.at(-1)) < 250
    ? "loop"
    : "point_to_point";
  return {
    ...commonEnvelope({
      id,
      entityType: "TrailRoute",
      name,
      language: raw.wl,
      wikiTitle: raw.wt,
      jurisdictionIds,
      geometry: { type: "LineString", coordinates },
      sourceId: "legacy-scenic-drives",
      sourceRecordId: `${path.basename(context.relativePath)}#${context.ordinal}`,
      sourcePath: context.relativePath,
      confidence: 0.34,
      flags: [
        "legacy_inventory",
        "legacy_provenance_incomplete",
        "overview_geometry_only",
      ],
    }),
    routeNature: "scenic_drive",
    geometryCompleteness: "overview_only",
    navigationSuitability: false,
    activities: ["scenic_driving"],
    journeyShape,
    direction: "both",
    classifications: [{
      system: "itinera-legacy",
      original: "scenic-drive",
      normalized: "scenic_drive",
    }],
    themes: stringArray(raw.themes),
    discovery: legacyDiscoveryMetadata(raw),
    seasons: stringArray(raw.season),
    summary: stringOrNull(raw.td),
    rationale: stringOrNull(raw.rs),
    metrics: {
      distanceMeters: Number.isFinite(raw.len_km) ? Math.round(raw.len_km * 1000) : null,
      typicalDurationMinutes: finiteOrNull(raw.drive_min),
    },
    access: {
      legal: "unknown",
      modes: ["car"],
    },
    legacy: {
      ordinalId: `scenic-drive-${context.ordinal}`,
      sourcePath: context.relativePath,
      compactRecord: raw,
    },
    deliveryRegions: regionsForJurisdictions(jurisdictionIds),
  };
}

function commonEnvelope({
  id,
  entityType,
  name,
  language,
  wikiTitle,
  jurisdictionIds,
  geometry,
  sourceId,
  sourceRecordId,
  sourcePath,
  confidence,
  flags,
}) {
  const names = [{
    language: language || "und",
    value: name,
    kind: "primary",
  }];
  if (wikiTitle
      && String(wikiTitle).trim()
      && normalizeSearchText(String(wikiTitle).trim()) !== normalizeSearchText(name)) {
    names.push({
      language: language || "und",
      value: String(wikiTitle).trim(),
      kind: language === "ja" ? "official" : "alternate",
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    entityType,
    jurisdictionIds,
    names,
    geometry,
    sourceAssertions: [
      assertion(`${id}:source`, sourceId, "/", sourceRecordId, confidence, sourcePath),
      assertion(`${id}:geometry`, sourceId, "/geometry", sourceRecordId, confidence, sourcePath),
      assertion(`${id}:names`, sourceId, "/names", sourceRecordId, confidence, sourcePath),
    ],
    quality: {
      confidence,
      verificationStatus: "unverified",
      assessedAt: "2026-07-25",
      geometryConfidence: Math.min(confidence + 0.08, 1),
      accessConfidence: 0.18,
      freshness: "unknown",
      flags: [...new Set([
        ...flags,
        "discovery_lead",
        "unverified_migration_preview",
      ])].sort(),
      notes: "Unverified migration/discovery preview; migrated without upgrading the evidence status of the legacy record.",
    },
    sensitivity: {
      action: "publish",
      reason: "Location was already public in the legacy application; sensitivity remains unassessed.",
    },
    originalSourceIds: [{
      sourceId,
      recordId: sourceRecordId,
    }],
  };
}

function assertion(id, sourceId, fieldPath, sourceRecordId, confidence, sourcePath) {
  return {
    id,
    sourceId,
    sourceRecordId,
    fieldPath,
    evidenceKind: "maintainer_curated",
    verificationStatus: "unverified",
    confidence,
    observedAt: null,
    validFrom: null,
    validUntil: null,
    retrievedAt: null,
    notes: `Migrated from ${sourcePath}; upstream provenance and licence need review.`,
  };
}

function legacyJurisdictions(raw, fallback) {
  const country = stringOrNull(raw.co) || fallback;
  if (country === "GB") return [ukNationFromRegion(raw.region) || "GB"];
  if (country === "IE") return ["IE"];
  if (country === "JP") {
    const prefecture = japanPrefectureFromRegion(raw.region);
    return prefecture ? ["JP", prefecture] : ["JP"];
  }
  if (country === "GB-IE") {
    if (String(raw.region || "").toLowerCase().includes("ireland")
        && !String(raw.region || "").toLowerCase().includes("northern ireland")) return ["IE"];
    return [ukNationFromRegion(raw.region) || "GB"];
  }
  return [country];
}

function ukNationFromRegion(region) {
  const value = String(region || "").toLowerCase();
  if (value.includes("scotland")) return "GB-SCT";
  if (value.includes("wales")) return "GB-WLS";
  if (value.includes("northern ireland")) return "GB-NIR";
  if (value.includes("england")) return "GB-ENG";
  return null;
}

function japanPrefectureFromRegion(region) {
  const normalized = String(region || "").toLowerCase();
  for (const [name, code] of JP_PREFECTURES) {
    if (normalized.includes(name)) return code;
  }
  return null;
}

function regionsForJurisdictions(ids) {
  const out = new Set();
  for (const id of ids) {
    if (id === "JP" || id.startsWith("JP-")) out.add("japan");
    else if (id === "CH") out.add("switzerland");
    else if (id === "NO" || id.startsWith("NO-") || id.startsWith("SJ-")) out.add("norway");
    else if (id === "GB" || id.startsWith("GB-") || id === "IE") out.add("uk-ireland");
    else if (id === "US" || id.startsWith("US-") || id === "CA" || id.startsWith("CA-")) out.add("north-america");
    else out.add("eu-alps");
  }
  return [...out].sort();
}

function pointGeometry(lon, lat) {
  return { type: "Point", coordinates: [Number(lon), Number(lat)] };
}

function validLegacyLatLon(value) {
  return Array.isArray(value)
    && value.length >= 2
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]))
    && Number(value[0]) >= -90
    && Number(value[0]) <= 90
    && Number(value[1]) >= -180
    && Number(value[1]) <= 180;
}

function normalizeAccessMode(value) {
  const mode = String(value).trim().toLowerCase().replace(/_/g, " ");
  if (["walk", "walking", "pedestrian", "foot"].includes(mode)) return "foot";
  if (["hike", "hiking"].includes(mode)) return "hiking";
  if (["cycle", "cycling", "bike", "bicycle"].includes(mode)) return "bicycle";
  if (["ferry", "boat"].includes(mode)) return "ferry";
  if ([
    "cable-car",
    "cable car",
    "gondola",
    "funicular",
    "cogwheel",
    "cog railway",
  ].includes(mode)) return "cable_transport";
  if (["bus", "train", "rail", "tram", "subway", "metro", "plane"].includes(mode)) {
    return "transit";
  }
  if (["car", "transit"].includes(mode)) return mode;
  return null;
}

function normalizeCategory(value) {
  return String(value || "generic").replace(/-/g, "_");
}

function legacyConfidence(value, fallback = 0.36) {
  if (value === "h" || value === "high") return 0.48;
  if (value === "m" || value === "medium") return 0.38;
  if (value === "l" || value === "low") return 0.26;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0.2, Math.min(0.55, numeric)) : fallback;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))].sort() : [];
}

function finiteOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
