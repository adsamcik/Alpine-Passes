import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  NatureUiError,
  attachLinkedEntities,
  buildMapFeatureCollections,
  buildRegionOptions,
  createDiscoveryDataSession,
  entityCardModel,
  filterAndRankEntities,
  mapViewportBounds,
  rankMapEntitiesForDisplay,
  serializeTrailRouteGeoJson,
  serializeTrailRouteGpx,
} from "../assets/js/nature/app.mjs";

const manifest = {
  packages: [
    { regionId: "uk-ireland", jurisdictionIds: ["GB", "GB-SCT"], url: "uk-0.json" },
    { regionId: "uk-ireland", jurisdictionIds: ["GB", "GB-SCT"], url: "uk-1.json" },
    { regionId: "japan", jurisdictionIds: ["JP"], url: "jp.json" },
  ],
};

function entity(overrides = {}) {
  return {
    id: "nature:test-place",
    entityType: "NaturalFeature",
    names: [{ language: "en", kind: "primary", value: "Quiet waterfall" }],
    jurisdictionIds: ["GB", "GB-SCT"],
    geometry: { type: "Point", coordinates: [-4.2, 57.1] },
    activities: ["walking"],
    themes: ["waterfall", "forest"],
    seasons: ["summer"],
    access: { legal: "legal", modes: ["foot"] },
    sensitivity: { action: "publish" },
    quality: { confidence: 0.82, verificationStatus: "verified", flags: [] },
    discovery: {
      distinctiveness: 0.82,
      regionalUniqueness: 0.77,
      evidenceQuality: 0.83,
      visitorProminence: 0.25,
      routeCompatibility: 0.8,
      seasonSuitability: 0.7,
      itineraryVariety: 0.6,
    },
    sourceAssertions: [{ evidenceKind: "verified_official" }],
    ...overrides,
  };
}

function route(overrides = {}) {
  return entity({
    id: "route:test-hike",
    entityType: "TrailRoute",
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
    metrics: { distanceMeters: 12_400, ascentMeters: 640, typicalDurationMinutes: 230 },
    quality: {
      confidence: 0.9,
      geometryConfidence: 0.92,
      verificationStatus: "verified",
      freshness: "current",
      assessedAt: "2026-07-20",
      flags: [],
    },
    sourceAssertions: [{
      sourceId: "fixture:route-source",
      sourceRecordId: "test-hike",
      fieldPath: "/geometry",
      verificationStatus: "verified",
      observedAt: "2026-07-19T10:00:00Z",
    }],
    exportMetadata: { sourceNotices: [{
      sourceId: "fixture:route-source",
      sourceRecordId: "test-hike",
      publisher: "Fixture Route Authority",
      product: "Verified Routes",
      licenceId: "CC-BY",
      licenceVersion: "4.0",
      licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Fixture Route Authority",
      sourceUrl: "https://routes.example.test/test-hike",
      transformationNotice: "Coordinates retained; properties normalized.",
    }] },
    ...overrides,
  });
}

test("manifest options derive one package choice per region and a cautious Scotland focus", () => {
  const options = buildRegionOptions(manifest);
  assert.deepEqual(options.map((option) => option.value), ["scotland", "japan", "uk-ireland"]);
  assert.equal(options[0].packageRegionId, "uk-ireland");
  assert.equal(options[0].jurisdictionId, "GB-SCT");
  assert.match(options[0].label, /incomplete/i);
  assert.equal(options.filter((option) => option.value === "uk-ireland").length, 1);
});


test("data session loads viewport cells independently from regional search packages", async () => {
  const calls = [];
  const visible = entity({ id: "nature:visible-cell" });
  const loader = {
    async loadManifest() {
      calls.push("manifest");
      return manifest;
    },
    async loadRegion(regionId) {
      calls.push(`region:${regionId}`);
      return { regionId, entities: [] };
    },
    async loadViewport(bounds, options) {
      calls.push({ bounds, signal: options.signal });
      return { bounds, entities: [visible] };
    },
  };
  const session = createDiscoveryDataSession(loader);
  await session.initialize();
  const controller = new AbortController();
  const loaded = await session.loadViewport([170, 50, -170, 60], {
    signal: controller.signal,
  });
  assert.deepEqual(loaded.entities, [visible]);
  assert.deepEqual(calls.slice(0, 1), ["manifest"]);
  assert.deepEqual(calls[1].bounds, [170, 50, -170, 60]);
  assert.equal(calls[1].signal, controller.signal);
  assert.equal(calls.some((call) => call === "region:uk-ireland"), false);
});

test("map viewport bounds normalize world copies, dateline wrap, and Web Mercator latitude", () => {
  const bounds = (west, south, east, north) => ({
    getWest: () => west,
    getSouth: () => south,
    getEast: () => east,
    getNorth: () => north,
  });
  assert.deepEqual(mapViewportBounds({ getBounds: () => bounds(-5, 50, 5, 60) }),
    [-5, 50, 5, 60]);
  assert.deepEqual(mapViewportBounds({ getBounds: () => bounds(170, 50, 190, 60) }),
    [170, 50, -170, 60]);
  assert.deepEqual(mapViewportBounds({ getBounds: () => bounds(190, -90, 200, 90) }),
    [-170, -85.0511287798066, -160, 85.0511287798066]);
  assert.deepEqual(mapViewportBounds({ getBounds: () => bounds(-200, -20, 200, 20) }),
    [-180, -20, 180, 20]);
  assert.deepEqual(mapViewportBounds({
    getBounds: () => ({ toArray: () => [[179, 0], [-179, 1]] }),
  }), [179, 0, -179, 1]);
  assert.equal(mapViewportBounds({ getBounds: () => bounds(0, 10, 1, 10) }), null);
  assert.equal(mapViewportBounds(null), null);
});
test("data session bootstrap is manifest-only until explicit activation", async () => {
  const calls = [];
  const scottish = entity();
  const english = entity({ id: "nature:english", jurisdictionIds: ["GB", "GB-ENG"] });
  const loader = {
    async loadManifest() {
      calls.push("manifest");
      return manifest;
    },
    async loadRegion(regionId) {
      calls.push(`region:${regionId}`);
      return { regionId, entities: [scottish, english] };
    },
  };
  const session = createDiscoveryDataSession(loader);
  const initialized = await session.initialize();
  assert.deepEqual(calls, ["manifest"], "initialization must not fetch a regional URL");
  assert.equal(initialized.options[0].value, "scotland");

  const loaded = await session.load("scotland");
  assert.deepEqual(calls, ["manifest", "region:uk-ireland"]);
  assert.deepEqual(loaded.entities.map((item) => item.id), [scottish.id]);
});

test("search, activity, time, interest and verified-access filters compose", () => {
  const unknown = entity({
    id: "nature:unknown-waterfall",
    names: [{ language: "en", kind: "primary", value: "Remote waterfall" }],
    access: { legal: "unknown", modes: ["foot"] },
  });
  const long = route({ id: "route:long", metrics: { typicalDurationMinutes: 600 } });
  const results = filterAndRankEntities([entity(), unknown, long], {
    query: "waterfall",
    activity: "walking",
    interest: "water",
    timeBudgetMinutes: 240,
    requireVerifiedAccess: true,
  });
  assert.deepEqual(results.map((item) => item.entity.id), ["nature:test-place"]);
});

test("dense visible-cell filtering can expose every ranked record in deterministic batches", () => {
  const dense = Array.from({ length: 80 }, (_, itemIndex) => entity({
    id: "nature:dense-" + String(itemIndex).padStart(3, "0"),
    names: [{ language: "en", kind: "primary", value: "Dense result " + itemIndex }],
  }));
  const ranked = filterAndRankEntities(dense, { limit: 5000 });
  const reversed = filterAndRankEntities([...dense].reverse(), { limit: 5000 });
  assert.equal(ranked.length, dense.length);
  assert.deepEqual(
    ranked.map((item) => item.entity.id),
    reversed.map((item) => item.entity.id),
  );
});

test("cards state unknowns literally and include season plus route effort", () => {
  const model = entityCardModel(route({
    access: { legal: "unknown", modes: ["foot"] },
    seasons: [],
  }), { reasons: ["distinctive scenery"], uncertainties: ["legal public access is not verified"], score: 0.7 });
  assert.equal(model.access, "Unknown — not verified");
  assert.equal(model.season, "Season unknown");
  assert.match(model.effort, /12 km/);
  assert.match(model.effort, /640 m ascent/);
  assert.deepEqual(model.uncertainties, ["legal public access is not verified"]);
});

test("discovery lane labels distinguish verified quieter places from unverified leads", () => {
  const verified = entityCardModel(entity(), { lane: "quieter_verified" });
  const lead = entityCardModel(entity(), { lane: "quieter_lead" });
  assert.equal(verified.discoveryLane, "quieter_verified");
  assert.equal(verified.discoveryLaneLabel, "Verified quieter place");
  assert.equal(lead.discoveryLaneLabel, "Unverified discovery lead");
  assert.ok(lead.uncertainties.some((value) => /unverified discovery lead/i.test(value)));
  assert.doesNotMatch(lead.uncertainties.join(" "), /worthwhile|recommended/i);
});

test("linked access points and transport connections remain explicit entities", () => {
  const access = entity({
    id: "access:test",
    entityType: "AccessPoint",
    legalAccess: "unknown",
    accessModes: ["car", "hiking"],
  });
  const transport = entity({ id: "transport:test", entityType: "TransportConnection" });
  const trail = route({
    accessPointIds: [access.id],
    transportConnectionIds: [transport.id],
  });
  const joined = attachLinkedEntities(trail, new Map([
    [trail.id, trail], [access.id, access], [transport.id, transport],
  ]));
  assert.deepEqual(joined.accessPoints.map((item) => item.id), [access.id]);
  assert.deepEqual(joined.transportConnections.map((item) => item.id), [transport.id]);
  assert.equal(joined.accessPoints[0].legalAccess, "unknown");
});

test("map collections render routes as lines and access/places as semantic points with caps", () => {
  const access = entity({ id: "access:test", entityType: "AccessPoint" });
  const collections = buildMapFeatureCollections([route(), access, entity()], null, { routes: 1, points: 1 });
  assert.equal(collections.routes.features.length, 1);
  assert.equal(collections.routes.features[0].geometry.type, "LineString");
  assert.equal(collections.points.features.length, 1);
  assert.equal(collections.points.features[0].geometry.type, "Point");
  assert.notEqual(collections.routes.features[0].geometry.type, "Point");
});

test("map caps use evidence priority instead of input or alphabetical order", () => {
  const low = entity({
    id: "nature:a-low-evidence",
    names: [{ language: "en", kind: "primary", value: "A low-evidence place" }],
    access: { legal: "unknown", modes: ["foot"] },
    quality: { confidence: 0.05, verificationStatus: "unverified", freshness: "stale", flags: ["critical_access_unknown"] },
    discovery: { evidenceQuality: 0.05 },
    sourceAssertions: [{ evidenceKind: "community_report", verificationStatus: "unverified" }],
  });
  const high = entity({
    id: "nature:z-high-evidence",
    names: [{ language: "en", kind: "primary", value: "Z high-evidence place" }],
    quality: { confidence: 0.99, verificationStatus: "verified", freshness: "current", flags: [] },
    discovery: { evidenceQuality: 0.99 },
    sourceAssertions: [{ evidenceKind: "verified_official", verificationStatus: "verified" }],
  });

  assert.deepEqual(
    rankMapEntitiesForDisplay([low, high]).map((item) => item.id),
    [high.id, low.id],
  );
  const capped = buildMapFeatureCollections([low, high], null, { points: 1 });
  assert.equal(capped.points.features[0].id, high.id);
  assert.deepEqual(capped.counts, {
    loaded: 2,
    mappable: 2,
    rendered: 1,
    capped: 1,
    unsupported: 0,
    routes: { loaded: 0, rendered: 0, limit: 180 },
    points: { loaded: 2, rendered: 1, limit: 1 },
  });
  const selected = buildMapFeatureCollections([high, low], low.id, { points: 1 });
  assert.equal(selected.points.features[0].id, low.id, "selected records stay visible above the cap");
});

test("nature map separates complete solid routes from dashed overview geometry", async () => {
  const source = await readFile(new URL("../assets/js/nature/app.mjs", import.meta.url), "utf8");
  assert.match(source, /routeLayer: "nature-discovery-route-lines"/);
  assert.match(source, /overviewRouteLayer: "nature-discovery-overview-route-lines"/);
  assert.match(source, /filter: \["==", \["get", "completeness"\], "complete"\]/);
  assert.match(source, /filter: \["!=", \["get", "completeness"\], "complete"\]/);
  assert.match(source, /"line-dasharray": \[2, 2\]/);
  assert.doesNotMatch(source, /"line-dasharray": \["case"/);
  assert.match(source, /this\.map\.on\("click", MAP_IDS\.routeLayer, selectFeature\)/);
  assert.match(source, /this\.map\.on\("click", MAP_IDS\.overviewRouteLayer, selectFeature\)/);
});

test("GPX export is gated strictly by navigation suitability", () => {
  const unsafe = route({ navigationSuitability: false });
  assert.throws(
    () => serializeTrailRouteGpx(unsafe),
    (error) => error instanceof NatureUiError && error.code === "gpx_navigation_unsuitable",
  );

  const gpx = serializeTrailRouteGpx(route());
  assert.match(gpx, /<trkseg>/);
  assert.match(gpx, /lat="57\.1" lon="-4\.2"/);
  assert.match(gpx, /Ridge &amp; Loch &lt;Loop&gt;/);

  const geojson = JSON.parse(serializeTrailRouteGeoJson(route()));
  assert.equal(geojson.metadata.routeId, "route:test-hike");
  assert.throws(
    () => serializeTrailRouteGeoJson({ ...route(), entityType: "Place" }),
    (error) => error instanceof NatureUiError && error.code === "geojson_not_route",
  );
});

test("static page keeps Discover inside the document and makes it default", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const discover = html.indexOf('id="discoverPanel"');
  const plan = html.indexOf('id="sidebarPanelPlan"');
  const close = html.indexOf("</html>");
  assert.ok(discover > 0 && discover < plan && plan < close);
  assert.equal(html.slice(close + "</html>".length).trim(), "");
  assert.match(html, /id="sidebarTabDiscover" checked/);
  assert.doesNotMatch(html, /id="sidebarTabPlan" checked/);
  assert.match(html, /name="itinera-routing-api" content="\/api\/routing\/v1"/);
  assert.match(html, /type="module" src="assets\/js\/nature\/app\.mjs"/);
  assert.match(html, /id="discoverMapCount" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /id="discoverResultsTitle">Visible map results<\/h2>/);
  assert.match(html, /id="discoverCount" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /id="discoverResults" aria-labelledby="discoverResultsTitle" aria-describedby="discoverCount discoverMapCount" aria-busy="true"/);
  assert.match(html, /id="discoverShowMore"[^>]+aria-describedby="discoverCount" hidden/);
  assert.doesNotMatch(html, /onsubmit=/i);

});

test("visible-cell discovery source synchronizes accessible results and discloses evidence-aware map caps", async () => {
  const [source, css, smoke] = await Promise.all([
    readFile(new URL("../assets/js/nature/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../assets/css/site.css", import.meta.url), "utf8"),
    readFile(new URL("../tools/nature/e2e-smoke.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(source, /const source = isRegionSearch \? this\.entities : this\.viewportEntities/);
  assert.match(source, /if \(!this\.selection\) this\.renderResults\(\)/);
  assert.match(source, /rankMapEntitiesForDisplay\(entities, selectedId/);
  assert.match(source, /mapEvidencePriority\(right, selectedId\) - mapEvidencePriority\(left, selectedId\)/);
  assert.ok(source.includes("Map renders ${rendered} of ${loaded} filter-eligible loaded record"));
  assert.match(source, /if \(!this\.selection\) return \[\.\.\.\(this\.currentMapEntities \|\| \[\]\)\]/);
  assert.match(source, /data-result-index/);
  assert.match(css, /\.discover-map-count/);
  assert.match(css, /\.discover-show-more/);
  assert.match(smoke, /initialNatureDataBytes/);
  assert.match(smoke, /mapBounds/);
});

test("legacy app uses the installed routing bridge and contains no direct public OSRM call", async () => {
  const source = await readFile(new URL("../assets/js/app.js", import.meta.url), "utf8");
  assert.match(source, /window\.ItineraRouting/);
  assert.doesNotMatch(source, /router\.project-osrm\.org/);
});
