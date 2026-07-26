import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertCanonicalEntity,
  displayName,
  lineDistanceMeters,
} from "../assets/js/nature/domain.mjs";
import {
  buildMixedModeItinerary,
  ItineraryError,
  RETURN_TRANSPORT_ENDPOINT_TOLERANCE_METERS,
} from "../assets/js/nature/itinerary.mjs";
import { RoutingGateway } from "../assets/js/nature/routing.mjs";

const fixtureDirectory = new URL("./fixtures/journeys/", import.meta.url);
const [successfulDocument, refusalDocument] = await Promise.all([
  readFixture("successful.json"),
  readFixture("refusals.json"),
]);

const successfulScenarios = new Map(
  successfulDocument.scenarios.map((scenario) => [scenario.id, scenario]),
);
const refusalScenarios = new Map(
  refusalDocument.scenarios.map((scenario) => [scenario.id, scenario]),
);

class DeterministicRoutingProvider {
  constructor(options = {}) {
    this.capabilities = options.timeDependentRouting
      ? Object.freeze({ timeDependentRouting: true })
      : Object.freeze({});
    this.routeCalls = [];
    this.matrixCalls = [];
  }

  async route(request) {
    this.routeCalls.push(structuredClone(request));
    const geometry = {
      type: "LineString",
      coordinates: request.coordinates.map(([longitude, latitude]) => [longitude, latitude]),
    };
    const durationSeconds = request.profile === "car"
      ? 600
      : request.profile === "foot"
        ? 420
        : 480;
    return {
      provider: "deterministic-fixture",
      routes: [{
        geometry,
        distanceMeters: Math.round(lineDistanceMeters(geometry)),
        durationSeconds,
        warnings: [],
      }],
    };
  }

  async matrix(request) {
    this.matrixCalls.push(structuredClone(request));
    const size = request.coordinates.length;
    return {
      provider: "deterministic-fixture",
      distancesMeters: Array.from(
        { length: size },
        (_, row) => Array.from({ length: size }, (_, column) => (row === column ? 0 : 1000)),
      ),
      durationsSeconds: Array.from(
        { length: size },
        (_, row) => Array.from({ length: size }, (_, column) => (row === column ? 0 : 120)),
      ),
    };
  }
}

function createRoutingHarness(options = {}) {
  const provider = new DeterministicRoutingProvider(options);
  const gateway = new RoutingGateway(provider, { timeoutMs: 1000 });
  const itineraryRequests = [];
  const normalizedRoute = gateway.route.bind(gateway);
  gateway.route = (request) => {
    itineraryRequests.push(structuredClone(request));
    return normalizedRoute(request);
  };
  return { gateway, provider, itineraryRequests };
}

async function readFixture(filename) {
  return JSON.parse(await readFile(new URL(filename, fixtureDirectory), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function canonicalEntities(experience) {
  return [
    experience,
    ...(experience.accessPoints || []),
    ...(experience.transportConnections || []),
    ...(experience.conditions || []),
    ...(experience.restrictions || []),
    ...(experience.hazards || []),
  ];
}

async function planScenario(scenario, options = {}) {
  const harness = createRoutingHarness(options);
  const experience = clone(scenario.experience);
  const originalGeometry = clone(experience.geometry);
  const itinerary = await buildMixedModeItinerary({
    ...scenario.request,
    experience,
    gateway: harness.gateway,
  });
  return {
    ...harness,
    experience,
    originalGeometry,
    itinerary,
  };
}

function assertErrorCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof ItineraryError);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

async function expectPlanningRefusal(scenario, expectedCode, inspect = null) {
  const harness = createRoutingHarness();
  let capturedError = null;
  await assert.rejects(
    buildMixedModeItinerary({
      ...scenario.request,
      experience: scenario.experience,
      gateway: harness.gateway,
    }),
    (error) => {
      capturedError = error;
      assert.ok(error instanceof ItineraryError);
      assert.equal(error.code, expectedCode);
      inspect?.(error);
      return true;
    },
  );
  return { ...harness, error: capturedError };
}

function clonedReturnScenario(id = "scotland-point-to-point-timed-transport") {
  return clone(successfulScenarios.get(id));
}

function onlyReturnConnection(scenario) {
  assert.equal(scenario.experience.transportConnections.length, 1);
  return scenario.experience.transportConnections[0];
}

function clonedOutboundScenario(options = {}) {
  const scenario = clone(successfulScenarios.get("coastal-point-to-point"));
  const accessPoint = scenario.experience.accessPoints[0];
  const transportMode = options.transportMode ?? "ferry";
  const accessPointMode = options.accessPointMode ?? "ferry";
  const boardingPoint = [-5.04, 51.65];
  const transportArrivalPoint = [-5.099, 51.665];
  const accessPointPosition = [-5.1, 51.665];
  const boardingEndpointId = `transport:${transportMode}-boarding`;
  const reverse = options.reverse === true;

  scenario.id = `outbound-${transportMode}`;
  scenario.request = {
    ...scenario.request,
    origin: [-5.05, 51.65],
    departureTime: "2026-07-15T07:50:00Z",
    accessMode: "transit",
  };
  accessPoint.geometry.coordinates = accessPointPosition;
  accessPoint.accessModes = [accessPointMode];
  const connection = {
    schemaVersion: "1.0.0",
    id: `transport:outbound-${transportMode}`,
    entityType: "TransportConnection",
    jurisdictionIds: ["gb-wls"],
    names: [{
      language: "en",
      value: `Outbound ${transportMode}`,
      kind: "primary",
    }],
    geometry: {
      type: "LineString",
      coordinates: reverse
        ? [transportArrivalPoint, boardingPoint]
        : [boardingPoint, transportArrivalPoint],
    },
    sourceAssertions: [{
      id: `assertion:transport:outbound-${transportMode}`,
      sourceId: "fixture:journeys",
      fieldPath: "/geometry",
      evidenceKind: "maintainer_curated",
      verificationStatus: "verified",
      confidence: 0.96,
      observedAt: "2026-07-01T00:00:00Z",
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2026-12-31T23:59:59Z",
    }],
    quality: {
      confidence: 0.96,
      verificationStatus: "verified",
      assessedAt: "2026-07-01",
      freshness: "current",
      flags: [],
    },
    sensitivity: { action: "publish" },
    transportMode,
    direction: reverse ? "both" : "outbound",
    endpointIds: reverse
      ? [accessPoint.id, boardingEndpointId]
      : [boardingEndpointId, accessPoint.id],
    typicalDurationMinutes: 20,
    schedule: {
      timezone: "Europe/London",
      departuresLocal: ["09:00", "11:00"],
      lastDepartureLocal: "11:00",
      freshness: "current",
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    },
    distanceMeters: 5200,
    operating: true,
  };
  scenario.experience.transportConnectionIds = [connection.id];
  scenario.experience.transportConnections = [connection];
  return scenario;
}

function onlyOutboundConnection(scenario) {
  assert.equal(scenario.experience.transportConnections.length, 1);
  return scenario.experience.transportConnections[0];
}

async function expectOutboundRefusal(mutate, expectedCode, expectedRoutingCalls = 0) {
  const scenario = clonedOutboundScenario();
  mutate(scenario);
  const harness = createRoutingHarness();
  const originalGeometry = clone(scenario.experience.geometry);
  let capturedError = null;
  await assert.rejects(
    buildMixedModeItinerary({
      ...scenario.request,
      experience: scenario.experience,
      gateway: harness.gateway,
    }),
    (error) => {
      capturedError = error;
      assert.ok(error instanceof ItineraryError);
      assert.equal(error.code, expectedCode);
      return true;
    },
  );
  assert.equal(harness.itineraryRequests.length, expectedRoutingCalls);
  assert.deepEqual(scenario.experience.geometry, originalGeometry);
  return { ...harness, error: capturedError, scenario };
}

test("all journey fixtures contain valid canonical entities", () => {
  const scenarios = [
    ...successfulDocument.scenarios,
    ...refusalDocument.scenarios,
  ];
  for (const scenario of scenarios) {
    for (const entity of canonicalEntities(scenario.experience)) {
      assert.doesNotThrow(
        () => assertCanonicalEntity(entity),
        scenario.id + " contains invalid entity " + entity.id,
      );
    }
  }
});

test("Alpine scenic-drive migration metadata retains its legacy identity and car profile", async () => {
  const scenario = successfulScenarios.get("alpine-drive-compatibility");
  const { experience, expected, request } = scenario;
  assert.equal(experience.routeNature, "scenic_drive");
  assert.equal(experience.compatibility.legacyId, expected.legacyId);
  assert.equal(experience.compatibility.routingProfile, "car");
  assert.deepEqual(
    experience.originalSourceIds,
    [{ sourceId: "legacy-passes-v1", recordId: "grossglockner" }],
  );

  const harness = createRoutingHarness();
  const response = await harness.gateway.route({
    profile: experience.compatibility.routingProfile,
    coordinates: [request.origin, experience.geometry.coordinates[0]],
  });
  assert.equal(response.profile, "car");
  assert.deepEqual(
    harness.provider.routeCalls.map((call) => call.profile),
    expected.routingProfiles,
  );
});

test("routing profiles are preserved exactly, including hiking", async () => {
  const harness = createRoutingHarness();
  const coordinates = [[-4.1, 56.1], [-4.0, 56.2]];
  for (const profile of ["car", "foot", "hiking"]) {
    const result = await harness.gateway.route({ profile, coordinates });
    assert.equal(result.profile, profile);
  }
  assert.deepEqual(
    harness.provider.routeCalls.map((call) => call.profile),
    ["car", "foot", "hiking"],
  );
});

for (const scenario of successfulDocument.scenarios.filter(
  ({ id }) => id !== "alpine-drive-compatibility",
)) {
  test(scenario.id + " builds the expected mixed-mode journey without altering established geometry", async () => {
    const result = await planScenario(scenario);
    const {
      itinerary,
      experience,
      originalGeometry,
      itineraryRequests,
      provider,
    } = result;

    assert.deepEqual(
      itinerary.legs.map((leg) => leg.mode),
      scenario.expected.modes,
    );
    assert.deepEqual(
      itineraryRequests.map((request) => request.profile),
      scenario.expected.routingProfiles,
    );
    assert.ok(
      itineraryRequests.every((request) => !Object.hasOwn(request, "departureTime")),
      "departureTime must be omitted when the provider lacks time-dependent routing",
    );
    assert.ok(
      provider.routeCalls.every((request) => request.departureTime === null),
      "normalization may add only a null departureTime for a non-time-dependent provider",
    );

    const establishedLeg = itinerary.legs.find((leg) => leg.routeNature === "established");
    assert.ok(establishedLeg, "an established route leg must be present");
    assert.deepEqual(establishedLeg.geometry, originalGeometry);
    assert.deepEqual(experience.geometry, originalGeometry);
    assert.notEqual(establishedLeg.routeNature, "generated");
    assert.ok(
      !itineraryRequests.some((request) => request.profile === "hiking"),
      "established hiking geometry must not be replaced by generated routing",
    );
  });
}

test("Scotland loop composes drive, foot connectors, established hike, and return drive", async () => {
  const scenario = successfulScenarios.get("scotland-drive-foot-established-loop");
  const { itinerary } = await planScenario(scenario);
  assert.deepEqual(
    itinerary.legs.map(({ mode, routeNature }) => [mode, routeNature]),
    [
      ["drive", "generated"],
      ["park_or_transfer", "dwell"],
      ["walk_connector", "generated"],
      ["hike", "established"],
      ["walk_connector", "generated"],
      ["drive", "generated"],
    ],
  );
});

test("Scotland point-to-point itinerary includes the linked timed return transport", async () => {
  const scenario = successfulScenarios.get("scotland-point-to-point-timed-transport");
  const { itinerary } = await planScenario(scenario);
  const scheduled = itinerary.legs.find((leg) => leg.routeNature === "scheduled");
  const wait = itinerary.legs.find((leg) => leg.mode === "wait_for_transport");
  assert.equal(scheduled.mode, scenario.expected.scheduledMode);
  assert.equal(scheduled.label, "Return bus to Rannoch trailhead");
  assert.ok(scheduled.sourceAssertionRefs.length > 0);
  assert.equal(wait.startsAt, "2026-07-15T12:20:00.000Z");
  assert.equal(wait.endsAt, "2026-07-15T16:30:00.000Z");
  assert.equal(wait.durationSeconds, 15_000);
  assert.equal(scheduled.startsAt, wait.endsAt);
  assert.equal(scheduled.endsAt, "2026-07-15T17:12:00.000Z");
  assert.deepEqual(wait.geometry.coordinates, [-4.62, 56.82]);
});
test("the earliest valid return service is selected across linked connections", async () => {
  const scenario = clonedReturnScenario();
  const later = onlyReturnConnection(scenario);
  later.names[0].value = "Later return bus";
  later.schedule.departuresLocal = ["20:30"];
  later.schedule.lastDepartureLocal = "20:30";
  const earlier = clone(later);
  earlier.id = "transport:scotland-earlier-return-bus";
  earlier.names[0].value = "Earlier return bus";
  earlier.endpointIds = ["transport:earlier:a", "transport:earlier:b"];
  earlier.sourceAssertions[0].id = "assertion:transport:scotland-earlier-return-bus";
  earlier.schedule.departuresLocal = ["17:30"];
  earlier.schedule.lastDepartureLocal = "17:30";
  scenario.experience.transportConnectionIds = [later.id, earlier.id];
  scenario.experience.transportConnections = [later, earlier];

  const { itinerary } = await planScenario(scenario);
  const scheduled = itinerary.legs.find((leg) => leg.routeNature === "scheduled");
  const wait = itinerary.legs.find((leg) => leg.mode === "wait_for_transport");
  assert.equal(scheduled.label, "Earlier return bus");
  assert.equal(wait.endsAt, "2026-07-15T16:30:00.000Z");
  assert.equal(scheduled.startsAt, wait.endsAt);
});


test("coastal route keeps complete geometry and ends at an explicit different pickup", async () => {
  const scenario = successfulScenarios.get("coastal-point-to-point");
  const { itinerary, originalGeometry } = await planScenario(scenario);
  assert.deepEqual(
    itinerary.legs.find((leg) => leg.routeNature === "established").geometry,
    originalGeometry,
  );
  assert.equal(itinerary.legs.at(-1).mode, "pickup");
  assert.match(itinerary.legs.at(-1).warnings[0], /different location/i);
});

test("island journey includes a scheduled ferry and returns to the parked vehicle", async () => {
  const scenario = successfulScenarios.get("island-ferry-return");
  const { itinerary } = await planScenario(scenario);
  assert.equal(
    itinerary.legs.find((leg) => leg.routeNature === "scheduled").mode,
    "ferry",
  );
  assert.equal(itinerary.legs.at(-1).mode, "drive");
});

test("foot access routes origin to a hiking-capable access point before the route", async () => {
  const scenario = clone(successfulScenarios.get("coastal-point-to-point"));
  const accessPoint = scenario.experience.accessPoints[0];
  scenario.request.accessMode = "foot";
  accessPoint.accessModes = ["hiking"];
  accessPoint.geometry.coordinates = [-5.09, 51.66];
  const originalGeometry = clone(scenario.experience.geometry);

  const { itinerary, itineraryRequests } = await planScenario(scenario);
  assert.deepEqual(
    itinerary.legs.map((leg) => leg.mode),
    ["walk_connector", "walk_connector", "hike", "pickup"],
  );
  assert.deepEqual(
    itineraryRequests.map((request) => request.profile),
    ["foot", "foot"],
  );
  assert.deepEqual(itineraryRequests[0].coordinates, [
    scenario.request.origin,
    accessPoint.geometry.coordinates,
  ]);
  assert.deepEqual(itineraryRequests[1].coordinates, [
    accessPoint.geometry.coordinates,
    scenario.experience.geometry.coordinates[0],
  ]);
  assert.equal(
    itinerary.legs[0].label,
    `Trip origin to ${displayName(accessPoint)}`,
  );
  assert.equal(
    itinerary.legs[1].label,
    `${displayName(accessPoint)} to Established route`,
  );
  assert.deepEqual(
    itinerary.legs.find((leg) => leg.routeNature === "established").geometry,
    originalGeometry,
  );
  assert.deepEqual(scenario.experience.geometry, originalGeometry);
});

for (const configuration of [
  { label: "ferry", transportMode: "ferry", accessPointMode: "ferry" },
  {
    label: "reversed bidirectional cable car",
    transportMode: "cable_car",
    accessPointMode: "cable_transport",
    reverse: true,
  },
  { label: "coarse transit bus", transportMode: "bus", accessPointMode: "transit" },
]) {
  test(`verified ${configuration.label} outbound access models connectors and waiting`, async () => {
    const scenario = clonedOutboundScenario(configuration);
    const connection = onlyOutboundConnection(scenario);
    const accessPoint = scenario.experience.accessPoints[0];
    const originalRouteGeometry = clone(scenario.experience.geometry);
    const originalConnectionGeometry = clone(connection.geometry);

    const { itinerary, itineraryRequests } = await planScenario(scenario);
    assert.deepEqual(
      itinerary.legs.map((leg) => leg.mode),
      [
        "walk_connector",
        "wait_for_transport",
        configuration.transportMode,
        "walk_connector",
        "walk_connector",
        "hike",
        "pickup",
      ],
    );
    assert.deepEqual(
      itineraryRequests.map((request) => request.profile),
      ["foot", "foot", "foot"],
    );

    const wait = itinerary.legs.find((leg) => leg.mode === "wait_for_transport");
    const scheduled = itinerary.legs.find(
      (leg) => leg.mode === configuration.transportMode,
    );
    assert.equal(wait.startsAt, "2026-07-15T07:57:00.000Z");
    assert.equal(wait.endsAt, "2026-07-15T08:00:00.000Z");
    assert.equal(wait.durationSeconds, 180);
    assert.equal(scheduled.startsAt, wait.endsAt);
    assert.equal(scheduled.endsAt, "2026-07-15T08:20:00.000Z");
    assert.deepEqual(scheduled.geometry.coordinates[0], [-5.04, 51.65]);
    assert.deepEqual(scheduled.geometry.coordinates.at(-1), [-5.099, 51.665]);

    assert.deepEqual(itineraryRequests[0].coordinates, [
      scenario.request.origin,
      [-5.04, 51.65],
    ]);
    assert.deepEqual(itineraryRequests[1].coordinates, [
      [-5.099, 51.665],
      accessPoint.geometry.coordinates,
    ]);
    assert.deepEqual(itineraryRequests[2].coordinates, [
      accessPoint.geometry.coordinates,
      scenario.experience.geometry.coordinates[0],
    ]);
    assert.deepEqual(
      itinerary.legs.find((leg) => leg.routeNature === "established").geometry,
      originalRouteGeometry,
    );
    assert.deepEqual(scenario.experience.geometry, originalRouteGeometry);
    assert.deepEqual(connection.geometry, originalConnectionGeometry);
  });
}

test("access-point planning filters legal, publication, quality, and parking state", async (t) => {
  const cases = [
    ["restricted legal state", (point) => { point.legalAccess = "restricted"; }],
    ["non-publish sensitivity", (point) => { point.sensitivity.action = "generalize"; }],
    ["unverified quality", (point) => { point.quality.verificationStatus = "unverified"; }],
    ["stale quality", (point) => { point.quality.freshness = "stale"; }],
    ["unsafe quality flag", (point) => { point.quality.flags = ["unsafe_access"]; }],
    ["future assessment", (point) => { point.quality.assessedAt = "2026-07-16"; }],
    ["parking not confirmed", (point) => { point.parking.stoppingAllowed = null; }],
  ];

  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const scenario = clone(
        successfulScenarios.get("scotland-drive-foot-established-loop"),
      );
      mutate(scenario.experience.accessPoints[0]);
      const { itineraryRequests } = await expectPlanningRefusal(
        scenario,
        "no_access_point",
      );
      assert.equal(itineraryRequests.length, 0);
    });
  }
});
test("route planning requires exact legal access and current navigation-safe quality", async (t) => {
  const cases = [
    ["non-public legal state", "access_not_public", (route) => { route.access.legal = "restricted"; }],
    ["navigation suitability not confirmed", "route_not_navigation_suitable", (route) => { route.navigationSuitability = false; }],
    ["unverified route", "route_unverified", (route) => { route.quality.verificationStatus = "unverified"; }],
    ["stale route", "route_quality_not_current", (route) => { route.quality.freshness = "stale"; }],
    ["unsafe quality flag", "unsafe_condition", (route) => { route.quality.flags = ["unsafe_surface"]; }],
    ["future assessment", "route_quality_invalid", (route) => { route.quality.assessedAt = "2026-07-16"; }],
    ["missing quality flags", "route_quality_invalid", (route) => { delete route.quality.flags; }],
  ];

  for (const [label, expectedCode, mutate] of cases) {
    await t.test(label, async () => {
      const scenario = clone(
        successfulScenarios.get("scotland-drive-foot-established-loop"),
      );
      mutate(scenario.experience);
      const { itineraryRequests } = await expectPlanningRefusal(
        scenario,
        expectedCode,
      );
      assert.equal(itineraryRequests.length, 0);
    });
  }
});


test("only car, foot, and transit are accepted as planner access modes", async () => {
  const scenario = clonedOutboundScenario();
  scenario.request.accessMode = "ferry";
  const harness = createRoutingHarness();
  await assert.rejects(
    buildMixedModeItinerary({
      ...scenario.request,
      experience: scenario.experience,
      gateway: harness.gateway,
    }),
    assertErrorCode("invalid_access_mode"),
  );
  assert.equal(harness.itineraryRequests.length, 0);
});

test("outbound schedules and connection quality must be current", async (t) => {
  for (const freshness of ["stale", "unknown"]) {
    await t.test(`schedule ${freshness}`, async () => {
      await expectOutboundRefusal((scenario) => {
        onlyOutboundConnection(scenario).schedule.freshness = freshness;
      }, "outbound_schedule_not_current");
    });
    await t.test(`quality ${freshness}`, async () => {
      await expectOutboundRefusal((scenario) => {
        onlyOutboundConnection(scenario).quality.freshness = freshness;
      }, "outbound_transport_quality_not_current");
    });
  }

  await t.test("unverified quality", async () => {
    await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).quality.verificationStatus = "unverified";
    }, "outbound_transport_unverified");
  });

  await t.test("unsafe quality flag", async () => {
    await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).quality.flags = ["unsafe_service"];
    }, "outbound_transport_quality_not_current");
  });

  await t.test("invalid quality assessment date", async () => {
    await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).quality.assessedAt = "2026-02-30";
    }, "outbound_transport_quality_invalid");
  });
});

test("outbound operating and publication state fail closed", async (t) => {
  await t.test("operating status unknown", async () => {
    await expectOutboundRefusal((scenario) => {
      delete onlyOutboundConnection(scenario).operating;
    }, "outbound_transport_operating_unknown");
  });

  await t.test("precise publication not approved", async () => {
    await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).sensitivity.action = "generalize";
    }, "outbound_transport_location_unavailable");
  });
});

test("outbound endpoint identity and geometry fail closed", async (t) => {
  await t.test("selected access point is not an endpoint", async () => {
    await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).endpointIds[1] = "access:other-place";
    }, "outbound_transport_access_point_mismatch");
  });

  await t.test("duplicate endpoints", async () => {
    await expectOutboundRefusal((scenario) => {
      const connection = onlyOutboundConnection(scenario);
      connection.endpointIds[1] = connection.endpointIds[0];
    }, "outbound_transport_endpoints_invalid");
  });

  await t.test("geometry does not end near access point", async () => {
    const { error } = await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).geometry.coordinates[1] = [20, 20];
    }, "outbound_transport_geometry_mismatch");
    assert.equal(
      error.details.toleranceMeters,
      RETURN_TRANSPORT_ENDPOINT_TOLERANCE_METERS,
    );
  });

  await t.test("multi-line geometry is not connected", async () => {
    await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).geometry = {
        type: "MultiLineString",
        coordinates: [
          [[-5.04, 51.65], [-5.07, 51.655]],
          [[-5.069, 51.655], [-5.099, 51.665]],
        ],
      };
    }, "outbound_transport_geometry_invalid");
  });

  await t.test("outbound-only geometry cannot be reversed", async () => {
    await expectOutboundRefusal((scenario) => {
      const accessPoint = scenario.experience.accessPoints[0];
      const connection = onlyOutboundConnection(scenario);
      connection.endpointIds = [accessPoint.id, connection.endpointIds[0]];
      connection.geometry.coordinates.reverse();
    }, "outbound_transport_geometry_mismatch");
  });
});

test("outbound schedule timezone, dates, departures, and provenance fail closed", async (t) => {
  await t.test("invalid timezone", async () => {
    await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).schedule.timezone = "Not/A_Timezone";
    }, "outbound_schedule_timezone_invalid");
  });

  await t.test("missing validity date", async () => {
    await expectOutboundRefusal((scenario) => {
      delete onlyOutboundConnection(scenario).schedule.validUntil;
    }, "outbound_schedule_invalid");
  });

  await t.test("travel date outside validity", async () => {
    await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).schedule.validUntil = "2026-07-14";
    }, "outbound_schedule_out_of_range");
  });

  await t.test("no exact departure", async () => {
    await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).schedule.departuresLocal = [];
    }, "outbound_schedule_unavailable");
  });

  await t.test("boarding connector misses the final departure", async () => {
    await expectOutboundRefusal((scenario) => {
      const schedule = onlyOutboundConnection(scenario).schedule;
      schedule.departuresLocal = ["08:55"];
      schedule.lastDepartureLocal = "08:55";
    }, "missed_outbound_transport", 1);
  });

  await t.test("geometry provenance expired", async () => {
    await expectOutboundRefusal((scenario) => {
      onlyOutboundConnection(scenario).sourceAssertions[0].validUntil =
        "2026-07-14T23:59:59Z";
    }, "outbound_transport_provenance_unverified");
  });
});

test("return transport geometry must connect route finish to vehicle within tolerance", async () => {
  const scenario = clonedReturnScenario();
  const connection = onlyReturnConnection(scenario);
  connection.geometry.coordinates = [[120, -40], [121, -40]];

  const { error, itineraryRequests } = await expectPlanningRefusal(
    scenario,
    "return_transport_geometry_mismatch",
  );
  assert.equal(itineraryRequests.length, 1, "only the outbound drive may run before refusal");
  assert.equal(
    error.details.toleranceMeters,
    RETURN_TRANSPORT_ENDPOINT_TOLERANCE_METERS,
  );
  assert.ok(error.details.routeFinishDistanceMeters > error.details.toleranceMeters);
  assert.ok(error.details.vehicleDistanceMeters > error.details.toleranceMeters);
});

test("bidirectional return geometry may be reversed but still must stay within tolerance", async () => {
  const scenario = clonedReturnScenario();
  const connection = onlyReturnConnection(scenario);
  connection.direction = "both";
  connection.geometry.coordinates.reverse();
  connection.geometry.coordinates[0][0] += 0.001;
  connection.geometry.coordinates[1][0] += 0.001;
  const sourceTransportGeometry = clone(connection.geometry);

  const { itinerary, itineraryRequests, originalGeometry, experience } = await planScenario(scenario);
  const scheduled = itinerary.legs.find((leg) => leg.routeNature === "scheduled");
  assert.equal(scheduled.mode, "bus");
  assert.deepEqual(scheduled.geometry.coordinates[0], sourceTransportGeometry.coordinates.at(-1));
  assert.deepEqual(scheduled.geometry.coordinates.at(-1), sourceTransportGeometry.coordinates[0]);
  assert.deepEqual(
    itinerary.legs.map((leg) => leg.mode),
    [
      "drive",
      "park_or_transfer",
      "hike",
      "walk_connector",
      "wait_for_transport",
      "bus",
      "walk_connector",
      "drive",
    ],
  );
  assert.deepEqual(
    itineraryRequests
      .filter((request) => request.profile === "foot")
      .map((request) => request.coordinates),
    [
      [originalGeometry.coordinates.at(-1), scheduled.geometry.coordinates[0]],
      [scheduled.geometry.coordinates.at(-1), scenario.experience.accessPoints[0].geometry.coordinates],
    ],
  );
  assert.deepEqual(connection.geometry, sourceTransportGeometry);
  assert.deepEqual(experience.transportConnections[0].geometry, sourceTransportGeometry);
  assert.deepEqual(
    itinerary.legs.find((leg) => leg.routeNature === "established").geometry,
    originalGeometry,
  );
  assert.deepEqual(experience.geometry, originalGeometry);
});

test("verified cable transport with matching endpoints remains plan-capable", async () => {
  const scenario = clonedReturnScenario("island-ferry-return");
  const connection = onlyReturnConnection(scenario);
  connection.transportMode = "cable_car";
  connection.names[0].value = "Verified return cable car";

  const { itinerary } = await planScenario(scenario);
  const scheduled = itinerary.legs.find((leg) => leg.routeNature === "scheduled");
  assert.equal(scheduled.mode, "cable_car");
  assert.equal(scheduled.label, "Verified return cable car");
});

test("stale, expired, and unknown return schedules fail closed", async (t) => {
  for (const freshness of ["stale", "expired", "unknown"]) {
    await t.test(freshness, async () => {
      const scenario = clonedReturnScenario();
      onlyReturnConnection(scenario).schedule.freshness = freshness;
      await expectPlanningRefusal(scenario, "return_schedule_not_current");
    });
  }
});

test("stale, expired, and unknown return-connection quality fails closed", async (t) => {
  for (const freshness of ["stale", "expired", "unknown"]) {
    await t.test(freshness, async () => {
      const scenario = clonedReturnScenario();
      onlyReturnConnection(scenario).quality.freshness = freshness;
      await expectPlanningRefusal(scenario, "return_transport_quality_not_current");
    });
  }

  await t.test("unverified", async () => {
    const scenario = clonedReturnScenario();
    onlyReturnConnection(scenario).quality.verificationStatus = "unverified";
    await expectPlanningRefusal(scenario, "return_transport_unverified");
  });

  await t.test("unsafe quality flag", async () => {
    const scenario = clonedReturnScenario();
    onlyReturnConnection(scenario).quality.flags = ["unsafe_service"];
    await expectPlanningRefusal(scenario, "return_transport_quality_not_current");
  });

  await t.test("missing quality flags", async () => {
    const scenario = clonedReturnScenario();
    delete onlyReturnConnection(scenario).quality.flags;
    await expectPlanningRefusal(scenario, "return_transport_quality_not_current");
  });
});

test("return schedule and provenance validity are evaluated at the journey time", async (t) => {
  for (const field of ["validFrom", "validUntil"]) {
    await t.test(`missing ${field}`, async () => {
      const scenario = clonedReturnScenario();
      delete onlyReturnConnection(scenario).schedule[field];
      await expectPlanningRefusal(scenario, "return_schedule_invalid");
    });
  }

  await t.test("expired schedule window", async () => {
    const scenario = clonedReturnScenario();
    onlyReturnConnection(scenario).schedule.validUntil = "2026-07-14";
    await expectPlanningRefusal(scenario, "return_schedule_out_of_range");
  });

  await t.test("future schedule window", async () => {
    const scenario = clonedReturnScenario();
    onlyReturnConnection(scenario).schedule.validFrom = "2026-07-16";
    await expectPlanningRefusal(scenario, "return_schedule_out_of_range");
  });

  await t.test("future quality assessment", async () => {
    const scenario = clonedReturnScenario();
    onlyReturnConnection(scenario).quality.assessedAt = "2026-07-16";
    await expectPlanningRefusal(scenario, "return_transport_quality_invalid");
  });

  await t.test("expired geometry assertion", async () => {
    const scenario = clonedReturnScenario();
    onlyReturnConnection(scenario).sourceAssertions[0].validUntil = "2026-07-14T23:59:59Z";
    await expectPlanningRefusal(scenario, "return_transport_provenance_unverified");
  });
});

test("return departure clocks use the schedule destination timezone", async (t) => {
  await t.test("service remains available in destination local time", async () => {
    const scenario = clonedReturnScenario();
    const schedule = onlyReturnConnection(scenario).schedule;
    schedule.timezone = "America/New_York";
    schedule.departuresLocal = ["09:00"];
    schedule.lastDepartureLocal = "09:00";

    const { itinerary } = await planScenario(scenario);
    const wait = itinerary.legs.find((leg) => leg.mode === "wait_for_transport");
    const scheduled = itinerary.legs.find((leg) => leg.routeNature === "scheduled");
    assert.equal(wait.startsAt, "2026-07-15T12:20:00.000Z");
    assert.equal(wait.endsAt, "2026-07-15T13:00:00.000Z");
    assert.equal(scheduled.startsAt, wait.endsAt);
  });

  await t.test("service is missed in destination local time", async () => {
    const scenario = clonedReturnScenario();
    const schedule = onlyReturnConnection(scenario).schedule;
    schedule.timezone = "Asia/Tokyo";
    schedule.departuresLocal = ["20:30"];
    schedule.lastDepartureLocal = "20:30";

    const { error } = await expectPlanningRefusal(scenario, "missed_last_transport");
    assert.equal(error.details.timezone, "Asia/Tokyo");
    assert.equal(error.details.plannedArrivalLocal, "21:20");
  });
});

test("missing or invalid return schedule timezone fails closed", async (t) => {
  for (const [label, timezone] of [
    ["missing", undefined],
    ["invalid", "Not/A_Timezone"],
  ]) {
    await t.test(label, async () => {
      const scenario = clonedReturnScenario();
      onlyReturnConnection(scenario).schedule.timezone = timezone;
      await expectPlanningRefusal(scenario, "return_schedule_timezone_invalid");
    });
  }
});

test("a last-service summary without exact departures cannot promise a return", async () => {
  const scenario = clonedReturnScenario();
  const schedule = onlyReturnConnection(scenario).schedule;
  schedule.departuresLocal = [];
  schedule.lastDepartureLocal = "23:55";
  await expectPlanningRefusal(scenario, "return_schedule_unavailable");
});

test("return transport must identify exactly two distinct endpoints", async (t) => {
  await t.test("duplicate endpoint", async () => {
    const scenario = clonedReturnScenario();
    const connection = onlyReturnConnection(scenario);
    connection.endpointIds = ["transport:same-stop", " transport:same-stop "];
    await expectPlanningRefusal(scenario, "return_transport_endpoints_invalid");
  });

  await t.test("extra endpoint", async () => {
    const scenario = clonedReturnScenario();
    onlyReturnConnection(scenario).endpointIds.push("transport:unexpected-third-stop");
    await expectPlanningRefusal(scenario, "return_transport_endpoints_invalid");
  });
});

test("Japanese endonym, romanization, and inactive seasonal condition remain traceable", async () => {
  const scenario = successfulScenarios.get("japan-endonym-romanization-seasonal-access");
  const { experience, itinerary } = await planScenario(scenario);
  assert.equal(displayName(experience, ["ja"]), "青木ヶ原樹海自然歩道");
  assert.equal(
    experience.names.find((name) => name.kind === "romanized").value,
    "Aokigahara Jukai Shizen Hodō",
  );

  const established = itinerary.legs.find((leg) => leg.routeNature === "established");
  assert.ok(established.conditionRefs.includes(scenario.expected.conditionRef));
  assert.ok(established.warnings.some((warning) => /Seasonal access/i.test(warning)));
});

test("cross-border route preserves all jurisdictions and full established geometry", async () => {
  const scenario = successfulScenarios.get("cross-border-established-route");
  const { experience, itinerary, originalGeometry } = await planScenario(scenario);
  assert.deepEqual(experience.jurisdictionIds, scenario.expected.jurisdictionIds);
  assert.deepEqual(
    itinerary.legs.find((leg) => leg.routeNature === "established").geometry,
    originalGeometry,
  );
});

test("multiple trailheads prefer verified legal parking over a closer unknown shoulder", async () => {
  const scenario = successfulScenarios.get("multiple-trailheads-select-verified");
  const { itinerary, itineraryRequests } = await planScenario(scenario);
  const transfer = itinerary.legs.find((leg) => leg.mode === "park_or_transfer");
  const chosen = scenario.experience.accessPoints.find(
    (point) => point.id === scenario.expected.accessPointId,
  );
  assert.equal(transfer.accessPointId, scenario.expected.accessPointId);
  assert.deepEqual(itineraryRequests[0].coordinates[1], chosen.geometry.coordinates);
});

test("departure time is sent only when the routing provider explicitly declares support", async () => {
  const scenario = successfulScenarios.get("scotland-drive-foot-established-loop");
  const result = await planScenario(scenario, { timeDependentRouting: true });
  assert.ok(result.itineraryRequests.length > 0);
  assert.ok(
    result.itineraryRequests.every(
      (request) => Object.hasOwn(request, "departureTime") && request.departureTime instanceof Date,
    ),
  );
  assert.ok(
    result.provider.routeCalls.every(
      (request) => typeof request.departureTime === "string" && request.departureTime.length > 0,
    ),
  );
});

for (const scenario of refusalDocument.scenarios) {
  test(scenario.id + " refuses with " + scenario.expected.errorCode, async () => {
    const harness = createRoutingHarness();
    const experience = clone(scenario.experience);
    const originalGeometry = clone(experience.geometry);

    await assert.rejects(
      buildMixedModeItinerary({
        ...scenario.request,
        experience,
        gateway: harness.gateway,
      }),
      assertErrorCode(scenario.expected.errorCode),
    );

    assert.equal(
      harness.itineraryRequests.length,
      scenario.expected.routingCallsBeforeRefusal,
    );
    assert.deepEqual(experience.geometry, originalGeometry);
    assert.ok(
      harness.itineraryRequests.every((request) => !Object.hasOwn(request, "departureTime")),
    );
  });
}

test("expired and out-of-interval conditions do not block but remain on the hike leg", async () => {
  const scenario = clone(
    successfulScenarios.get("japan-endonym-romanization-seasonal-access"),
  );
  scenario.experience.conditions.push({
    ...clone(scenario.experience.conditions[0]),
    id: "condition:japan-expired-advisory",
    state: "expired",
    effectiveFrom: "2025-12-01T00:00:00+09:00",
    effectiveUntil: "2026-04-30T23:59:59+09:00",
  });
  scenario.experience.conditionRefs.push("condition:japan-expired-advisory");

  const { itinerary } = await planScenario(scenario);
  const established = itinerary.legs.find((leg) => leg.routeNature === "established");
  assert.ok(established.conditionRefs.includes("condition:japan-winter-seasonal-gate"));
  assert.ok(established.conditionRefs.includes("condition:japan-expired-advisory"));
});
test("explicit closed access state refuses before connector routing", async () => {
  const scenario = clone(
    successfulScenarios.get("scotland-drive-foot-established-loop"),
  );
  scenario.experience.access.state = "closed";
  const harness = createRoutingHarness();

  await assert.rejects(
    buildMixedModeItinerary({
      ...scenario.request,
      experience: scenario.experience,
      gateway: harness.gateway,
    }),
    assertErrorCode("route_closed"),
  );
  assert.equal(harness.itineraryRequests.length, 0);
});
