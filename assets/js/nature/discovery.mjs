import {
  displayName,
  flattenPositions,
  haversineMeters,
  normalizeSearchText,
} from "./domain.mjs";

const DEFAULT_WEIGHTS = Object.freeze({
  distinctiveness: 0.21,
  regionalUniqueness: 0.14,
  evidenceQuality: 0.18,
  lowerProminence: 0.10,
  routeCompatibility: 0.12,
  seasonSuitability: 0.10,
  accessFit: 0.10,
  itineraryVariety: 0.05,
});

export function buildSearchDocument(entity) {
  const names = (entity.names || []).map((name) => name.value);
  const terms = [
    ...names,
    ...(entity.classifications || []).map((item) => item.normalized || item.original),
    ...(entity.activities || []),
    ...(entity.themes || []),
    ...(entity.jurisdictionIds || []),
    entity.summary,
  ].filter(Boolean);
  const normalized = normalizeSearchText(terms.join(" "));
  return {
    entity,
    title: displayName(entity),
    normalized,
    nameVariants: names.map(normalizeSearchText),
    trigrams: trigrams(normalized),
  };
}

export function searchEntities(entities, query, options = {}) {
  const normalizedQuery = normalizeSearchText(query);
  const queryTrigrams = normalizedQuery ? trigrams(normalizedQuery) : null;
  const queryTokens = normalizedQuery ? normalizedQuery.split(" ") : [];
  const documents = (options.documents || entities.map(buildSearchDocument));
  const origin = options.origin;
  const withinMeters = options.withinMeters;
  const requiredActivities = new Set(options.activities || []);
  const requiredCategories = new Set(options.categories || []);

  return documents
    .map((document) => {
      const entity = document.entity;
      if (requiredActivities.size
          && !(entity.activities || []).some((activity) => requiredActivities.has(activity))) return null;
      if (requiredCategories.size
          && !(entity.classifications || []).some((item) => requiredCategories.has(item.normalized))) return null;
      const distanceM = origin ? entityDistanceFrom(entity, origin) : null;
      if (withinMeters != null && (!Number.isFinite(distanceM) || distanceM > withinMeters)) return null;
      const relevance = normalizedQuery
        ? textRelevance(document, normalizedQuery, queryTokens, queryTrigrams) : 1;
      if (normalizedQuery && relevance < (options.minimumRelevance ?? 0.16)) return null;
      return { entity, relevance, distanceM };
    })
    .filter(Boolean)
    .sort((a, b) => b.relevance - a.relevance
      || finiteSort(a.distanceM) - finiteSort(b.distanceM)
      || displayName(a.entity).localeCompare(displayName(b.entity)));
}

export function rankDiscovery(entities, context = {}) {
  const ranked = entities
    .map((entity) => discoveryAssessment(entity, context))
    .filter((assessment) => assessment.eligible)
    .sort((a, b) => b.score - a.score
      || (b.entity.quality?.confidence || 0) - (a.entity.quality?.confidence || 0)
      || displayName(a.entity).localeCompare(displayName(b.entity)));
  return context.hiddenOnly ? ranked : interleaveDiscoveryAssessments(ranked, context);
}

export function interleaveDiscoveryAssessments(assessments, options = {}) {
  const interval = Number.isSafeInteger(options.quieterInterval) && options.quieterInterval >= 2
    ? options.quieterInterval
    : 4;
  const minimumScore = Number.isFinite(options.minimumQuieterScore)
    ? bounded(options.minimumQuieterScore, 0.55)
    : 0.55;
  const quieter = assessments.filter((assessment) =>
    assessment.lane === "quieter_verified" && assessment.score >= minimumScore);
  if (!quieter.length) return [...assessments];

  const quieterIds = new Set(quieter.map((assessment) => assessment.entity.id));
  const ordinary = assessments.filter((assessment) => !quieterIds.has(assessment.entity.id));
  if (!ordinary.length) return [...assessments];

  const maxInterleaved = Math.min(
    quieter.length,
    Math.max(1, Math.floor(assessments.length / interval)),
  );
  const interleaved = [];
  let quieterIndex = 0;
  for (const assessment of ordinary) {
    interleaved.push(assessment);
    if (interleaved.length % interval === interval - 1
        && quieterIndex < maxInterleaved) {
      interleaved.push(quieter[quieterIndex]);
      quieterIndex += 1;
    }
  }
  return [
    ...interleaved,
    ...quieter.slice(quieterIndex),
  ];
}

export function discoveryAssessment(entity, context = {}) {
  const dimensions = {
    distinctiveness: bounded(entity.discovery?.distinctiveness, 0.5),
    regionalUniqueness: bounded(entity.discovery?.regionalUniqueness, 0.5),
    evidenceQuality: bounded(entity.discovery?.evidenceQuality, entity.quality?.confidence ?? 0),
    lowerProminence: 1 - bounded(entity.discovery?.visitorProminence, 0.5),
    routeCompatibility: routeCompatibility(entity, context),
    seasonSuitability: seasonSuitability(entity, context),
    accessFit: accessFit(entity, context),
    itineraryVariety: bounded(entity.discovery?.itineraryVariety, 0.5),
  };
  const uncertainties = [];
  const exclusions = [];

  if (entity.sensitivity?.action === "exclude" || entity.sensitivity?.action === "redact") {
    exclusions.push("location is intentionally withheld");
  }
  if (entity.sensitivity?.action === "coarsen") {
    uncertainties.push("location is deliberately approximate to protect the site");
  }
  if (entity.access?.legal === "private") exclusions.push("public access is not permitted");
  if (entity.access?.legal === "unknown") uncertainties.push("legal public access is not verified");
  if ((entity.quality?.flags || []).includes("critical_access_unknown")) {
    uncertainties.push("a critical access fact is unknown");
  }
  if ((entity.quality?.flags || []).includes("technical_route")
      && context.experienceLevel !== "technical") {
    exclusions.push("technical experience is required");
  }
  if (dimensions.evidenceQuality < 0.45) {
    uncertainties.push("evidence quality is too low for an unqualified recommendation");
  }
  if (context.requireVerifiedAccess
      && !["legal", "restricted"].includes(entity.access?.legal)) {
    exclusions.push("verified public access is required");
  }
  const lane = discoveryLane(entity, dimensions);
  if (lane === "quieter_lead") {
    uncertainties.push("less-known status is an unverified discovery lead, not a quality claim");
  }
  if (context.hiddenOnly
      && (lane !== "quieter_verified"
        || dimensions.evidenceQuality < 0.6
        || dimensions.distinctiveness < 0.55
        || dimensions.accessFit < 0.45)) {
    exclusions.push("obscurity alone is insufficient; hidden-only discovery requires verified evidence, access and distinctiveness");
  }

  const weights = { ...DEFAULT_WEIGHTS, ...(context.weights || {}) };
  let weightedTotal = 0;
  let weightTotal = 0;
  for (const [key, weight] of Object.entries(weights)) {
    weightedTotal += dimensions[key] * weight;
    weightTotal += weight;
  }
  let score = weightTotal ? weightedTotal / weightTotal : 0;
  if (entity.access?.legal === "unknown") score *= 0.72;
  if ((entity.quality?.flags || []).includes("critical_condition_unknown")) score *= 0.62;

  const reasons = topReasons(dimensions, context);
  return {
    entity,
    lane,
    eligible: exclusions.length === 0,
    score: Math.round(score * 1000) / 1000,
    dimensions,
    reasons,
    uncertainties,
    exclusions,
  };
}

function textRelevance(document, normalizedQuery, queryTokens, queryTrigrams) {
  if (document.nameVariants.some((name) => name === normalizedQuery)) return 1;
  if (document.nameVariants.some((name) => name.startsWith(normalizedQuery))) return 0.94;
  if (document.normalized.includes(normalizedQuery)) return 0.82;
  const tokenCoverage = queryTokens.filter((token) => document.normalized.includes(token)).length
    / queryTokens.length;
  const trigramScore = jaccard(document.trigrams, queryTrigrams);
  return tokenCoverage * 0.62 + trigramScore * 0.38;
}

function trigrams(value) {
  const padded = `  ${value}  `;
  const out = new Set();
  for (let index = 0; index <= padded.length - 3; index += 1) {
    out.add(padded.slice(index, index + 3));
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function routeCompatibility(entity, context) {
  const desired = new Set(context.activities || []);
  if (!desired.size) return bounded(entity.discovery?.routeCompatibility, 0.65);
  const offered = new Set(entity.activities || []);
  const matches = [...desired].filter((activity) => offered.has(activity)).length;
  return matches / desired.size;
}

function seasonSuitability(entity, context) {
  if (!context.season) return bounded(entity.discovery?.seasonSuitability, 0.65);
  const seasons = entity.seasons || [];
  if (!seasons.length) return 0.35;
  return seasons.includes(context.season) ? 1 : 0;
}

function accessFit(entity, context) {
  const desired = new Set(context.accessModes || []);
  const available = new Set(entity.access?.modes || entity.accessModes || []);
  if (!desired.size) {
    if (entity.access?.legal === "legal") return 0.9;
    if (entity.access?.legal === "restricted") return 0.58;
    return 0.3;
  }
  const matches = [...desired].filter((mode) => available.has(mode)).length;
  const modeFit = matches / desired.size;
  if (entity.access?.legal === "private") return 0;
  if (entity.access?.legal === "unknown") return modeFit * 0.45;
  return modeFit;
}

function discoveryLane(entity, dimensions) {
  const explicit = entity.discovery?.lane;
  const themes = new Set(entity.themes || []);
  if (explicit === "quieter_lead") return "quieter_lead";
  if (explicit === "iconic" || themes.has("iconic")) return "iconic";

  const criticalUnknown = (entity.quality?.flags || []).some((flag) =>
    flag === "critical_access_unknown" || flag === "critical_condition_unknown");
  const evidenceQualified = ["verified", "partially_verified"].includes(
    entity.quality?.verificationStatus,
  )
    && dimensions.evidenceQuality >= 0.6
    && dimensions.accessFit >= 0.45
    && entity.sensitivity?.action === "publish"
    && !["private", "unknown"].includes(entity.access?.legal)
    && !criticalUnknown;

  if (explicit === "quieter_verified") {
    return evidenceQualified ? "quieter_verified" : "quieter_lead";
  }
  if (themes.has("hidden-gem")) {
    return evidenceQualified ? "quieter_verified" : "quieter_lead";
  }
  return "general";
}

function topReasons(dimensions, context) {
  const labels = {
    distinctiveness: "distinctive scenery or ecology",
    regionalUniqueness: "adds something unusual for this region",
    evidenceQuality: "supported by comparatively strong evidence",
    lowerProminence: "away from the most prominent tourism corridor",
    routeCompatibility: "fits the requested activity",
    seasonSuitability: "fits the selected season",
    accessFit: "fits the requested access mode",
    itineraryVariety: "adds variety to the itinerary",
  };
  return Object.entries(dimensions)
    .filter(([key, value]) => value >= (key === "lowerProminence" && !context.hiddenOnly ? 0.72 : 0.7))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key]) => labels[key]);
}

function entityDistanceFrom(entity, origin) {
  const position = flattenPositions(entity.geometry || {})[0];
  if (!position || !Array.isArray(origin)) return null;
  return haversineMeters(origin, position);
}

function bounded(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function finiteSort(value) {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
