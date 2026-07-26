/**
 * Canonical nature-travel domain primitives shared by ingestion, tests and the
 * browser. Source records intentionally use descriptive keys; compact keys are
 * permitted only in generated delivery artifacts.
 */

export const SCHEMA_VERSION = "1.0.0";

export const ENTITY_TYPES = Object.freeze([
  "Place",
  "NaturalFeature",
  "ProtectedArea",
  "TrailRoute",
  "RouteStage",
  "RouteVariant",
  "TrailSegment",
  "AccessPoint",
  "TransportConnection",
  "Amenity",
  "Condition",
  "Restriction",
  "PermitRequirement",
  "Hazard",
  "OpeningSchedule",
  "Price",
  "MediaAsset",
  "LocalizedName",
  "Source",
  "SourceAssertion",
  "Jurisdiction",
  "Geometry",
  "QualityAssessment",
]);

export const EVIDENCE_KINDS = Object.freeze([
  "verified_official",
  "structured_community",
  "maintainer_curated",
  "third_party_claim",
  "derived",
  "inference",
  "estimate",
  "unknown",
  "stale",
  "needs_physical_verification",
]);

export const VERIFICATION_STATES = Object.freeze([
  "verified",
  "partially_verified",
  "unverified",
  "conflicting",
  "expired",
]);

export const SENSITIVITY_ACTIONS = Object.freeze([
  "publish",
  "coarsen",
  "redact",
  "exclude",
]);

const PLANNING_BLOCKING_QUALITY_FLAGS = new Set([
  "access_unknown", "border_conditions_unknown", "conditions_unknown",
  "critical_access_unknown", "critical_condition_unknown",
  "generalized_geometry", "generalized_position",
  "legal_access_unknown", "not_navigation_grade", "operation_unknown",
  "overview_geometry_only", "parking_rules_unknown", "reservation_status_unknown",
  "route_geometry_missing", "schedule_unknown", "sensitivity_not_assessed",
  "stopping_permission_unknown", "transport_schedule_unknown", "transport_stop_unknown",
]);
const PLANNING_ADVISORY_QUALITY_FLAGS = new Set([
  "current_conditions_require_local_verification",
  "current_road_status_requires_local_verification",
  "official_centerline",
  "parking_capacity_unknown",
  "parking_centroid_not_surveyed",
  "parking_fee_unknown",
  "parking_hours_unknown",
  "source_geometry_surveyed_2016",
]);
const UNSAFE_PLANNING_QUALITY_FLAG_TOKEN =
  /(?:^|_)(?:unsafe|danger|hazard|closed|closure|blocked|prohibited)(?:_|$)/i;
const NON_CURRENT_PLANNING_QUALITY_FLAG_TOKEN =
  /(?:^|_)(?:stale|expired|unverified|conflict)(?:_|$)/i;
const PLANNING_SENSITIVE_QUALITY_FLAG_TOKEN =
  /(?:^|_)(?:legal|access|stopping|operation|schedule|transport|conditions?|avalanche|fire|flood|hazard|reservation|sensitivity|navigation|geometry)(?:_|$)/i;
const UNKNOWN_QUALITY_FLAG_TOKEN = /(?:^|_)(?:unknown|unverified)(?:_|$)/i;

export function isUnsafePlanningQualityFlag(value) {
  return UNSAFE_PLANNING_QUALITY_FLAG_TOKEN.test(String(value ?? "").trim().toLowerCase());
}

/**
 * Distinguishes facts that invalidate safe planning from advisory unknowns.
 * Missing parking capacity, fee, centroid or hours remain visible caveats when
 * legal access and stopping permission are independently verified.
 */
export function isPlanningBlockingQualityFlag(value) {
  const flag = String(value ?? "").trim().toLowerCase();
  if (!flag || PLANNING_ADVISORY_QUALITY_FLAGS.has(flag)) return false;
  return PLANNING_BLOCKING_QUALITY_FLAGS.has(flag)
    || isUnsafePlanningQualityFlag(flag)
    || NON_CURRENT_PLANNING_QUALITY_FLAG_TOKEN.test(flag)
    || (UNKNOWN_QUALITY_FLAG_TOKEN.test(flag)
      && PLANNING_SENSITIVE_QUALITY_FLAG_TOKEN.test(flag));
}

export function isSafetySensitiveTrailRoute(route) {
  const activities = new Set(Array.isArray(route?.activities) ? route.activities : []);
  return ["technical", "expert"].includes(route?.difficulty?.normalizedBand)
    || ["scrambling", "via_ferrata", "winter_walking", "snowshoe"]
      .some((activity) => activities.has(activity))
    || (Array.isArray(route?.hazards) ? route.hazards : [])
      .some((hazard) => ["high", "extreme", "unknown"].includes(hazard?.severity));
}

const ENTITY_TYPE_SET = new Set(ENTITY_TYPES);
const EVIDENCE_KIND_SET = new Set(EVIDENCE_KINDS);
const VERIFICATION_STATE_SET = new Set(VERIFICATION_STATES);
const SENSITIVITY_ACTION_SET = new Set(SENSITIVITY_ACTIONS);
const ROUTE_SOURCE_NOTICE_FIELDS = Object.freeze([
  "sourceId",
  "sourceRecordId",
  "publisher",
  "product",
  "licenceId",
  "licenceVersion",
  "licenceUrl",
  "attribution",
  "sourceUrl",
  "transformationNotice",
]);
const GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
]);

export class DomainValidationError extends Error {
  constructor(errors, label = "canonical entity") {
    super(`${label} is invalid: ${errors.join("; ")}`);
    this.name = "DomainValidationError";
    this.errors = errors;
  }
}

export function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function stableSlug(value) {
  const normalized = normalizeSearchText(value)
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unnamed";
}

export function stableId(namespace, sourceId, fallback = "") {
  const prefix = stableSlug(namespace);
  const readable = stableSlug(sourceId || fallback);
  const hash = fnv1a(`${namespace}\0${sourceId}\0${fallback}`);
  return `${prefix}:${readable.slice(0, 72)}:${hash}`;
}

export function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function displayName(entity, preferredLanguages = ["en"]) {
  const names = Array.isArray(entity?.names) ? entity.names : [];
  for (const language of preferredLanguages) {
    const exact = names.find((name) => name.language === language && name.kind === "primary");
    if (exact?.value) return exact.value;
  }
  return names.find((name) => name.kind === "primary")?.value
    || names.find((name) => name.value)?.value
    || entity?.id
    || "Unnamed";
}

export function validateCanonicalEntity(entity, options = {}) {
  const errors = [];
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    return ["record must be an object"];
  }
  if (entity.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must equal ${SCHEMA_VERSION}`);
  }
  if (typeof entity.id !== "string" || !/^[a-z0-9][a-z0-9:._-]{2,159}$/i.test(entity.id)) {
    errors.push("id must be a stable readable identifier");
  }
  if (!ENTITY_TYPE_SET.has(entity.entityType)) {
    errors.push(`entityType must be one of ${ENTITY_TYPES.join(", ")}`);
  }
  if (!Array.isArray(entity.jurisdictionIds) || entity.jurisdictionIds.length === 0) {
    errors.push("jurisdictionIds must contain at least one jurisdiction");
  } else if (entity.jurisdictionIds.some((id) => typeof id !== "string" || !id)) {
    errors.push("jurisdictionIds must contain non-empty strings");
  }
  validateNames(entity.names, errors);
  validateGeometry(entity.geometry, errors, options);
  validateProvenance(entity.sourceAssertions, errors);
  validateQuality(entity.quality, errors);
  validateSensitivity(entity.sensitivity, errors);

  if (entity.entityType === "TrailRoute") validateTrailRoute(entity, errors, options);
  if (entity.entityType === "AccessPoint") validateAccessPoint(entity, errors);
  if (entity.entityType === "TransportConnection") validateTransportConnection(entity, errors);
  if (entity.originalSourceIds && !Array.isArray(entity.originalSourceIds)) {
    errors.push("originalSourceIds must be an array when present");
  }
  return errors;
}

export function assertCanonicalEntity(entity, options = {}) {
  const errors = validateCanonicalEntity(entity, options);
  if (errors.length) throw new DomainValidationError(errors);
  return entity;
}

function validateNames(names, errors) {
  if (!Array.isArray(names) || names.length === 0) {
    errors.push("names must contain at least one localized name");
    return;
  }
  const seen = new Set();
  let primaryCount = 0;
  for (const [index, name] of names.entries()) {
    if (!name || typeof name !== "object") {
      errors.push(`names[${index}] must be an object`);
      continue;
    }
    if (typeof name.value !== "string" || !name.value.trim()) {
      errors.push(`names[${index}].value must be non-empty`);
    }
    if (typeof name.language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$|^und$/i.test(name.language)) {
      errors.push(`names[${index}].language must be a BCP 47 language tag or und`);
    }
    if (!["primary", "official", "alternate", "translated", "romanized", "historic"].includes(name.kind)) {
      errors.push(`names[${index}].kind is unsupported`);
    }
    if (name.kind === "primary") primaryCount += 1;
    const key = `${String(name.language).toLowerCase()}\0${normalizeSearchText(name.value)}`;
    if (seen.has(key)) errors.push(`names[${index}] duplicates another localized name`);
    seen.add(key);
  }
  if (primaryCount === 0) errors.push("names must include a primary name");
}

export function validateGeometry(geometry, errors = [], options = {}) {
  if (!geometry || typeof geometry !== "object") {
    errors.push("geometry is required");
    return errors;
  }
  if (!GEOMETRY_TYPES.has(geometry.type)) {
    errors.push("geometry.type must be a supported GeoJSON geometry type");
    return errors;
  }
  const positions = flattenPositions(geometry);
  if (positions.length === 0) {
    errors.push("geometry must contain coordinates");
    return errors;
  }
  for (const [index, position] of positions.entries()) {
    if (!validPosition(position)) errors.push(`geometry position ${index} is invalid or appears swapped`);
  }
  if (geometry.type === "LineString" && geometry.coordinates.length < 2) {
    errors.push("LineString must contain at least two positions");
  }
  if (geometry.type === "MultiLineString"
      && geometry.coordinates.some((line) => !Array.isArray(line) || line.length < 2)) {
    errors.push("every MultiLineString part must contain at least two positions");
  }
  if (["Polygon", "MultiPolygon"].includes(geometry.type)) {
    const rings = geometry.type === "Polygon"
      ? geometry.coordinates
      : geometry.coordinates.flat();
    for (const [index, ring] of rings.entries()) {
      if (!Array.isArray(ring) || ring.length < 4) {
        errors.push(`polygon ring ${index} must contain at least four positions`);
      } else if (!samePosition(ring[0], ring.at(-1))) {
        errors.push(`polygon ring ${index} must be closed`);
      }
    }
  }
  if (options.bounds && positions.some((position) => !insideBounds(position, options.bounds))) {
    errors.push("geometry falls outside the expected jurisdiction bounds");
  }
  return errors;
}

function validateProvenance(assertions, errors) {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    errors.push("sourceAssertions must preserve at least one provenance assertion");
    return;
  }
  for (const [index, assertion] of assertions.entries()) {
    if (!assertion || typeof assertion !== "object") {
      errors.push(`sourceAssertions[${index}] must be an object`);
      continue;
    }
    if (typeof assertion.sourceId !== "string" || !assertion.sourceId) {
      errors.push(`sourceAssertions[${index}].sourceId is required`);
    }
    if (typeof assertion.fieldPath !== "string" || !assertion.fieldPath.startsWith("/")) {
      errors.push(`sourceAssertions[${index}].fieldPath must be a JSON Pointer`);
    }
    if (!EVIDENCE_KIND_SET.has(assertion.evidenceKind)) {
      errors.push(`sourceAssertions[${index}].evidenceKind is unsupported`);
    }
    if (!VERIFICATION_STATE_SET.has(assertion.verificationStatus)) {
      errors.push(`sourceAssertions[${index}].verificationStatus is unsupported`);
    }
    if (assertion.confidence != null
        && (!Number.isFinite(assertion.confidence) || assertion.confidence < 0 || assertion.confidence > 1)) {
      errors.push(`sourceAssertions[${index}].confidence must be between 0 and 1`);
    }
  }
}

function validateQuality(quality, errors) {
  if (!quality || typeof quality !== "object") {
    errors.push("quality assessment is required");
    return;
  }
  if (!Number.isFinite(quality.confidence) || quality.confidence < 0 || quality.confidence > 1) {
    errors.push("quality.confidence must be between 0 and 1");
  }
  if (!VERIFICATION_STATE_SET.has(quality.verificationStatus)) {
    errors.push("quality.verificationStatus is unsupported");
  }
  if (typeof quality.assessedAt !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(quality.assessedAt)) {
    errors.push("quality.assessedAt must be an ISO date");
  }
  if (!Array.isArray(quality.flags)) errors.push("quality.flags must be an array");
}

function validateSensitivity(sensitivity, errors) {
  if (!sensitivity || typeof sensitivity !== "object") {
    errors.push("sensitivity policy is required");
    return;
  }
  if (!SENSITIVITY_ACTION_SET.has(sensitivity.action)) {
    errors.push("sensitivity.action is unsupported");
  }
  if (sensitivity.action !== "publish" && typeof sensitivity.reason !== "string") {
    errors.push("non-public sensitivity actions require a reason");
  }
}

function validateTrailRoute(route, errors, options) {
  if (!["LineString", "MultiLineString"].includes(route.geometry?.type)) {
    errors.push("TrailRoute geometry must be a LineString or MultiLineString");
  }
  if (!["established", "generated", "scenic_drive"].includes(route.routeNature)) {
    errors.push("TrailRoute.routeNature must distinguish established, generated, or scenic_drive");
  }
  if (!Array.isArray(route.activities) || route.activities.length === 0) {
    errors.push("TrailRoute.activities must contain at least one activity");
  }
  if (!["loop", "out_and_back", "point_to_point", "network", "stage"].includes(route.journeyShape)) {
    errors.push("TrailRoute.journeyShape is unsupported");
  }
  if (route.routeNature === "established" && route.geometryCompleteness !== "complete") {
    errors.push("established TrailRoute records must carry complete route geometry");
  }
  if (route.navigationSuitability == null) {
    errors.push("TrailRoute.navigationSuitability must be explicit");
  }
  validateRouteExportMetadata(route, errors);
  if (route.routeNature === "established" && route.geometryCompleteness === "complete") {
    const maxGapM = options.maxTrailGeometryGapM ?? 50_000;
    const lines = route.geometry?.type === "LineString"
      ? [route.geometry.coordinates]
      : route.geometry?.coordinates ?? [];
    for (const [lineIndex, line] of lines.entries()) {
      for (let index = 1; index < line.length; index += 1) {
        if (haversineMeters(line[index - 1], line[index]) > maxGapM) {
          errors.push(`TrailRoute geometry part ${lineIndex} has a disconnected or over-generalized segment`);
          break;
        }
      }
    }
  }
}

function validateRouteExportMetadata(route, errors) {
  if (route.exportMetadata == null) return;
  const metadata = route.exportMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    errors.push("TrailRoute.exportMetadata must be an object when present");
    return;
  }
  const metadataExtraProperties = Object.keys(metadata)
    .filter((property) => property !== "sourceNotices");
  if (metadataExtraProperties.length) {
    errors.push(`TrailRoute.exportMetadata has unsupported properties: ${metadataExtraProperties.join(", ")}`);
  }
  if (!Array.isArray(metadata.sourceNotices) || metadata.sourceNotices.length === 0) {
    errors.push("TrailRoute.exportMetadata.sourceNotices must be a non-empty array");
    return;
  }

  const noticeKeys = new Set();
  for (const [index, notice] of metadata.sourceNotices.entries()) {
    if (!notice || typeof notice !== "object" || Array.isArray(notice)) {
      errors.push(`TrailRoute export source notice ${index} must be an object`);
      continue;
    }
    const extraProperties = Object.keys(notice)
      .filter((property) => !ROUTE_SOURCE_NOTICE_FIELDS.includes(property));
    if (extraProperties.length) {
      errors.push(`TrailRoute export source notice ${index} has unsupported properties: ${extraProperties.join(", ")}`);
    }
    for (const field of ROUTE_SOURCE_NOTICE_FIELDS) {
      if (typeof notice[field] !== "string" || !notice[field].trim()) {
        errors.push(`TrailRoute export source notice ${index}.${field} must be non-empty`);
      }
    }
    for (const field of ["licenceUrl", "sourceUrl"]) {
      if (typeof notice[field] !== "string" || !validHttpUrl(notice[field])) {
        errors.push(`TrailRoute export source notice ${index}.${field} must be an absolute HTTP(S) URL`);
      }
    }
    if (typeof notice.sourceId === "string" && typeof notice.sourceRecordId === "string") {
      const key = `${notice.sourceId}\0${notice.sourceRecordId}`;
      if (noticeKeys.has(key)) {
        errors.push(`TrailRoute export source notice ${index} duplicates ${notice.sourceId}/${notice.sourceRecordId}`);
      }
      noticeKeys.add(key);
    }
  }

  const assertionKeys = new Set((route.sourceAssertions || [])
    .filter((assertion) => typeof assertion?.sourceId === "string"
      && typeof assertion?.sourceRecordId === "string"
      && assertion.sourceRecordId)
    .map((assertion) => `${assertion.sourceId}\0${assertion.sourceRecordId}`));
  for (const [index, assertion] of (route.sourceAssertions || []).entries()) {
    if (typeof assertion?.sourceRecordId !== "string" || !assertion.sourceRecordId.trim()) {
      errors.push(`TrailRoute export metadata requires sourceAssertions[${index}].sourceRecordId`);
    }
  }
  for (const key of assertionKeys) {
    if (!noticeKeys.has(key)) {
      const [sourceId, sourceRecordId] = key.split("\0");
      errors.push(`TrailRoute export metadata lacks a notice for ${sourceId}/${sourceRecordId}`);
    }
  }
  for (const key of noticeKeys) {
    if (!assertionKeys.has(key)) {
      const [sourceId, sourceRecordId] = key.split("\0");
      errors.push(`TrailRoute export metadata has no matching assertion for ${sourceId}/${sourceRecordId}`);
    }
  }
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function validateAccessPoint(accessPoint, errors) {
  if (accessPoint.geometry?.type !== "Point") errors.push("AccessPoint geometry must be a Point");
  if (!Array.isArray(accessPoint.accessModes) || accessPoint.accessModes.length === 0) {
    errors.push("AccessPoint.accessModes must be non-empty");
  }
  if (!["legal", "restricted", "private", "unknown"].includes(accessPoint.legalAccess)) {
    errors.push("AccessPoint.legalAccess must be explicit");
  }
}

function validateTransportConnection(connection, errors) {
  if (!["ferry", "bus", "rail", "tram", "cable_car", "gondola", "funicular", "cog_railway", "boat", "pickup"].includes(connection.transportMode)) {
    errors.push("TransportConnection.transportMode is unsupported");
  }
  if (!Array.isArray(connection.endpointIds) || connection.endpointIds.length !== 2) {
    errors.push("TransportConnection.endpointIds must identify exactly two ends");
  } else if (new Set(connection.endpointIds).size !== connection.endpointIds.length) {
    errors.push("TransportConnection.endpointIds must be unique");
  }
  if (connection.direction !== undefined
      && !["outbound", "return", "both"].includes(connection.direction)) {
    errors.push("TransportConnection.direction is unsupported");
  }
  if (connection.operating !== undefined && typeof connection.operating !== "boolean") {
    errors.push("TransportConnection.operating must be boolean when supplied");
  }
  if (connection.schedule?.timezone !== undefined
      && (typeof connection.schedule.timezone !== "string"
        || !connection.schedule.timezone.trim())) {
    errors.push("TransportConnection.schedule.timezone must be non-empty when supplied");
  }
}

export function flattenPositions(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  switch (geometry.type) {
    case "Point": return [geometry.coordinates];
    case "MultiPoint":
    case "LineString": return geometry.coordinates;
    case "MultiLineString":
    case "Polygon": return geometry.coordinates.flat();
    case "MultiPolygon": return geometry.coordinates.flat(2);
    default: return [];
  }
}

export function validPosition(position) {
  return Array.isArray(position)
    && position.length >= 2
    && Number.isFinite(position[0])
    && Number.isFinite(position[1])
    && position[0] >= -180
    && position[0] <= 180
    && position[1] >= -90
    && position[1] <= 90;
}

export function insideBounds(position, bounds) {
  const [lon, lat] = position;
  return lon >= bounds[0] && lat >= bounds[1] && lon <= bounds[2] && lat <= bounds[3];
}

export function samePosition(a, b, tolerance = 1e-8) {
  return validPosition(a)
    && validPosition(b)
    && Math.abs(a[0] - b[0]) <= tolerance
    && Math.abs(a[1] - b[1]) <= tolerance;
}

export function haversineMeters(a, b) {
  if (!validPosition(a) || !validPosition(b)) return Number.NaN;
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function lineDistanceMeters(geometry) {
  if (!geometry || !["LineString", "MultiLineString"].includes(geometry.type)) return 0;
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      total += haversineMeters(line[index - 1], line[index]);
    }
  }
  return total;
}

export function geometryBounds(geometry) {
  const positions = flattenPositions(geometry).filter(validPosition);
  if (!positions.length) return null;
  return positions.reduce(
    (bounds, [lon, lat]) => [
      Math.min(bounds[0], lon),
      Math.min(bounds[1], lat),
      Math.max(bounds[2], lon),
      Math.max(bounds[3], lat),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}
