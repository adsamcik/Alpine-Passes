const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const apiModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "index.js")).href);

let appSourceCache;
let closedPlanPromise;
let openPlanPromise;
let selectedPlanPromise;

test("smoke 1: closed-loop leisure plan uses the real graph and Phase 4 fields", { timeout: 10_000 }, async () => {
  const result = await getClosedPlan();

  assert.equal(result.status, "ok");
  assert.equal(result.start.id, "j-bellinzona");
  assert.equal(result.endNode, "j-bellinzona");
  assert.ok(result.tourStops.length >= 2, "expected at least two leisure stops");
  assertPhase4Fields(result);
  assert.ok(result.routeAlternatives.length >= 1);
});

test("smoke 2: open A-to-B leisure plan includes endpoint sentinels quickly", { timeout: 5_000 }, async () => {
  const started = performance.now();
  const result = await getOpenPlan();
  const elapsedMs = performance.now() - started;

  assert.equal(result.status, "ok");
  assert.equal(result.endNode, "j-chur");
  assert.equal(result.tourStops[0].id, "j-bellinzona");
  assert.equal(result.tourStops.at(-1).id, "j-chur");
  assertPhase4Fields(result);
  assert.ok(elapsedMs < 1500, `open A→B smoke took ${Math.round(elapsedMs)}ms`);
});

test("smoke 3: selected leisure mode carries all must-visit passes", { timeout: 5_000 }, async () => {
  const result = await getSelectedPlan();
  const stopIds = new Set(result.tourStops.map((stop) => stop.id));

  assert.equal(result.status, "ok");
  assert.equal(result.advanced, true);
  for (const id of ["furkapass", "grimselpass", "sustenpass"]) {
    assert.ok(stopIds.has(id), `missing selected pass ${id}`);
  }
  assert.ok(result.corridor.autoInclude.length >= 0);
});

test("smoke 4: DOM rendering of a real leisure result has no visible object leaks", { timeout: 5_000 }, async () => {
  const result = await getClosedPlan();
  const sandbox = showPlanSandbox();
  sandbox.__result = result;
  const snippet = sourceBetween(appSource(), "function renderLeisureIntentBlock", "function clearLeisureOverlays()");

  assert.doesNotThrow(() => {
    vm.runInNewContext(`${snippet}\nshowPlanResult(__result);`, sandbox, { filename: "assets/js/app.js" });
  });

  assert.match(sandbox.planResult.innerHTML, /Day type:|Optional sights|Photographer/i);
  assertNoVisibleLeaks(sandbox.planResult.innerHTML);
});

test("smoke 5: MapLibre leisure overlay rendering uses fixed sources and layers safely", () => {
  const map = createMapStub();
  const sandbox = overlaySandbox(map);
  const overlays = sampleOverlays();

  assert.doesNotThrow(() => sandbox.__api.setupMapLayers());
  const leisureAddLayers = map.calls.filter((call) => call.type === "addLayer" && String(call.id).startsWith("leisure-"));
  const leisureAddSources = map.calls.filter((call) => call.type === "addSource" && String(call.id).startsWith("leisure-"));
  assert.equal(leisureAddSources.length, 2);
  assert.equal(leisureAddLayers.length, 5);

  const addLayerCount = map.calls.filter((call) => call.type === "addLayer").length;
  assert.doesNotThrow(() => sandbox.__api.drawLeisureOverlays(overlays));
  assert.equal(map.calls.filter((call) => call.type === "addLayer").length, addLayerCount, "draw should update GeoJSON sources, not add marker layers");
  assert.equal(map.sources.get("leisure-zones").data.features.length, 1);
  assert.equal(map.sources.get("leisure-points").data.features.length, 4);
});

test("leisure layers paint below the route and marker overlay as specified", () => {
  const map = createMapStub();
  const sandbox = overlaySandbox(map);

  sandbox.__api.setupMapLayers();

  assertLayerBefore(map, "leisure-zone-fill", "planned-route-shadow");
  assertLayerBefore(map, "leisure-zone-outline", "planned-route-shadow");
  for (const layerId of ["leisure-corridor-points", "leisure-break-points", "leisure-point-labels"]) {
    assertLayerBefore(map, "planned-route-core", layerId);
    assertLayerBefore(map, layerId, "alpine-overlay");
  }
});

test("drawLeisureOverlays converts lunch polygons from lat-lon to lon-lat", () => {
  const map = createMapStub();
  const sandbox = overlaySandbox(map);

  sandbox.__api.setupMapLayers();
  sandbox.__api.drawLeisureOverlays({
    lunchZones: [{
      id: "lat-lon-zone",
      polygon: [[46.5, 9.0], [46.6, 9.1], [46.7, 9.2]],
      centroid: [46.6, 9.1],
    }],
  });

  const [feature] = map.sources.get("leisure-zones").data.features;
  const coordinates = JSON.parse(JSON.stringify(feature.geometry.coordinates[0].slice(0, 3)));
  assert.deepEqual(coordinates, [[9.0, 46.5], [9.1, 46.6], [9.2, 46.7]]);
});

test("setupMapLayers survives leisure layer registration failure", () => {
  const map = createMapStub();
  const addLayer = map.addLayer.bind(map);
  map.addLayer = function addLayerWithFault(layer, beforeId) {
    if (String(layer.id).startsWith("leisure-")) throw new Error("leisure layer boom");
    return addLayer(layer, beforeId);
  };
  const warnings = [];
  const sandbox = overlaySandbox(map, { ...console, warn: (...args) => warnings.push(args) });

  assert.doesNotThrow(() => sandbox.__api.setupMapLayers());
  assert.equal(sandbox.__api.layersReady(), true);
  assert.ok(map.layers.has("planned-route-core"));
  assert.ok(map.layers.has("alpine-overlay"));
  assert.equal(warnings[0]?.[0], "leisure overlays disabled");
});

test("showPlanResult handles empty Phase 4 arrays without object leaks", () => {
  const sandbox = showPlanSandbox();
  sandbox.__result = minimalLeisureResult({
    corridor: { autoInclude: [], suggestions: [], drawer: [] },
    lunchZones: [],
    breaks: [],
    intent: { topPersona: "", ambiguous: false, primary: [], serendipity: [], topPersonas: [] },
  });
  const snippet = sourceBetween(appSource(), "function renderLeisureIntentBlock", "function clearLeisureOverlays()");

  vm.runInNewContext(`${snippet}\nshowPlanResult(__result);`, sandbox, { filename: "assets/js/app.js" });

  assertNoVisibleLeaks(sandbox.planResult.innerHTML);
  assert.doesNotMatch(sandbox.planResult.innerHTML, /Optional sights along the way|Lunch zones|Suggested breaks/);
});

test("non-plannable corridor suggestions render as text instead of add buttons", () => {
  const sandbox = showPlanSandbox();
  sandbox.POI_BY_ID = new Map([["poi-nonplannable", { id: "poi-nonplannable", name: "Hidden chapel" }]]);
  sandbox.PLANNABLE_POI_IDS = new Set();
  sandbox.__result = minimalLeisureResult({
    corridor: {
      autoInclude: [],
      suggestions: [{ poiId: "poi-nonplannable", poiName: "Hidden chapel", detourMin: 9, reason: "near the route" }],
      drawer: [],
    },
  });
  const snippet = sourceBetween(appSource(), "function renderLeisureIntentBlock", "function clearLeisureOverlays()");

  vm.runInNewContext(`${snippet}\nshowPlanResult(__result);`, sandbox, { filename: "assets/js/app.js" });

  assert.match(sandbox.planResult.innerHTML, /Hidden chapel/);
  assert.doesNotMatch(sandbox.planResult.innerHTML, /data-leisure-add-poi/);
  assert.doesNotMatch(sandbox.planResult.innerHTML, />\+\s*Hidden chapel/);
});

test("smoke 6: disabled leisure flag keeps planTour on the legacy branch", async () => {
  const sandbox = legacyPlanTourSandbox();

  await sandbox.__planTour();

  assert.equal(sandbox.__leisureCalled, false);
  assert.equal(sandbox.__legacyBestTourCalled, true);
  assert.ok(sandbox.__alternatives.length >= 1);
  const legacyResult = sandbox.__alternatives[0].result;
  for (const field of ["corridor", "lunchZones", "breaks", "intent"]) {
    assert.equal(Object.hasOwn(legacyResult, field), false, `legacy result should not include ${field}`);
  }
  assert.equal(Object.hasOwn(sandbox.__alternatives[0].draw.meta, "leisureOverlays"), false);
});

test("smoke 7: clearPlannedTour clears leisure overlay source data", { timeout: 5_000 }, async () => {
  const result = await getClosedPlan();
  const map = createMapStub();
  const sandbox = overlaySandbox(map);

  sandbox.__api.setupMapLayers();
  sandbox.__api.drawLeisureOverlays(result._drawMeta.leisureOverlays);
  const before = leisureFeatureCount(map);
  assert.ok(before > 0, "expected a planned leisure overlay to draw features");

  sandbox.__api.clearPlannedTour();
  const after = leisureFeatureCount(map);

  assert.ok(after < before, `expected overlay features to shrink from ${before}, got ${after}`);
  assert.equal(after, 0);
});

test("smoke 8: fresh-process planning plus Phase 4 render stays under two seconds median", { timeout: 20_000 }, (t) => {
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const child = spawnSync(process.execPath, ["-e", performanceChildScript(i)], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    samples.push(JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)).ms);
  }
  samples.sort((a, b) => a - b);
  const median = samples[1];
  t.diagnostic(`Smoke 8 fresh-process samples: ${samples.join(", ")} ms; median ${median} ms`);
  assert.ok(median <= 2000, `median ${median}ms exceeded 2000ms`);
});

function getClosedPlan() {
  closedPlanPromise ??= apiModule.then(({ leisurePlanAuto }) => leisurePlanAuto(uiOptions({
    start: "j-bellinzona",
    targetMode: "time",
    targetValue: 8,
    themes: ["panoramic-view"],
    personas: ["photographer"],
  })));
  return closedPlanPromise;
}

function getOpenPlan() {
  openPlanPromise ??= apiModule.then(({ leisurePlanAuto }) => leisurePlanAuto(uiOptions({
    start: "j-bellinzona",
    endNode: "j-chur",
    targetMode: "time",
    targetValue: 8,
    timeBudgetMs: 1,
    iterationCap: 0,
  })));
  return openPlanPromise;
}

function getSelectedPlan() {
  selectedPlanPromise ??= apiModule.then(({ leisurePlanSelected }) => leisurePlanSelected(uiOptions({
    start: "j-andermatt",
    targetMode: "time",
    targetValue: 7,
    seed: "smoke-selected",
    timeBudgetMs: 100,
  }), ["furkapass", "grimselpass", "sustenpass"]));
  return selectedPlanPromise;
}

function uiOptions(overrides = {}) {
  return {
    targetMode: "time",
    targetValue: 8,
    targetTol: 0.2,
    openOnly: false,
    kAlternatives: 1,
    osrmRoute: straightLineOsrmRoute,
    stopsConfig: {
      passStopMin: 0,
      lunchBreak: "none",
      restBreakOn: false,
      restInterval: 0,
      restDuration: 0,
    },
    ...overrides,
  };
}

function assertPhase4Fields(result) {
  assert.ok(result.corridor && typeof result.corridor === "object");
  assert.ok(Array.isArray(result.corridor.autoInclude));
  assert.ok(Array.isArray(result.corridor.suggestions));
  assert.ok(Array.isArray(result.lunchZones));
  assert.ok(Array.isArray(result.breaks));
  assert.ok(result.intent && typeof result.intent === "object");
  assert.ok(Array.isArray(result.intent.primary));
  assert.ok(Array.isArray(result.intent.serendipity));
}

function showPlanSandbox() {
  const classList = { add() {}, remove() {}, toggle() {} };
  const planResult = {
    classList,
    children: [],
    innerHTML: "",
    removeAttribute() {},
    setAttribute() {},
  };
  const document = {
    getElementById: () => planResult,
    querySelector: () => null,
    createElement: () => ({ style: {}, classList, setAttribute() {}, appendChild() {} }),
  };
  return {
    planResult,
    document,
    window: {},
    PRESET_STARTS: { bellinzona: { name: "Bellinzona" }, chur: { name: "Chur" } },
    POI_BY_ID: new Map(),
    PLANNABLE_POI_IDS: new Set(),
    PASS_BY_ID: new Map(),
    requestAnimationFrame: (fn) => fn(),
    escapeHtml,
    fmtDuration: (hours) => `${Number(hours).toFixed(1)}h`,
    poiCategoryIcon: () => "",
    qualityStarsCompact: () => "",
    fmtExtrasSummary: () => "planned breaks",
    renderTourStatChips: () => "",
    renderScenicStopsBlock: () => "",
    renderRouteAlternativesBlock: () => "",
    renderPlanResultActions: () => "",
    scrollPlanResultIntoView: () => {},
    cleanStartName: (name) => String(name || ""),
    todayLocalDate: () => new Date(2026, 5, 15),
    daysBetweenDates: () => 0,
    formatTripDate: () => "15 Jun 2026",
  };
}

function overlaySandbox(map, consoleOverride = console) {
  const sandbox = {
    console: consoleOverride,
    map,
    window: {},
    document: { body: { classList: { contains: () => false } } },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 0,
    scheduleAlpineOverlayRender() {},
    currentPassMapFeatures: () => ({ type: "FeatureCollection", features: [] }),
    currentPoiMapFeatures: () => ({ type: "FeatureCollection", features: [] }),
    updateMapInfo() {},
    currentBaseLayerName: "test",
    bindMapInteractions() {},
    updatePlannedTourLayers() {},
    plannedRouteCoords: null,
    plannedRouteFallback: false,
    alpineOverlayLayer: { id: "alpine-overlay", type: "custom", render() {} },
    POI_BY_ID: new Map(),
    PASS_BY_ID: new Map(),
    PRESET_STARTS: {},
    escapeHtml,
    fmtDuration: (hours) => `${Number(hours).toFixed(1)}h`,
    poiCategoryIcon: () => "",
    qualityStarsCompact: () => "",
    fmtExtrasSummary: () => "",
    renderTourStatChips: () => "",
    renderScenicStopsBlock: () => "",
    renderRouteAlternativesBlock: () => "",
    renderPlanResultActions: () => "",
    scrollPlanResultIntoView: () => {},
    cleanStartName: (name) => String(name || ""),
    todayLocalDate: () => new Date(2026, 5, 15),
    daysBetweenDates: () => 0,
    formatTripDate: () => "15 Jun 2026",
    planResult: { classList: { add() {}, remove() {} }, children: [], innerHTML: "", removeAttribute() {}, setAttribute() {} },
    weatherHydrationSeq: 0,
    weatherHydrationTimer: null,
    setPlannedTourIds(ids) { sandbox.__plannedTourIds = ids; },
    setLayerSoloFocus() {},
    refreshLayerControlUI() {},
    activePopup: null,
    plannedStart: null,
    plannedRouteActive: false,
    plannedRouteGeometry: null,
    plannedRouteAlternatives: [],
    activeRouteAlternativeIndex: 0,
    set clearTimeout(fn) { this.__clearTimeout = fn; },
  };
  sandbox.clearTimeout = () => {};

  const constants = `
const PASS_SOURCE_ID = "alpine-passes";
const POI_SOURCE_ID = "swiss-pois";
const ROUTE_SOURCE_ID = "planned-route";
const START_SOURCE_ID = "planned-start";
const LEISURE_ZONE_SOURCE_ID = "leisure-zones";
const LEISURE_POINT_SOURCE_ID = "leisure-points";
const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] };
let mapLayersReady = false;
let mapLayerRestoreQueued = false;
let plannedLeisureOverlayData = { zones: EMPTY_FEATURE_COLLECTION, points: EMPTY_FEATURE_COLLECTION };
let plannedLeisureOverlayFocus = new Map();
const ALPINE_GL_LAYER_ID = "alpine-overlay";
`;
  const snippets = [
    constants,
    sourceBetween(appSource(), "function setSourceData", "const ALPINE_GL_LAYER_ID"),
    sourceBetween(appSource(), "function setupMapLayers()", "function bindMapLayerCursor"),
    sourceBetween(appSource(), "function renderLeisureIntentBlock", "function updatePlannedTourLayers"),
    sourceBetween(appSource(), "function clearPlannedTour()", "window.setPlannedStart"),
    `globalThis.__api = { setupMapLayers, drawLeisureOverlays, clearLeisureOverlays, clearPlannedTour, overlayData: () => plannedLeisureOverlayData, layersReady: () => mapLayersReady };`,
  ].join("\n");

  vm.runInNewContext(snippets, sandbox, { filename: "assets/js/app.js" });
  return sandbox;
}

function legacyPlanTourSandbox() {
  const sandbox = {
    console,
    localStorage: new MemoryStorage(),
    performance: { now: (() => { let t = 0; return () => { t += 1; return t; }; })() },
    __leisureCalled: false,
    __legacyBestTourCalled: false,
    __alternatives: [],
  };
  const snippet = sourceBetween(appSource(), "async function planTour()", "/* Index in `polyline`");
  vm.runInNewContext(`
const advancedModeEl = { checked: false };
const openOnlyEl = { checked: false };
const includePoisEl = { checked: false };
const PASSES = [{ id: "legacy-pass", name: "Legacy Pass", lat: 0.01, lon: 0.01, quality: 1, qSummit: 1, qApproach: 1, baseA: {}, baseB: {} }];
const PLANNABLE_POIS = [];
const allowedPoiCategories = new Set();
const allowedPoiThemes = new Set();
const activePresetIds = new Set();
const PLANNER_MAX_CANDIDATES = 4;
const PLANNER_MAX_PASSES = 4;
const RETRACE_REPAIR_MAX_ITER = 1;
function isLeisurePlannerEnabled() { try { return localStorage.getItem("alpine.planner.leisure.v1") === "1"; } catch { return false; } }
async function runLeisurePlanner() { globalThis.__leisureCalled = true; throw new Error("leisure branch should be disabled"); }
async function planSelectedTour() { throw new Error("advanced branch should be disabled"); }
function clearPlannedTour() { globalThis.__cleared = true; }
function currentStart() { return { id: "legacy-start", name: "Legacy Start", lat: 0, lon: 0 }; }
function planTargetMode() { return "time"; }
function planTargetValue() { return 8; }
function planTargetTolerance() { return 0.2; }
function currentStopsConfig() { return { passStopMin: 0, lunchBreak: "none", restBreakOn: false }; }
function computeExtras() { return { extrasH: 0, parts: { passStopMins: [0], restH: 0, lunchH: 0 } }; }
function estimateTourPassN() { return 1; }
function passStatus() { return { state: "open" }; }
function haversine() { return 1; }
function currentTripSeason() { return null; }
function poiMinScoreVal() { return 0; }
function poiMaxCountVal() { return 0; }
function setPlannerBusy(label) { globalThis.__busyLabel = label; }
function showPlanResult(result) { globalThis.__shownResult = result; }
function fetchTable() { return Promise.resolve({}); }
function plannerPointsForPasses() { return []; }
function computeSharedGatewayFlags() { return []; }
function bestTourGated() {
  globalThis.__legacyBestTourCalled = true;
  return { perm: [{ passIdx: 0, enterSide: 0, exitSide: 1, mode: "traverse" }], k: 1, km: 100, driveH: 1, dwellH: 0, totalH: 1, h: 1, inRange: true };
}
function tourWaypointPlan(start, candidates, perm) { return { waypoints: [start, candidates[perm[0].passIdx], start], wpMatrixIdx: [0, 1, 2] }; }
function coordsFromWaypoints() { return "0,0;0.01,0.01;0,0"; }
async function osrmRoute() { return { geom: [[0, 0], [0.01, 0.01], [0, 0]], distanceKm: 100, durationH: 1 }; }
function orderedPolylineWaypointIndices() { return [0, 1, 2]; }
function routePassCrossingsForPlan() { return { blocked: [], implicit: [] }; }
function detectRetracedConnectorLegs() { return []; }
function applyRetracePenalties() {}
function mergeImplicitRoutePasses(tourStops, modes) { return { tourStops, modes }; }
function planScenicStops() { return []; }
function resetPlanButton() { globalThis.__reset = true; }
function currentTripDate() { return null; }
function formatTripDate() { return "today"; }
function setPlannedRouteAlternatives(alternatives) { globalThis.__alternatives = alternatives; }
function activateRouteAlternative(index) { globalThis.__activeAlternative = index; }
${snippet}
globalThis.__planTour = planTour;
`, sandbox, { filename: "assets/js/app.js" });
  return sandbox;
}

function createMapStub() {
  const map = {
    calls: [],
    sources: new Map(),
    layers: new Map(),
    layerOrder: [],
    getSource(id) { return this.sources.get(id) || null; },
    addSource(id, source) {
      const stored = {
        ...source,
        data: source.data,
        setData(data) { this.data = data; },
      };
      this.sources.set(id, stored);
      this.calls.push({ type: "addSource", id });
    },
    removeSource(id) {
      this.sources.delete(id);
      this.calls.push({ type: "removeSource", id });
    },
    getLayer(id) { return this.layers.get(id) || null; },
    addLayer(layer, beforeId) {
      this.layers.set(layer.id, layer);
      this.layerOrder = this.layerOrder.filter((id) => id !== layer.id);
      const beforeIndex = beforeId ? this.layerOrder.indexOf(beforeId) : -1;
      if (beforeIndex >= 0) this.layerOrder.splice(beforeIndex, 0, layer.id);
      else this.layerOrder.push(layer.id);
      this.calls.push({ type: "addLayer", id: layer.id, beforeId: beforeId || null });
    },
    removeLayer(id) {
      this.layers.delete(id);
      this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id);
      this.calls.push({ type: "removeLayer", id });
    },
    on() {},
    getCanvas: () => ({ style: {} }),
  };
  return map;
}

function assertLayerBefore(map, lowerLayerId, upperLayerId) {
  const lowerIndex = map.layerOrder.indexOf(lowerLayerId);
  const upperIndex = map.layerOrder.indexOf(upperLayerId);
  assert.notEqual(lowerIndex, -1, `missing layer ${lowerLayerId}`);
  assert.notEqual(upperIndex, -1, `missing layer ${upperLayerId}`);
  assert.ok(lowerIndex < upperIndex, `${lowerLayerId} should paint below ${upperLayerId}; order=${map.layerOrder.join(" > ")}`);
}

function minimalLeisureResult(overrides = {}) {
  return {
    start: { id: "j-bellinzona", name: "Bellinzona", displayName: "Bellinzona" },
    endNode: "j-chur",
    tourStops: [],
    modes: [],
    implicitPasses: [],
    scenicStops: [],
    km: 0,
    driveH: 0,
    dwellH: 0,
    extrasH: 0,
    extrasParts: {},
    totalH: 0,
    inRange: true,
    advanced: false,
    routeWarning: "",
    statusWarning: "",
    tripDate: null,
    matched: 0,
    poolSize: 0,
    totalOpen: 0,
    targetMode: "time",
    targetValue: 7,
    corridor: { autoInclude: [], suggestions: [], drawer: [] },
    lunchZones: [],
    breaks: [],
    intent: { topPersona: "", ambiguous: false, primary: [], serendipity: [], topPersonas: [] },
    ...overrides,
  };
}

function sampleOverlays() {
  return {
    lunchZones: [{
      id: "lunch-1",
      vibeTag: "valley",
      centroid: [46.2, 8.2],
      polygon: [[46.2, 8.2], [46.21, 8.2], [46.2, 8.21]],
      tArriveMin: new Date(2026, 5, 15, 12, 0),
      tArriveMax: new Date(2026, 5, 15, 13, 0),
    }],
    breaks: [
      { id: "break-1", type: "coffee", tStart: new Date(2026, 5, 15, 10, 0), lat: 46.3, lon: 8.3, reason: "rest" },
      { id: "break-2", type: "viewpoint", tStart: new Date(2026, 5, 15, 11, 0), poiCandidate: { name: "View", lat: 46.4, lon: 8.4 } },
    ],
    corridorSuggestions: [{ poiId: "poi-smoke", poiName: "Optional view", detourMin: 8, lat: 46.5, lon: 8.5 }],
    corridorAutoInclude: [],
  };
}

function leisureFeatureCount(map) {
  return (map.sources.get("leisure-zones")?.data?.features?.length || 0)
    + (map.sources.get("leisure-points")?.data?.features?.length || 0);
}

async function straightLineOsrmRoute(coords) {
  const points = String(coords)
    .split(";")
    .map((token) => {
      const [lon, lat] = token.split(",").map(Number);
      return { lat, lon };
    })
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  const geom = [];
  let distanceKm = 0;
  for (let i = 0; i < points.length; i += 1) {
    if (i === 0) {
      geom.push([points[i].lon, points[i].lat]);
      continue;
    }
    const previous = points[i - 1];
    const current = points[i];
    distanceKm += haversineKm(previous, current);
    geom.push([current.lon, current.lat]);
  }
  return { geom, distanceKm: round(distanceKm, 3), durationH: round(distanceKm / 45, 3) };
}

function performanceChildScript(runIndex) {
  return `
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');
const root = process.cwd();
function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error('missing ' + startMarker);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error('missing ' + endMarker);
  return source.slice(start, end);
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function haversineKm(a, b) {
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
async function osrmRoute(coords) {
  const points = String(coords).split(';').map(token => {
    const [lon, lat] = token.split(',').map(Number);
    return { lat, lon };
  }).filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  let distanceKm = 0;
  const geom = points.map((point, index) => {
    if (index > 0) distanceKm += haversineKm(points[index - 1], point);
    return [point.lon, point.lat];
  });
  return { geom, distanceKm, durationH: distanceKm / 45 };
}
function showPlanSandbox() {
  const classList = { add() {}, remove() {}, toggle() {} };
  const planResult = { classList, children: [], innerHTML: '', removeAttribute() {}, setAttribute() {} };
  return {
    planResult,
    document: { getElementById: () => planResult, querySelector: () => null, createElement: () => ({ style: {}, classList, setAttribute() {}, appendChild() {} }) },
    window: {},
    PRESET_STARTS: { bellinzona: { name: 'Bellinzona' } },
    POI_BY_ID: new Map(),
    PASS_BY_ID: new Map(),
    requestAnimationFrame: fn => fn(),
    escapeHtml,
    fmtDuration: hours => Number(hours).toFixed(1) + 'h',
    poiCategoryIcon: () => '',
    qualityStarsCompact: () => '',
    fmtExtrasSummary: () => '',
    renderTourStatChips: () => '',
    renderScenicStopsBlock: () => '',
    renderRouteAlternativesBlock: () => '',
    renderPlanResultActions: () => '',
    scrollPlanResultIntoView: () => {},
    cleanStartName: name => String(name || ''),
    todayLocalDate: () => new Date(2026, 5, 15),
    daysBetweenDates: () => 0,
    formatTripDate: () => '15 Jun 2026',
  };
}
(async () => {
  const t0 = performance.now();
  const module = await import(pathToFileURL(path.join(root, 'assets', 'js', 'leisure', 'index.js')).href);
  const result = await module.leisurePlanAuto({
    start: 'j-bellinzona',
    targetMode: 'time',
    targetValue: 2,
    budgetSeconds: 6200,
    kAlternatives: 1,
    timeBudgetMs: 1,
    iterationCap: 0,
    osrmRoute,
  });
  const source = fs.readFileSync(path.join(root, 'assets', 'js', 'app.js'), 'utf8');
  const snippet = sourceBetween(source, 'function renderLeisureIntentBlock', 'function clearLeisureOverlays()');
  const sandbox = showPlanSandbox();
  sandbox.__result = result;
  vm.runInNewContext(snippet + '\\nshowPlanResult(__result);', sandbox, { filename: 'assets/js/app.js' });
  if (!sandbox.planResult.innerHTML) throw new Error('empty render');
  console.log(JSON.stringify({ run: ${runIndex}, ms: Math.round(performance.now() - t0), status: result.status, html: sandbox.planResult.innerHTML.length }));
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
`;
}

function haversineKm(a, b) {
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function round(value, decimals = 3) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function appSource() {
  appSourceCache ??= fs.readFileSync(path.join(repoRoot, "assets", "js", "app.js"), "utf8");
  return appSourceCache;
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function assertNoVisibleLeaks(html) {
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.doesNotMatch(html, /\bundefined\b/);
}

class MemoryStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}
