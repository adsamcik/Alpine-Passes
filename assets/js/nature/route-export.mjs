import {
  displayName,
  validPosition,
} from "./domain.mjs";

export const ROUTE_SAFETY_DISCLAIMER = "Route data is not live. Verify current access, closures, hazards, weather, and local guidance before departure.";

/**
 * Route-provided download notice contract.
 *
 * `exportMetadata.sourceNotices` contains one item for every distinct
 * `{ sourceId, sourceRecordId }` in `sourceAssertions`:
 * {
 *   sourceId, sourceRecordId, publisher, product,
 *   licenceId, licenceVersion, licenceUrl,
 *   attribution, sourceUrl, transformationNotice
 * }
 *
 * All strings are non-empty and both URLs are absolute HTTP(S) URLs. Both
 * downloadable formats fail closed when any asserted source record lacks a
 * complete notice. GPX additionally requires verified/current geometry
 * provenance and route quality, a publish sensitivity decision, complete
 * non-generalized geometry, and navigationSuitability=true.
 */
export const ROUTE_EXPORT_METADATA_CONTRACT = Object.freeze({
  field: "exportMetadata.sourceNotices",
  requiredFields: Object.freeze([
    "sourceId", "sourceRecordId", "publisher", "product",
    "licenceId", "licenceVersion", "licenceUrl", "attribution",
    "sourceUrl", "transformationNotice",
  ]),
});

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const NON_NAVIGATION_GEOMETRY_FLAG = /(coarsen|generali[sz]|overview|simplif|redact)/i;
export const DEFAULT_GPX_EXPORT_POLICY = Object.freeze({
  maxGeometryAssessmentAgeMilliseconds: 366 * DAY_MILLISECONDS,
  maxGeometryObservationAgeMilliseconds: 366 * DAY_MILLISECONDS,
  maxFutureSkewMilliseconds: 5 * 60 * 1_000,
});

export class RouteExportError extends Error {
  constructor(message, code = "route_export_error") {
    super(message);
    this.name = "RouteExportError";
    this.code = code;
  }
}

export function assessTrailRouteExport(entity, format, options = {}) {
  const normalizedFormat = String(format || "").toLowerCase();
  if (!["gpx", "geojson"].includes(normalizedFormat)) {
    throw new TypeError("format must be gpx or geojson");
  }
  const prefix = normalizedFormat === "gpx" ? "gpx" : "geojson";
  if (entity?.entityType !== "TrailRoute") {
    return denied(prefix, "not_route", "Only trail routes can be exported");
  }
  const lines = routeLines(entity.geometry);
  if (!lines.length || lines.some((line) => !validLine(line))) {
    return denied(prefix, "invalid_geometry", "Route geometry is missing or invalid");
  }

  const sourceNoticeSet = downloadableSourceNotices(entity);
  if (normalizedFormat === "gpx") {
    if (entity.navigationSuitability !== true) {
      return denied(
        prefix,
        "navigation_unsuitable",
        "GPX export is disabled because this geometry is not verified as navigation-suitable",
      );
    }
    if (entity.geometryCompleteness !== "complete") {
      return denied(
        prefix,
        "incomplete_geometry",
        "GPX export requires complete route geometry",
      );
    }
    if (entity.sensitivity?.action !== "publish") {
      return denied(
        prefix,
        "sensitivity_not_publishable",
        "GPX export requires an explicit publish sensitivity decision",
      );
    }
    if (geometryWasReduced(entity)) {
      return denied(
        prefix,
        "reduced_geometry",
        "GPX export is disabled for coarsened, generalized, simplified, redacted, or overview geometry",
      );
    }
    const assessmentContext = resolveGpxAssessmentContext(options);
    if (!assessmentContext.allowed) {
      return denied(
        prefix,
        assessmentContext.code,
        assessmentContext.message,
      );
    }
    if (entity.access?.legal !== "legal") {
      const legalStatus = textValue(entity.access?.legal) || "missing";
      return denied(
        prefix,
        "access_not_legal",
        `GPX export requires explicitly verified legal public access; route access is ${legalStatus}`,
      );
    }
    const provenanceAssessment = assessGeometryProvenance(entity, assessmentContext);
    if (!provenanceAssessment.allowed) {
      return denied(prefix, provenanceAssessment.code, provenanceAssessment.message);
    }
  }

  if (!sourceNoticeSet.complete) {
    return {
      ...denied(
        prefix,
        "source_notices_incomplete",
        `${normalizedFormat.toUpperCase()} download requires complete publisher, product, licence, attribution, source, and transformation notices for every source record`,
      ),
      sourceNoticeSet,
    };
  }
  const warnings = routeWarnings(entity);
  return {
    allowed: true,
    code: null,
    message: normalizedFormat === "gpx"
      ? "Verified, current, complete route geometry and source notices are available as GPX."
      : "Route geometry is available as metadata-rich GeoJSON.",
    lines,
    sourceNoticeSet,
    warnings,
  };
}

export function serializeTrailRouteGpx(entity, options = {}) {
  const assessment = requireAllowed(entity, "gpx", options);
  const title = escapeXml(displayName(entity));
  const noticeText = assessment.sourceNoticeSet.notices
    .map(sourceNoticeText)
    .join(" ");
  const description = escapeXml([
    geometryRepresentationLabel(entity),
    noticeText,
    ROUTE_SAFETY_DISCLAIMER,
  ].join(" "));
  const segments = assessment.lines.map((line) => `<trkseg>${line.map((position) => {
    const elevation = Number.isFinite(position[2]) ? `<ele>${position[2]}</ele>` : "";
    return `<trkpt lat="${position[1]}" lon="${position[0]}">${elevation}</trkpt>`;
  }).join("")}</trkseg>`).join("");
  const sourceNotices = assessment.sourceNoticeSet.notices
    .map((notice) => `<itinera:source sourceId="${escapeXml(notice.sourceId)}" sourceRecordId="${escapeXml(notice.sourceRecordId)}"><itinera:publisher>${escapeXml(notice.publisher)}</itinera:publisher><itinera:product>${escapeXml(notice.product)}</itinera:product><itinera:licence id="${escapeXml(notice.licenceId)}" version="${escapeXml(notice.licenceVersion)}" url="${escapeXml(notice.licenceUrl)}"/><itinera:attribution>${escapeXml(notice.attribution)}</itinera:attribution><itinera:sourceUrl>${escapeXml(notice.sourceUrl)}</itinera:sourceUrl><itinera:transformationNotice>${escapeXml(notice.transformationNotice)}</itinera:transformationNotice></itinera:source>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Itinera" xmlns="http://www.topografix.com/GPX/1/1" xmlns:itinera="urn:itinera:route-export:1"><metadata><name>${title}</name><desc>${description}</desc><extensions><itinera:sourceNotices status="complete">${sourceNotices}</itinera:sourceNotices></extensions></metadata><trk><name>${title}</name><desc>${description}</desc>${segments}</trk></gpx>\n`;
}

export function serializeTrailRouteGeoJson(entity, options = {}) {
  const assessment = requireAllowed(entity, "geojson", options);
  const provenance = (entity.sourceAssertions || []).map((assertion) => compactObject({
    sourceId: assertion.sourceId,
    sourceRecordId: assertion.sourceRecordId,
    fieldPath: assertion.fieldPath,
    evidenceKind: assertion.evidenceKind,
    verificationStatus: assertion.verificationStatus,
    confidence: assertion.confidence,
    observedAt: assertion.observedAt,
    retrievedAt: assertion.retrievedAt,
    validFrom: assertion.validFrom,
    validUntil: assertion.validUntil,
    notes: assertion.notes,
  }));
  const sourceNoticeSet = assessment.sourceNoticeSet;
  const exportSourceNotices = {
    status: "complete",
    notices: sourceNoticeSet.notices,
    sourceReferences: sourceNoticeSet.sourceReferences,
    missingSourceReferences: sourceNoticeSet.missingSourceReferences,
    unexpectedSourceReferences: sourceNoticeSet.unexpectedSourceReferences,
    invalidNoticeIndexes: sourceNoticeSet.invalidNoticeIndexes,
    duplicateNoticeKeys: sourceNoticeSet.duplicateNoticeKeys,
  };
  const payload = {
    type: "FeatureCollection",
    name: displayName(entity),
    metadata: {
      creator: "Itinera",
      schemaVersion: entity.schemaVersion || null,
      routeId: entity.id,
      geometryRepresentation: geometryRepresentationCode(entity),
      geometryRepresentationLabel: geometryRepresentationLabel(entity),
      geometryCompleteness: entity.geometryCompleteness || "unknown",
      navigationSuitability: entity.navigationSuitability === true,
      safetyDisclaimer: ROUTE_SAFETY_DISCLAIMER,
      exportSourceNotices,
      provenance,
    },
    features: [{
      type: "Feature",
      id: entity.id,
      properties: {
        id: entity.id,
        name: displayName(entity),
        routeNature: entity.routeNature || "unknown",
        journeyShape: entity.journeyShape || "unknown",
        geometryCompleteness: entity.geometryCompleteness || "unknown",
        navigationSuitability: entity.navigationSuitability === true,
        geometryRepresentation: geometryRepresentationCode(entity),
        safetyDisclaimer: ROUTE_SAFETY_DISCLAIMER,
        exportSourceNotices,
        sourceAssertions: provenance,
      },
      geometry: entity.geometry,
    }],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function routeExportFilename(entity, extension) {
  const stem = displayName(entity)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "route";
  return `${stem}.${extension === "geojson" ? "geojson" : "gpx"}`;
}

export function geometryRepresentationLabel(entity) {
  switch (geometryRepresentationCode(entity)) {
    case "navigation_suitable_complete_path":
      return "Complete geometry verified as navigation-suitable.";
    case "overview_geometry_only":
      return "Overview geometry only; not a navigation path.";
    case "complete_non_navigation_geometry":
      return "Complete route representation, but not verified as navigation-suitable.";
    default:
      return "Route geometry has unknown completeness and is not verified for navigation.";
  }
}

function requireAllowed(entity, format, options) {
  const assessment = assessTrailRouteExport(entity, format, options);
  if (!assessment.allowed) throw new RouteExportError(assessment.message, assessment.code);
  return assessment;
}

function routeLines(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function validLine(line) {
  return Array.isArray(line)
    && line.length >= 2
    && line.every((position) => validPosition(position));
}

function geometryRepresentationCode(entity) {
  if (entity.geometryCompleteness === "complete"
      && entity.navigationSuitability === true
      && !geometryWasReduced(entity)) {
    return "navigation_suitable_complete_path";
  }
  if (entity.geometryCompleteness === "overview_only" || geometryWasReduced(entity)) {
    return "overview_geometry_only";
  }
  if (entity.geometryCompleteness === "complete") return "complete_non_navigation_geometry";
  return "unknown_non_navigation_geometry";
}

function geometryWasReduced(entity) {
  const flags = Array.isArray(entity?.quality?.flags) ? entity.quality.flags : [];
  const representations = [
    entity?.geometryRepresentation,
    entity?.geometry?.representation,
  ].filter((value) => typeof value === "string");
  return entity?.geometryCompleteness === "overview_only"
    || flags.some((flag) => NON_NAVIGATION_GEOMETRY_FLAG.test(String(flag)))
    || representations.some((value) => NON_NAVIGATION_GEOMETRY_FLAG.test(value));
}

function resolveGpxAssessmentContext(options) {
  const input = options && typeof options === "object" ? options : {};
  const asOf = parseTemporalInstant(input.asOf ?? new Date(), false);
  if (!asOf) {
    return {
      allowed: false,
      code: "assessment_time_invalid",
      message: "GPX export requires a valid deterministic assessment time",
    };
  }
  const rawPolicy = input.gpxPolicy ?? {};
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
    return {
      allowed: false,
      code: "policy_invalid",
      message: "GPX export freshness policy must be an object",
    };
  }
  const policy = {
    maxGeometryAssessmentAgeMilliseconds: rawPolicy.maxGeometryAssessmentAgeMilliseconds
      ?? DEFAULT_GPX_EXPORT_POLICY.maxGeometryAssessmentAgeMilliseconds,
    maxGeometryObservationAgeMilliseconds: rawPolicy.maxGeometryObservationAgeMilliseconds
      ?? DEFAULT_GPX_EXPORT_POLICY.maxGeometryObservationAgeMilliseconds,
    maxFutureSkewMilliseconds: rawPolicy.maxFutureSkewMilliseconds
      ?? DEFAULT_GPX_EXPORT_POLICY.maxFutureSkewMilliseconds,
  };
  if (Object.values(policy).some((value) => !Number.isFinite(value) || value < 0)) {
    return {
      allowed: false,
      code: "policy_invalid",
      message: "GPX export freshness policy values must be finite non-negative milliseconds",
    };
  }
  return { allowed: true, asOf, policy };
}

function assessGeometryProvenance(entity, context) {
  const quality = entity?.quality;
  if (!quality
      || quality.verificationStatus !== "verified"
      || quality.freshness !== "current") {
    return provenanceDenied(
      "geometry_provenance_unverified",
      "GPX export requires verified, current geometry quality and provenance",
    );
  }
  const assessedAt = parseTemporalInstant(quality.assessedAt, false);
  if (!assessedAt) {
    return provenanceDenied(
      "geometry_provenance_unverified",
      "GPX export requires a valid geometry assessment date",
    );
  }
  const assessmentFreshness = assessProvenanceTimestamp(
    assessedAt,
    context,
    context.policy.maxGeometryAssessmentAgeMilliseconds,
    "geometry_assessment",
    "geometry assessment",
  );
  if (!assessmentFreshness.allowed) return assessmentFreshness;

  const geometryAssertions = (entity.sourceAssertions || []).filter((assertion) =>
    assertion?.fieldPath === "/geometry"
    || String(assertion?.fieldPath || "").startsWith("/geometry/"));
  if (!geometryAssertions.length) {
    return provenanceDenied(
      "geometry_provenance_unverified",
      "GPX export requires at least one verified geometry source assertion",
    );
  }
  for (const assertion of geometryAssertions) {
    if (assertion.verificationStatus !== "verified") {
      return provenanceDenied(
        "geometry_provenance_unverified",
        "GPX export requires every geometry source assertion to be verified",
      );
    }
    const observedAt = parseTemporalInstant(
      firstPresent(assertion.observedAt, assertion.retrievedAt),
      false,
    );
    if (!observedAt) {
      return provenanceDenied(
        "geometry_provenance_unverified",
        "GPX export requires a dated observation or retrieval for every geometry assertion",
      );
    }
    const observationFreshness = assessProvenanceTimestamp(
      observedAt,
      context,
      context.policy.maxGeometryObservationAgeMilliseconds,
      "geometry_observation",
      "geometry observation",
    );
    if (!observationFreshness.allowed) return observationFreshness;

    if (assertion.validFrom) {
      const validFrom = parseTemporalInstant(assertion.validFrom, false);
      if (!validFrom) {
        return provenanceDenied(
          "geometry_provenance_unverified",
          "GPX export geometry provenance has an invalid validity start",
        );
      }
      if (validFrom.getTime() > context.asOf.getTime() + context.policy.maxFutureSkewMilliseconds) {
        return provenanceDenied(
          "geometry_provenance_not_yet_valid",
          "GPX export geometry provenance is not yet valid at the assessment time",
        );
      }
    }
    if (assertion.validUntil) {
      const validUntil = parseTemporalInstant(assertion.validUntil, true);
      if (!validUntil) {
        return provenanceDenied(
          "geometry_provenance_unverified",
          "GPX export geometry provenance has an invalid validity end",
        );
      }
      if (validUntil.getTime() < context.asOf.getTime()) {
        return provenanceDenied(
          "geometry_provenance_expired",
          "GPX export geometry provenance is expired at the assessment time",
        );
      }
    }
  }
  return { allowed: true };
}

function assessProvenanceTimestamp(timestamp, context, maxAgeMilliseconds, codePrefix, label) {
  const delta = timestamp.getTime() - context.asOf.getTime();
  if (delta > context.policy.maxFutureSkewMilliseconds) {
    return provenanceDenied(
      `${codePrefix}_future`,
      `GPX export ${label} is implausibly future-dated`,
    );
  }
  if (-delta > maxAgeMilliseconds) {
    return provenanceDenied(
      `${codePrefix}_stale`,
      `GPX export ${label} exceeds the configured maximum age`,
    );
  }
  return { allowed: true };
}

function provenanceDenied(code, message) {
  return { allowed: false, code, message };
}

function downloadableSourceNotices(entity) {
  const sourceReferences = distinctSourceReferences(entity?.sourceAssertions);
  const rawNotices = Array.isArray(entity?.exportMetadata?.sourceNotices)
    ? entity.exportMetadata.sourceNotices : [];
  const invalidNoticeIndexes = [];
  const notices = rawNotices.flatMap((rawNotice, index) => {
    const normalized = normalizeSourceNotice(rawNotice);
    if (!normalized) {
      invalidNoticeIndexes.push(index);
      return [];
    }
    return [normalized];
  });
  const noticeKeys = new Set(notices.map(sourceReferenceKey));
  const sourceReferenceKeys = new Set(sourceReferences.map(sourceReferenceKey));
  const duplicateNoticeKeys = notices
    .map(sourceReferenceKey)
    .filter((key, index, keys) => keys.indexOf(key) !== index);
  const missingSourceReferences = sourceReferences.filter((reference) =>
    !noticeKeys.has(sourceReferenceKey(reference)));
  const unexpectedSourceReferences = notices
    .filter((notice) => !sourceReferenceKeys.has(sourceReferenceKey(notice)))
    .map(({ sourceId, sourceRecordId }) => ({ sourceId, sourceRecordId }));
  const complete = sourceReferences.length > 0
    && invalidNoticeIndexes.length === 0
    && duplicateNoticeKeys.length === 0
    && missingSourceReferences.length === 0
    && unexpectedSourceReferences.length === 0;
  return {
    complete,
    notices,
    sourceReferences,
    missingSourceReferences,
    unexpectedSourceReferences,
    invalidNoticeIndexes,
    duplicateNoticeKeys: [...new Set(duplicateNoticeKeys)],
  };
}

function normalizeSourceNotice(rawNotice) {
  if (!rawNotice || typeof rawNotice !== "object" || Array.isArray(rawNotice)) return null;
  const notice = Object.fromEntries(
    ROUTE_EXPORT_METADATA_CONTRACT.requiredFields.map((field) =>
      [field, textValue(rawNotice[field])]),
  );
  if (ROUTE_EXPORT_METADATA_CONTRACT.requiredFields.some((field) => !notice[field])) {
    return null;
  }
  if (!webUrl(notice.licenceUrl) || !webUrl(notice.sourceUrl)) return null;
  notice.licenceUrl = webUrl(notice.licenceUrl);
  notice.sourceUrl = webUrl(notice.sourceUrl);
  return notice;
}

function distinctSourceReferences(assertions) {
  const references = [];
  const seen = new Set();
  for (const assertion of Array.isArray(assertions) ? assertions : []) {
    const reference = {
      sourceId: textValue(assertion?.sourceId),
      sourceRecordId: textValue(assertion?.sourceRecordId),
    };
    const key = sourceReferenceKey(reference);
    if ((!reference.sourceId && !reference.sourceRecordId) || seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

function sourceReferenceKey(reference) {
  return `${reference.sourceId}\u0000${reference.sourceRecordId}`;
}

function sourceNoticeText(notice) {
  return [
    `Publisher: ${notice.publisher}.`,
    `Product: ${notice.product}.`,
    `Licence: ${notice.licenceId} ${notice.licenceVersion} (${notice.licenceUrl}).`,
    `Attribution: ${notice.attribution}.`,
    `Source: ${notice.sourceUrl}.`,
    `Source ID: ${notice.sourceId}.`,
    `Source record ID: ${notice.sourceRecordId}.`,
    `Transformation: ${notice.transformationNotice}.`,
  ].join(" ");
}

function routeWarnings(entity) {
  const warnings = [ROUTE_SAFETY_DISCLAIMER];
  if (entity.navigationSuitability !== true) {
    warnings.push("Geometry is not verified as navigation-suitable.");
  }
  if (entity.geometryCompleteness !== "complete") {
    warnings.push("Geometry does not represent a complete route path.");
  }
  if (geometryWasReduced(entity)) {
    warnings.push("Geometry is coarsened, generalized, simplified, redacted, or overview-only.");
  }
  if (entity.access?.legal === "unknown") warnings.push("Legal public access is unknown.");
  return warnings;
}

function denied(prefix, suffix, message) {
  return {
    allowed: false,
    code: `${prefix}_${suffix}`,
    message,
    lines: [],
    warnings: [ROUTE_SAFETY_DISCLAIMER],
  };
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function webUrl(value) {
  try {
    const parsed = new URL(textValue(value));
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && !parsed.username && !parsed.password ? parsed.href : "";
  } catch {
    return "";
  }
}

function parseTemporalInstant(value, endOfDate) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const text = textValue(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    const timestamp = endOfDate
      ? Date.UTC(year, month - 1, day, 23, 59, 59, 999)
      : Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day ? date : null;
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]);
}
