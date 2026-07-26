import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildHikeDetailModel,
  buildJourneyOptions,
  HIKE_DETAIL_SECTION_TITLES,
  renderHikeDetail,
} from "../assets/js/nature/hike-detail.mjs";
import {
  assessTrailRouteExport,
  RouteExportError,
  routeExportFilename,
  ROUTE_SAFETY_DISCLAIMER,
  serializeTrailRouteGeoJson,
  serializeTrailRouteGpx,
} from "../assets/js/nature/route-export.mjs";

const JOURNEY_AS_OF = new Date("2026-07-26T12:00:00Z");

function journeyOptions(route) {
  return buildJourneyOptions(route, { asOf: JOURNEY_AS_OF });
}

function trail(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    id: "route:test-ridge-loop",
    entityType: "TrailRoute",
    jurisdictionIds: ["GB", "GB-SCT"],
    names: [{ language: "en", kind: "primary", value: "Ridge & Loch <Loop>" }],
    geometry: {
      type: "LineString",
      coordinates: [[-4.2, 57.1, 30], [-4.1, 57.2, 90], [-4.0, 57.15, 40]],
    },
    geometryCompleteness: "complete",
    navigationSuitability: true,
    routeNature: "established",
    journeyShape: "loop",
    activities: ["walking", "hiking"],
    access: { legal: "legal", modes: ["car", "foot", "hiking"] },
    sourceAssertions: [{
      sourceId: "fixture:route-source",
      sourceRecordId: "ridge-loop",
      fieldPath: "/geometry",
      evidenceKind: "verified_official",
      verificationStatus: "verified",
      confidence: 0.92,
      observedAt: "2026-06-12T10:00:00Z",
      notes: "Route & alignment <checked>.",
    }],
    exportMetadata: {
      sourceNotices: [{
        sourceId: "fixture:route-source",
        sourceRecordId: "ridge-loop",
        publisher: "Fixture Route Authority",
        product: "Verified Ridge Routes",
        licenceId: "CC-BY",
        licenceVersion: "4.0",
        licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
        attribution: "Fixture Route Authority",
        sourceUrl: "https://routes.example.test/ridge-loop",
        transformationNotice: "Coordinates retained; properties normalized to the Itinera schema.",
      }],
    },
    quality: {
      confidence: 0.88,
      geometryConfidence: 0.92,
      accessConfidence: 0.74,
      verificationStatus: "verified",
      freshness: "current",
      assessedAt: "2026-06-12",
      flags: [],
    },
    sensitivity: { action: "publish" },
    ...overrides,
  };
}

function accessPoint(overrides = {}) {
  return {
    id: "access:test-route",
    entityType: "AccessPoint",
    names: [{ language: "en", kind: "primary", value: "Test trailhead" }],
    jurisdictionIds: ["GB", "GB-SCT"],
    geometry: { type: "Point", coordinates: [-4.2, 57.1] },
    legalAccess: "legal",
    accessModes: ["car", "foot", "transit", "ferry", "cable_transport"],
    parking: { name: "Verified public parking", stoppingAllowed: true },
    quality: {
      verificationStatus: "verified",
      freshness: "current",
      assessedAt: "2026-06-12",
      flags: [],
    },
    sensitivity: { action: "publish" },
    ...overrides,
  };
}

function transportConnection(overrides = {}) {
  return {
    id: "transport:test-route",
    entityType: "TransportConnection",
    names: [{ language: "en", kind: "primary", value: "Test ferry" }],
    jurisdictionIds: ["GB", "GB-SCT"],
    transportMode: "ferry",
    geometry: { type: "LineString", coordinates: [[-4.3, 57.0], [-4.2, 57.1]] },
    endpointIds: ["access:origin", "access:test-route"],
    direction: "outbound",
    operating: true,
    typicalDurationMinutes: 20,
    schedule: {
      departuresLocal: ["09:00", "10:00"],
      lastDepartureLocal: "10:00",
      freshness: "current",
      timezone: "Europe/London",
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    },
    sourceAssertions: [{
      sourceId: "fixture:transport-source",
      sourceRecordId: "test-ferry",
      fieldPath: "/geometry",
      verificationStatus: "verified",
      observedAt: "2026-06-12T10:00:00Z",
    }],
    quality: {
      verificationStatus: "verified",
      freshness: "current",
      assessedAt: "2026-06-12",
      flags: [],
    },
    sensitivity: { action: "publish" },
    ...overrides,
  };
}

function returnTransportConnection(overrides = {}) {
  return transportConnection({
    id: "transport:test-route-return",
    names: [{ language: "en", kind: "primary", value: "Verified return ferry" }],
    geometry: { type: "LineString", coordinates: [[-4.0, 57.15], [-4.2, 57.1]] },
    endpointIds: ["access:route-finish", "access:test-route"],
    direction: "return",
    ...overrides,
  });
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  focus() {
    this.focused = true;
  }
}

function fakeDom() {
  const documentRef = { createElement: (tagName) => new FakeElement(tagName, documentRef) };
  const container = new FakeElement("div", documentRef);
  return { container };
}

function descendants(root) {
  return [root, ...(root.children || []).flatMap(descendants)];
}

test("journey options expose only linked car, foot and grouped public transport support", () => {
  const loop = trail({
    accessPoints: [accessPoint()],
    transportConnections: [transportConnection({ transportMode: "cable_car" })],
  });
  const options = journeyOptions(loop);

  assert.deepEqual(
    options.accessModes.map((option) => option.value),
    ["car", "foot", "transit"],
  );
  assert.equal(options.accessModes.at(-1).label, "Transit, ferry, or cable transport");
  assert.deepEqual(options.returnStrategies.map((option) => option.value), ["return_to_vehicle"]);

  const pointToPoint = journeyOptions(trail({
    journeyShape: "point_to_point",
    accessPoints: [accessPoint()],
    transportConnections: [transportConnection(), returnTransportConnection()],
  }));
  assert.deepEqual(
    pointToPoint.returnStrategies.map((option) => option.value),
    ["return_to_vehicle", "different_pickup"],
  );

  const noVerifiedReturn = journeyOptions(trail({
    journeyShape: "point_to_point",
    accessPoints: [accessPoint()],
    transportConnections: [transportConnection()],
  }));
  assert.deepEqual(
    noVerifiedReturn.returnStrategies.map((option) => option.value),
    ["different_pickup"],
  );

  const unknownRouteAccess = journeyOptions(trail({
    access: { legal: "unknown", modes: ["car", "foot"] },
    accessPoints: [accessPoint()],
  }));
  assert.equal(unknownRouteAccess.canPlan, false);
  assert.match(unknownRouteAccess.unavailableMessage, /legal public route access is not verified/i);

  const noVerifiedParking = journeyOptions(trail({
    accessPoints: [accessPoint({ parking: { stoppingAllowed: false } })],
    transportConnections: [transportConnection()],
  }));
  assert.deepEqual(
    noVerifiedParking.accessModes.map((option) => option.value),
    ["foot", "transit"],
  );

  const staleTransport = journeyOptions(trail({
    accessPoints: [accessPoint()],
    transportConnections: [transportConnection({
      schedule: {
        departuresLocal: ["09:00"],
        freshness: "stale",
        timezone: "Europe/London",
      },
    })],
  }));
  assert.deepEqual(
    staleTransport.accessModes.map((option) => option.value),
    ["car", "foot"],
  );

  const unsupported = journeyOptions(trail({
    accessPoints: [accessPoint({ legalAccess: "private" })],
    transportConnections: [transportConnection()],
  }));
  assert.equal(unsupported.canPlan, false);
  assert.match(unsupported.unavailableMessage, /no current verified public access point/i);

  const missingWindow = transportConnection();
  delete missingWindow.schedule.validUntil;
  const missingWindowOptions = journeyOptions(trail({
    accessPoints: [accessPoint()],
    transportConnections: [missingWindow],
  }));
  assert.deepEqual(
    missingWindowOptions.accessModes.map((option) => option.value),
    ["car", "foot"],
  );

  const expiredProvenance = transportConnection();
  expiredProvenance.sourceAssertions[0].validUntil = "2026-07-25T23:59:59Z";
  const expiredProvenanceOptions = journeyOptions(trail({
    accessPoints: [accessPoint()],
    transportConnections: [expiredProvenance],
  }));
  assert.deepEqual(
    expiredProvenanceOptions.accessModes.map((option) => option.value),
    ["car", "foot"],
  );

  const unsafePoint = accessPoint();
  unsafePoint.quality.flags = ["unsafe_access"];
  const unsafeOptions = journeyOptions(trail({
    accessPoints: [unsafePoint],
  }));
  assert.equal(unsafeOptions.canPlan, false);

  const futureRoute = trail();
  futureRoute.quality.assessedAt = "2026-07-27";
  const futureOptions = journeyOptions(futureRoute);
  assert.equal(futureOptions.canPlan, false);
});

test("critical safety unknowns block matching routes while exact parking caveats stay advisory", () => {
  const criticalTechnicalRoute = trail({
    activities: ["hiking", "scrambling"],
    quality: {
      ...trail().quality,
      flags: ["critical_condition_unknown"],
    },
    accessPoints: [accessPoint()],
  });
  const criticalTechnicalOptions = journeyOptions(criticalTechnicalRoute);
  assert.equal(criticalTechnicalOptions.canPlan, false);
  assert.match(criticalTechnicalOptions.unavailableMessage, /critical condition is unknown/i);

  const criticalOrdinaryRoute = trail({
    quality: {
      ...trail().quality,
      flags: ["critical_condition_unknown"],
    },
    accessPoints: [accessPoint()],
  });
  assert.equal(journeyOptions(criticalOrdinaryRoute).canPlan, true);

  const advisoryParking = accessPoint({
    quality: {
      ...accessPoint().quality,
      flags: [
        "parking_capacity_unknown",
        "parking_centroid_not_surveyed",
        "parking_fee_unknown",
        "parking_hours_unknown",
      ],
    },
  });
  assert.equal(journeyOptions(trail({ accessPoints: [advisoryParking] })).canPlan, true);
  assert.equal(journeyOptions(trail({
    accessPoints: [accessPoint({
      legalAccess: "unknown",
      quality: advisoryParking.quality,
    })],
  })).canPlan, false);
});

test("native journey controls forward the selected access and return values", async () => {
  const { container } = fakeDom();
  const route = trail({
    journeyShape: "point_to_point",
    accessPoints: [accessPoint()],
    transportConnections: [transportConnection(), returnTransportConnection()],
  });
  let received = null;
  const rendered = renderHikeDetail(container, route, {
    assessment: { asOf: JOURNEY_AS_OF },
    onPlan: (selectedRoute, output, selection) => {
      received = { selectedRoute, output, selection };
      return { ok: true, itinerary: { legs: [{ mode: "hike" }] } };
    },
  });

  const elements = descendants(rendered.root);
  const fieldsets = elements.filter((element) => element.tagName === "FIELDSET");
  const inputs = elements.filter((element) => element.tagName === "INPUT");
  const legends = elements.filter((element) => element.tagName === "LEGEND");
  const plan = elements.find((element) =>
    element.tagName === "BUTTON" && element.textContent === "Plan access + route");

  assert.equal(fieldsets.length, 2);
  assert.deepEqual(
    legends.map((legend) => legend.textContent),
    ["Access to the route", "After the route"],
  );
  assert.equal(inputs.length, 5);
  assert.ok(inputs.every((input) => input.type === "radio" && input.required === true));
  assert.ok(inputs.every((input) => input.getAttribute("aria-describedby")));
  assert.equal(plan.getAttribute("aria-disabled"), "false");
  assert.equal(plan.disabled, undefined, "the native button remains keyboard focusable");

  inputs.forEach((input) => { input.checked = false; });
  const transit = inputs.find((input) => input.value === "transit");
  transit.checked = true;
  const pickup = inputs.find((input) => input.value === "different_pickup");
  pickup.checked = true;
  await plan.listeners.get("click")[0]();

  assert.equal(received.selectedRoute, route);
  assert.equal(received.output, rendered.itineraryOutput);
  assert.deepEqual(received.selection, {
    accessMode: "transit",
    returnStrategy: "different_pickup",
  });
  assert.equal(rendered.status.textContent, "Route itinerary built.");
});

test("hike model exposes the required readable sections and only supplied metrics", () => {
  const route = trail({
    metrics: {
      distanceMeters: 12_400,
      ascentMeters: 640,
      descentMeters: 610,
      typicalDurationMinutes: 230,
    },
    difficulty: {
      originalScale: "SAC",
      originalGrade: "T2",
      normalizedBand: "moderate",
      normalizationCaveat: "Local grades remain authoritative.",
    },
    direction: "both",
    seasons: ["summer", "autumn"],
    trailSegments: [{
      surface: "rocky_path",
      trailClass: "mountain_trail",
      visibility: "waymarked",
    }],
  });
  const model = buildHikeDetailModel(route);

  assert.deepEqual(HIKE_DETAIL_SECTION_TITLES, [
    "At a glance",
    "Route character",
    "Getting there",
    "Safety & conditions",
    "Data confidence",
  ]);
  assert.deepEqual(
    model.atAGlance.map(({ term }) => term),
    ["Reported distance", "Typical time", "Ascent", "Descent", "Difficulty", "Route shape"],
  );
  assert.equal(model.atAGlance[0].value, "12 km");
  assert.equal(model.atAGlance[1].value, "3 h 50 min");
  assert.equal(model.atAGlance[2].value, "640 m");
  assert.equal(model.atAGlance[3].value, "610 m");
  assert.match(model.atAGlance[4].value, /T2 \(SAC\)/);
  assert.match(model.atAGlance[4].value, /Local grades remain authoritative/);
  assert.equal(model.routeCharacter.find(({ term }) => term === "Surface").value, "Rocky path");
  assert.equal(model.safety.seasons, "Summer, Autumn");
  assert.doesNotMatch(model.atAGlance.map(({ value }) => value).join(" "), /overview geometry only/i);
});

test("permit requirements retain booking and source fields in the safety model", () => {
  const model = buildHikeDetailModel(trail({
    permitRequirements: [{
      id: "permit:test-route",
      entityType: "PermitRequirement",
      names: [{ language: "en", kind: "primary", value: "Route permit" }],
      reservationRequired: true,
      quotaApplies: true,
      bookingUrl: "https://parks.example.test/book",
      authoritySourceId: "source:park-authority",
      sourceAssertions: [{ sourceId: "source:permit-page" }],
    }],
  }));

  assert.equal(model.safety.permitRequirements.length, 1);
  assert.match(model.safety.permitRequirements[0].detail, /Reservation required/);
  assert.match(model.safety.permitRequirements[0].detail, /Quota applies/);
  assert.match(model.safety.permitRequirements[0].detail, /https:\/\/parks\.example\.test\/book/);
  assert.match(model.safety.permitRequirements[0].detail, /source:park-authority/);
  assert.match(model.safety.permitRequirements[0].detail, /source:permit-page/);

  const unknown = buildHikeDetailModel(trail());
  assert.deepEqual(unknown.safety.permitRequirements, []);
  assert.ok(unknown.safety.unknowns.includes("Restrictions and permit requirements are not supplied."));
});

test("missing hike facts stay explicit and geometry-derived length discloses non-navigation geometry", () => {
  const model = buildHikeDetailModel(trail({
    navigationSuitability: false,
    metrics: undefined,
    difficulty: undefined,
    seasons: undefined,
    quality: {
      confidence: 0.3,
      verificationStatus: "unverified",
      freshness: "unknown",
      assessedAt: "2026-07-26",
      flags: ["generalized_geometry", "conditions_unknown"],
    },
    access: { legal: "unknown", modes: ["foot"] },
  }));

  assert.equal(model.atAGlance[0].term, "Geometry length");
  assert.match(model.atAGlance[0].value, /complete geometry that is not navigation-suitable/);
  assert.equal(model.atAGlance.find(({ term }) => term === "Ascent").value, "Unknown");
  assert.equal(model.atAGlance.find(({ term }) => term === "Descent").value, "Unknown");
  assert.equal(model.atAGlance.find(({ term }) => term === "Typical time").value, "Unknown");
  assert.equal(model.atAGlance.find(({ term }) => term === "Difficulty").value, "Unknown");
  assert.ok(model.safety.unknowns.includes("Ascent unknown."));
  assert.ok(model.safety.unknowns.includes("Difficulty not supplied."));
  assert.ok(model.safety.unknowns.some((value) => /absence of a hazard record/i.test(value)));
  assert.ok(model.safety.unknowns.includes("Current trail conditions unknown."));
  assert.match(model.gettingThere.access, /not verified/i);
});

test("GPX requires navigation suitability, complete geometry, and a valid route line", () => {
  const unsuitable = assessTrailRouteExport(trail({ navigationSuitability: false }), "gpx");
  assert.equal(unsuitable.allowed, false);
  assert.equal(unsuitable.code, "gpx_navigation_unsuitable");

  const incomplete = assessTrailRouteExport(trail({ geometryCompleteness: "partial" }), "gpx");
  assert.equal(incomplete.allowed, false);
  assert.equal(incomplete.code, "gpx_incomplete_geometry");

  const invalid = assessTrailRouteExport(trail({
    geometry: { type: "LineString", coordinates: [[-4.2, 57.1]] },
  }), "gpx");
  assert.equal(invalid.allowed, false);
  assert.equal(invalid.code, "gpx_invalid_geometry");

  assert.throws(
    () => serializeTrailRouteGpx(trail({ navigationSuitability: false })),
    (error) => error instanceof RouteExportError
      && error.code === "gpx_navigation_unsuitable",
  );
});

test("GPX escapes text, retains elevation, and embeds the safety disclaimer", () => {
  const gpx = serializeTrailRouteGpx(trail());
  assert.match(gpx, /Ridge &amp; Loch &lt;Loop&gt;/);
  assert.doesNotMatch(gpx, /Ridge & Loch <Loop>/);
  assert.match(gpx, /lat="57\.1" lon="-4\.2"><ele>30<\/ele>/);
  assert.match(gpx, /<trkseg>/);
  assert.match(gpx, new RegExp(ROUTE_SAFETY_DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("GeoJSON exports every valid TrailRoute line with provenance and honest geometry metadata", () => {
  const route = trail({
    navigationSuitability: false,
    geometryCompleteness: "overview_only",
    quality: {
      confidence: 0.34,
      verificationStatus: "unverified",
      assessedAt: "2026-07-26",
      freshness: "unknown",
      flags: ["generalized_geometry"],
    },
  });
  const assessment = assessTrailRouteExport(route, "geojson");
  assert.equal(assessment.allowed, true);

  const payload = JSON.parse(serializeTrailRouteGeoJson(route));
  assert.equal(payload.type, "FeatureCollection");
  assert.equal(payload.metadata.routeId, route.id);
  assert.equal(payload.metadata.geometryRepresentation, "overview_geometry_only");
  assert.equal(payload.metadata.navigationSuitability, false);
  assert.equal(payload.metadata.safetyDisclaimer, ROUTE_SAFETY_DISCLAIMER);
  assert.deepEqual(payload.features[0].geometry, route.geometry);
  assert.equal(payload.features[0].properties.geometryCompleteness, "overview_only");
  assert.equal(payload.features[0].properties.navigationSuitability, false);
  assert.equal(payload.metadata.provenance[0].sourceId, "fixture:route-source");
  assert.equal(payload.metadata.provenance[0].fieldPath, "/geometry");
  assert.match(payload.metadata.provenance[0].notes, /<checked>/);
});

test("GeoJSON refuses non-routes and invalid line geometry", () => {
  const nonRoute = assessTrailRouteExport({ ...trail(), entityType: "Place" }, "geojson");
  assert.equal(nonRoute.allowed, false);
  assert.equal(nonRoute.code, "geojson_not_route");

  assert.throws(
    () => serializeTrailRouteGeoJson(trail({
      geometry: { type: "Point", coordinates: [-4.2, 57.1] },
    })),
    (error) => error instanceof RouteExportError
      && error.code === "geojson_invalid_geometry",
  );
});

test("download filenames are normalized, safe, and format-specific", () => {
  assert.equal(routeExportFilename(trail(), "gpx"), "ridge-loch-loop.gpx");
  assert.equal(
    routeExportFilename(trail({
      names: [{ language: "fr", kind: "primary", value: "Crête d’Été / Étape 1" }],
    }), "geojson"),
    "crete-d-ete-etape-1.geojson",
  );
});

test("hike detail implementation keeps unavailable actions focusable and visibly explained", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../assets/js/nature/hike-detail.mjs", import.meta.url), "utf8"),
    readFile(new URL("../assets/css/nature-hike-detail.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /setAttribute\("aria-disabled"/);
  assert.match(source, /setAttribute\("aria-describedby"/);
  assert.match(source, /setAttribute\("role", "status"\)/);
  assert.match(source, /setAttribute\("aria-live", "polite"\)/);
  assert.match(styles, /\.hike-action\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /@media \(forced-colors: active\)/);
  assert.match(styles, /\.hike-detail\s*\{[^}]*font-size:\s*14px/s);
  assert.match(styles, /\.hike-journey-options label\s*\{[^}]*min-height:\s*44px/s);
});
