const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const START_ANDERMATT = Object.freeze({
  id: "andermatt",
  name: "Andermatt",
  displayName: "Andermatt",
  lat: 46.635,
  lon: 8.594,
});
const SELECTED_PASS_IDS = Object.freeze(["grimselpass", "sustenpass"]);
const SELECTED_POI_IDS = Object.freeze(["furkapass", "poi3"]);
const APPROX_ROUTE_WARNING = "Could not fetch detailed route geometry; map line is approximate.";
const noExtrasConfig = Object.freeze({
  passStopMin: 0,
  lunchBreak: "none",
  restBreakOn: false,
  restInterval: 0,
  restDuration: 0,
});

globalThis.osrmRoute = straightLineOsrmRoute;

const apiModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "index.js")).href);
const graphModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "graph.js")).href);

let realGraphPromise;
let autoPlanPromise;
let selectedPlanPromise;
let selectedPoiPlanPromise;

test("leisurePlanAuto returns the full UiPlanResult shape", { timeout: 5_000 }, async () => {
  const result = await getAutoPlan();

  assertUiPlanResult(result);
  assert.equal(result.advanced, false);
});

test("leisurePlanSelected returns advanced result including both requested stops", { timeout: 5_000 }, async () => {
  const result = await getSelectedPlan();
  const ids = result.tourStops.map((stop) => stop.id);

  assertUiPlanResult(result);
  assert.equal(result.advanced, true);
  for (const id of SELECTED_PASS_IDS) assert.ok(ids.includes(id), `missing selected stop ${id}`);
});

test("public API tourStops omit the start because the closed loop is implicit", { timeout: 5_000 }, async () => {
  const [auto, selected] = await Promise.all([getAutoPlan(), getSelectedPlan()]);

  assertLegacyTourStopsContract(auto);
  assertLegacyTourStopsContract(selected);
});

test("routeAlternatives summarize a primary route and unique alternatives", { timeout: 5_000 }, async () => {
  const result = await getAutoPlan();
  const alternatives = result.routeAlternatives;

  assert.ok(alternatives.length >= 1);
  for (const [index, alternative] of alternatives.entries()) {
    assert.equal(alternative.index, index);
    assert.equal(typeof alternative.label, "string");
    assertFiniteNumber(alternative.km, `alternative ${index} km`);
    assertFiniteNumber(alternative.driveH, `alternative ${index} driveH`);
    assertFiniteNumber(alternative.totalH, `alternative ${index} totalH`);
  }
  assert.equal(alternatives[0].km, result.km);
  assert.equal(alternatives[0].driveH, result.driveH);
  assert.equal(alternatives[0].totalH, result.totalH);
  assert.equal(new Set(alternatives.map(routeSummarySignature)).size, alternatives.length);
});

test("modes are parallel to tourStops and use the UI traversal mode shape", { timeout: 5_000 }, async () => {
  const result = await getAutoPlan();

  assert.equal(result.modes.length, result.tourStops.length);
  for (const [index, mode] of result.modes.entries()) {
    assert.equal(mode.passIdx, index);
    assert.ok(mode.enterSide === 0 || mode.enterSide === 1, `mode ${index} enterSide`);
    assert.ok(mode.exitSide === 0 || mode.exitSide === 1, `mode ${index} exitSide`);
    assert.ok(["traverse", "out-and-back", "poi"].includes(mode.mode), `mode ${index} kind`);
  }
});

test("pass traversal stops translate pass name, coordinates, kind, and opposing sides", { timeout: 5_000 }, async () => {
  const [result, graph] = await Promise.all([getSelectedPlan(), getRealGraph()]);
  const index = result.modes.findIndex((mode) => mode.mode === "traverse");
  assert.notEqual(index, -1, "expected at least one traversal mode");

  const stop = result.tourStops[index];
  const pass = graph.nodes.get(stop.id);
  assert.ok(pass, `missing graph pass ${stop.id}`);
  assert.equal(stop.kind, "pass");
  assert.equal(stop.name, pass.name);
  assert.equal(stop.lat, Number(pass.lat));
  assert.equal(stop.lon, Number(pass.lon));
  assert.equal(result.modes[index].mode, "traverse");
  assert.ok(result.modes[index].enterSide === 0 || result.modes[index].enterSide === 1);
  assert.ok(result.modes[index].exitSide === 0 || result.modes[index].exitSide === 1);
  assert.notEqual(result.modes[index].enterSide, result.modes[index].exitSide);
});

test("POI stops translate isPoi and canonical poi mode", { timeout: 5_000 }, async () => {
  const result = await getSelectedPoiPlan();
  const index = result.tourStops.findIndex((stop) => stop.isPoi);

  assert.notEqual(index, -1, "expected at least one POI stop");
  assert.equal(result.tourStops[index].kind, "poi");
  assert.equal(result.modes[index].mode, "poi");
});

test("public totals are numerically consistent", { timeout: 5_000 }, async () => {
  const result = await getAutoPlan();

  assert.ok(result.totalH + 0.01 >= result.driveH, `totalH ${result.totalH} should include driveH ${result.driveH}`);
  assert.ok(result.dwellH >= 0);
  assert.ok(result.extrasH >= 0);
});

test("isLeisurePlannerEnabled is false without a localStorage entry", async () => {
  const { isLeisurePlannerEnabled } = await apiModule;

  await withFakeLocalStorage({}, () => {
    assert.equal(isLeisurePlannerEnabled(), false);
  });
});

test("isLeisurePlannerEnabled is true only for the enabled flag value", async () => {
  const { isLeisurePlannerEnabled } = await apiModule;

  await withFakeLocalStorage({ "alpine.planner.leisure.v1": "1" }, () => {
    assert.equal(isLeisurePlannerEnabled(), true);
  });
});

test("isLeisurePlannerEnabled rejects non-enabled flag values", async () => {
  const { isLeisurePlannerEnabled } = await apiModule;

  for (const value of ["0", "yes", ""]) {
    await withFakeLocalStorage({ "alpine.planner.leisure.v1": value }, () => {
      assert.equal(isLeisurePlannerEnabled(), false, `value ${JSON.stringify(value)}`);
    });
  }
});

test("leisurePlanAuto reports invalid starts as an error UiPlanResult", { timeout: 5_000 }, async () => {
  const { leisurePlanAuto } = await apiModule;
  const result = await leisurePlanAuto({
    start: "nonexistent-id",
    targetMode: "time",
    targetValue: 7,
    targetTol: 0.2,
    themes: [],
    openOnly: false,
    osrmRoute: straightLineOsrmRoute,
  });

  assertUiPlanResult(result);
  assert.equal(result.status, "infeasible");
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0);
});

test("leisurePlanSelected reports empty selections as a clear error UiPlanResult", { timeout: 5_000 }, async () => {
  const { leisurePlanSelected } = await apiModule;
  const result = await leisurePlanSelected(baseUiOptions({ targetMode: "time", targetValue: 6 }), []);

  assertUiPlanResult(result);
  assert.equal(result.status, "infeasible");
  assert.match(result.error, /selected/i);
});

test("time target planning uses targetValue-derived budgetSeconds and targetTol for inRange", { timeout: 5_000 }, async () => {
  const { leisurePlanAuto } = await apiModule;
  const targetValue = 7;
  const targetTol = 0.15;
  const result = await leisurePlanAuto(baseUiOptions({ targetMode: "time", targetValue, targetTol, timeBudgetMs: 20 }));
  const expectedInRange = Math.abs(result.totalH - targetValue) <= targetValue * targetTol;

  assert.equal(result.diagnostics?.budget?.mode, "duration");
  assert.equal(result.diagnostics?.budget?.value, targetValue * 3600);
  assert.equal(result.inRange, expectedInRange);
});

test("forbidden passes are absent from primary and route alternatives", { timeout: 5_000 }, async () => {
  const { leisurePlanAuto } = await apiModule;
  const result = await leisurePlanAuto(baseUiOptions({
    targetMode: "time",
    targetValue: 7,
    forbiddenPassIds: new Set(["furkapass"]),
    timeBudgetMs: 20,
  }));

  for (const alternative of resultObjectsForAlternatives(result)) {
    assert.ok(
      !alternative.tourStops.some((stop) => stop.id === "furkapass"),
      `furkapass appeared in alternative ${alternative.routeAlternativeIndex ?? 0}`
    );
  }
});

test("OSRM failures fall back to approximate routes with route warnings", { timeout: 5_000 }, async () => {
  const { leisurePlanAuto } = await apiModule;
  const result = await leisurePlanAuto(baseUiOptions({
    targetMode: "time",
    targetValue: 7,
    osrmRoute: rejectingOsrmRoute,
    timeBudgetMs: 20,
  }));

  assertUiPlanResult(result);
  assert.equal(result.routeWarning, APPROX_ROUTE_WARNING);
  assert.ok(Array.isArray(result._latlngs), "_latlngs should be exposed for drawing");
  assert.ok(result._latlngs.length > 0, "fallback latlngs should not be empty");
  for (const alternative of resultObjectsForAlternatives(result)) {
    assert.equal(alternative.routeWarning, APPROX_ROUTE_WARNING);
  }
});

test("totalOpen is a finite integer in auto and selected modes", { timeout: 5_000 }, async () => {
  const { leisurePlanAuto, leisurePlanSelected } = await apiModule;
  const options = baseUiOptions({
    targetMode: "time",
    targetValue: 7,
    openOnly: true,
    tripDate: "2026-02-01",
    forbiddenPassIds: new Set(["furkapass"]),
    timeBudgetMs: 20,
  });
  const [auto, selected] = await Promise.all([
    leisurePlanAuto(options),
    leisurePlanSelected(options, [...SELECTED_PASS_IDS]),
  ]);

  assertTotalOpen(auto.totalOpen, "auto totalOpen");
  assertTotalOpen(selected.totalOpen, "selected totalOpen");
});

test("seeded leisurePlanAuto calls produce identical primary node ordering", { timeout: 5_000 }, async () => {
  const { leisurePlanAuto } = await apiModule;
  const options = baseUiOptions({ targetMode: "time", targetValue: 7, seed: 1234, timeBudgetMs: 20 });
  const first = await leisurePlanAuto(options);
  const second = await leisurePlanAuto(options);

  assert.equal(first.diagnostics?.seed, 1234);
  assert.equal(second.diagnostics?.seed, 1234);
  assert.deepEqual(primaryStopIds(second), primaryStopIds(first));
});

test("seeded leisurePlanSelected calls propagate seed and remain deterministic", { timeout: 5_000 }, async () => {
  const { leisurePlanSelected } = await apiModule;
  const options = baseUiOptions({ targetMode: "time", targetValue: 6, seed: "selected-seed", timeBudgetMs: 20 });
  const first = await leisurePlanSelected(options, [...SELECTED_PASS_IDS]);
  const second = await leisurePlanSelected(options, [...SELECTED_PASS_IDS]);

  assert.equal(first.diagnostics?.seed, "selected-seed");
  assert.equal(second.diagnostics?.seed, "selected-seed");
  assert.deepEqual(primaryStopIds(second), primaryStopIds(first));
});

test("leisurePlanAuto does not mutate the loaded leisure graph counts", { timeout: 5_000 }, async () => {
  const [graph, { leisurePlanAuto }] = await Promise.all([getRealGraph(), apiModule]);
  const before = graphCountHash(graph);

  await leisurePlanAuto(baseUiOptions({ targetMode: "time", targetValue: 7, timeBudgetMs: 20 }));

  assert.equal(graphCountHash(graph), before);
});

test("app.js keeps selected-tour leisure dispatch conditional before legacy optimizer call", () => {
  const source = fs.readFileSync(path.join(repoRoot, "assets", "js", "app.js"), "utf8");
  const body = sourceBetween(source, "async function planSelectedTour()", "async function planTour()");

  assert.match(body, /if\s*\(\s*isLeisurePlannerEnabled\(\)\s*\)/);
  assert.match(body, /runLeisurePlanner\(\{\s*advanced:\s*true\s*\}\)/);
  assert.match(body, /bestExactSelectedTour\s*\(/);
  assert.ok(
    body.indexOf("bestExactSelectedTour(") > body.indexOf("if (isLeisurePlannerEnabled())"),
    "legacy optimizer call should remain after the leisure feature-flag branch"
  );
});

test("index.html includes the hidden leisure beta checkbox with the documented id", () => {
  const source = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");

  assert.match(source, /<label\b[^>]*\bhidden\b[^>]*\bid="leisureFlagWrap"/);
  assert.match(source, /<input\b[^>]*\btype="checkbox"[^>]*\bid="leisureFlag"/);
});

function baseUiOptions(overrides = {}) {
  return {
    start: START_ANDERMATT,
    targetMode: "time",
    targetValue: 7,
    targetTol: 0.2,
    themes: [],
    openOnly: false,
    osrmRoute: straightLineOsrmRoute,
    kAlternatives: 3,
    timeBudgetMs: 20,
    stopsConfig: noExtrasConfig,
    ...overrides,
  };
}

function getRealGraph() {
  realGraphPromise ??= graphModule.then(({ loadLeisureGraph }) =>
    loadLeisureGraph(path.join(repoRoot, "assets", "data", "leisure-graph.v1.json"))
  );
  return realGraphPromise;
}

function getAutoPlan() {
  autoPlanPromise ??= apiModule.then(({ leisurePlanAuto }) =>
    leisurePlanAuto(baseUiOptions({ targetMode: "time", targetValue: 7, targetTol: 0.2, seed: "integration-auto", timeBudgetMs: 100 }))
  );
  return autoPlanPromise;
}

function getSelectedPlan() {
  selectedPlanPromise ??= apiModule.then(({ leisurePlanSelected }) =>
    leisurePlanSelected(baseUiOptions({ targetMode: "time", targetValue: 6, seed: "integration-selected", timeBudgetMs: 100 }), [...SELECTED_PASS_IDS])
  );
  return selectedPlanPromise;
}

function getSelectedPoiPlan() {
  selectedPoiPlanPromise ??= apiModule.then(({ leisurePlanSelected }) =>
    leisurePlanSelected(baseUiOptions({ targetMode: "time", targetValue: 8 }), [...SELECTED_POI_IDS])
  );
  return selectedPoiPlanPromise;
}

function assertUiPlanResult(result) {
  assert.equal(typeof result, "object");
  for (const field of [
    "start",
    "tourStops",
    "modes",
    "implicitPasses",
    "scenicStops",
    "km",
    "driveH",
    "dwellH",
    "extrasH",
    "extrasParts",
    "totalH",
    "inRange",
    "advanced",
    "routeWarning",
    "statusWarning",
    "tripDate",
    "routeAlternatives",
    "totalOpen",
  ]) {
    assert.ok(Object.hasOwn(result, field), `missing UiPlanResult field ${field}`);
  }
  assert.ok(Array.isArray(result.tourStops), "tourStops should be an array");
  assert.ok(Array.isArray(result.routeAlternatives), "routeAlternatives should be an array");
  assertFiniteNumber(result.km, "km");
  assertFiniteNumber(result.driveH, "driveH");
  assertFiniteNumber(result.totalH, "totalH");
  assertTotalOpen(result.totalOpen, "totalOpen");
}

function assertLegacyTourStopsContract(result) {
  assert.ok(!result.tourStops.some((stop) => stop.id === result.start.id), "tourStops should not repeat the start");
}

function assertFiniteNumber(value, label) {
  assert.equal(typeof value, "number", `${label} should be a number`);
  assert.ok(Number.isFinite(value), `${label} should be finite`);
}

function assertTotalOpen(value, label) {
  assert.equal(Number.isInteger(value), true, `${label} should be an integer`);
  assert.ok(value >= 0, `${label} should be non-negative`);
}

function primaryStopIds(result) {
  return result.tourStops.map((stop) => stop.id);
}

function routeSummarySignature(summary) {
  return `${summary.km}|${summary.driveH}|${summary.totalH}`;
}

function resultObjectsForAlternatives(result) {
  return Array.isArray(result._routeAlternatives)
    ? result._routeAlternatives.map((alternative) => alternative.result)
    : [result];
}

function graphCountHash(graph) {
  return JSON.stringify([graph.nodes.size, graph.edges.length]);
}

async function withFakeLocalStorage(entries, fn) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage(entries);
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  try {
    return await fn(storage);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
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

  clear() {
    this.map.clear();
  }
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
    for (let step = 1; step <= 3; step += 1) {
      const t = step / 3;
      geom.push([
        previous.lon + (current.lon - previous.lon) * t,
        previous.lat + (current.lat - previous.lat) * t,
      ]);
    }
  }

  return {
    geom,
    distanceKm: round(distanceKm, 3),
    durationH: round(distanceKm / 45, 3),
  };
}

async function rejectingOsrmRoute() {
  throw new Error("synthetic OSRM outage");
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

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}
