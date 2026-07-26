import {
  displayName,
  haversineMeters,
  isPlanningBlockingQualityFlag,
  isSafetySensitiveTrailRoute,
  isUnsafePlanningQualityFlag,
  lineDistanceMeters,
  validPosition,
} from "./domain.mjs";
import { RoutingError } from "./routing.mjs";

export const RETURN_TRANSPORT_ENDPOINT_TOLERANCE_METERS = 250;

const DESTINATION_TIME_FORMATTERS = new Map();
const ACCESS_MODES = Object.freeze(["car", "foot", "transit"]);
const ACCESS_POINT_MODES = Object.freeze({
  car: Object.freeze(["car"]),
  foot: Object.freeze(["foot", "hiking"]),
  transit: Object.freeze(["transit", "ferry", "cable_transport"]),
});
const OUTBOUND_TRANSPORT_MODES = new Set([
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
const WALK_CONNECTOR_TOLERANCE_METERS = 35;

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
  if (experience.navigationSuitability !== true) {
    throw new ItineraryError(
      "Mixed itineraries require geometry verified as suitable for navigation",
      "route_not_navigation_suitable",
    );
  }
  if (experience.sensitivity?.action !== "publish") {
    throw new ItineraryError("This route cannot be planned at precise coordinates", "sensitive_location");
  }
  if (experience.access?.legal === "private") {
    throw new ItineraryError("Public access is not permitted", "private_access");
  }
  if (experience.access?.legal !== "legal") {
    throw new ItineraryError(
      experience.access?.legal === "unknown" || experience.access?.legal == null
        ? "Legal public access is unknown"
        : "Legal public access is not verified",
      experience.access?.legal === "unknown" || experience.access?.legal == null
        ? "unknown_access"
        : "access_not_public",
      { legalAccess: experience.access?.legal ?? null },
    );
  }
  if (!ACCESS_MODES.includes(accessMode)) {
    throw new ItineraryError(
      "Access mode must be car, foot, or transit",
      "invalid_access_mode",
      { accessMode: accessMode ?? null },
    );
  }

  const startTime = toDate(departureTime);
  ensureRouteQuality(experience, startTime);
  ensureRouteAvailable(experience, startTime);

  const routeLine = primaryLine(experience.geometry);
  const routeStart = routeLine[0];
  const routeEnd = routeLine.at(-1);
  const accessPoint = selectAccessPoint(
    experience.accessPoints || [],
    routeStart,
    accessMode,
    startTime,
  );
  if (!accessPoint) {
    throw new ItineraryError(`No suitable ${accessMode} access point is linked to this route`, "no_access_point");
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
  } else if (accessMode === "foot") {
    if (!gateway) {
      throw new ItineraryError(
        "A routing gateway is required for foot access",
        "routing_unavailable",
      );
    }
    const accessWalk = await routeLeg(
      gateway,
      "foot",
      cursor,
      accessPoint.geometry.coordinates,
      cursorTime,
    );
    legs.push(makeGeneratedLeg("walk_connector", cursorTime, accessWalk, {
      fromLabel: "Trip origin",
      toLabel: displayName(accessPoint),
      conditionRefs: accessPoint.conditionRefs,
    }));
    cursorTime = addSeconds(cursorTime, accessWalk.durationSeconds);
    cursor = accessPoint.geometry.coordinates;
  } else if (accessMode === "transit") {
    let outbound = chooseOutboundTransport(
      experience.transportConnections || [],
      cursorTime,
      accessPoint,
    );
    if (!outbound) {
      throw new ItineraryError("No usable outbound public transport connection is linked", "no_transport_connection");
    }

    if (haversineMeters(cursor, outbound.boardingPoint)
        > WALK_CONNECTOR_TOLERANCE_METERS) {
      if (!gateway) {
        throw new ItineraryError(
          "A walking route to the transport boarding point is required",
          "routing_unavailable",
        );
      }
      const boardingWalk = await routeLeg(
        gateway,
        "foot",
        cursor,
        outbound.boardingPoint,
        cursorTime,
      );
      legs.push(makeGeneratedLeg("walk_connector", cursorTime, boardingWalk, {
        fromLabel: "Trip origin",
        toLabel: `${displayName(outbound.connection)} boarding point`,
      }));
      cursorTime = addSeconds(cursorTime, boardingWalk.durationSeconds);
    }
    cursor = outbound.boardingPoint;

    outbound = validateOutboundTransport(
      outbound.connection,
      cursorTime,
      accessPoint,
    );
    legs.push(makeWaitingLeg(
      outbound.connection,
      cursorTime,
      outbound.nextDeparture,
      outbound.boardingPoint,
    ));
    cursorTime = outbound.nextDeparture;
    legs.push(makeScheduledLeg(
      outbound.connection,
      cursorTime,
      outbound.connection.typicalDurationMinutes,
      { geometry: outbound.geometry },
    ));
    cursorTime = addMinutes(
      cursorTime,
      outbound.connection.typicalDurationMinutes,
    );
    cursor = outbound.arrivalPoint;

    if (haversineMeters(cursor, accessPoint.geometry.coordinates)
        > WALK_CONNECTOR_TOLERANCE_METERS) {
      if (!gateway) {
        throw new ItineraryError(
          "A walking connector from transport to the access point is required",
          "routing_unavailable",
        );
      }
      const arrivalWalk = await routeLeg(
        gateway,
        "foot",
        cursor,
        accessPoint.geometry.coordinates,
        cursorTime,
      );
      legs.push(makeGeneratedLeg("walk_connector", cursorTime, arrivalWalk, {
        fromLabel: `${displayName(outbound.connection)} arrival point`,
        toLabel: displayName(accessPoint),
      }));
      cursorTime = addSeconds(cursorTime, arrivalWalk.durationSeconds);
    }
    cursor = accessPoint.geometry.coordinates;
  }

  const approachDistance = haversineMeters(cursor, routeStart);
  if (approachDistance > WALK_CONNECTOR_TOLERANCE_METERS) {
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
      let returnTransport = chooseReturnTransport(
        experience.transportConnections || [],
        cursorTime,
        cursor,
        accessPoint.geometry.coordinates,
      );
      if (!returnTransport) {
        throw new ItineraryError(
          "This point-to-point route has no verified return transport or pickup",
          "stranded_at_route_end",
        );
      }
      if (haversineMeters(cursor, returnTransport.boardingPoint)
          > WALK_CONNECTOR_TOLERANCE_METERS) {
        if (!gateway) {
          throw new ItineraryError(
            "A walking route to the return transport boarding point is required",
            "routing_unavailable",
          );
        }
        const returnBoardingWalk = await routeLeg(
          gateway,
          "foot",
          cursor,
          returnTransport.boardingPoint,
          cursorTime,
        );
        legs.push(makeGeneratedLeg("walk_connector", cursorTime, returnBoardingWalk, {
          fromLabel: "Route finish",
          toLabel: `${displayName(returnTransport.connection)} boarding point`,
        }));
        cursorTime = addSeconds(cursorTime, returnBoardingWalk.durationSeconds);
        cursor = returnTransport.boardingPoint;
        returnTransport = validateReturnTransport(
          returnTransport.connection,
          cursorTime,
          cursor,
          accessPoint.geometry.coordinates,
        );
      } else {
        cursor = returnTransport.boardingPoint;
      }
      legs.push(makeWaitingLeg(
        returnTransport.connection,
        cursorTime,
        returnTransport.nextDeparture,
        returnTransport.boardingPoint,
      ));
      cursorTime = returnTransport.nextDeparture;
      legs.push(makeScheduledLeg(
        returnTransport.connection,
        cursorTime,
        returnTransport.connection.typicalDurationMinutes,
        { geometry: returnTransport.geometry },
      ));
      cursorTime = addMinutes(
        cursorTime,
        returnTransport.connection.typicalDurationMinutes,
      );
      cursor = returnTransport.arrivalPoint;
      if (haversineMeters(cursor, accessPoint.geometry.coordinates)
          > WALK_CONNECTOR_TOLERANCE_METERS) {
        if (!gateway) {
          throw new ItineraryError(
            "A walking route from return transport to the starting access point is required",
            "routing_unavailable",
          );
        }
        const returnArrivalWalk = await routeLeg(
          gateway,
          "foot",
          cursor,
          accessPoint.geometry.coordinates,
          cursorTime,
        );
        legs.push(makeGeneratedLeg("walk_connector", cursorTime, returnArrivalWalk, {
          fromLabel: `${displayName(returnTransport.connection)} arrival point`,
          toLabel: displayName(accessPoint),
        }));
        cursorTime = addSeconds(cursorTime, returnArrivalWalk.durationSeconds);
      }
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

function selectAccessPoint(accessPoints, routeStart, mode, time) {
  const acceptedModes = ACCESS_POINT_MODES[mode] || [];
  return (Array.isArray(accessPoints) ? accessPoints : [])
    .filter((point) => point?.entityType === "AccessPoint"
      && point.geometry?.type === "Point"
      && validPosition(point.geometry.coordinates)
      && Array.isArray(point.accessModes)
      && point.accessModes.some((candidate) => acceptedModes.includes(candidate))
      && accessPointIsPlanSafe(point, mode, time))
    .sort((left, right) =>
      haversineMeters(left.geometry.coordinates, routeStart)
        - haversineMeters(right.geometry.coordinates, routeStart))[0] || null;
}

function accessPointIsPlanSafe(point, mode, time) {
  if (point.legalAccess !== "legal" || point.sensitivity?.action !== "publish") {
    return false;
  }
  const quality = point.quality;
  const unsafeFlags = Array.isArray(quality?.flags)
    ? quality.flags.filter(isPlanningBlockingQualityFlag)
    : ["quality_flags_missing"];
  const assessedAt = validInstant(quality?.assessedAt);
  return quality?.verificationStatus === "verified"
    && quality.freshness === "current"
    && unsafeFlags.length === 0
    && assessedAt !== null
    && assessedAt <= time.getTime()
    && (mode !== "car" || point.parking?.stoppingAllowed === true);
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

function makeWaitingLeg(connection, startsAt, departureTime, boardingPoint) {
  const durationSeconds = Math.max(
    0,
    Math.round((departureTime.getTime() - startsAt.getTime()) / 1000),
  );
  return {
    id: `leg-${startsAt.getTime()}-wait-for-${connection.id}`,
    mode: "wait_for_transport",
    routeNature: "dwell",
    geometry: { type: "Point", coordinates: [...boardingPoint] },
    distanceMeters: 0,
    durationSeconds,
    startsAt: startsAt.toISOString(),
    endsAt: departureTime.toISOString(),
    label: `Wait at ${displayName(connection)} boarding point`,
    sourceAssertionRefs: (connection.sourceAssertions || [])
      .map((assertion) => assertion.id)
      .filter(Boolean),
    warnings: [],
  };
}

function makeScheduledLeg(connection, startsAt, minutes, options = {}) {
  return {
    id: `leg-${startsAt.getTime()}-${connection.transportMode}`,
    mode: connection.transportMode,
    routeNature: "scheduled",
    geometry: options.geometry || connection.geometry || null,
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

function chooseOutboundTransport(connections, time, accessPoint) {
  const candidates = Array.isArray(connections) ? connections : [];
  if (!candidates.length) return null;

  const rejections = [];
  for (const connection of candidates) {
    try {
      return validateOutboundTransport(connection, time, accessPoint);
    } catch (error) {
      if (!(error instanceof ItineraryError)) throw error;
      rejections.push({
        connectionId: connection?.id ?? null,
        code: error.code,
        message: error.message,
        details: error.details,
      });
    }
  }

  const failure = rejections[0];
  throw new ItineraryError(failure.message, failure.code, {
    ...failure.details,
    rejectedConnections: rejections,
  });
}

function validateOutboundTransport(connection, time, accessPoint) {
  if (!connection
      || connection.entityType !== "TransportConnection"
      || !OUTBOUND_TRANSPORT_MODES.has(connection.transportMode)) {
    throw new ItineraryError(
      "The linked outbound transport record is invalid",
      "outbound_transport_invalid",
      { connectionId: connection?.id ?? null },
    );
  }
  if (!["outbound", "both"].includes(connection.direction)) {
    throw new ItineraryError(
      "The linked transport is not explicitly valid for outbound travel",
      "outbound_transport_direction_invalid",
      { connectionId: connection.id, direction: connection.direction ?? null },
    );
  }
  if (connection.operating !== true) {
    throw new ItineraryError(
      connection.operating === false
        ? "The linked outbound transport is not operating"
        : "The operating status of the linked outbound transport is unknown",
      connection.operating === false
        ? "outbound_transport_not_operating"
        : "outbound_transport_operating_unknown",
      { connectionId: connection.id },
    );
  }
  if (connection.sensitivity?.action !== "publish") {
    throw new ItineraryError(
      "The outbound transport geometry is not approved for precise planning",
      "outbound_transport_location_unavailable",
      { connectionId: connection.id },
    );
  }
  if (!Number.isFinite(connection.typicalDurationMinutes)
      || connection.typicalDurationMinutes <= 0) {
    throw new ItineraryError(
      "The outbound transport duration is missing or invalid",
      "outbound_transport_duration_invalid",
      { connectionId: connection.id },
    );
  }

  const orientation = validateOutboundTransportGeometry(connection, accessPoint);
  const scheduleContext = validateOutboundSchedule(connection, time);
  validateOutboundTransportQuality(connection, time, scheduleContext);
  return {
    connection,
    ...orientation,
    nextDeparture: nextOutboundDeparture(connection, time, scheduleContext),
  };
}

function validateOutboundTransportGeometry(connection, accessPoint) {
  const endpointIds = connection.endpointIds;
  const normalizedEndpointIds = Array.isArray(endpointIds)
    ? endpointIds.map((value) => typeof value === "string" ? value.trim() : "")
    : [];
  if (normalizedEndpointIds.length !== 2
      || normalizedEndpointIds.some((value) => !value)
      || new Set(normalizedEndpointIds).size !== normalizedEndpointIds.length) {
    throw new ItineraryError(
      "The outbound transport must identify exactly two distinct endpoints",
      "outbound_transport_endpoints_invalid",
      { connectionId: connection.id },
    );
  }
  const accessEndpointIndex = normalizedEndpointIds.indexOf(accessPoint.id);
  if (accessEndpointIndex === -1) {
    throw new ItineraryError(
      "The outbound transport endpoints do not include the selected access point",
      "outbound_transport_access_point_mismatch",
      { connectionId: connection.id, accessPointId: accessPoint.id },
    );
  }

  const endpoints = transportGeometryEndpoints(
    connection.geometry,
    WALK_CONNECTOR_TOLERANCE_METERS,
  );
  if (!endpoints) {
    throw new ItineraryError(
      "The outbound transport lacks valid connected line geometry",
      "outbound_transport_geometry_invalid",
      { connectionId: connection.id },
    );
  }

  let geometry = connection.geometry;
  let boardingPoint = endpoints.start;
  let arrivalPoint = endpoints.end;
  if (accessEndpointIndex === 0) {
    if (connection.direction !== "both") {
      throw new ItineraryError(
        "Outbound-only transport geometry may not be reversed toward the access point",
        "outbound_transport_geometry_mismatch",
        { connectionId: connection.id, accessPointId: accessPoint.id },
      );
    }
    geometry = reverseTransportGeometry(connection.geometry);
    boardingPoint = endpoints.end;
    arrivalPoint = endpoints.start;
  }

  const accessPointDistanceMeters = haversineMeters(
    arrivalPoint,
    accessPoint.geometry.coordinates,
  );
  if (accessPointDistanceMeters > RETURN_TRANSPORT_ENDPOINT_TOLERANCE_METERS) {
    throw new ItineraryError(
      "The outbound transport geometry does not end at the selected access point",
      "outbound_transport_geometry_mismatch",
      {
        connectionId: connection.id,
        accessPointId: accessPoint.id,
        accessPointDistanceMeters: Math.round(accessPointDistanceMeters),
        toleranceMeters: RETURN_TRANSPORT_ENDPOINT_TOLERANCE_METERS,
      },
    );
  }

  return { geometry, boardingPoint, arrivalPoint };
}

function reverseTransportGeometry(geometry) {
  if (geometry.type === "LineString") {
    return {
      ...geometry,
      coordinates: geometry.coordinates
        .toReversed()
        .map((position) => [...position]),
    };
  }
  return {
    ...geometry,
    coordinates: geometry.coordinates
      .toReversed()
      .map((line) => line.toReversed().map((position) => [...position])),
  };
}

function validateOutboundSchedule(connection, time) {
  const schedule = connection.schedule;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new ItineraryError(
      "The outbound transport has no schedule",
      "outbound_schedule_unavailable",
      { connectionId: connection.id },
    );
  }
  if (schedule.freshness !== "current") {
    throw new ItineraryError(
      "The outbound transport schedule is not verified as current",
      "outbound_schedule_not_current",
      {
        connectionId: connection.id,
        freshness: schedule.freshness ?? "unknown",
      },
    );
  }

  const local = outboundLocalParts(time, schedule.timezone, connection.id);
  const travelDate = dateOrdinal(local.year, local.month, local.day);
  const validFrom = outboundDateOrdinal(
    schedule.validFrom,
    "schedule.validFrom",
    connection.id,
  );
  const validUntil = outboundDateOrdinal(
    schedule.validUntil,
    "schedule.validUntil",
    connection.id,
  );
  if (validFrom > validUntil) {
    throw new ItineraryError(
      "The outbound transport schedule validity interval is invalid",
      "outbound_schedule_invalid",
      { connectionId: connection.id },
    );
  }
  if (travelDate < validFrom || travelDate > validUntil) {
    throw new ItineraryError(
      "The outbound transport schedule is not valid on the planned travel date",
      "outbound_schedule_out_of_range",
      {
        connectionId: connection.id,
        travelDate: localDateText(local),
        validFrom: schedule.validFrom,
        validUntil: schedule.validUntil,
        timezone: schedule.timezone,
      },
    );
  }

  if (!Array.isArray(schedule.departuresLocal)
      || schedule.departuresLocal.length === 0) {
    throw new ItineraryError(
      "The outbound transport has no exact usable departure time",
      "outbound_schedule_unavailable",
      { connectionId: connection.id },
    );
  }
  const departureMinutes = schedule.departuresLocal.map((value, index) =>
    outboundClockMinutes(
      value,
      connection.id,
      `schedule.departuresLocal[${index}]`,
    ));
  if (new Set(departureMinutes).size !== departureMinutes.length) {
    throw new ItineraryError(
      "The outbound transport departure list contains duplicates",
      "outbound_schedule_invalid",
      { connectionId: connection.id },
    );
  }
  const lastDeparture = schedule.lastDepartureLocal == null
    ? null
    : outboundClockMinutes(
      schedule.lastDepartureLocal,
      connection.id,
      "schedule.lastDepartureLocal",
    );
  if (lastDeparture !== null
      && departureMinutes.some((minutes) => minutes > lastDeparture)) {
    throw new ItineraryError(
      "The outbound departure list extends beyond its declared final departure",
      "outbound_schedule_invalid",
      { connectionId: connection.id },
    );
  }

  return {
    ...local,
    departureMinutes: departureMinutes.toSorted((left, right) => left - right),
    travelDate,
    timezone: schedule.timezone.trim(),
  };
}

function validateOutboundTransportQuality(connection, time, scheduleContext) {
  const quality = connection.quality;
  if (quality?.verificationStatus !== "verified") {
    throw new ItineraryError(
      "The outbound transport record is not verified",
      "outbound_transport_unverified",
      {
        connectionId: connection.id,
        verificationStatus: quality?.verificationStatus ?? "unknown",
      },
    );
  }
  const unsafeFlags = Array.isArray(quality.flags)
    ? quality.flags.filter(isPlanningBlockingQualityFlag)
    : ["quality_flags_missing"];
  if (quality.freshness !== "current" || unsafeFlags.length) {
    throw new ItineraryError(
      "The outbound transport record is not verified as current",
      "outbound_transport_quality_not_current",
      {
        connectionId: connection.id,
        freshness: quality.freshness ?? "unknown",
        flags: unsafeFlags,
      },
    );
  }
  const assessedAt = outboundDateOrdinal(
    quality.assessedAt,
    "quality.assessedAt",
    connection.id,
    "outbound_transport_quality_invalid",
  );
  if (assessedAt > scheduleContext.travelDate) {
    throw new ItineraryError(
      "The outbound transport quality assessment is dated after the journey",
      "outbound_transport_quality_invalid",
      {
        connectionId: connection.id,
        assessedAt: quality.assessedAt,
        travelDate: localDateText(scheduleContext),
        timezone: scheduleContext.timezone,
      },
    );
  }

  const geometryAssertions = (connection.sourceAssertions || []).filter((assertion) =>
    assertion?.fieldPath === "/geometry"
    || String(assertion?.fieldPath || "").startsWith("/geometry/"));
  const currentGeometryAssertion = geometryAssertions.some((assertion) => {
    if (assertion.verificationStatus !== "verified") return false;
    const observed = firstPresent(
      assertion.observedAt,
      assertion.retrievedAt,
      assertion.validFrom,
    );
    const observedAt = validInstant(observed);
    const validFrom = assertion.validFrom ? validInstant(assertion.validFrom) : null;
    const validUntil = assertion.validUntil ? validInstant(assertion.validUntil) : null;
    return observedAt !== null
      && observedAt <= time.getTime()
      && (!assertion.validFrom || (validFrom !== null && validFrom <= time.getTime()))
      && (!assertion.validUntil || (validUntil !== null && validUntil >= time.getTime()));
  });
  if (!currentGeometryAssertion) {
    throw new ItineraryError(
      "The outbound transport geometry lacks current verified provenance",
      "outbound_transport_provenance_unverified",
      { connectionId: connection.id },
    );
  }
}

function nextOutboundDeparture(connection, time, scheduleContext) {
  const departureMinutes = new Set(scheduleContext.departureMinutes);
  const firstCandidate = Math.ceil(time.getTime() / 60_000) * 60_000;
  const searchLimit = firstCandidate + 27 * 60 * 60_000;
  for (let timestamp = firstCandidate; timestamp <= searchLimit; timestamp += 60_000) {
    const candidate = new Date(timestamp);
    const local = outboundLocalParts(
      candidate,
      scheduleContext.timezone,
      connection.id,
    );
    const candidateDate = dateOrdinal(local.year, local.month, local.day);
    if (candidateDate > scheduleContext.travelDate) break;
    if (candidateDate === scheduleContext.travelDate
        && departureMinutes.has(local.hour * 60 + local.minute)) {
      return candidate;
    }
  }

  throw new ItineraryError(
    `The boarding point is reached after the final ${connection.transportMode} departure`,
    "missed_outbound_transport",
    {
      connectionId: connection.id,
      plannedArrivalLocal: `${twoDigits(scheduleContext.hour)}:${twoDigits(scheduleContext.minute)}`,
      timezone: scheduleContext.timezone,
    },
  );
}

function outboundLocalParts(date, timezone, connectionId) {
  if (typeof timezone !== "string" || !timezone.trim()) {
    throw new ItineraryError(
      "The outbound transport schedule has no IANA timezone",
      "outbound_schedule_timezone_invalid",
      { connectionId, timezone: timezone ?? null },
    );
  }
  const normalizedTimezone = timezone.trim();
  let formatter = DESTINATION_TIME_FORMATTERS.get(normalizedTimezone);
  try {
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: normalizedTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      DESTINATION_TIME_FORMATTERS.set(normalizedTimezone, formatter);
    }
    const parts = Object.fromEntries(
      formatter.formatToParts(date)
        .filter(({ type }) => type !== "literal")
        .map(({ type, value }) => [type, Number(value)]),
    );
    if (![parts.year, parts.month, parts.day, parts.hour, parts.minute]
      .every(Number.isFinite)) {
      throw new RangeError("Incomplete timezone conversion");
    }
    return parts;
  } catch {
    throw new ItineraryError(
      "The outbound transport schedule timezone is invalid",
      "outbound_schedule_timezone_invalid",
      { connectionId, timezone },
    );
  }
}

function outboundDateOrdinal(
  value,
  field,
  connectionId,
  code = "outbound_schedule_invalid",
) {
  if (value == null || value === "") {
    throw new ItineraryError(
      `The outbound transport ${field} is required`,
      code,
      { connectionId, field },
    );
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) {
    throw new ItineraryError(
      `The outbound transport ${field} must be an ISO calendar date`,
      code,
      { connectionId, field, value },
    );
  }
  const [year, month, day] = match.slice(1).map(Number);
  const ordinal = dateOrdinal(year, month, day);
  const normalized = new Date(ordinal * 86_400_000);
  if (normalized.getUTCFullYear() !== year
      || normalized.getUTCMonth() + 1 !== month
      || normalized.getUTCDate() !== day) {
    throw new ItineraryError(
      `The outbound transport ${field} is not a real calendar date`,
      code,
      { connectionId, field, value },
    );
  }
  return ordinal;
}

function outboundClockMinutes(value, connectionId, field) {
  try {
    return clockMinutes(value);
  } catch (error) {
    if (!(error instanceof ItineraryError)) throw error;
    throw new ItineraryError(
      `The outbound transport ${field} is invalid`,
      "outbound_schedule_invalid",
      { connectionId, field, value },
    );
  }
}

function chooseReturnTransport(connections, time, currentPosition, vehiclePosition) {
  const candidates = (Array.isArray(connections) ? connections : [])
    .filter((connection) => connection?.direction !== "outbound");
  if (!candidates.length) return null;

  const rejections = [];
  const validCandidates = [];
  for (const connection of candidates) {
    try {
      validCandidates.push(
        validateReturnTransport(connection, time, currentPosition, vehiclePosition),
      );
    } catch (error) {
      if (!(error instanceof ItineraryError)) throw error;
      rejections.push({
        connectionId: connection?.id ?? null,
        code: error.code,
        message: error.message,
        details: error.details,
      });
    }
  }
  if (validCandidates.length) {
    return validCandidates.toSorted((left, right) =>
      left.nextDeparture.getTime() - right.nextDeparture.getTime())[0];
  }

  const failure = rejections[0];
  throw new ItineraryError(failure.message, failure.code, {
    ...failure.details,
    rejectedConnections: rejections,
  });
}

function validateReturnTransport(connection, time, currentPosition, vehiclePosition) {
  if (!connection || connection.entityType !== "TransportConnection") {
    throw new ItineraryError(
      "The linked return transport record is invalid",
      "return_transport_invalid",
    );
  }
  if (!["return", "both"].includes(connection.direction)) {
    throw new ItineraryError(
      "The linked transport is not explicitly valid for the return direction",
      "return_transport_direction_invalid",
      { connectionId: connection.id, direction: connection.direction ?? null },
    );
  }
  if (connection.operating !== true) {
    throw new ItineraryError(
      connection.operating === false
        ? "The linked return transport is not operating"
        : "The operating status of the linked return transport is unknown",
      connection.operating === false
        ? "return_transport_not_operating"
        : "return_transport_operating_unknown",
      { connectionId: connection.id },
    );
  }
  if (connection.sensitivity?.action !== "publish") {
    throw new ItineraryError(
      "The return transport geometry is not approved for precise planning",
      "return_transport_location_unavailable",
      { connectionId: connection.id },
    );
  }
  if (!Number.isFinite(connection.typicalDurationMinutes)
      || connection.typicalDurationMinutes <= 0) {
    throw new ItineraryError(
      "The return transport duration is missing or invalid",
      "return_transport_duration_invalid",
      { connectionId: connection.id },
    );
  }

  validateReturnEndpointIds(connection);
  const orientation = validateReturnTransportGeometry(
    connection,
    currentPosition,
    vehiclePosition,
  );
  const scheduleContext = validateReturnSchedule(connection, time);
  validateReturnTransportQuality(connection, time, scheduleContext);
  return {
    connection,
    ...orientation,
    nextDeparture: nextReturnDeparture(connection, time, scheduleContext),
  };
}

function validateReturnEndpointIds(connection) {
  const endpointIds = connection.endpointIds;
  const normalizedEndpointIds = Array.isArray(endpointIds)
    ? endpointIds.map((value) => typeof value === "string" ? value.trim() : "") : [];
  if (!Array.isArray(endpointIds)
      || endpointIds.length !== 2
      || normalizedEndpointIds.some((value) => !value)
      || new Set(normalizedEndpointIds).size !== normalizedEndpointIds.length) {
    throw new ItineraryError(
      "The return transport does not identify two distinct endpoints",
      "return_transport_endpoints_invalid",
      { connectionId: connection.id },
    );
  }
}

function validateReturnTransportGeometry(connection, currentPosition, vehiclePosition) {
  const endpoints = transportGeometryEndpoints(connection.geometry);
  if (!endpoints || !validPosition(currentPosition) || !validPosition(vehiclePosition)) {
    throw new ItineraryError(
      "The return transport lacks valid endpoint geometry",
      "return_transport_geometry_invalid",
      { connectionId: connection.id },
    );
  }

  const orientations = [{
    start: endpoints.start,
    end: endpoints.end,
    geometry: connection.geometry,
  }];
  if (connection.direction === "both") {
    orientations.push({
      start: endpoints.end,
      end: endpoints.start,
      geometry: reverseTransportGeometry(connection.geometry),
    });
  }
  const matches = orientations.map(({ start, end, geometry }) => ({
    start,
    end,
    routeFinishDistanceMeters: haversineMeters(currentPosition, start),
    vehicleDistanceMeters: haversineMeters(vehiclePosition, end),
    geometry,
  }));
  const best = matches.reduce((preferred, candidate) =>
    Math.max(candidate.routeFinishDistanceMeters, candidate.vehicleDistanceMeters)
      < Math.max(preferred.routeFinishDistanceMeters, preferred.vehicleDistanceMeters)
      ? candidate : preferred);
  if (best.routeFinishDistanceMeters > RETURN_TRANSPORT_ENDPOINT_TOLERANCE_METERS
      || best.vehicleDistanceMeters > RETURN_TRANSPORT_ENDPOINT_TOLERANCE_METERS) {
    throw new ItineraryError(
      "The return transport does not connect the route finish to the parked vehicle or pickup point",
      "return_transport_geometry_mismatch",
      {
        connectionId: connection.id,
        routeFinishDistanceMeters: Math.round(best.routeFinishDistanceMeters),
        vehicleDistanceMeters: Math.round(best.vehicleDistanceMeters),
        toleranceMeters: RETURN_TRANSPORT_ENDPOINT_TOLERANCE_METERS,
      },
    );
  }
  return {
    geometry: best.geometry,
    boardingPoint: best.start,
    arrivalPoint: best.end,
  };
}

function transportGeometryEndpoints(
  geometry,
  lineJoinToleranceMeters = RETURN_TRANSPORT_ENDPOINT_TOLERANCE_METERS,
) {
  const lines = geometry?.type === "LineString"
    ? [geometry.coordinates]
    : geometry?.type === "MultiLineString"
      ? geometry.coordinates
      : [];
  if (!Array.isArray(lines) || !lines.length
      || lines.some((line) => !Array.isArray(line)
        || line.length < 2
        || line.some((position) => !validPosition(position)))) {
    return null;
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (haversineMeters(lines[index - 1].at(-1), lines[index][0])
        > lineJoinToleranceMeters) {
      return null;
    }
  }
  return {
    start: lines[0][0],
    end: lines.at(-1).at(-1),
  };
}

function validateReturnSchedule(connection, time) {
  const schedule = connection.schedule;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new ItineraryError(
      "The return transport has no schedule",
      "return_schedule_unavailable",
      { connectionId: connection.id },
    );
  }
  if (schedule.freshness !== "current") {
    throw new ItineraryError(
      "The return transport schedule is not verified as current",
      "return_schedule_not_current",
      {
        connectionId: connection.id,
        freshness: schedule.freshness ?? "unknown",
      },
    );
  }

  const local = destinationLocalParts(time, schedule.timezone, connection.id);
  const travelDate = dateOrdinal(local.year, local.month, local.day);
  const validFrom = optionalDateOrdinal(
    schedule.validFrom,
    "schedule.validFrom",
    "return_schedule_invalid",
    connection.id,
    { required: true },
  );
  const validUntil = optionalDateOrdinal(
    schedule.validUntil,
    "schedule.validUntil",
    "return_schedule_invalid",
    connection.id,
    { required: true },
  );
  if (validFrom > validUntil) {
    throw new ItineraryError(
      "The return transport schedule validity interval is invalid",
      "return_schedule_invalid",
      { connectionId: connection.id },
    );
  }
  if (travelDate < validFrom || travelDate > validUntil) {
    throw new ItineraryError(
      "The return transport schedule is not valid on the planned travel date",
      "return_schedule_out_of_range",
      {
        connectionId: connection.id,
        travelDate: localDateText(local),
        validFrom: schedule.validFrom,
        validUntil: schedule.validUntil,
        timezone: schedule.timezone,
      },
    );
  }
  if (!Array.isArray(schedule.departuresLocal)
      || schedule.departuresLocal.length === 0) {
    throw new ItineraryError(
      "The return transport has no exact usable departure time",
      "return_schedule_unavailable",
      { connectionId: connection.id },
    );
  }
  const departureMinutes = schedule.departuresLocal.map((value, index) =>
    returnClockMinutes(value, connection.id, `schedule.departuresLocal[${index}]`));
  if (new Set(departureMinutes).size !== departureMinutes.length) {
    throw new ItineraryError(
      "The return transport departure list contains duplicates",
      "return_schedule_invalid",
      { connectionId: connection.id },
    );
  }
  const lastDeparture = schedule.lastDepartureLocal == null
    ? null
    : returnClockMinutes(
      schedule.lastDepartureLocal,
      connection.id,
      "schedule.lastDepartureLocal",
    );
  if (lastDeparture !== null
      && departureMinutes.some((minutes) => minutes > lastDeparture)) {
    throw new ItineraryError(
      "The return transport departure list extends beyond its declared final departure",
      "return_schedule_invalid",
      { connectionId: connection.id },
    );
  }
  return {
    ...local,
    departureMinutes: departureMinutes.toSorted((left, right) => left - right),
    travelDate,
    timezone: schedule.timezone.trim(),
  };
}

function validateReturnTransportQuality(connection, time, scheduleContext) {
  const quality = connection.quality;
  if (quality?.verificationStatus !== "verified") {
    throw new ItineraryError(
      "The return transport record is not verified",
      "return_transport_unverified",
      {
        connectionId: connection.id,
        verificationStatus: quality?.verificationStatus ?? "unknown",
      },
    );
  }
  const unsafeFlags = Array.isArray(quality.flags)
    ? quality.flags.filter(isPlanningBlockingQualityFlag)
    : ["quality_flags_missing"];
  if (quality.freshness !== "current" || unsafeFlags.length) {
    throw new ItineraryError(
      "The return transport record is not verified as current",
      "return_transport_quality_not_current",
      {
        connectionId: connection.id,
        freshness: quality.freshness ?? "unknown",
        flags: unsafeFlags,
      },
    );
  }
  const assessedAt = optionalDateOrdinal(
    quality.assessedAt,
    "quality.assessedAt",
    "return_transport_quality_invalid",
    connection.id,
    { required: true },
  );
  if (assessedAt > scheduleContext.travelDate) {
    throw new ItineraryError(
      "The return transport quality assessment is dated after the planned journey",
      "return_transport_quality_invalid",
      {
        connectionId: connection.id,
        assessedAt: quality.assessedAt,
        travelDate: localDateText(scheduleContext),
        timezone: scheduleContext.timezone,
      },
    );
  }

  const geometryAssertions = (connection.sourceAssertions || []).filter((assertion) =>
    assertion?.fieldPath === "/geometry"
    || String(assertion?.fieldPath || "").startsWith("/geometry/"));
  const currentGeometryAssertion = geometryAssertions.some((assertion) => {
    if (assertion.verificationStatus !== "verified") return false;
    const observed = firstPresent(assertion.observedAt, assertion.retrievedAt, assertion.validFrom);
    const observedAt = validInstant(observed);
    const validFrom = assertion.validFrom ? validInstant(assertion.validFrom) : null;
    const validUntil = assertion.validUntil ? validInstant(assertion.validUntil) : null;
    return observedAt !== null
      && observedAt <= time.getTime()
      && (!assertion.validFrom || (validFrom !== null && validFrom <= time.getTime()))
      && (!assertion.validUntil || (validUntil !== null && validUntil >= time.getTime()));
  });
  if (!currentGeometryAssertion) {
    throw new ItineraryError(
      "The return transport geometry lacks current verified provenance",
      "return_transport_provenance_unverified",
      { connectionId: connection.id },
    );
  }
}

function nextReturnDeparture(connection, time, scheduleContext) {
  const departureMinutes = new Set(scheduleContext.departureMinutes);
  const firstCandidate = Math.ceil(time.getTime() / 60_000) * 60_000;
  const searchLimit = firstCandidate + 27 * 60 * 60_000;
  for (let timestamp = firstCandidate; timestamp <= searchLimit; timestamp += 60_000) {
    const candidate = new Date(timestamp);
    const local = destinationLocalParts(
      candidate,
      scheduleContext.timezone,
      connection.id,
    );
    const candidateDate = dateOrdinal(local.year, local.month, local.day);
    if (candidateDate > scheduleContext.travelDate) break;
    if (candidateDate === scheduleContext.travelDate
        && departureMinutes.has(local.hour * 60 + local.minute)) {
      return candidate;
    }
  }
  throw missedReturnTransport(connection, scheduleContext);
}

function missedReturnTransport(connection, scheduleContext) {
  return new ItineraryError(
    `The route finishes after the final ${connection.transportMode} departure`,
    "missed_last_transport",
    {
      connectionId: connection.id,
      lastDepartureLocal: connection.schedule.lastDepartureLocal ?? null,
      plannedArrivalLocal: `${twoDigits(scheduleContext.hour)}:${twoDigits(scheduleContext.minute)}`,
      timezone: scheduleContext.timezone,
    },
  );
}

function returnClockMinutes(value, connectionId, field) {
  try {
    return clockMinutes(value);
  } catch (error) {
    if (!(error instanceof ItineraryError)) throw error;
    throw new ItineraryError(
      `The return transport ${field} is invalid`,
      "return_schedule_invalid",
      { connectionId, field, value },
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
      && isSafetySensitiveTrailRoute(experience)) {
    throw new ItineraryError(
      "A critical condition is unknown for this safety-sensitive route",
      "critical_condition_unknown",
    );
  }
}
function ensureRouteQuality(experience, time) {
  const quality = experience.quality;
  if (quality?.verificationStatus !== "verified") {
    throw new ItineraryError(
      "The route record is not verified",
      "route_unverified",
      { verificationStatus: quality?.verificationStatus ?? "unknown" },
    );
  }
  const flags = Array.isArray(quality.flags) ? quality.flags : null;
  if (!flags) {
    throw new ItineraryError(
      "The route quality flags are missing",
      "route_quality_invalid",
    );
  }
  const unsafeFlags = flags.filter(isUnsafePlanningQualityFlag);
  if (unsafeFlags.length) {
    throw new ItineraryError(
      "The route quality record contains an unsafe or blocking flag",
      "unsafe_condition",
      { flags: unsafeFlags },
    );
  }
  const nonCurrentFlags = flags.filter((flag) =>
    String(flag) !== "critical_condition_unknown" && isPlanningBlockingQualityFlag(flag));
  if (quality.freshness !== "current" || nonCurrentFlags.length) {
    throw new ItineraryError(
      "The route record is not verified as current",
      "route_quality_not_current",
      {
        freshness: quality.freshness ?? "unknown",
        flags: nonCurrentFlags,
      },
    );
  }
  const assessedAt = validInstant(quality.assessedAt);
  if (assessedAt === null || assessedAt > time.getTime()) {
    throw new ItineraryError(
      assessedAt === null
        ? "The route quality assessment date is missing or invalid"
        : "The route quality assessment is dated after the journey",
      "route_quality_invalid",
      { assessedAt: quality.assessedAt ?? null },
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
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match) throw new ItineraryError(`Invalid local clock value: ${value}`, "invalid_schedule");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new ItineraryError(`Invalid local clock value: ${value}`, "invalid_schedule");
  }
  return hour * 60 + minute;
}

function destinationLocalParts(date, timezone, connectionId) {
  if (typeof timezone !== "string" || !timezone.trim()) {
    throw new ItineraryError(
      "The return transport schedule has no destination timezone",
      "return_schedule_timezone_invalid",
      { connectionId, timezone: timezone ?? null },
    );
  }
  const normalizedTimezone = timezone.trim();
  let formatter = DESTINATION_TIME_FORMATTERS.get(normalizedTimezone);
  try {
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: normalizedTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      DESTINATION_TIME_FORMATTERS.set(normalizedTimezone, formatter);
    }
    const parts = Object.fromEntries(
      formatter.formatToParts(date)
        .filter(({ type }) => type !== "literal")
        .map(({ type, value }) => [type, Number(value)]),
    );
    if (![parts.year, parts.month, parts.day, parts.hour, parts.minute]
      .every(Number.isFinite)) {
      throw new RangeError("Incomplete timezone conversion");
    }
    return parts;
  } catch {
    throw new ItineraryError(
      "The return transport schedule timezone is invalid",
      "return_schedule_timezone_invalid",
      { connectionId, timezone },
    );
  }
}

function optionalDateOrdinal(value, field, code, connectionId, options = {}) {
  if (value == null || value === "") {
    if (!options.required) return null;
    throw new ItineraryError(
      `The return transport ${field} is required`,
      code,
      { connectionId, field },
    );
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) {
    throw new ItineraryError(
      `The return transport ${field} must be an ISO calendar date`,
      code,
      { connectionId, field, value },
    );
  }
  const [year, month, day] = match.slice(1).map(Number);
  const ordinal = dateOrdinal(year, month, day);
  const normalized = new Date(ordinal * 86_400_000);
  if (normalized.getUTCFullYear() !== year
      || normalized.getUTCMonth() + 1 !== month
      || normalized.getUTCDate() !== day) {
    throw new ItineraryError(
      `The return transport ${field} is not a real calendar date`,
      code,
      { connectionId, field, value },
    );
  }
  return ordinal;
}

function dateOrdinal(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function localDateText(parts) {
  return `${parts.year}-${twoDigits(parts.month)}-${twoDigits(parts.day)}`;
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function validInstant(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}
