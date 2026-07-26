import {
  displayName,
  lineDistanceMeters,
} from "./domain.mjs";
import {
  assessTrailRouteExport,
  geometryRepresentationLabel,
  ROUTE_SAFETY_DISCLAIMER,
} from "./route-export.mjs";

export const HIKE_DETAIL_SECTION_TITLES = Object.freeze([
  "At a glance",
  "Route character",
  "Getting there",
  "Safety & conditions",
  "Data confidence",
]);

export function buildHikeDetailModel(route, assessment = {}) {
  if (route?.entityType !== "TrailRoute") {
    throw new TypeError("A TrailRoute is required");
  }
  const metrics = route.metrics || {};
  const reportedDistance = positiveNumber(metrics.distanceMeters);
  const geometryDistance = lineDistanceMeters(route.geometry);
  const distance = reportedDistance
    ? fact("Reported distance", formatDistance(reportedDistance))
    : Number.isFinite(geometryDistance) && geometryDistance > 0
      ? fact("Geometry length", `${formatDistance(geometryDistance)} · overview geometry only`)
      : fact("Distance", "Unknown");
  const difficulty = difficultyLabel(route.difficulty);
  const segments = route.trailSegments || route.segments || [];
  const surfaces = uniqueValues(segments.map((segment) => segment.surface));
  const trailClasses = uniqueValues(segments.map((segment) => segment.trailClass));
  const visibility = uniqueValues(segments.map((segment) => segment.visibility));
  const accessPoints = (route.accessPoints || []).map(accessPointModel);
  const transportConnections = (route.transportConnections || []).map(transportModel);
  const hazards = (route.hazards || []).map((hazard) => ({
    title: displayName(hazard),
    detail: joinKnown([
      humanize(hazard.hazardKind),
      hazard.severity ? `${humanize(hazard.severity)} severity` : "Severity unknown",
      hazard.summary,
    ]),
  }));
  const conditions = (route.conditions || []).map((condition) => ({
    title: displayName(condition),
    detail: joinKnown([
      humanize(condition.conditionKind),
      condition.state ? `State: ${humanize(condition.state)}` : "State unknown",
      dateRange(condition.effectiveFrom, condition.effectiveUntil),
      condition.checkedAt ? `Checked ${formatDate(condition.checkedAt)}` : "Check time unknown",
      condition.summary,
    ]),
  }));
  const restrictions = (route.restrictions || []).map((restriction) => ({
    title: displayName(restriction),
    detail: joinKnown([
      humanize(restriction.restrictionKind),
      restriction.summary,
    ]),
  }));
  const permitRequirements = (route.permitRequirements || []).map((permit) => {
    const sourceIds = uniqueValues((permit.sourceAssertions || [])
      .map((assertion) => assertion.sourceId));
    return {
      title: displayName(permit),
      detail: joinKnown([
        permit.reservationRequired === true
          ? "Reservation required"
          : permit.reservationRequired === false
            ? "Reservation not reported as required"
            : "Reservation requirement unknown",
        permit.quotaApplies === true
          ? "Quota applies"
          : permit.quotaApplies === false
            ? "No quota reported"
            : "Quota unknown",
        permit.bookingUrl ? `Booking: ${permit.bookingUrl}` : "Booking source unknown",
        permit.authoritySourceId ? `Authority source: ${permit.authoritySourceId}` : "",
        permit.sourceId ? `Source: ${permit.sourceId}` : "",
        sourceIds.length ? `Sources: ${sourceIds.join(", ")}` : "",
        permit.summary,
      ]),
    };
  });
  const assertions = (route.sourceAssertions || []).map((assertion) => ({
    source: assertion.sourceId || "Source unknown",
    field: assertion.fieldPath || "Field unknown",
    evidence: humanize(assertion.evidenceKind || "evidence unknown"),
    verification: humanize(assertion.verificationStatus || "unverified"),
    confidence: percentOrUnknown(assertion.confidence),
    date: assertion.observedAt
      ? `Observed ${formatDate(assertion.observedAt)}`
      : assertion.retrievedAt
        ? `Retrieved ${formatDate(assertion.retrievedAt)}`
        : "Observation/retrieval date unknown",
    notes: assertion.notes || "",
  }));
  const unknowns = new Set(assessment.uncertainties || []);
  for (const flag of route.quality?.flags || []) unknowns.add(humanize(flag));
  if (!reportedDistance) unknowns.add("No reported route distance; displayed length is calculated from overview geometry.");
  if (!positiveNumber(metrics.ascentMeters)) unknowns.add("Ascent unknown.");
  if (!positiveNumber(metrics.descentMeters)) unknowns.add("Descent unknown.");
  if (!positiveNumber(metrics.typicalDurationMinutes)) unknowns.add("Typical duration unknown.");
  if (!route.difficulty) unknowns.add("Difficulty not supplied.");
  if (!segments.length) unknowns.add("Terrain, surface, trail class, and visibility not supplied.");
  if (!(route.seasons || []).length) unknowns.add("Seasonal suitability unknown.");
  if (!hazards.length) unknowns.add("Hazards not supplied; absence of a hazard record does not mean no hazard exists.");
  if (!conditions.length) unknowns.add("Current trail conditions unknown.");
  if (!restrictions.length && !permitRequirements.length) {
    unknowns.add("Restrictions and permit requirements are not supplied.");
  }
  if (route.access?.legal === "unknown") unknowns.add("Legal public access is not verified.");

  return {
    id: route.id,
    title: displayName(route),
    atAGlance: [
      distance,
      fact("Typical time", durationLabel(metrics.typicalDurationMinutes)),
      fact("Ascent", distanceMetersLabel(metrics.ascentMeters)),
      fact("Descent", distanceMetersLabel(metrics.descentMeters)),
      fact("Difficulty", difficulty),
      fact("Route shape", humanize(route.journeyShape || "unknown")),
    ],
    routeCharacter: [
      fact("Activity", listOrUnknown(route.activities)),
      fact("Route type", humanize(route.routeNature || "unknown")),
      fact("Direction", humanize(route.direction || "unknown")),
      fact("Geometry", geometryRepresentationLabel(route)),
      fact("Surface", surfaces.length ? surfaces.map(humanize).join(", ") : "Unknown"),
      fact("Trail class", trailClasses.length ? trailClasses.map(humanize).join(", ") : "Unknown"),
      fact("Visibility / wayfinding", visibility.length ? visibility.map(humanize).join(", ") : "Unknown"),
    ],
    gettingThere: {
      access: accessLabel(route.access?.legal),
      modes: listOrUnknown(route.access?.modes),
      accessPoints,
      transportConnections,
    },
    safety: {
      seasons: listOrUnknown(route.seasons),
      hazards,
      conditions,
      restrictions,
      permitRequirements,
      unknowns: [...unknowns],
    },
    confidence: {
      verification: humanize(route.quality?.verificationStatus || "unverified"),
      overall: percentOrUnknown(route.quality?.confidence),
      geometry: percentOrUnknown(route.quality?.geometryConfidence),
      access: percentOrUnknown(route.quality?.accessConfidence),
      freshness: humanize(route.quality?.freshness || "unknown"),
      assessedAt: route.quality?.assessedAt ? formatDate(route.quality.assessedAt) : "Unknown",
      assertions,
    },
    export: {
      gpx: assessTrailRouteExport(route, "gpx"),
      geojson: assessTrailRouteExport(route, "geojson"),
      disclaimer: ROUTE_SAFETY_DISCLAIMER,
    },
  };
}

export function renderHikeDetail(container, route, options = {}) {
  const documentRef = container?.ownerDocument || globalThis.document;
  if (!container || !documentRef) throw new TypeError("A DOM container is required");
  const model = buildHikeDetailModel(route, options.assessment);
  const root = node(documentRef, "div", "hike-detail");
  root.append(
    definitionSection(documentRef, HIKE_DETAIL_SECTION_TITLES[0], model.atAGlance, "hike-at-a-glance"),
    definitionSection(documentRef, HIKE_DETAIL_SECTION_TITLES[1], model.routeCharacter),
    gettingThereSection(documentRef, model.gettingThere),
    safetySection(documentRef, model.safety),
    confidenceSection(documentRef, model.confidence),
  );

  const actionSection = node(documentRef, "section", "hike-actions");
  const actionTitle = node(documentRef, "h3", "", "Plan and download");
  const actionRow = node(documentRef, "div", "hike-action-row");
  const statusId = `hikeActionStatus-${safeId(route.id)}`;
  const status = node(documentRef, "p", "hike-action-status", [
    model.export.geojson.message,
    model.export.gpx.allowed ? model.export.gpx.message : model.export.gpx.message,
    model.export.disclaimer,
  ].join(" "));
  status.id = statusId;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.tabIndex = -1;

  const itineraryOutput = node(documentRef, "div", "discover-itinerary-output");
  itineraryOutput.setAttribute("aria-live", "polite");
  itineraryOutput.setAttribute("aria-label", "Planned journey result");
  const plan = actionButton(documentRef, "Plan access + route", statusId);
  plan.addEventListener("click", async () => {
    await invokeAction(options.onPlan, route, itineraryOutput, status, "Route planning opened.");
  });
  const gpx = exportButton(
    documentRef,
    "Download GPX",
    model.export.gpx,
    statusId,
    () => options.onDownloadGpx?.(route),
    status,
  );
  const geojson = exportButton(
    documentRef,
    "Download GeoJSON",
    model.export.geojson,
    statusId,
    () => options.onDownloadGeoJson?.(route),
    status,
  );
  actionRow.append(plan, gpx, geojson);
  actionSection.append(actionTitle, actionRow, status, itineraryOutput);
  root.append(actionSection);
  container.append(root);
  return { model, root, status, itineraryOutput };
}

function definitionSection(documentRef, title, facts, className = "") {
  const section = node(documentRef, "section", className);
  section.append(node(documentRef, "h3", "", title));
  const definitions = node(documentRef, "dl", "hike-fact-grid");
  for (const item of facts) {
    definitions.append(
      node(documentRef, "dt", "", item.term),
      node(documentRef, "dd", item.value === "Unknown" ? "is-unknown" : "", item.value),
    );
  }
  section.append(definitions);
  return section;
}

function gettingThereSection(documentRef, model) {
  const section = node(documentRef, "section", "hike-getting-there");
  section.append(node(documentRef, "h3", "", HIKE_DETAIL_SECTION_TITLES[2]));
  const definitions = node(documentRef, "dl", "hike-fact-grid");
  definitions.append(
    node(documentRef, "dt", "", "Legal access"),
    node(documentRef, "dd", model.access.startsWith("Unknown") ? "is-unknown" : "", model.access),
    node(documentRef, "dt", "", "Access modes"),
    node(documentRef, "dd", model.modes === "Unknown" ? "is-unknown" : "", model.modes),
  );
  section.append(definitions);
  section.append(itemGroup(
    documentRef,
    "Trailheads and parking",
    model.accessPoints,
    "No linked trailhead or parking details are supplied.",
  ));
  section.append(itemGroup(
    documentRef,
    "Transit, ferry, and cable transport",
    model.transportConnections,
    "No linked transport details are supplied.",
  ));
  return section;
}

function safetySection(documentRef, model) {
  const section = node(documentRef, "section", "hike-safety");
  section.append(node(documentRef, "h3", "", HIKE_DETAIL_SECTION_TITLES[3]));
  const definitions = node(documentRef, "dl", "hike-fact-grid");
  definitions.append(
    node(documentRef, "dt", "", "Season"),
    node(documentRef, "dd", model.seasons === "Unknown" ? "is-unknown" : "", model.seasons),
  );
  section.append(definitions);
  section.append(
    itemGroup(
      documentRef,
      "Known hazards",
      model.hazards,
      "Hazards not supplied; absence of a hazard record does not mean no hazard exists.",
    ),
    itemGroup(
      documentRef,
      "Current conditions",
      model.conditions,
      "Current trail conditions unknown.",
    ),
    itemGroup(
      documentRef,
      "Restrictions and permits",
      [...model.restrictions, ...model.permitRequirements],
      "Restrictions and permit requirements are not supplied.",
    ),
  );
  const unknowns = node(documentRef, "div", "hike-unknowns");
  unknowns.append(node(documentRef, "h4", "", "Unknowns and cautions"));
  const list = node(documentRef, "ul");
  for (const text of model.unknowns) list.append(node(documentRef, "li", "", text));
  unknowns.append(list);
  section.append(unknowns);
  return section;
}

function confidenceSection(documentRef, model) {
  const section = node(documentRef, "section", "hike-confidence");
  section.append(node(documentRef, "h3", "", HIKE_DETAIL_SECTION_TITLES[4]));
  const definitions = node(documentRef, "dl", "hike-fact-grid");
  for (const [term, value] of [
    ["Verification", model.verification],
    ["Overall confidence", model.overall],
    ["Geometry confidence", model.geometry],
    ["Access confidence", model.access],
    ["Freshness", model.freshness],
    ["Assessed", model.assessedAt],
  ]) {
    definitions.append(
      node(documentRef, "dt", "", term),
      node(documentRef, "dd", value === "Unknown" ? "is-unknown" : "", value),
    );
  }
  section.append(definitions);
  const sources = node(documentRef, "div", "hike-sources");
  sources.append(node(documentRef, "h4", "", "Sources and provenance"));
  if (!model.assertions.length) {
    sources.append(node(documentRef, "p", "is-unknown", "No source assertions supplied."));
  } else {
    const list = node(documentRef, "ul");
    for (const assertion of model.assertions) {
      const item = node(documentRef, "li");
      item.append(
        node(documentRef, "strong", "", assertion.source),
        node(documentRef, "span", "", joinKnown([
          assertion.field,
          assertion.evidence,
          assertion.verification,
          assertion.confidence,
          assertion.date,
        ])),
      );
      if (assertion.notes) item.append(node(documentRef, "small", "", assertion.notes));
      list.append(item);
    }
    sources.append(list);
  }
  section.append(sources);
  return section;
}

function itemGroup(documentRef, title, items, emptyText) {
  const group = node(documentRef, "div", "hike-item-group");
  group.append(node(documentRef, "h4", "", title));
  if (!items.length) {
    group.append(node(documentRef, "p", "is-unknown", emptyText));
    return group;
  }
  const list = node(documentRef, "ul");
  for (const item of items) {
    const entry = node(documentRef, "li");
    entry.append(node(documentRef, "strong", "", item.title), node(documentRef, "span", "", item.detail));
    list.append(entry);
  }
  group.append(list);
  return group;
}

function exportButton(documentRef, label, assessment, statusId, callback, status) {
  const button = actionButton(documentRef, label, statusId);
  button.setAttribute("aria-disabled", String(!assessment.allowed));
  button.addEventListener("click", async () => {
    if (!assessment.allowed) {
      announce(status, assessment.message);
      return;
    }
    await invokeAction(callback, null, null, status, `${label} created. ${ROUTE_SAFETY_DISCLAIMER}`);
  });
  return button;
}

function actionButton(documentRef, label, statusId) {
  const button = node(documentRef, "button", "hike-action", label);
  button.type = "button";
  button.setAttribute("aria-describedby", statusId);
  return button;
}

async function invokeAction(callback, route, output, status, successText) {
  if (typeof callback !== "function") {
    announce(status, "This action is not configured.");
    return;
  }
  try {
    await callback(route, output);
    announce(status, successText);
  } catch (error) {
    announce(status, `Action failed: ${error?.message || "Unknown error"}.`);
  }
}

function announce(status, text) {
  status.textContent = text;
  status.focus({ preventScroll: true });
}

function accessPointModel(point) {
  const parking = point.parking;
  const parkingFacts = parking
    ? [
        parking.name || "Parking name unknown",
        typeof parking.stoppingAllowed === "boolean"
          ? parking.stoppingAllowed ? "Stopping reported as allowed" : "Stopping not allowed"
          : "Stopping rules unknown",
        Number.isInteger(parking.spaces) ? `${parking.spaces} spaces reported` : "Capacity unknown",
        typeof parking.fee === "boolean" ? parking.fee ? "Fee reported" : "No fee reported" : "Fee unknown",
        parking.opensLocal || parking.closesLocal
          ? `Hours ${parking.opensLocal || "opening unknown"}–${parking.closesLocal || "closing unknown"}`
          : "Hours unknown",
      ]
    : ["Parking details unknown"];
  return {
    title: displayName(point),
    detail: joinKnown([
      accessLabel(point.legalAccess),
      listOrUnknown(point.accessModes),
      ...parkingFacts,
    ]),
  };
}

function transportModel(connection) {
  const schedule = connection.schedule || {};
  return {
    title: displayName(connection),
    detail: joinKnown([
      humanize(connection.transportMode || "mode unknown"),
      connection.direction ? `Direction: ${humanize(connection.direction)}` : "Direction unknown",
      positiveNumber(connection.typicalDurationMinutes)
        ? `Typical time ${durationLabel(connection.typicalDurationMinutes)}`
        : "Duration unknown",
      `Schedule freshness: ${humanize(schedule.freshness || "unknown")}`,
      schedule.lastDepartureLocal
        ? `Last departure ${schedule.lastDepartureLocal}`
        : "Last departure unknown",
    ]),
  };
}

function fact(term, value) {
  return { term, value };
}

function difficultyLabel(difficulty) {
  if (!difficulty || typeof difficulty !== "object") return "Unknown";
  const original = difficulty.originalGrade && difficulty.originalScale
    ? `${difficulty.originalGrade} (${difficulty.originalScale})`
    : difficulty.originalGrade || difficulty.originalScale || "";
  const normalized = difficulty.normalizedBand
    ? `Normalized: ${humanize(difficulty.normalizedBand)}`
    : "";
  return joinKnown([original, normalized, difficulty.normalizationCaveat]) || "Unknown";
}

function accessLabel(value) {
  switch (value) {
    case "legal": return "Public access reported";
    case "restricted": return "Restricted; verify current rules";
    case "private": return "Private; public access not permitted";
    default: return "Unknown; legal public access is not verified";
  }
}

function durationLabel(value) {
  const minutes = positiveNumber(value);
  if (!minutes) return "Unknown";
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${hours} h${remainder ? ` ${remainder} min` : ""}`;
}

function distanceMetersLabel(value) {
  const meters = positiveNumber(value);
  return meters ? `${Math.round(meters).toLocaleString("en")} m` : "Unknown";
}

function formatDistance(meters) {
  const kilometers = meters / 1000;
  return `${kilometers.toFixed(kilometers < 10 ? 1 : 0)} km`;
}

function listOrUnknown(values) {
  const items = uniqueValues(values || []);
  return items.length ? items.map(humanize).join(", ") : "Unknown";
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function percentOrUnknown(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "Unknown";
}

function dateRange(from, until) {
  if (!from && !until) return "";
  return `Effective ${from ? formatDate(from) : "from unknown"} to ${until ? formatDate(until) : "open-ended"}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });
}

function humanize(value) {
  return String(value || "unknown")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function joinKnown(values) {
  return values.filter((value) => typeof value === "string" && value.trim()).join(" · ");
}

function node(documentRef, tag, className = "", text = null) {
  const element = documentRef.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function safeId(value) {
  return String(value || "route").replace(/[^a-z0-9_-]+/gi, "-");
}
