const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const graphPath = path.join(repoRoot, "assets", "data", "leisure-graph.v1.json");
const START_BELLINZONA = "j-bellinzona";
const START_ANDERMATT = "j-andermatt";
const END_CHUR = "j-chur";
const REAL_OPEN_OPTIONS = Object.freeze({
  start: START_BELLINZONA,
  endNode: END_CHUR,
  budgetSeconds: 8 * 3600,
  seed: "a-b-real-open",
  timeBudgetMs: 20,
  iterationCap: 0,
  kAlternatives: 3,
});

const graphModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "graph.js")).href);
const earsModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "ears.js")).href);
const optimizerModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "optimizer.js")).href);
const apiModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "index.js")).href);

const realGraph = graphModule.then(({ loadLeisureGraph }) => loadLeisureGraph(graphPath));
const realDecomposition = Promise.all([realGraph, earsModule]).then(([graph, { decomposeEars }]) => ({
  graph,
  ears: decomposeEars(graph),
}));

let realOpenPlanPromise;
let uiOpenAutoPlanPromise;
let uiClosedAutoPlanPromise;
let uiSelectedPlanPromise;

test("open A-to-B real-graph tour ends at the requested endpoint", { timeout: 5_000 }, async () => {
  const { result } = await getRealOpenPlan();

  assert.equal(result.status, "ok");
  assert.ok(result.primary, "expected a primary tour");
  assert.equal(result.primary.endNode, END_CHUR);
  assert.notEqual(result.primary.endNode, START_BELLINZONA);
});

test("open A-to-B primary stops include start and end sentinels around intermediates", { timeout: 5_000 }, async () => {
  const { result } = await getRealOpenPlan();
  const stopNodeIds = stopNodeIdsOf(result.primary);
  const intermediateNodeIds = stopNodeIds.slice(1, -1);

  assert.equal(result.primary.stops[0].id, START_BELLINZONA);
  assert.equal(result.primary.stops[0].kind, "start");
  assert.equal(result.primary.stops.at(-1).id, END_CHUR);
  assert.equal(result.primary.stops.at(-1).kind, "end");
  assert.ok(!intermediateNodeIds.includes(START_BELLINZONA), "start node should not be an intermediate stop");
  assert.ok(!intermediateNodeIds.includes(END_CHUR), "end node should not be an intermediate stop");
});

test("open A-to-B excludes the start node from intermediate candidates", { timeout: 5_000 }, async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const result = planLeisureTour(graph, ears, {
    start: "poi12",
    endNode: END_CHUR,
    budgetSeconds: 8 * 3600,
    seed: "a-b-start-candidate-regression",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 1,
  });
  const intermediateStops = result.primary.stops.slice(1, -1);

  assert.ok(["ok", "degraded"].includes(result.status), `unexpected status ${result.status}`);
  assert.equal(result.primary.stops[0].id, "poi12");
  assert.equal(result.primary.stops.at(-1).id, END_CHUR);
  assert.ok(intermediateStops.every((stop) => stop.id !== "poi12" && stop.nodeId !== "poi12"));
});

test("open A-to-B edge chain begins at start and ends at endNode", { timeout: 5_000 }, async () => {
  const { graph, result } = await getRealOpenPlan();
  const edges = result.primary.edges.map((edgeId) => graph.edgeById.get(edgeId));

  assert.ok(edges.length > 0, "expected route edges");
  assert.equal(edges[0].from, START_BELLINZONA);
  assert.equal(edges.at(-1).to, END_CHUR);
  assertContiguousEdgeObjects(edges);
});

test("closed-loop default keeps the prior synthetic stop fixture unchanged", { timeout: 5_000 }, async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticClosedFixture();
  const options = { start: "base", budgetSeconds: 3600, seed: "closed-loop-fixture", timeBudgetMs: 20, iterationCap: 0, kAlternatives: 1 };
  const omitted = planLeisureTour(graph, ears, options);
  const explicitNull = planLeisureTour(graph, ears, { ...options, endNode: null });
  const expectedStopIds = ["base", "lake-poi", "east-pass", "north-pass", "base"];

  assert.equal(omitted.status, "ok");
  assert.deepEqual(stopIdsOf(omitted.primary), expectedStopIds);
  assert.deepEqual(stopIdsOf(explicitNull.primary), expectedStopIds);
});

test("endNode equal to start is treated as a closed loop", { timeout: 5_000 }, async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticChoiceFixture();
  const result = planLeisureTour(graph, ears, {
    start: "base",
    endNode: "base",
    budgetSeconds: 3600,
    seed: "same-start-closed",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 1,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.diagnostics.openTrip, false);
  assert.equal(result.primary.endNode, "base");
  assert.equal(result.primary.stops.at(-1).returnToStart, true);
});

test("synthetic pass-summit endNode resolves to a pass base endpoint", { timeout: 5_000 }, async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const result = planLeisureTour(graph, ears, {
    start: START_ANDERMATT,
    endNode: "p-furkapass:S",
    budgetSeconds: 6 * 3600,
    seed: "p-furka-snap",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 1,
  });

  assert.ok(["ok", "degraded"].includes(result.status), `unexpected status ${result.status}`);
  assert.match(result.primary.endNode, /^(?:p-)?furkapass:[AB]$/);
});

test("ad-hoc end points snap within 30km and fail cleanly outside the snap radius", { timeout: 5_000 }, async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticSnapFixture();

  const near = planLeisureTour(graph, ears, {
    start: "start",
    endNode: { lat: 46.105, lon: 8.105, name: "ad-hoc end" },
    budgetSeconds: 1800,
    seed: "adhoc-near",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 1,
  });
  assert.ok(["ok", "degraded"].includes(near.status));
  assert.equal(near.primary.endNode, "finish");
  assert.equal(near.diagnostics.end.snapped, true);
  assert.ok(near.diagnostics.end.snapDistanceM <= 30_000);

  const far = planLeisureTour(graph, ears, {
    start: "start",
    endNode: { lat: 0, lon: 0, name: "too far" },
    budgetSeconds: 1800,
    seed: "adhoc-far",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 1,
  });
  assert.equal(far.status, "infeasible");
  assert.equal(far.diagnostics.reason, "end-snap-failed");

  const capped = planLeisureTour(graph, ears, {
    start: "start",
    endNode: { lat: 46.105, lon: 8.105, name: "ad-hoc end" },
    endSnapMaxDistanceM: 1,
    budgetSeconds: 1800,
    seed: "adhoc-capped",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 1,
  });
  assert.equal(capped.status, "infeasible");
  assert.equal(capped.diagnostics.reason, "end-snap-failed");
  assert.equal(capped.diagnostics.snapMaxDistanceM, 1);
});

test("nonexistent endNode returns an endpoint-specific infeasible reason", { timeout: 5_000 }, async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticSnapFixture();
  const result = planLeisureTour(graph, ears, {
    start: "start",
    endNode: "nonexistent-id",
    budgetSeconds: 1800,
    seed: "missing-end-id",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 1,
  });

  assert.equal(result.status, "infeasible");
  assert.ok(
    ["end-unreachable", "end-snap-failed"].includes(result.diagnostics.reason),
    `unexpected reason ${result.diagnostics.reason}`
  );
});

test("open A-to-B optimization stays within a small closed-loop overhead", { timeout: 5_000 }, async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticChoiceFixture();
  const options = { start: "base", budgetSeconds: 3600, seed: "elapsed-compare", timeBudgetMs: 20, iterationCap: 0, kAlternatives: 1 };
  planLeisureTour(graph, ears, { ...options, seed: "elapsed-warmup", endNode: "finish" });
  const closed = planLeisureTour(graph, ears, options);
  const open = planLeisureTour(graph, ears, { ...options, endNode: "finish" });

  assert.equal(open.status, "ok");
  assert.equal(closed.status, "ok");
  assert.ok(open.elapsedMs <= closed.elapsedMs + 20, `open ${open.elapsedMs}ms, closed ${closed.elapsedMs}ms`);
});

test("same seed yields identical open A-to-B primary stops and edges", { timeout: 5_000 }, async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticChoiceFixture();
  const options = {
    start: "base",
    endNode: "finish",
    budgetSeconds: 3600,
    seed: "a-b-deterministic",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 2,
  };
  const first = planLeisureTour(graph, ears, options);
  const second = planLeisureTour(graph, ears, options);

  assert.deepEqual(stopIdsOf(second.primary), stopIdsOf(first.primary));
  assert.deepEqual(second.primary.edges, first.primary.edges);
});

test("open A-to-B uses budget slack for at least two intermediate stops", { timeout: 5_000 }, async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticChoiceFixture();
  const result = planLeisureTour(graph, ears, {
    start: "base",
    endNode: "finish",
    budgetSeconds: 3600,
    seed: "a-b-nondegenerate",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 1,
  });
  const intermediates = result.primary.stops.filter((stop) => !["base", "finish"].includes(stop.nodeId ?? stop.id));

  assert.equal(result.status, "ok");
  assert.ok(intermediates.length >= 2, `expected at least two intermediate stops, got ${intermediates.map((s) => s.id).join(",")}`);
});

test("very tight open A-to-B budget degrades instead of becoming infeasible", { timeout: 5_000 }, async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticTightBudgetFixture();
  const direct = graph.edgeBetween("start", "finish");
  const result = planLeisureTour(graph, ears, {
    start: "start",
    endNode: "finish",
    budgetSeconds: direct.durationS,
    seed: "a-b-tight",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 1,
  });
  const reasons = [result.diagnostics.reason, ...(result.diagnostics.degradedReasons || [])].filter(Boolean).join("|");

  assert.equal(result.status, "degraded");
  assert.notEqual(result.status, "infeasible");
  assert.match(reasons, /budget|tight|no-pass-fit/i);
});

test("p-prefixed forbidden Furka pass propagates through A-to-B planning", { timeout: 5_000 }, async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const result = planLeisureTour(graph, ears, {
    start: START_ANDERMATT,
    endNode: END_CHUR,
    budgetSeconds: 8 * 3600,
    forbiddenPassIds: new Set(["p-furkapass"]),
    seed: "a-b-forbid-furka",
    timeBudgetMs: 20,
    iterationCap: 0,
    kAlternatives: 1,
  });
  const pathPassIds = new Set((result.primary?.path || []).map((nodeId) => graph.passIdByNodeId.get(nodeId)).filter(Boolean));

  assert.ok(result.diagnostics.forbiddenPassIds.includes("furkapass"), "Furka should be normalized into forbiddenPassIds");
  assert.ok(!stopIdsOf(result.primary).includes("furkapass"), "Furka should not appear as an explicit stop");
  assert.ok(!pathPassIds.has("furkapass"), "connector path should not traverse Furka");
});

test("leisurePlanAuto exposes endNode for open and closed UiPlanResult calls", { timeout: 5_000 }, async () => {
  const open = await getUiOpenAutoPlan();
  const closed = await getUiClosedAutoPlan();

  assert.equal(open.endNode, END_CHUR);
  assert.notEqual(open.endNode, open.start.id);
  assert.equal(closed.endNode, closed.start.id);
});

test("leisurePlanSelected supports selected stops with an explicit open endpoint", { timeout: 5_000 }, async () => {
  const result = await getUiSelectedPlan();
  const stopIds = result.tourStops.map((stop) => stop.id);

  assert.equal(result.status, "ok");
  assert.equal(result.advanced, true);
  assert.equal(result.endNode, END_CHUR);
  assert.ok(stopIds.includes("grimselpass"));
  assert.ok(stopIds.includes("sustenpass"));
});

test("open A-to-B route alternatives share endpoints but differ by route summary", { timeout: 5_000 }, async () => {
  const result = await getUiSelectedPlan();
  const alternatives = result._routeAlternatives.map((alternative) => alternative.result);
  const signatures = new Set(alternatives.map((alt) => `${alt.tourStops.map((stop) => stop.id).join(">")}|${alt.km}|${alt.driveH}`));

  assert.ok(alternatives.length >= 2, "expected primary plus at least one alternative");
  for (const alternative of alternatives) {
    assert.equal(alternative.start.id, result.start.id);
    assert.equal(alternative.endNode, END_CHUR);
  }
  assert.equal(signatures.size, alternatives.length);
});

test("app.js localStorage endNode override is passed into leisure planner options", async () => {
  const source = fs.readFileSync(path.join(repoRoot, "assets", "js", "app.js"), "utf8");
  const planTourBody = sourceBetween(source, "async function planTour()", "  const targetMode");
  assert.match(planTourBody, /if\s*\(\s*isLeisurePlannerEnabled\(\)\s*\)/);
  assert.match(planTourBody, /runLeisurePlanner\(\{\s*advanced:\s*!!advancedModeEl\.checked\s*\}\)/);

  const sandbox = {
    console,
    localStorage: new MemoryStorage({
      "alpine.planner.leisure.v1": "1",
      "alpine.planner.endNode": END_CHUR,
    }),
    window: { osrmRoute: async () => ({}) },
  };
  const snippet = sourceBetween(source, "function currentLeisureEndNodeOverride", "async function planSelectedTour()");
  vm.runInNewContext(`
const ADVANCED_MAX_STOPS = 10;
const advancedModeEl = { checked: false };
const openOnlyEl = { checked: false };
const includePoisEl = { checked: false };
const allowedPoiThemes = new Set();
const activePresetIds = new Set();
const osrmRoute = async () => ({});
function currentStart() { return { id: "${START_BELLINZONA}", lat: 46.1946, lon: 9.0244, name: "Bellinzona" }; }
function selectedAdvancedStops() { return []; }
function clearPlannedTour() {}
function setPlannerBusy(label) { globalThis.__busyLabel = label; }
function showPlanResult(result) { globalThis.__shownResult = result; }
function setPlannedRouteAlternatives(alternatives) { globalThis.__plannedAlternatives = alternatives; }
function activateRouteAlternative(index) { globalThis.__activeAlternative = index; }
function drawPlannedTour() {}
function resetPlanButton() {}
function planTargetMode() { return "time"; }
function planTargetValue() { return 8; }
function planTargetTolerance() { return 0.2; }
function currentTripDate() { return null; }
function currentStopsConfig() { return {}; }
function leisureForbiddenPassIds() { return []; }
function poiMinScoreVal() { return 0; }
function poiMaxCountVal() { return 0; }
    async function loadLeisurePlannerModule() {
  return {
    LEISURE_PLANNER_END_NODE_KEY: "alpine.planner.endNode",
    leisurePlanAuto: async (options) => {
      globalThis.__capturedOptions = options;
      return { status: "ok", _routeAlternatives: [] };
    },
    leisurePlanSelected: async () => {
      throw new Error("unexpected selected planner call");
    },
  };
}
${snippet}
globalThis.__runLeisurePlanner = runLeisurePlanner;
`, sandbox, { filename: "assets/js/app.js" });

  await sandbox.__runLeisurePlanner({ advanced: false });

  assert.equal(sandbox.__capturedOptions.endNode, END_CHUR);
});

function getRealOpenPlan() {
  realOpenPlanPromise ??= Promise.all([realDecomposition, optimizerModule]).then(([{ graph, ears }, { planLeisureTour }]) => ({
    graph,
    result: planLeisureTour(graph, ears, REAL_OPEN_OPTIONS),
  }));
  return realOpenPlanPromise;
}

function getUiOpenAutoPlan() {
  uiOpenAutoPlanPromise ??= apiModule.then(({ leisurePlanAuto }) => leisurePlanAuto(uiOptions({
    start: START_BELLINZONA,
    endNode: END_CHUR,
    budgetSeconds: 6200,
    targetValue: 2,
    seed: "ui-a-b-open",
    kAlternatives: 1,
    timeBudgetMs: 20,
  })));
  return uiOpenAutoPlanPromise;
}

function getUiClosedAutoPlan() {
  uiClosedAutoPlanPromise ??= apiModule.then(({ leisurePlanAuto }) => leisurePlanAuto(uiOptions({
    start: START_BELLINZONA,
    budgetSeconds: 60,
    targetValue: 1,
    seed: "ui-a-b-closed",
    kAlternatives: 1,
    timeBudgetMs: 20,
  })));
  return uiClosedAutoPlanPromise;
}

function getUiSelectedPlan() {
  uiSelectedPlanPromise ??= apiModule.then(({ leisurePlanSelected }) => leisurePlanSelected(uiOptions({
    start: START_ANDERMATT,
    endNode: END_CHUR,
    budgetSeconds: 10 * 3600,
    targetValue: 10,
    seed: "ui-a-b-selected",
    kAlternatives: 3,
    timeBudgetMs: 20,
  }), ["grimselpass", "sustenpass"]));
  return uiSelectedPlanPromise;
}

function uiOptions(overrides = {}) {
  return {
    targetMode: "time",
    targetValue: 8,
    targetTol: 0.2,
    openOnly: false,
    themes: [],
    stopsConfig: {
      passStopMin: 0,
      lunchBreak: "none",
      restBreakOn: false,
      restInterval: 0,
      restDuration: 0,
    },
    osrmRoute: straightLineOsrmRoute,
    ...overrides,
  };
}

async function syntheticChoiceFixture() {
  const [{ planLeisureTour }, { decomposeEars }, graph] = await Promise.all([
    optimizerModule,
    earsModule,
    makeGraph([
      node("base", "junction", 0),
      node("finish", "junction", 5),
      node("north-pass", "pass", 1, { scenicScore: 0.9, themes: ["panoramic-view"] }),
      node("east-pass", "pass", 2, { scenicScore: 0.85, themes: ["historic"] }),
      node("lake-poi", "poi", 3, { score: 0.8, themes: ["alpine-lake"] }),
    ], [
      ...bidirectional("base", "north-pass", { durationS: 400, distanceM: 8000, leisureCost: 20 }),
      ...bidirectional("north-pass", "east-pass", { durationS: 400, distanceM: 8000, leisureCost: 20 }),
      ...bidirectional("east-pass", "lake-poi", { durationS: 400, distanceM: 8000, leisureCost: 20 }),
      ...bidirectional("lake-poi", "base", { durationS: 400, distanceM: 8000, leisureCost: 20 }),
      ...bidirectional("lake-poi", "finish", { durationS: 400, distanceM: 8000, leisureCost: 20 }),
      ...bidirectional("east-pass", "finish", { durationS: 500, distanceM: 9000, leisureCost: 20 }),
      ...bidirectional("base", "finish", { durationS: 900, distanceM: 15000, leisureCost: 50 }),
      ...bidirectional("base", "east-pass", { durationS: 800, distanceM: 12000, leisureCost: 35 }),
    ]),
  ]);
  return [{ planLeisureTour }, graph, decomposeEars(graph)];
}

async function syntheticClosedFixture() {
  const [{ planLeisureTour }, { decomposeEars }, graph] = await Promise.all([
    optimizerModule,
    earsModule,
    makeGraph([
      node("base", "junction", 0),
      node("north-pass", "pass", 1, { scenicScore: 0.9, themes: ["panoramic-view"] }),
      node("east-pass", "pass", 2, { scenicScore: 0.85, themes: ["historic"] }),
      node("lake-poi", "poi", 3, { score: 0.8, themes: ["alpine-lake"] }),
    ], [
      ...bidirectional("base", "north-pass", { durationS: 500, distanceM: 8000, leisureCost: 20 }),
      ...bidirectional("north-pass", "east-pass", { durationS: 500, distanceM: 8000, leisureCost: 20 }),
      ...bidirectional("east-pass", "lake-poi", { durationS: 500, distanceM: 8000, leisureCost: 20 }),
      ...bidirectional("lake-poi", "base", { durationS: 500, distanceM: 8000, leisureCost: 20 }),
      ...bidirectional("base", "east-pass", { durationS: 800, distanceM: 12000, leisureCost: 35 }),
    ]),
  ]);
  return [{ planLeisureTour }, graph, decomposeEars(graph)];
}

async function syntheticSnapFixture() {
  const [{ planLeisureTour }, { decomposeEars }, graph] = await Promise.all([
    optimizerModule,
    earsModule,
    makeGraph([
      node("start", "junction", 0),
      node("finish", "junction", 10),
      node("view-pass", "pass", 4, { scenicScore: 0.7 }),
    ], [
      ...bidirectional("start", "finish", { durationS: 600, distanceM: 10000, leisureCost: 10 }),
      ...bidirectional("start", "view-pass", { durationS: 500, distanceM: 8000, leisureCost: 10 }),
      ...bidirectional("view-pass", "finish", { durationS: 500, distanceM: 8000, leisureCost: 10 }),
    ]),
  ]);
  return [{ planLeisureTour }, graph, decomposeEars(graph)];
}

async function syntheticTightBudgetFixture() {
  const [{ planLeisureTour }, { decomposeEars }, graph] = await Promise.all([
    optimizerModule,
    earsModule,
    makeGraph([
      node("start", "junction", 0),
      node("finish", "junction", 2),
      node("slow-pass", "pass", 1, { scenicScore: 0.95 }),
    ], [
      ...bidirectional("start", "finish", { durationS: 600, distanceM: 9000, leisureCost: 10 }),
      ...bidirectional("start", "slow-pass", { durationS: 500, distanceM: 8000, leisureCost: 10 }),
      ...bidirectional("slow-pass", "finish", { durationS: 500, distanceM: 8000, leisureCost: 10 }),
    ]),
  ]);
  return [{ planLeisureTour }, graph, decomposeEars(graph)];
}

async function makeGraph(nodes, edges) {
  const { LeisureGraph } = await graphModule;
  return new LeisureGraph({
    version: "test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    stats: { nodes: nodes.length, edges: edges.length },
    nodes,
    edges,
  });
}

function node(id, kind, index, extra = {}) {
  return {
    id,
    kind,
    name: id,
    lat: 46 + index * 0.01,
    lon: 8 + index * 0.01,
    ...extra,
  };
}

function bidirectional(a, b, opts = {}) {
  return [edge(a, b, opts), edge(b, a, opts)];
}

function edge(from, to, opts = {}) {
  return {
    id: `${from}->${to}`,
    from,
    to,
    kind: "connector",
    distanceM: 1000,
    durationS: 60,
    leisureCost: 1,
    season: "all",
    ...opts,
  };
}

function stopIdsOf(tour) {
  return (tour?.stops || []).map((stop) => stop.id);
}

function stopNodeIdsOf(tour) {
  return (tour?.stops || []).map((stop) => stop.nodeId ?? stop.id);
}

function assertContiguousEdgeObjects(edges) {
  let previousTo = null;
  for (const [index, edgeObject] of edges.entries()) {
    assert.ok(edgeObject, `missing edge at ${index}`);
    if (index > 0) assert.equal(edgeObject.from, previousTo);
    previousTo = edgeObject.to;
  }
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
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
  const geom = points.map((point) => [point.lon, point.lat]);
  let distanceKm = 0;
  for (let i = 1; i < points.length; i += 1) distanceKm += haversineKm(points[i - 1], points[i]);
  return { geom, distanceKm, durationH: distanceKm / 55 };
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toRad(value) {
  return value * Math.PI / 180;
}
