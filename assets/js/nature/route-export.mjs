import {
  displayName,
  validPosition,
} from "./domain.mjs";

export const ROUTE_SAFETY_DISCLAIMER = "Route data is not live. Verify current access, closures, hazards, weather, and local guidance before departure.";

export class RouteExportError extends Error {
  constructor(message, code = "route_export_error") {
    super(message);
    this.name = "RouteExportError";
    this.code = code;
  }
}

export function assessTrailRouteExport(entity, format) {
  const normalizedFormat = String(format || "").toLowerCase();
  if (!["gpx", "geojson"].includes(normalizedFormat)) {
    throw new TypeError("format must be gpx or geojson");
  }
  const prefix = normalizedFormat === "gpx" ? "gpx" : "geojson";
  if (entity?.entityType !== "TrailRoute") {
    return denied(prefix, "not_route", "Only trail routes can be exported");
  }
  if (normalizedFormat === "gpx" && entity.navigationSuitability !== true) {
    return denied(
      prefix,
      "navigation_unsuitable",
      "GPX export is disabled because this geometry is not verified as navigation-suitable",
    );
  }
  if (normalizedFormat === "gpx" && entity.geometryCompleteness !== "complete") {
    return denied(
      prefix,
      "incomplete_geometry",
      "GPX export requires complete route geometry",
    );
  }
  const lines = routeLines(entity.geometry);
  if (!lines.length || lines.some((line) => !validLine(line))) {
    return denied(prefix, "invalid_geometry", "Route geometry is missing or invalid");
  }
  return {
    allowed: true,
    code: null,
    message: normalizedFormat === "gpx"
      ? "Navigation-suitable complete route geometry is available as GPX."
      : "Route geometry is available as metadata-rich GeoJSON.",
    lines,
    warnings: routeWarnings(entity),
  };
}

export function serializeTrailRouteGpx(entity) {
  const assessment = requireAllowed(entity, "gpx");
  const title = escapeXml(displayName(entity));
  const description = escapeXml([
    geometryRepresentationLabel(entity),
    ROUTE_SAFETY_DISCLAIMER,
  ].join(" "));
  const segments = assessment.lines.map((line) => `<trkseg>${line.map((position) => {
    const elevation = Number.isFinite(position[2]) ? `<ele>${position[2]}</ele>` : "";
    return `<trkpt lat="${position[1]}" lon="${position[0]}">${elevation}</trkpt>`;
  }).join("")}</trkseg>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Itinera" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${title}</name><desc>${description}</desc></metadata><trk><name>${title}</name><desc>${description}</desc>${segments}</trk></gpx>\n`;
}

export function serializeTrailRouteGeoJson(entity) {
  requireAllowed(entity, "geojson");
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

function requireAllowed(entity, format) {
  const assessment = assessTrailRouteExport(entity, format);
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
  if (entity.geometryCompleteness === "complete" && entity.navigationSuitability === true) {
    return "navigation_suitable_complete_path";
  }
  if (entity.geometryCompleteness === "overview_only"
      || (entity.quality?.flags || []).some((flag) =>
        ["generalized_geometry", "overview_geometry_only"].includes(flag))) {
    return "overview_geometry_only";
  }
  if (entity.geometryCompleteness === "complete") return "complete_non_navigation_geometry";
  return "unknown_non_navigation_geometry";
}

function routeWarnings(entity) {
  const warnings = [ROUTE_SAFETY_DISCLAIMER];
  if (entity.navigationSuitability !== true) {
    warnings.push("Geometry is not verified as navigation-suitable.");
  }
  if (entity.geometryCompleteness !== "complete") {
    warnings.push("Geometry does not represent a complete route path.");
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

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]);
}
