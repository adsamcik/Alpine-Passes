import {
  displayName,
  haversineMeters,
  lineDistanceMeters,
  validPosition,
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

const HOUR_MILLISECONDS = 60 * 60 * 1_000;
export const DEFAULT_SAFETY_FRESHNESS_POLICY = Object.freeze({
  maxAgeMilliseconds: 72 * HOUR_MILLISECONDS,
  maxFutureSkewMilliseconds: 5 * 60 * 1_000,
});

const TRANSPORT_ENDPOINT_TOLERANCE_METERS = 250;
const TRANSIT_ACCESS_MODES = new Set(["transit", "ferry", "cable_transport"]);
const TRANSIT_CONNECTION_MODES = new Set([
  "ferry",
  "bus",
  "rail",
  "tram",
  "cable_car",
  "gondola",
  "funicular",
  "cog_railway",
  "boat",
]);
const UNSAFE_PLANNING_FLAG_PATTERN = /(unsafe|danger|hazard|closed|closure|blocked|prohibited|stale|expired|unknown|unverified|conflict)/i;

/**
 * Exposes only access choices backed by linked route data. The itinerary
 * contract intentionally groups public transport, ferries and cable transport
 * under its coarse `transit` access mode.
 */
export function buildJourneyOptions(route, options = {}) {
  if (route?.entityType !== "TrailRoute") {
    throw new TypeError("A TrailRoute is required");
  }
  const asOf = temporalBoundary(options.asOf ?? new Date(), false);
  const routeBlocker = routePlanningBlocker(route, asOf);
  if (routeBlocker) {
    return {
      accessModes: [],
      returnStrategies: [],
      canPlan: false,
      unavailableMessage: routeBlocker,
    };
  }
  const accessPoints = Array.isArray(route.accessPoints) ? route.accessPoints : [];
  const transportConnections = Array.isArray(route.transportConnections)
    ? route.transportConnections
    : [];
  const usableAccessPoints = accessPoints.filter((point) =>
    accessPointIsActionable(point, asOf));
  const accessModes = [];

  if (usableAccessPoints.some((point) =>
    point.accessModes.includes("car") && point.parking?.stoppingAllowed === true)) {
    accessModes.push({
      value: "car",
      label: "Drive to the route",
      detail: "Uses a verified linked access point where car access and stopping permission are reported.",
    });
  }
  if (usableAccessPoints.some((point) =>
    point.accessModes.includes("foot") || point.accessModes.includes("hiking"))) {
    accessModes.push({
      value: "foot",
      label: "Walk to the route",
      detail: "Uses a linked access point that reports a walk-in or hiking approach.",
    });
  }

  const transitSupport = usableAccessPoints.flatMap((point) =>
    transportConnections
      .filter((connection) => outboundConnectionSupportsPoint(connection, point, asOf))
      .map((connection) => ({ point, connection })));
  if (transitSupport.length) {
    const sourceModes = uniqueValues(transitSupport.flatMap(({ point, connection }) => [
      ...point.accessModes.filter((mode) => TRANSIT_ACCESS_MODES.has(mode)),
      connection.transportMode,
    ]));
    accessModes.push({
      value: "transit",
      label: "Transit, ferry, or cable transport",
      detail: `Current verified linked data reports ${sourceModes.map(humanize)
        .join(", ")}. Verify the current timetable before departure.`,
      sourceModes,
    });
  }

  const returnStrategies = [];
  const selfReturning = ["loop", "out_and_back"].includes(route.journeyShape);
  const verifiedReturn = usableAccessPoints.some((point) =>
    transportConnections.some((connection) =>
      returnConnectionSupportsRoute(connection, point, route, asOf)));
  if (selfReturning || verifiedReturn) {
    returnStrategies.push({
      value: "return_to_vehicle",
      label: "Return to the starting access point",
      detail: verifiedReturn && !selfReturning
        ? "Uses a current verified return connection to reach the starting access point."
        : "Returns along the route and any linked walking connector to the starting access point.",
    });
  }
  if (route.journeyShape === "point_to_point") {
    returnStrategies.push({
      value: "different_pickup",
      label: "Finish at a different pickup point",
      detail: "Ends at the route finish; arrange the pickup before departure.",
    });
  }

  let unavailableMessage = "";
  if (!accessModes.length) {
    unavailableMessage = "Planning is unavailable because no current verified public access point supports a safe approach.";
  } else if (!returnStrategies.length) {
    unavailableMessage = "Planning is unavailable because this route has no supported return or explicit pickup strategy.";
  }
  return {
    accessModes,
    returnStrategies,
    canPlan: accessModes.length > 0 && returnStrategies.length > 0,
    unavailableMessage,
  };
}

function routePlanningBlocker(route, asOf) {
  if (!asOf) {
    return "Planning is unavailable because the journey assessment time is invalid.";
  }
  if (route.routeNature !== "established"
      || route.geometryCompleteness !== "complete"
      || route.navigationSuitability !== true) {
    return "Planning requires complete, navigation-suitable geometry for an established walking or hiking route.";
  }
  if (route.sensitivity?.action !== "publish") {
    return "Planning is unavailable because precise route geometry is not approved for publication.";
  }
  if (route.access?.legal !== "legal") {
    return "Planning is unavailable because legal public route access is not verified.";
  }
  if (!qualityIsActionable(route.quality, asOf)) {
    return "Planning is unavailable because the route record is not verified as current.";
  }
  return "";
}

function accessPointIsActionable(point, asOf) {
  return point?.entityType === "AccessPoint"
    && point.legalAccess === "legal"
    && point.geometry?.type === "Point"
    && validPosition(point.geometry.coordinates)
    && point.sensitivity?.action === "publish"
    && qualityIsActionable(point.quality, asOf)
    && Array.isArray(point.accessModes);
}

function outboundConnectionSupportsPoint(connection, point, asOf) {
  if (!point.accessModes.some((mode) => TRANSIT_ACCESS_MODES.has(mode))
      || !connectionIsActionable(connection, asOf)
      || !["outbound", "both"].includes(connection.direction)
      || !connection.endpointIds.includes(point.id)) {
    return false;
  }
  const endpoints = geometryEndpoints(connection.geometry);
  if (!endpoints) return false;
  if (connection.direction === "outbound") {
    return haversineMeters(endpoints.end, point.geometry?.coordinates)
      <= TRANSPORT_ENDPOINT_TOLERANCE_METERS;
  }
  return Math.min(
    haversineMeters(endpoints.start, point.geometry?.coordinates),
    haversineMeters(endpoints.end, point.geometry?.coordinates),
  ) <= TRANSPORT_ENDPOINT_TOLERANCE_METERS;
}

function returnConnectionSupportsRoute(connection, point, route, asOf) {
  if (!connectionIsActionable(connection, asOf)
      || !["return", "both"].includes(connection.direction)
      || !connection.endpointIds.includes(point.id)) {
    return false;
  }
  const transport = geometryEndpoints(connection.geometry);
  const routeGeometry = geometryEndpoints(route.geometry);
  if (!transport || !routeGeometry) return false;
  const orientations = [[transport.start, transport.end]];
  if (connection.direction === "both") orientations.push([transport.end, transport.start]);
  return orientations.some(([start, end]) =>
    haversineMeters(routeGeometry.end, start) <= TRANSPORT_ENDPOINT_TOLERANCE_METERS
    && haversineMeters(point.geometry?.coordinates, end)
      <= TRANSPORT_ENDPOINT_TOLERANCE_METERS);
}

function connectionIsActionable(connection, asOf) {
  if (connection?.entityType !== "TransportConnection"
      || !TRANSIT_CONNECTION_MODES.has(connection.transportMode)
      || connection.operating !== true
      || connection.sensitivity?.action !== "publish"
      || !qualityIsActionable(connection.quality, asOf)
      || !Number.isFinite(connection.typicalDurationMinutes)
      || connection.typicalDurationMinutes <= 0
      || !Array.isArray(connection.endpointIds)
      || connection.endpointIds.length !== 2
      || connection.endpointIds.some((endpointId) =>
        typeof endpointId !== "string" || !endpointId.trim())
      || new Set(connection.endpointIds).size !== connection.endpointIds.length
      || !geometryEndpoints(connection.geometry)) {
    return false;
  }
  const schedule = connection.schedule;
  if (!scheduleIsActionable(schedule, asOf)) {
    return false;
  }
  return (connection.sourceAssertions || []).some((assertion) =>
    assertion?.verificationStatus === "verified"
    && (assertion.fieldPath === "/geometry"
      || String(assertion.fieldPath || "").startsWith("/geometry/"))
    && assertionIsCurrent(assertion, asOf));
}

function qualityIsActionable(quality, asOf) {
  const assessedAt = temporalBoundary(quality?.assessedAt, false);
  return quality?.verificationStatus === "verified"
    && quality.freshness === "current"
    && Array.isArray(quality.flags)
    && !quality.flags.some((flag) => UNSAFE_PLANNING_FLAG_PATTERN.test(String(flag)))
    && assessedAt !== null
    && assessedAt.getTime() <= asOf.getTime();
}

function scheduleIsActionable(schedule, asOf) {
  if (schedule?.freshness !== "current"
      || typeof schedule.timezone !== "string"
      || !schedule.timezone.trim()
      || !Array.isArray(schedule.departuresLocal)
      || schedule.departuresLocal.length === 0) {
    return false;
  }
  const departureMinutes = schedule.departuresLocal.map(clockMinutesOrNull);
  if (departureMinutes.some((value) => value === null)
      || new Set(departureMinutes).size !== departureMinutes.length) {
    return false;
  }
  const lastDeparture = schedule.lastDepartureLocal == null
    ? null
    : clockMinutesOrNull(schedule.lastDepartureLocal);
  if (schedule.lastDepartureLocal != null && lastDeparture === null) return false;
  if (lastDeparture !== null && departureMinutes.some((value) => value > lastDeparture)) {
    return false;
  }
  const validFrom = isoCalendarOrdinal(schedule.validFrom);
  const validUntil = isoCalendarOrdinal(schedule.validUntil);
  const localDate = dateOrdinalInTimezone(asOf, schedule.timezone);
  return validFrom !== null
    && validUntil !== null
    && validFrom <= validUntil
    && localDate !== null
    && localDate >= validFrom
    && localDate <= validUntil;
}

function assertionIsCurrent(assertion, asOf) {
  const observedAt = temporalBoundary(
    assertion.observedAt ?? assertion.retrievedAt ?? assertion.validFrom,
    false,
  );
  const validFrom = assertion.validFrom
    ? temporalBoundary(assertion.validFrom, false)
    : null;
  const validUntil = assertion.validUntil
    ? temporalBoundary(assertion.validUntil, true)
    : null;
  return observedAt !== null
    && observedAt.getTime() <= asOf.getTime()
    && (!assertion.validFrom
      || (validFrom !== null && validFrom.getTime() <= asOf.getTime()))
    && (!assertion.validUntil
      || (validUntil !== null && validUntil.getTime() >= asOf.getTime()));
}

function clockMinutesOrNull(value) {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(String(value || ""));
  return match ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)) : null;
}

function isoCalendarOrdinal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
      || date.getUTCMonth() + 1 !== month
      || date.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(date.getTime() / 86_400_000);
}

function dateOrdinalInTimezone(date, timezone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone.trim(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]));
    if (![parts.year, parts.month, parts.day].every(Number.isFinite)) return null;
    return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
  } catch {
    return null;
  }
}

function geometryEndpoints(geometry) {
  const lines = geometry?.type === "LineString"
    ? [geometry.coordinates]
    : geometry?.type === "MultiLineString"
      ? geometry.coordinates
      : [];
  if (!lines.length || lines.some((line) =>
    !Array.isArray(line) || line.length < 2 || line.some((position) => !validPosition(position)))) {
    return null;
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (haversineMeters(lines[index - 1].at(-1), lines[index][0])
        > TRANSPORT_ENDPOINT_TOLERANCE_METERS) {
      return null;
    }
  }
  return { start: lines[0][0], end: lines.at(-1).at(-1) };
}

export function buildHikeDetailModel(route, assessment = {}) {
  if (route?.entityType !== "TrailRoute") {
    throw new TypeError("A TrailRoute is required");
  }
  const isScenicDrive = route.routeNature === "scenic_drive"
    || (route.activities || []).includes("scenic_driving");
  const asOf = assessment.asOf ?? assessment.now ?? new Date();
  const safetyFreshnessPolicy = assessment.safetyFreshnessPolicy;
  const exportAssessmentOptions = {
    asOf,
    gpxPolicy: assessment.gpxExportPolicy,
  };
  const metrics = route.metrics || {};
  const reportedDistance = positiveNumber(metrics.distanceMeters);
  const geometryDistance = lineDistanceMeters(route.geometry);
  const geometryDistanceContext = geometryDistanceLabel(route);
  const distance = reportedDistance
    ? fact("Reported distance", formatDistance(reportedDistance))
    : Number.isFinite(geometryDistance) && geometryDistance > 0
      ? fact("Geometry length", `${formatDistance(geometryDistance)} · ${geometryDistanceContext}`)
      : fact("Distance", "Unknown");
  const ascent = nonNegativeNumber(metrics.ascentMeters);
  const descent = nonNegativeNumber(metrics.descentMeters);
  const difficulty = difficultyLabel(route.difficulty);
  const segments = route.trailSegments || route.segments || [];
  const surfaces = uniqueValues(segments.map((segment) => segment.surface));
  const trailClasses = uniqueValues(segments.map((segment) => segment.trailClass));
  const visibility = uniqueValues(segments.map((segment) => segment.visibility));
  const accessPoints = (route.accessPoints || []).map(accessPointModel);
  const transportConnections = (route.transportConnections || []).map(transportModel);
  const hazards = (route.hazards || []).map((hazard) => safetyRecordModel(hazard, [
      humanize(hazard.hazardKind),
      hazard.severity ? `${humanize(hazard.severity)} severity` : "Severity unknown",
      hazard.summary,
    ], asOf, safetyFreshnessPolicy));
  const conditions = (route.conditions || []).map((condition) => safetyRecordModel(condition, [
      humanize(condition.conditionKind),
      condition.state ? `State: ${humanize(condition.state)}` : "State unknown",
      condition.checkedAt ? `Checked ${formatDate(condition.checkedAt)}` : "Check time unknown",
      condition.summary,
    ], asOf, safetyFreshnessPolicy));
  const restrictions = (route.restrictions || []).map((restriction) => safetyRecordModel(restriction, [
      humanize(restriction.restrictionKind),
      restriction.summary,
    ], asOf, safetyFreshnessPolicy));
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
  if (!reportedDistance && Number.isFinite(geometryDistance) && geometryDistance > 0) {
    unknowns.add(`No reported route distance; displayed length is calculated from ${geometryDistanceContext}.`);
  }
  if (!isScenicDrive && ascent == null) unknowns.add("Ascent unknown.");
  if (!isScenicDrive && descent == null) unknowns.add("Descent unknown.");
  if (!positiveNumber(metrics.typicalDurationMinutes)) unknowns.add("Typical duration unknown.");
  if (!isScenicDrive && !route.difficulty) unknowns.add("Difficulty not supplied.");
  if (!segments.length) {
    unknowns.add(isScenicDrive
      ? "Road surface and drive-character details are not supplied."
      : "Terrain, surface, trail class, and visibility not supplied.");
  }
  if (!(route.seasons || []).length) unknowns.add("Seasonal suitability unknown.");
  if (!hazards.length) {
    unknowns.add(isScenicDrive
      ? "Road hazards are not supplied; absence of a hazard record does not mean no hazard exists."
      : "Hazards not supplied; absence of a hazard record does not mean no hazard exists.");
  }
  if (!conditions.some((condition) => condition.temporalStatus === "current")) {
    unknowns.add(isScenicDrive ? "Current road conditions unknown." : "Current trail conditions unknown.");
  }
  if (!restrictions.length && !permitRequirements.length) {
    unknowns.add(isScenicDrive
      ? "Road restrictions, closures, tolls, and permit requirements are not supplied."
      : "Restrictions and permit requirements are not supplied.");
  }
  if (route.access?.legal === "unknown") {
    unknowns.add(isScenicDrive
      ? "Legal road access is not verified."
      : "Legal public access is not verified.");
  }

  return {
    id: route.id,
    title: displayName(route),
    routeKind: isScenicDrive ? "scenic_drive" : "hike",
    atAGlance: isScenicDrive
      ? [
          distance,
          fact("Typical drive time", durationLabel(metrics.typicalDurationMinutes)),
          fact("Route shape", humanize(route.journeyShape || "unknown")),
          fact("Direction", humanize(route.direction || "unknown")),
          fact("Road access", accessLabel(route.access?.legal)),
          fact("Geometry", geometryRepresentationLabel(route)),
        ]
      : [
          distance,
          fact("Typical time", durationLabel(metrics.typicalDurationMinutes)),
          fact("Ascent", distanceMetersLabel(metrics.ascentMeters)),
          fact("Descent", distanceMetersLabel(metrics.descentMeters)),
          fact("Difficulty", difficulty),
          fact("Route shape", humanize(route.journeyShape || "unknown")),
        ],
    routeCharacter: isScenicDrive
      ? [
          fact("Activity", listOrUnknown(route.activities)),
          fact("Drive type", humanize(route.routeNature || "scenic_drive")),
          fact("Drive character", driveCharacterLabel(route)),
          fact("Road surface", surfaces.length ? surfaces.map(humanize).join(", ") : "Unknown"),
          fact("Vehicle access", listOrUnknown(route.access?.modes)),
          fact("Geometry", geometryRepresentationLabel(route)),
        ]
      : [
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
      accessTerm: isScenicDrive ? "Legal road access" : "Legal access",
      modesTerm: isScenicDrive ? "Road access modes" : "Access modes",
      accessPointsTitle: isScenicDrive ? "Road access, parking, and stops" : "Trailheads and parking",
      accessPointsEmpty: isScenicDrive
        ? "No linked road-access, parking, or stopping details are supplied."
        : "No linked trailhead or parking details are supplied.",
      transportTitle: isScenicDrive
        ? "Ferries and other transport connections"
        : "Transit, ferry, and cable transport",
    },
    safety: {
      routeKind: isScenicDrive ? "scenic_drive" : "hike",
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
    journeyOptions: buildJourneyOptions(route, { asOf }),
    export: {
      gpx: assessTrailRouteExport(route, "gpx", exportAssessmentOptions),
      geojson: assessTrailRouteExport(route, "geojson", exportAssessmentOptions),
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
  const journeyControls = journeyOptionControls(
    documentRef,
    route,
    model.journeyOptions,
  );
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
  plan.setAttribute("aria-disabled", String(!model.journeyOptions.canPlan));
  plan.addEventListener("click", async () => {
    if (!model.journeyOptions.canPlan) {
      announce(status, model.journeyOptions.unavailableMessage);
      return;
    }
    const onPlan = typeof options.onPlan === "function"
      ? (selectedRoute, selectedOutput) => options.onPlan(
          selectedRoute,
          selectedOutput,
          journeyControls.selection(),
        )
      : null;
    await invokeAction(
      onPlan,
      route,
      itineraryOutput,
      status,
      "Route itinerary built.",
      { requireItinerary: true },
    );
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
  actionSection.append(actionTitle, journeyControls.root, actionRow, status, itineraryOutput);
  root.append(actionSection);
  container.append(root);
  return { model, root, status, itineraryOutput };
}

function journeyOptionControls(documentRef, route, model) {
  const root = node(documentRef, "div", "hike-journey-options");
  if (!model.canPlan) {
    root.append(node(documentRef, "p", "is-unknown", model.unavailableMessage));
    return { root, selection: () => null };
  }

  const routeId = safeId(route.id);
  const access = radioFieldset(
    documentRef,
    "Access to the route",
    `hikeAccessMode-${routeId}`,
    model.accessModes,
    `hikeAccessModeDescription-${routeId}`,
  );
  const returnStrategy = radioFieldset(
    documentRef,
    "After the route",
    `hikeReturnStrategy-${routeId}`,
    model.returnStrategies,
    `hikeReturnStrategyDescription-${routeId}`,
  );
  root.append(access.root, returnStrategy.root);
  return {
    root,
    selection: () => ({
      accessMode: selectedRadioValue(access.inputs),
      returnStrategy: selectedRadioValue(returnStrategy.inputs),
    }),
  };
}

function radioFieldset(documentRef, legendText, name, options, descriptionId) {
  const fieldset = node(documentRef, "fieldset", "hike-item-group");
  fieldset.append(node(documentRef, "legend", "", legendText));
  const description = node(
    documentRef,
    "p",
    "",
    "Choose one option. Only choices supported by linked route records are shown.",
  );
  description.id = descriptionId;
  fieldset.append(description);
  const list = node(documentRef, "ul");
  const inputs = [];
  options.forEach((option, index) => {
    const item = node(documentRef, "li");
    const label = node(documentRef, "label");
    const input = node(documentRef, "input");
    const optionId = `${name}-${safeId(option.value)}`;
    const detailId = `${optionId}-detail`;
    input.type = "radio";
    input.name = name;
    input.value = option.value;
    input.id = optionId;
    input.checked = index === 0;
    input.required = true;
    input.setAttribute("aria-describedby", `${descriptionId} ${detailId}`);
    const detail = node(documentRef, "span", "", option.detail);
    detail.id = detailId;
    label.append(input, node(documentRef, "strong", "", option.label), detail);
    item.append(label);
    list.append(item);
    inputs.push(input);
  });
  fieldset.append(list);
  return { root: fieldset, inputs };
}

function selectedRadioValue(inputs) {
  return inputs.find((input) => input.checked)?.value || null;
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
    node(documentRef, "dt", "", model.accessTerm),
    node(documentRef, "dd", model.access.startsWith("Unknown") ? "is-unknown" : "", model.access),
    node(documentRef, "dt", "", model.modesTerm),
    node(documentRef, "dd", model.modes === "Unknown" ? "is-unknown" : "", model.modes),
  );
  section.append(definitions);
  section.append(itemGroup(
    documentRef,
    model.accessPointsTitle,
    model.accessPoints,
    model.accessPointsEmpty,
  ));
  section.append(itemGroup(
    documentRef,
    model.transportTitle,
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
      model.routeKind === "scenic_drive" ? "Known road hazards" : "Known hazards",
      model.hazards,
      model.routeKind === "scenic_drive"
        ? "Road hazards are not supplied; absence of a hazard record does not mean no hazard exists."
        : "Hazards not supplied; absence of a hazard record does not mean no hazard exists.",
    ),
    itemGroup(
      documentRef,
      "Condition reports",
      model.conditions,
      model.routeKind === "scenic_drive"
        ? "Current road conditions unknown."
        : "Current trail conditions unknown.",
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

export async function invokeAction(
  callback,
  route,
  output,
  status,
  successText,
  { requireItinerary = false } = {},
) {
  if (typeof callback !== "function") {
    announce(status, "This action is not configured.");
    return { ok: false, code: "action_not_configured" };
  }
  try {
    const result = await callback(route, output);
    const hasItinerary = result?.ok === true
      && result.itinerary
      && Array.isArray(result.itinerary.legs)
      && result.itinerary.legs.length > 0;
    if (result === false || result?.ok === false || (requireItinerary && !hasItinerary)) {
      const failure = result?.message
        || (requireItinerary
          ? "Route planning did not produce an itinerary."
          : "The action did not complete.");
      announce(status, failure);
      return result?.ok === false
        ? result
        : { ok: false, code: "action_incomplete", message: failure };
    }
    announce(status, successText);
    return result ?? { ok: true };
  } catch (error) {
    const message = `Action failed: ${error?.message || "Unknown error"}.`;
    announce(status, message);
    return { ok: false, code: error?.code || "action_failed", message, error };
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

function safetyRecordModel(record, content, asOf, freshnessPolicy) {
  const temporalStatus = classifySafetyRecordTemporalStatus(record, asOf, freshnessPolicy);
  const assertionVerification = uniqueValues((record.sourceAssertions || [])
    .map((assertion) => assertion.verificationStatus));
  const verification = humanize(record.quality?.verificationStatus || "unknown");
  const verificationDetail = assertionVerification.length
    ? `${verification}; assertions: ${assertionVerification.map(humanize).join(", ")}`
    : verification;
  const freshness = humanize(record.quality?.freshness || "unknown");
  const sources = uniqueValues([
    record.authoritySourceId,
    record.sourceId,
    ...(record.sourceAssertions || []).map((assertion) => assertion.sourceId),
  ]);
  const validity = safetyRecordValidity(record);
  return {
    title: displayName(record),
    temporalStatus,
    verification,
    freshness,
    sources,
    validity,
    detail: joinKnown([
      ...content,
      `Temporal status: ${humanize(temporalStatus)}`,
      `Verification: ${verificationDetail}`,
      `Freshness: ${freshness}`,
      `Sources: ${sources.length ? sources.join(", ") : "Unknown"}`,
      `Validity: ${validity}`,
    ]),
  };
}

export function classifySafetyRecordTemporalStatus(record, asOf = new Date(), freshnessPolicy) {
  if (!record || typeof record !== "object") return "unknown";
  const now = temporalBoundary(asOf, false);
  if (!now) return "unknown";
  const directFromValue = record.effectiveFrom ?? record.validFrom;
  const directUntilValue = record.effectiveUntil ?? record.validUntil;
  const directFrom = temporalBoundary(directFromValue, false);
  const directUntil = temporalBoundary(directUntilValue, true);
  const state = String(record.state || "").toLowerCase();
  const verification = String(record.quality?.verificationStatus || "").toLowerCase();
  const freshness = String(record.quality?.freshness || "").toLowerCase();
  const invalidDirectBoundary = Boolean(
    (directFromValue && !directFrom) || (directUntilValue && !directUntil),
  );

  if ((directUntil && directUntil.getTime() < now.getTime())
      || state === "expired"
      || verification === "expired"
      || freshness === "expired") {
    return "expired";
  }
  if (invalidDirectBoundary) return "unknown";
  if ((directFrom && directFrom.getTime() > now.getTime()) || state === "scheduled") {
    return "scheduled";
  }

  const assertions = record.sourceAssertions || [];
  const invalidAssertionBoundary = assertions.some((assertion) =>
    (assertion.validFrom && !temporalBoundary(assertion.validFrom, false))
    || (assertion.validUntil && !temporalBoundary(assertion.validUntil, true)));
  const assertionWindows = assertions
    .map((assertion) => ({
      from: temporalBoundary(assertion.validFrom, false),
      until: temporalBoundary(assertion.validUntil, true),
    }))
    .filter(({ from, until }) => from || until);
  const everyAssertionBounded = assertions.length > 0
    && assertionWindows.length === assertions.length;
  if (invalidAssertionBoundary) return "unknown";
  if (everyAssertionBounded
      && assertionWindows.every(({ until }) => until && until.getTime() < now.getTime())) {
    return "expired";
  }
  if (everyAssertionBounded
      && assertionWindows.every(({ from }) => from && from.getTime() > now.getTime())) {
    return "scheduled";
  }

  const assertionWindowIsCurrent = assertionWindows.some(({ from, until }) =>
    (!from || from.getTime() <= now.getTime())
    && (!until || until.getTime() >= now.getTime()));
  const assertionValidityAllowsCurrent = assertionWindows.length === 0 || assertionWindowIsCurrent;
  const conditionStateAllowsCurrent = state === "live"
    || (state === "seasonal"
      && Boolean(directFrom || directUntil || assertionWindowIsCurrent));
  const stateAllowsCurrent = record.entityType === "Condition"
    ? conditionStateAllowsCurrent
    : !["scheduled", "expired"].includes(state);
  const verificationAllowsCurrent = ["verified", "partially_verified"].includes(verification);
  if (stateAllowsCurrent
      && verificationAllowsCurrent
      && freshness === "current"
      && safetyRecordIsFresh(record, now, freshnessPolicy)
      && assertionValidityAllowsCurrent) {
    return "current";
  }
  return "unknown";
}

function safetyRecordIsFresh(record, now, rawPolicy) {
  const policy = normalizeSafetyFreshnessPolicy(rawPolicy);
  if (!policy) return false;
  const timestampValues = [
    record.checkedAt,
    record.observedAt,
    record.retrievedAt,
    record.quality?.assessedAt,
    ...(record.sourceAssertions || []).flatMap((assertion) => [
      assertion.observedAt,
      assertion.retrievedAt,
    ]),
  ].filter((value) => value !== undefined && value !== null && value !== "");
  if (!timestampValues.length) return false;
  const timestamps = timestampValues.map((value) => temporalBoundary(value, false));
  if (timestamps.some((value) => !value)) return false;
  const nowMilliseconds = now.getTime();
  const futureLimit = nowMilliseconds + policy.maxFutureSkewMilliseconds;
  if (timestamps.some((value) => value.getTime() > futureLimit)) return false;
  return timestamps.every((value) =>
    nowMilliseconds - value.getTime() <= policy.maxAgeMilliseconds);
}

function normalizeSafetyFreshnessPolicy(rawPolicy) {
  const policy = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {};
  const maxAgeMilliseconds = policy.maxAgeMilliseconds
    ?? DEFAULT_SAFETY_FRESHNESS_POLICY.maxAgeMilliseconds;
  const maxFutureSkewMilliseconds = policy.maxFutureSkewMilliseconds
    ?? DEFAULT_SAFETY_FRESHNESS_POLICY.maxFutureSkewMilliseconds;
  if (!Number.isFinite(maxAgeMilliseconds) || maxAgeMilliseconds < 0
      || !Number.isFinite(maxFutureSkewMilliseconds) || maxFutureSkewMilliseconds < 0) {
    return null;
  }
  return { maxAgeMilliseconds, maxFutureSkewMilliseconds };
}

function safetyRecordValidity(record) {
  const directFrom = record.effectiveFrom ?? record.validFrom;
  const directUntil = record.effectiveUntil ?? record.validUntil;
  if (directFrom || directUntil) return dateRange(directFrom, directUntil);
  const assertionRanges = (record.sourceAssertions || [])
    .filter((assertion) => assertion.validFrom || assertion.validUntil)
    .map((assertion) => {
      const source = assertion.sourceId || "source unknown";
      return `${source}: ${dateRange(assertion.validFrom, assertion.validUntil)}`;
    });
  return assertionRanges.length ? assertionRanges.join("; ") : "Unknown";
}

function temporalBoundary(value, endOfDate) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-").map(Number);
    const timestamp = endOfDate
      ? Date.UTC(year, month - 1, day, 23, 59, 59, 999)
      : Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day
      ? date
      : null;
  }
  return validDate(value);
}

function validDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function geometryDistanceLabel(route) {
  if (route.geometryCompleteness === "complete" && route.navigationSuitability === true) {
    return "complete navigation-suitable geometry";
  }
  if (route.geometryCompleteness === "complete") {
    return "complete geometry that is not navigation-suitable";
  }
  if (route.geometryCompleteness === "partial") return "partial geometry only";
  if (route.geometryCompleteness === "overview_only") return "overview/generalized geometry only";
  return "geometry with unknown completeness and navigation suitability";
}

function driveCharacterLabel(route) {
  const direct = Array.isArray(route.driveCharacter)
    ? route.driveCharacter
    : route.driveCharacter ? [route.driveCharacter] : [];
  const classifications = (route.classifications || [])
    .map((classification) => classification.normalized || classification.original)
    .filter((value) => value !== "scenic_drive");
  const values = uniqueValues([...direct, ...(route.themes || []), ...classifications]);
  return values.length ? values.slice(0, 8).map(humanize).join(", ") : "Unknown";
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
  const meters = nonNegativeNumber(value);
  return meters == null ? "Unknown" : `${Math.round(meters).toLocaleString("en")} m`;
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

function nonNegativeNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function percentOrUnknown(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "Unknown";
}

function dateRange(from, until) {
  if (!from && !until) return "";
  return `Effective ${from ? formatDate(from) : "from unknown"} to ${until ? formatDate(until) : "open-ended"}`;
}

export function formatDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-").map(Number);
    const dateOnly = new Date(Date.UTC(year, month - 1, day));
    if (dateOnly.getUTCFullYear() === year
        && dateOnly.getUTCMonth() === month - 1
        && dateOnly.getUTCDate() === day) {
      return dateOnly.toLocaleDateString(
        "en",
        { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" },
      );
    }
    return String(value);
  }
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
