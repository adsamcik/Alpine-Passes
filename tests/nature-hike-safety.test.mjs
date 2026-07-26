import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildHikeDetailModel,
  DEFAULT_SAFETY_FRESHNESS_POLICY,
  classifySafetyRecordTemporalStatus,
  formatDate,
  invokeAction,
} from "../assets/js/nature/hike-detail.mjs";

const AS_OF = "2026-07-15T12:00:00Z";

function trail(overrides = {}) {
  return {
    id: "route:safety-test",
    entityType: "TrailRoute",
    names: [{ language: "en", kind: "primary", value: "Safety test route" }],
    geometry: {
      type: "LineString",
      coordinates: [[-4.2, 57.1], [-4.1, 57.2]],
    },
    geometryCompleteness: "complete",
    navigationSuitability: true,
    routeNature: "established",
    journeyShape: "point_to_point",
    direction: "both",
    activities: ["hiking"],
    access: { legal: "legal", modes: ["foot"] },
    metrics: { ascentMeters: 0, descentMeters: 0 },
    quality: {
      confidence: 0.8,
      verificationStatus: "verified",
      freshness: "current",
      assessedAt: "2026-07-15",
      flags: [],
    },
    sourceAssertions: [],
    sensitivity: { action: "publish" },
    ...overrides,
  };
}

function safetyRecord(entityType, id, overrides = {}) {
  return {
    id,
    entityType,
    names: [{ language: "en", kind: "primary", value: id }],
    quality: {
      confidence: 0.85,
      verificationStatus: "verified",
      freshness: "current",
      assessedAt: "2026-07-15",
      flags: [],
    },
    sourceAssertions: [{
      sourceId: "authority:test",
      fieldPath: "/",
      evidenceKind: "verified_official",
      verificationStatus: "verified",
      confidence: 0.9,
    }],
    ...overrides,
  };
}

test("linked safety records expose status, verification, freshness, sources, and validity", () => {
  const current = safetyRecord("Condition", "condition:current", {
    conditionKind: "weather",
    state: "live",
    effectiveFrom: "2026-07-01T00:00:00Z",
    effectiveUntil: "2026-07-31T23:59:59Z",
  });
  const expired = safetyRecord("Condition", "condition:expired", {
    conditionKind: "trail_closure",
    state: "live",
    effectiveUntil: "2026-07-01T00:00:00Z",
  });
  const scheduled = safetyRecord("Restriction", "restriction:scheduled", {
    restrictionKind: "seasonal",
    authoritySourceId: "authority:park",
    sourceAssertions: [{
      sourceId: "authority:park",
      verificationStatus: "verified",
      validFrom: "2026-08-01T00:00:00Z",
    }],
  });
  const hazard = safetyRecord("Hazard", "hazard:current", {
    hazardKind: "rockfall",
    severity: "high",
    sourceAssertions: [{
      sourceId: "authority:mountain-rescue",
      verificationStatus: "partially_verified",
      validFrom: "2026-07-01T00:00:00Z",
      validUntil: "2026-07-31T23:59:59Z",
    }],
  });
  const model = buildHikeDetailModel(trail({
    conditions: [current, expired],
    restrictions: [scheduled],
    hazards: [hazard],
  }), { asOf: AS_OF });

  assert.deepEqual(model.safety.conditions.map((item) => item.temporalStatus), ["current", "expired"]);
  assert.equal(model.safety.restrictions[0].temporalStatus, "scheduled");
  assert.equal(model.safety.hazards[0].temporalStatus, "current");
  for (const item of [
    ...model.safety.conditions,
    ...model.safety.restrictions,
    ...model.safety.hazards,
  ]) {
    assert.match(item.detail, /Temporal status: (Current|Scheduled|Expired|Unknown)/);
    assert.match(item.detail, /Verification:/);
    assert.match(item.detail, /Freshness:/);
    assert.match(item.detail, /Sources:/);
    assert.match(item.detail, /Validity:/);
  }
  assert.match(model.safety.conditions[1].detail, /Validity: Effective from unknown to Jul 1, 2026/);
  assert.match(model.safety.restrictions[0].detail, /authority:park/);
  assert.ok(!model.safety.unknowns.includes("Current trail conditions unknown."));
});

test("expired, scheduled, and uncertain reports never suppress current-conditions unknown", () => {
  const expired = safetyRecord("Condition", "condition:expired-only", {
    conditionKind: "trail_closure",
    state: "live",
    effectiveUntil: "2020-01-01T00:00:00Z",
  });
  const scheduled = safetyRecord("Condition", "condition:scheduled", {
    conditionKind: "construction",
    state: "scheduled",
    effectiveFrom: "2030-01-01T00:00:00Z",
  });
  const unknown = safetyRecord("Condition", "condition:unknown", {
    conditionKind: "weather",
    state: "live",
    quality: {
      confidence: 0.2,
      verificationStatus: "unverified",
      freshness: "unknown",
      assessedAt: "2026-07-15",
      flags: [],
    },
  });
  const model = buildHikeDetailModel(trail({ conditions: [expired, scheduled, unknown] }), {
    asOf: AS_OF,
  });

  assert.deepEqual(
    model.safety.conditions.map((item) => item.temporalStatus),
    ["expired", "scheduled", "unknown"],
  );
  assert.ok(model.safety.unknowns.includes("Current trail conditions unknown."));
  assert.equal(classifySafetyRecordTemporalStatus(expired, AS_OF), "expired");
});

test("invalid safety validity fails closed instead of being presented as current", () => {
  const invalid = safetyRecord("Condition", "condition:invalid-date", {
    conditionKind: "weather",
    state: "live",
    effectiveUntil: "not-a-date",
  });
  assert.equal(classifySafetyRecordTemporalStatus(invalid, AS_OF), "unknown");
  const model = buildHikeDetailModel(trail({ conditions: [invalid] }), { asOf: AS_OF });
  assert.ok(model.safety.unknowns.includes("Current trail conditions unknown."));
  const undatedSeasonal = safetyRecord("Condition", "condition:undated-seasonal", {
    conditionKind: "seasonal_gate",
    state: "seasonal",
  });
  assert.equal(classifySafetyRecordTemporalStatus(undatedSeasonal, AS_OF), "unknown");
});

test("old, future-dated, and undated live safety records cannot be current", () => {
  const old = safetyRecord("Condition", "condition:old-live", {
    conditionKind: "weather",
    state: "live",
    quality: {
      ...safetyRecord("Condition", "template").quality,
      assessedAt: "2026-07-01",
    },
  });
  const future = safetyRecord("Condition", "condition:future-live", {
    conditionKind: "weather",
    state: "live",
    quality: {
      ...safetyRecord("Condition", "template").quality,
      assessedAt: "2026-07-16",
    },
  });
  const undated = safetyRecord("Condition", "condition:undated-live", {
    conditionKind: "weather",
    state: "live",
    quality: {
      confidence: 0.85,
      verificationStatus: "verified",
      freshness: "current",
      flags: [],
    },
  });

  assert.equal(classifySafetyRecordTemporalStatus(old, AS_OF), "unknown");
  assert.equal(classifySafetyRecordTemporalStatus(future, AS_OF), "unknown");
  assert.equal(classifySafetyRecordTemporalStatus(undated, AS_OF), "unknown");

  const model = buildHikeDetailModel(trail({ conditions: [old, future, undated] }), {
    asOf: AS_OF,
  });
  assert.deepEqual(
    model.safety.conditions.map((item) => item.temporalStatus),
    ["unknown", "unknown", "unknown"],
  );
  assert.ok(model.safety.unknowns.includes("Current trail conditions unknown."));
});

test("safety freshness age and future skew are deterministic and configurable", () => {
  const old = safetyRecord("Condition", "condition:configured-old", {
    conditionKind: "weather",
    state: "live",
    quality: {
      ...safetyRecord("Condition", "template").quality,
      assessedAt: "2026-07-01",
    },
  });
  const future = safetyRecord("Condition", "condition:configured-future", {
    conditionKind: "weather",
    state: "live",
    checkedAt: "2026-07-16T00:00:00Z",
  });
  const permissivePolicy = {
    maxAgeMilliseconds: 20 * 24 * 60 * 60 * 1_000,
    maxFutureSkewMilliseconds: 24 * 60 * 60 * 1_000,
  };

  assert.equal(DEFAULT_SAFETY_FRESHNESS_POLICY.maxAgeMilliseconds, 72 * 60 * 60 * 1_000);
  assert.equal(classifySafetyRecordTemporalStatus(old, AS_OF, permissivePolicy), "current");
  assert.equal(classifySafetyRecordTemporalStatus(future, AS_OF, permissivePolicy), "current");
  assert.equal(classifySafetyRecordTemporalStatus(old, AS_OF, {
    maxAgeMilliseconds: -1,
  }), "unknown");
});

test("fresh quality metadata cannot launder stale or timezone-ambiguous safety evidence", () => {
  const staleCheck = safetyRecord("Condition", "condition:stale-check", {
    conditionKind: "weather",
    state: "live",
    checkedAt: "2026-07-01T12:00:00Z",
  });
  const staleObservation = safetyRecord("Condition", "condition:stale-observation", {
    conditionKind: "weather",
    state: "live",
    sourceAssertions: [{
      ...safetyRecord("Condition", "template").sourceAssertions[0],
      observedAt: "2026-07-01T12:00:00Z",
    }],
  });
  const ambiguousCheck = safetyRecord("Condition", "condition:ambiguous-check", {
    conditionKind: "weather",
    state: "live",
    checkedAt: "2026-07-15T11:00:00",
  });
  const recentCheck = safetyRecord("Condition", "condition:recent-check", {
    conditionKind: "weather",
    state: "live",
    checkedAt: "2026-07-15T11:00:00Z",
  });

  assert.equal(classifySafetyRecordTemporalStatus(staleCheck, AS_OF), "unknown");
  assert.equal(classifySafetyRecordTemporalStatus(staleObservation, AS_OF), "unknown");
  assert.equal(classifySafetyRecordTemporalStatus(ambiguousCheck, AS_OF), "unknown");
  assert.equal(classifySafetyRecordTemporalStatus(recentCheck, AS_OF), "current");
  assert.equal(
    classifySafetyRecordTemporalStatus(recentCheck, "2026-07-15T12:00:00"),
    "unknown",
    "an assessment time without a UTC offset must not depend on the host timezone",
  );
});

test("geometry distance distinguishes navigation, complete non-navigation, partial, and overview lines", () => {
  const navigation = buildHikeDetailModel(trail());
  assert.match(navigation.atAGlance[0].value, /complete navigation-suitable geometry/);
  assert.equal(navigation.atAGlance.find(({ term }) => term === "Ascent").value, "0 m");
  assert.equal(navigation.atAGlance.find(({ term }) => term === "Descent").value, "0 m");
  assert.ok(!navigation.safety.unknowns.includes("Ascent unknown."));
  assert.ok(!navigation.safety.unknowns.includes("Descent unknown."));

  const completeOverview = buildHikeDetailModel(trail({ navigationSuitability: false }));
  assert.match(completeOverview.atAGlance[0].value, /complete geometry that is not navigation-suitable/);

  const partial = buildHikeDetailModel(trail({
    geometryCompleteness: "partial",
    navigationSuitability: false,
  }));
  assert.match(partial.atAGlance[0].value, /partial geometry only/);

  const overview = buildHikeDetailModel(trail({
    geometryCompleteness: "overview_only",
    navigationSuitability: false,
  }));
  assert.match(overview.atAGlance[0].value, /overview\/generalized geometry only/);
});

test("scenic drives use road-access and drive-character details without hike-only copy", () => {
  const model = buildHikeDetailModel(trail({
    routeNature: "scenic_drive",
    activities: ["scenic_driving"],
    navigationSuitability: false,
    geometryCompleteness: "overview_only",
    journeyShape: "loop",
    access: { legal: "unknown", modes: ["car"] },
    metrics: { distanceMeters: 75_000, typicalDurationMinutes: 105 },
    themes: ["panoramic-view", "remote"],
  }), { asOf: AS_OF });

  assert.equal(model.routeKind, "scenic_drive");
  assert.deepEqual(model.atAGlance.map(({ term }) => term), [
    "Reported distance",
    "Typical drive time",
    "Route shape",
    "Direction",
    "Road access",
    "Geometry",
  ]);
  assert.equal(model.routeCharacter.find(({ term }) => term === "Drive character").value,
    "Panoramic view, Remote");
  assert.ok(model.routeCharacter.some(({ term }) => term === "Road surface"));
  assert.ok(!model.routeCharacter.some(({ term }) => term === "Trail class"));
  assert.equal(model.gettingThere.accessTerm, "Legal road access");
  assert.equal(model.gettingThere.accessPointsTitle, "Road access, parking, and stops");
  assert.ok(model.safety.unknowns.includes("Current road conditions unknown."));
  assert.ok(!model.safety.unknowns.some((value) =>
    /Ascent unknown|Difficulty not supplied/.test(value)));
});

test("date-only values render on their schema date without a timezone day shift", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    assert.equal(formatDate("2026-01-01"), "Jan 1, 2026");
    assert.equal(formatDate("2026-02-31"), "2026-02-31");
  } finally {
    if (previousTimezone == null) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("planning success is announced only for an explicit non-empty itinerary", async () => {
  const focusCalls = [];
  const status = {
    textContent: "",
    focus(options) { focusCalls.push(options); },
  };
  const refused = await invokeAction(
    async () => ({ ok: false, code: "unknown_access", message: "Planning refused: access unknown." }),
    trail(),
    {},
    status,
    "Route itinerary built.",
    { requireItinerary: true },
  );
  assert.equal(refused.ok, false);
  assert.equal(status.textContent, "Planning refused: access unknown.");
  assert.doesNotMatch(status.textContent, /itinerary built/i);

  const incomplete = await invokeAction(
    async () => undefined,
    trail(),
    {},
    status,
    "Route itinerary built.",
    { requireItinerary: true },
  );
  assert.equal(incomplete.ok, false);
  assert.match(status.textContent, /did not produce an itinerary/i);

  const itinerary = { legs: [{ mode: "hike" }] };
  const succeeded = await invokeAction(
    async () => ({ ok: true, itinerary }),
    trail(),
    {},
    status,
    "Route itinerary built.",
    { requireItinerary: true },
  );
  assert.equal(succeeded.ok, true);
  assert.equal(status.textContent, "Route itinerary built.");
  assert.equal(focusCalls.length, 3);
});

test("the application planner propagates explicit success and refusal results", async () => {
  const source = await readFile(new URL("../assets/js/nature/app.mjs", import.meta.url), "utf8");
  assert.match(source, /return \{ ok: true, itinerary \}/);
  assert.match(source, /return \{ ok: false, code, message \}/);
});
