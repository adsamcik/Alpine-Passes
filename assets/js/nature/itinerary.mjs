import {
  displayName,
  haversineMeters,
  lineDistanceMeters,
  validPosition,
} from "./domain.mjs";
import { RoutingError } from "./routing.mjs";

export class ItineraryError extends Error {
  constructor(message, code = "itinerary_error", details = {}) {
    super(message);
    this.name = "ItineraryError";
    this.code = code;
    this.details = details;
  }
}

export async function buildMixedModeItinerary(options) {
  const {
    origin,
    experience,
    gateway,
    departureTime = new Date(),
    returnStrategy = "return_to_vehicle",
    accessMode = "car",
  } = options || {};
  if (!validPosition(origin)) throw new ItineraryError("A valid [longitude, latitude] origin is required", "invalid_origin");
  if (!experience || experience.entityType !== "TrailRoute") {
    throw new ItineraryError("A TrailRoute experience is required", "invalid_experience");
  }
  if (experience.routeNature !== "established" || experience.geometryCompleteness !== "complete") {
    throw new ItineraryError(
      "Mixed itineraries require complete established route geometry",
      "incomplete_established_route",
    );
  }
  if (experience.sensitivity?.action !== "publish") {
    throw new ItineraryError("This route cannot be planned at precise coordinates", "sensitive_location");
  }
  if (experience.access?.legal === "private") {
    throw new ItineraryError("Public access is not permitted", "private_access");
  }
  if (experience.access?.legal === "unknown") {
    throw new ItineraryError("Legal public access is unknown", "unknown_access");
  }

  const startTime = toDate(departureTime);
  ensureRouteAvailable(experience, startTime);

  const routeLine = primaryLine(experience.geometry);
  const routeStart = routeLine[0];
  const routeEnd = routeLine.at(-1);
  const accessPoint = selectAccessPoint(experience.accessPoints || [], routeStart, accessMode);
  if (!accessPoint) {
    throw new ItineraryError(`No suitable ${accessMode} access point is linked to this route`, "no_access_point");
  }
  if (accessPoint.legalAccess === "private" || accessPoint.legalAccess === "unknown") {
    throw new ItineraryError("The selected access point is not verified for public use", "invalid_access_point");
  }

  const legs = [];
  let cursorTime = startTime;
  let cursor = origin;

  if (accessMode === "car") {
    if (!gateway) throw new ItineraryError("A routing gateway is required for car access", "routing_unavailable");
    const drive = await routeLeg(gateway, "car", cursor, accessPoint.geometry.coordinates, cursorTime);
    legs.push(makeGeneratedLeg("drive", cursorTime, drive, {
      fromLabel: "Trip origin",
      toLabel: displayName(accessPoint),
      conditionRefs: accessPoint.conditionRefs,
    }));
    cursorTime = addSeconds(cursorTime, drive.durationSeconds);
    cursor = accessPoint.geometry.coordinates;
    legs.push(makeDwellLeg("park_or_transfer", cursorTime, accessPoint.transferMinutes ?? 10, {
      label: accessPoint.parking?.name || "Park and prepare",
      accessPointId: accessPoint.id,
    }));
    cursorTime = addMinutes(cursorTime, accessPoint.transferMinutes ?? 10);
  } else if (accessMode === "transit") {
    const connection = chooseOutboundTransport(experience.transportConnections || [], cursorTime);
    if (!connection) {
      throw new ItineraryError("No usable outbound public transport connection is linked", "no_transport_connection");
    }
    const minutes = connection.typicalDurationMinutes;
    legs.push(makeScheduledLeg(connection, cursorTime, minutes));
    cursorTime = addMinutes(cursorTime, minutes);
    cursor = accessPoint.geometry.coordinates;
  }

  const approachDistance = haversineMeters(cursor, routeStart);
  if (approachDistance > 35) {
    if (!gateway) throw new ItineraryError("A walking connector is required but routing is unavailable", "routing_unavailable");
    const approach = await routeLeg(gateway, "foot", cursor, routeStart, cursorTime);
    legs.push(makeGeneratedLeg("walk_connector", cursorTime, approach, {
      fromLabel: displayName(accessPoint),
      toLabel: "Established route",
    }));
    cursorTime = addSeconds(cursorTime, approach.durationSeconds);
  }

  const hikeDistanceMeters = experience.metrics?.distanceMeters || lineDistanceMeters(experience.geometry);
  const hikeDurationSeconds = (experience.metrics?.typicalDurationMinutes
    ? experience.metrics.typicalDurationMinutes * 60
    : estimateHikeDurationSeconds(hikeDistanceMeters, experience.metrics?.ascentMeters || 0));
  const hikeStart = cursorTime;
  const hikeEnd = addSeconds(hikeStart, hikeDurationSeconds);
  legs.push({
    id: `leg-${legs.length + 1}`,
    mode: experience.activities?.includes("hiking") ? "hike" : "walk",
    routeNature: "established",
    geometry: experience.geometry,
    distanceMeters: Math.round(hikeDistanceMeters),
    durationSeconds: Math.round(hikeDurationSeconds),
    startsAt: hikeStart.toISOString(),
    endsAt: hikeEnd.toISOString(),
    label: displayName(experience),
    sourceAssertionRefs: (experience.sourceAssertions || []).map((assertion) => assertion.id).filter(Boolean),
    conditionRefs: entityReferences(experience.conditionRefs, experience.conditions),
    restrictions: entityReferences(experience.restrictionRefs, experience.restrictions),
    warnings: criticalUnknownWarnings(experience),
  });
  cursorTime = hikeEnd;
  cursor = routeEnd;

  if (returnStrategy === "return_to_vehicle") {
    if (experience.journeyShape === "point_to_point"
        && haversineMeters(routeEnd, accessPoint.geometry.coordinates) > 250) {
      const returnConnection = chooseReturnTransport(experience.transportConnections || [], cursorTime);
      if (!returnConnection) {
        throw new ItineraryError(
          "This point-to-point route has no verified return transport or pickup",
          "stranded_at_route_end",
        );
      }
      ensureLastDeparture(returnConnection, cursorTime);
      legs.push(makeScheduledLeg(returnConnection, cursorTime, returnConnection.typicalDurationMinutes));
      cursorTime = addMinutes(cursorTime, returnConnection.typicalDurationMinutes);
      cursor = accessPoint.geometry.coordinates;
    } else if (haversineMeters(cursor, accessPoint.geometry.coordinates) > 35) {
      if (!gateway) throw new ItineraryError("Return walking connector is unavailable", "routing_unavailable");
      const returnWalk = await routeLeg(gateway, "foot", cursor, accessPoint.geometry.coordinates, cursorTime);
      legs.push(makeGeneratedLeg("walk_connector", cursorTime, returnWalk, {
        fromLabel: "Route finish",
        toLabel: displayName(accessPoint),
      }));
      cursorTime = addSeconds(cursorTime, returnWalk.durationSeconds);
      cursor = accessPoint.geometry.coordinates;
    }
    ensureParkingOpen(accessPoint, cursorTime);
    if (accessMode === "car") {
      const returnDrive = await routeLeg(gateway, "car", cursor, origin, cursorTime);
      legs.push(makeGeneratedLeg("drive", cursorTime, returnDrive, {
        fromLabel: displayName(accessPoint),
        toLabel: "Trip origin",
      }));
      cursorTime = addSeconds(cursorTime, returnDrive.durationSeconds);
    }
  } else if (returnStrategy === "different_pickup") {
    if (experience.journeyShape !== "point_to_point") {
      throw new ItineraryError("A different pickup only applies to point-to-point routes", "invalid_return_strategy");
    }
    legs.push({
      id: `leg-${legs.length + 1}`,
      mode: "pickup",
      routeNature: "scheduled",
      geometry: { type: "Point", coordinates: routeEnd },
      distanceMeters: 0,
      durationSeconds: 0,
      startsAt: cursorTime.toISOString(),
      endsAt: cursorTime.toISOString(),
      label: "Different pickup required",
      warnings: ["The itinerary ends at a different location; arrange pickup before departure."],
    });
  }

  return summarizeItinerary(experience, legs, startTime, cursorTime, returnStrategy);
}

export function summarizeItinerary(experience, legs, startsAt, endsAt, returnStrategy) {
  const totalsByMode = {};
  for (const leg of legs) {
    const bucket = totalsByMode[leg.mode] ||= { distanceMeters: 0, durationSeconds: 0 };
    bucket.distanceMeters += leg.distanceMeters || 0;
    bucket.durationSeconds += leg.durationSeconds || 0;
  }
  return {
    schemaVersion: "1.0.0",
    experienceId: experience.id,
    title: displayName(experience),
    returnStrategy,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    totalDistanceMeters: legs.reduce((sum, leg) => sum + (leg.distanceMeters || 0), 0),
    totalDurationSeconds: Math.max(0, (endsAt.getTime() - startsAt.getTime()) / 1000),
    totalsByMode,
    legs,
    safetyNotice: "Conditions and legal access can change. Verify current local sources before departure.",
  };
}

export function estimateHikeDurationSeconds(distanceMeters, ascentMeters = 0) {
  const flatHours = Math.max(0, distanceMeters) / 4_500;
  const ascentHours = Math.max(0, ascentMeters) / 600;
  return Math.round((flatHours + ascentHours) * 3600);
}

function primaryLine(geometry) {
  if (geometry?.type === "LineString" && geometry.coordinates.length >= 2) return geometry.coordinates;
  if (geometry?.type === "MultiLineString" && geometry.coordinates[0]?.length >= 2) {
    return geometry.coordinates[0];
  }
  throw new ItineraryError("Route geometry is missing or invalid", "invalid_geometry");
}

function selectAccessPoint(accessPoints, routeStart, mode) {
  return accessPoints
    .filter((point) => point?.entityType === "AccessPoint"
      && point.geometry?.type === "Point"
      && validPosition(point.geometry.coordinates)
      && point.accessModes?.includes(mode)
      && !["private"].includes(point.legalAccess))
    .sort((a, b) => accessRank(a, routeStart) - accessRank(b, routeStart))[0] || null;
}

function accessRank(point, routeStart) {
  const legalPenalty = point.legalAccess === "legal" ? 0 : 1_000_000;
  const parkingPenalty = point.parking?.stoppingAllowed === false ? 10_000_000 : 0;
  return legalPenalty + parkingPenalty + haversineMeters(point.geometry.coordinates, routeStart);
}

async function routeLeg(gateway, profile, from, to, departureTime) {
  const request = {
    profile,
    coordinates: [from, to],
  };
  if (gateway.provider?.capabilities?.timeDependentRouting === true) {
    request.departureTime = departureTime;
  }
  try {
    const response = await gateway.route(request);
    return response.routes[0];
  } catch (error) {
    if (error instanceof RoutingError) {
      throw new ItineraryError(error.message, "connector_routing_failed", { profile, cause: error.code });
    }
    throw error;
  }
}

function makeGeneratedLeg(mode, startsAt, route, metadata = {}) {
  const endsAt = addSeconds(startsAt, route.durationSeconds);
  return {
    id: `leg-${startsAt.getTime()}-${mode}`,
    mode,
    routeNature: "generated",
    geometry: route.geometry,
    distanceMeters: Math.round(route.distanceMeters),
    durationSeconds: Math.round(route.durationSeconds),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    label: `${metadata.fromLabel || "Start"} to ${metadata.toLabel || "finish"}`,
    conditionRefs: metadata.conditionRefs || [],
    warnings: route.warnings || [],
  };
}

function makeDwellLeg(mode, startsAt, minutes, metadata = {}) {
  return {
    id: `leg-${startsAt.getTime()}-${mode}`,
    mode,
    routeNature: "dwell",
    geometry: null,
    distanceMeters: 0,
    durationSeconds: minutes * 60,
    startsAt: startsAt.toISOString(),
    endsAt: addMinutes(startsAt, minutes).toISOString(),
    label: metadata.label || "Transfer",
    accessPointId: metadata.accessPointId,
    warnings: [],
  };
}

function makeScheduledLeg(connection, startsAt, minutes) {
  return {
    id: `leg-${startsAt.getTime()}-${connection.transportMode}`,
    mode: connection.transportMode,
    routeNature: "scheduled",
    geometry: connection.geometry || null,
    distanceMeters: connection.distanceMeters || 0,
    durationSeconds: minutes * 60,
    startsAt: startsAt.toISOString(),
    endsAt: addMinutes(startsAt, minutes).toISOString(),
    label: displayName(connection),
    sourceAssertionRefs: (connection.sourceAssertions || []).map((assertion) => assertion.id).filter(Boolean),
    warnings: connection.schedule?.freshness === "stale"
      ? ["Transport schedule is stale; verify before departure."]
      : [],
  };
}

function chooseOutboundTransport(connections, time) {
  return connections.find((connection) => connection.direction !== "return"
    && connection.operating !== false
    && departureAvailable(connection, time));
}

function chooseReturnTransport(connections, time) {
  return connections.find((connection) => connection.direction !== "outbound"
    && connection.operating !== false
    && departureAvailable(connection, time));
}

function departureAvailable(connection, time) {
  const departures = connection.schedule?.departuresLocal || [];
  if (!departures.length) return true;
  const minutes = localMinutes(time);
  return departures.some((value) => clockMinutes(value) >= minutes);
}

function ensureLastDeparture(connection, time) {
  const last = connection.schedule?.lastDepartureLocal;
  if (!last) return;
  if (localMinutes(time) > clockMinutes(last)) {
    throw new ItineraryError(
      `The route finishes after the final ${connection.transportMode} departure`,
      "missed_last_transport",
      { lastDepartureLocal: last },
    );
  }
}

function ensureParkingOpen(accessPoint, time) {
  const closes = accessPoint.parking?.closesLocal;
  if (closes && localMinutes(time) > clockMinutes(closes)) {
    throw new ItineraryError(
      "The calculated return is after the parking area closes",
      "parking_closed_before_return",
      { closesLocal: closes },
    );
  }
  if (accessPoint.parking?.stoppingAllowed === false) {
    throw new ItineraryError("Stopping is not allowed at the selected access point", "parking_prohibited");
  }
}

function ensureRouteAvailable(experience, time) {
  const accessState = normalizedState(experience.access?.state);
  if (accessState === "closed") {
    throw new ItineraryError("The route is closed at the requested departure time", "route_closed");
  }
  if (["forbidden", "private"].includes(accessState)) {
    throw new ItineraryError(
      "An active access restriction prevents this itinerary",
      "active_restriction",
      { accessState },
    );
  }
  if (accessState === "unsafe") {
    throw new ItineraryError("The route is currently unsafe", "unsafe_condition");
  }

  for (const condition of experience.conditions || []) {
    if (!isActiveAt(condition, time)) continue;
    const conditionState = normalizedState(
      condition.accessState || condition.effect || condition.status,
    );
    const conditionKind = normalizedState(condition.conditionKind);
    if (conditionState === "closed"
        || ["road_closure", "trail_closure", "seasonal_gate"].includes(conditionKind)) {
      throw new ItineraryError(
        "An active condition closes this route",
        "route_closed",
        { conditionId: condition.id, conditionKind: condition.conditionKind },
      );
    }
    if (["forbidden", "private"].includes(conditionState)) {
      throw new ItineraryError(
        "An active condition prevents public access",
        "active_restriction",
        { conditionId: condition.id, accessState: conditionState },
      );
    }
    if (conditionState === "unsafe" || isUnsafeBlocker(condition)) {
      throw new ItineraryError(
        "An active condition makes this route unsafe",
        "unsafe_condition",
        { conditionId: condition.id, conditionKind: condition.conditionKind },
      );
    }
  }

  for (const restriction of experience.restrictions || []) {
    if (!isActiveAt(restriction, time) || restriction.blocking === false) continue;
    const restrictionState = normalizedState(
      restriction.accessState || restriction.effect || restriction.status,
    );
    if (restrictionState === "closed") {
      throw new ItineraryError(
        "An active restriction closes this route",
        "route_closed",
        { restrictionId: restriction.id, restrictionKind: restriction.restrictionKind },
      );
    }
    if (restrictionState === "unsafe"
        || (restriction.restrictionKind === "safety" && isUnsafeBlocker(restriction))) {
      throw new ItineraryError(
        "An active safety restriction makes this route unsafe",
        "unsafe_condition",
        { restrictionId: restriction.id, restrictionKind: restriction.restrictionKind },
      );
    }
    if (restriction.blocking === true
        || ["forbidden", "private"].includes(restrictionState)
        || restriction.restrictionKind === "private_land") {
      throw new ItineraryError(
        "An active restriction prevents this itinerary",
        "active_restriction",
        { restrictionId: restriction.id, restrictionKind: restriction.restrictionKind },
      );
    }
  }

  if ((experience.quality?.flags || []).includes("critical_condition_unknown")
      && isSafetySensitive(experience)) {
    throw new ItineraryError(
      "A critical condition is unknown for this safety-sensitive route",
      "critical_condition_unknown",
    );
  }
}

function isActiveAt(record, time) {
  if (!record || record.active === false || record.state === "expired") return false;
  const from = optionalDate(record.effectiveFrom || record.validFrom);
  const until = optionalDate(record.effectiveUntil || record.validUntil);
  if (from && time < from) return false;
  if (until && time > until) return false;
  return true;
}

function optionalDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ItineraryError("Invalid condition effective date: " + value, "invalid_condition_time");
  }
  return date;
}

function isUnsafeBlocker(record) {
  const severity = normalizedState(record.severity);
  const kind = normalizedState(record.conditionKind);
  return record.unsafe === true
    || (record.blocking === true && ["high", "extreme"].includes(severity))
    || (record.blocking === true
      && ["fire", "avalanche", "flood", "volcanic", "emergency"].includes(kind));
}

function isSafetySensitive(experience) {
  const activities = new Set(experience.activities || []);
  return ["technical", "expert"].includes(experience.difficulty?.normalizedBand)
    || ["scrambling", "via_ferrata", "winter_walking", "snowshoe"]
      .some((activity) => activities.has(activity))
    || (experience.hazards || []).some((hazard) => ["high", "extreme", "unknown"].includes(hazard.severity));
}

function normalizedState(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function entityReferences(explicitRefs, entities) {
  return [...new Set([
    ...(Array.isArray(explicitRefs) ? explicitRefs : []),
    ...(Array.isArray(entities) ? entities.map((entity) => entity?.id).filter(Boolean) : []),
  ])];
}

function criticalUnknownWarnings(experience) {
  const warnings = [];
  if ((experience.quality?.flags || []).includes("critical_condition_unknown")) {
    warnings.push("A critical live condition is unknown; verify locally.");
  }
  if ((experience.quality?.flags || []).includes("seasonal_access")) {
    warnings.push("Seasonal access applies; check the current effective dates.");
  }
  return warnings;
}

function toDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ItineraryError("Departure time is invalid", "invalid_time");
  return date;
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

function addMinutes(date, minutes) {
  return addSeconds(date, minutes * 60);
}

function localMinutes(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function clockMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value));
  if (!match) throw new ItineraryError(`Invalid local clock value: ${value}`, "invalid_schedule");
  return Number(match[1]) * 60 + Number(match[2]);
}

