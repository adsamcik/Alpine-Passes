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
  assert.equal(scheduled.mode, scenario.expected.scheduledMode);
  assert.equal(scheduled.label, "Return bus to Rannoch trailhead");
  assert.ok(scheduled.sourceAssertionRefs.length > 0);
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
