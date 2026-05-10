const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const graphPath = path.join(repoRoot, "assets", "data", "leisure-graph.v1.json");
const graphModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "graph.js")).href);
const earsModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "ears.js")).href);
const optimizerModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "optimizer.js")).href);
const realGraph = graphModule.then(({ loadLeisureGraph }) => loadLeisureGraph(graphPath));
const realDecomposition = Promise.all([realGraph, earsModule]).then(([graph, { decomposeEars }]) => ({
  graph,
  ears: decomposeEars(graph),
}));

test("planLeisureTour returns the public result and primary tour metric shape", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const result = planLeisureTour(graph, ears, baselineOptions({ timeBudgetMs: 160, kAlternatives: 3 }));

  assertResultShape(result);
  assertPrimaryShape(result.primary);
});

test("auto primary stop sequence starts and ends at the selected base", async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticChoiceFixture();
  const result = planLeisureTour(graph, ears, { start: "base", budgetSeconds: 3600, seed: "closed", timeBudgetMs: 120 });

  assert.equal(result.status, "ok");
  assert.ok(result.primary.stops.length > 1);
  assert.equal(result.primary.stops[0].id, "base");
  assert.equal(result.primary.stops.at(-1).id, "base");
  assert.equal(result.primary.stops.at(-1).returnToStart, true);
});

test("closed-loop primary repeats the start nodeId as the terminal stop", async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticChoiceFixture();
  const result = planLeisureTour(graph, ears, { start: "base", budgetSeconds: 3600, seed: "closed-node", timeBudgetMs: 120 });

  assert.equal(result.status, "ok");
  assert.ok(result.primary.stops.length > 1);
  assert.equal(result.primary.stops[0].nodeId, result.primary.stops.at(-1).nodeId);
});

test("auto primary edges are a contiguous chain of valid graph edges", async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticChoiceFixture();
  const result = planLeisureTour(graph, ears, { start: "base", budgetSeconds: 3600, seed: "chain", timeBudgetMs: 120 });

  assert.equal(result.status, "ok");
  assertContiguousEdges(graph, result.primary);
});

test("auto duration stays within ten percent of the supplied seconds budget", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const budgetSeconds = 8 * 3600;
  const result = planLeisureTour(graph, ears, baselineOptions({ budgetSeconds, timeBudgetMs: 180 }));

  assert.ok(result.primary.totalDurationH * 3600 <= budgetSeconds * 1.10);
});

test("route alternatives are distinct from primary and from each other by stop and edge sets", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const result = planLeisureTour(graph, ears, baselineOptions({ seed: 33, timeBudgetMs: 120, kAlternatives: 4 }));
  const primaryKey = tourSetKey(result.primary);
  const alternativeKeys = result.alternatives.map(tourSetKey);

  assert.ok(alternativeKeys.every((key) => key !== primaryKey), "primary should not be repeated as an alternative");
  assert.equal(new Set(alternativeKeys).size, alternativeKeys.length, "alternatives should be mutually distinct");
});

test("route alternatives are bounded by kAlternatives minus the primary", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const kAlternatives = 4;
  const result = planLeisureTour(graph, ears, baselineOptions({ seed: 33, timeBudgetMs: 80, kAlternatives }));

  assert.ok(
    result.alternatives.length <= kAlternatives - 1,
    `expected at most ${kAlternatives - 1} alternatives, got ${result.alternatives.length}`
  );
});

test("same seed and same real input produce identical score and stop sequence", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const options = baselineOptions({ seed: 42, timeBudgetMs: 5000, kAlternatives: 3 });
  const first = planLeisureTour(graph, ears, options);
  const second = planLeisureTour(graph, ears, options);

  assert.equal(first.diagnostics.searchBound.mode, "iterations");
  assert.equal(second.diagnostics.searchBound.mode, "iterations");
  assert.ok(first.primary && second.primary);
  assert.equal(second.primary.score, first.primary.score);
  assert.deepEqual(stopNodeIds(second.primary), stopNodeIds(first.primary));
});

test("timeBudgetMs 50 returns a feasible first real-graph solution quickly", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const started = performance.now();
  const result = planLeisureTour(graph, ears, { start: "j-andermatt", budgetSeconds: 8 * 3600, timeBudgetMs: 50, kAlternatives: 1 });
  const elapsedMs = performance.now() - started;

  assert.ok(["ok", "degraded"].includes(result.status), `unexpected status ${result.status}`);
  assert.notEqual(result.status, "infeasible");
  assertPrimaryShape(result.primary);
  assert.ok(elapsedMs <= 150, `expected around an 80ms wall-time first solution, got ${elapsedMs.toFixed(3)}ms`);
});

test("longer anytime refinement does not increase total leisure cost on a stable small graph", async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticSinglePassFixture();
  const options = { start: "base", budgetSeconds: 2400, seed: "anytime", kAlternatives: 1 };
  const quick = planLeisureTour(graph, ears, { ...options, timeBudgetMs: 50 });
  const refined = planLeisureTour(graph, ears, { ...options, timeBudgetMs: 800 });

  assert.equal(quick.status, "ok");
  assert.equal(refined.status, "ok");
  assert.ok(refined.primary.totalLeisureCost <= quick.primary.totalLeisureCost);
});

test("reported diagnostics checkpoints are feasible when the optimizer exposes them", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const result = planLeisureTour(graph, ears, baselineOptions({ seed: 19, timeBudgetMs: 120 }));
  const checkpoints = result.diagnostics.checkpoints ?? result.diagnostics.anytimeCheckpoints ?? [];

  assert.ok(Array.isArray(checkpoints));
  for (const checkpoint of checkpoints) {
    const tour = checkpoint.primary ?? checkpoint.tour ?? checkpoint;
    assert.ok(tour.budgetFit?.within, `checkpoint should be budget-feasible: ${JSON.stringify(checkpoint)}`);
    assert.ok(tour.stops?.length >= 1, "checkpoint should expose at least the start stop");
    if (tour.edges) assertContiguousEdges(graph, tour);
  }
});

test("same seed and same synthetic input produce identical primary tour structure", async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticChoiceFixture();
  const options = { start: "base", budgetSeconds: 3600, seed: "stable", timeBudgetMs: 200, iterationCap: 20, kAlternatives: 2 };
  const first = planLeisureTour(graph, ears, options);
  const second = planLeisureTour(graph, ears, options);

  assert.deepEqual(tourStructure(second.primary), tourStructure(first.primary));
});

test("different seeds keep synthetic tour scores within five percent", async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticSymmetricFixture();
  const options = { start: "base", budgetSeconds: 1200, timeBudgetMs: 120, iterationCap: 20, kAlternatives: 1 };
  const left = planLeisureTour(graph, ears, { ...options, seed: 1 });
  const right = planLeisureTour(graph, ears, { ...options, seed: 2 });
  const denominator = Math.max(1, Math.abs(left.primary.score), Math.abs(right.primary.score));
  const ratio = Math.abs(left.primary.score - right.primary.score) / denominator;

  assert.ok(ratio <= 0.05, `seed scores diverged by ${(ratio * 100).toFixed(2)}%`);
});

test("food-drink theme increases average food-drink POI stops over baseline", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const seeds = [101, 102, 103, 104, 105];
  const options = { start: "j-andermatt", budgetSeconds: 6 * 3600, timeBudgetMs: 5000, iterationCap: 0, kAlternatives: 1 };
  const baselineAverage = mean(seeds.map((seed) => foodDrinkPoiStops(planLeisureTour(graph, ears, { ...options, seed }))));
  const themedAverage = mean(seeds.map((seed) => foodDrinkPoiStops(planLeisureTour(graph, ears, { ...options, seed, themes: ["food-drink"] }))));

  assert.ok(themedAverage > baselineAverage, `expected food-drink average to increase (${baselineAverage} -> ${themedAverage})`);
});

test("theme matching normalizes case and whitespace", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const options = baselineOptions({ seed: 123, timeBudgetMs: 5000, iterationCap: 0, kAlternatives: 1 });
  const canonical = planLeisureTour(graph, ears, { ...options, themes: ["panoramic-view", "iconic"] });
  const noisy = planLeisureTour(graph, ears, { ...options, themes: ["PANORAMIC-VIEW", " iconic "] });
  const canonicalStops = passStopIds(canonical.primary);
  const noisyStops = passStopIds(noisy.primary);
  const overlap = stopOverlapRatio(canonicalStops, noisyStops);

  assert.ok(canonicalStops.length > 0, "expected at least one themed pass stop");
  assert.ok(overlap >= 0.9, `expected at least 90% pass-stop overlap, got ${(overlap * 100).toFixed(1)}%`);
});

test("motorcyclist persona does not crash and produces finite metrics", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const result = planLeisureTour(graph, ears, baselineOptions({ personas: ["motorcyclist"], seed: 88, timeBudgetMs: 140 }));

  assert.ok(["ok", "degraded"].includes(result.status));
  assertFiniteMetrics(result.primary);
});

test("forbiddenPassIds excludes Furkapass from auto primary stops", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const result = planLeisureTour(graph, ears, baselineOptions({
    forbiddenPassIds: new Set(["furkapass"]),
    seed: 7,
    timeBudgetMs: 140,
  }));
  const stopIds = result.primary.stops.map((stop) => stop.id);

  assert.equal(result.status, "ok");
  assert.ok(!stopIds.includes("furkapass"));
  assert.ok(result.primary.stops.every((stop) => stop.passId !== "furkapass"));
});

test("forbidding all real passes returns cleanly with only non-pass primary stops or infeasible", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const forbiddenPassIds = new Set((graph.nodesByKind.get("pass") ?? []).map((node) => node.id));
  const result = planLeisureTour(graph, ears, {
    start: "j-andermatt",
    budgetSeconds: 6 * 3600,
    forbiddenPassIds,
    seed: 7,
    timeBudgetMs: 140,
    kAlternatives: 1,
  });

  assert.ok(["ok", "degraded", "infeasible"].includes(result.status));
  if (result.primary) {
    assert.ok(result.primary.stops.every((stop) => stop.kind !== "pass" && !stop.passId));
  }
});

test("unknown forbiddenPassIds are ignored without blocking real nodes", async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticChoiceFixture();
  const options = { start: "base", budgetSeconds: 3600, seed: "unknown-forbidden", timeBudgetMs: 5000, kAlternatives: 1 };
  const baseline = planLeisureTour(graph, ears, options);
  const result = planLeisureTour(graph, ears, { ...options, forbiddenPassIds: new Set(["nonexistent-id"]) });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.diagnostics.forbiddenPassIds, []);
  assert.equal(result.diagnostics.forbiddenNodeCount, 0);
  assert.deepEqual(stopNodeIds(result.primary), stopNodeIds(baseline.primary));
});

test("advanced mode includes all selected hero must-visit passes", async () => {
  const [{ graph, ears }, { planLeisureTourAdvanced }] = await Promise.all([realDecomposition, optimizerModule]);
  const mustVisitIds = ["furkapass", "grimselpass", "sustenpass"];
  const result = planLeisureTourAdvanced(graph, ears, mustVisitIds, baselineOptions({ seed: 9, timeBudgetMs: 200, kAlternatives: 1 }));
  const stopIds = new Set(result.primary.stops.map((stop) => stop.id));

  assert.equal(result.status, "ok");
  for (const passId of mustVisitIds) assert.ok(stopIds.has(passId), `${passId} should be included`);
});

test("advanced mode with an unreachable must-visit returns infeasible cleanly", async () => {
  const [{ planLeisureTourAdvanced }, graph, ears] = await syntheticDisconnectedFixture();
  const result = planLeisureTourAdvanced(graph, ears, ["reachable-pass", "isolated-pass"], {
    start: "base",
    budgetSeconds: 3600,
    seed: "blocked",
    timeBudgetMs: 120,
  });

  assert.equal(result.status, "infeasible");
  assert.equal(result.primary, null);
  assert.ok(["unreachable-must-visits", "invalid-must-visit"].includes(result.diagnostics.reason));
});

test("advanced mode with too-small budget for must-visits degrades or returns infeasible without crashing", async () => {
  const [{ graph, ears }, { planLeisureTourAdvanced }] = await Promise.all([realDecomposition, optimizerModule]);
  const result = planLeisureTourAdvanced(graph, ears, ["furkapass", "grimselpass", "sustenpass"], {
    start: "j-andermatt",
    budgetSeconds: 1800,
    seed: 5,
    timeBudgetMs: 140,
  });

  assert.ok(["degraded", "infeasible"].includes(result.status), `unexpected status ${result.status}`);
});

test("baseline Swiss auto plans keep retracedConnectorCount at one or less in at least four of five seeds", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const retraceCounts = [11, 12, 13, 14, 15].map((seed) => planLeisureTour(graph, ears, {
    start: "j-andermatt",
    budgetSeconds: 8 * 3600,
    seed,
    timeBudgetMs: 120,
    kAlternatives: 1,
  }).primary.retracedConnectorCount);

  assert.ok(retraceCounts.filter((count) => count <= 1).length >= 4, `retraces: ${retraceCounts.join(", ")}`);
});

test("forced retrace topology reports the retraced connector count instead of zero", async () => {
  const [{ planLeisureTourAdvanced }, graph, ears] = await syntheticLineRetraceFixture();
  const result = planLeisureTourAdvanced(graph, ears, ["near-pass", "far-pass"], {
    start: "base",
    budgetSeconds: 3600,
    seed: "retrace",
    timeBudgetMs: 120,
  });
  const expected = countRetracedConnectors(graph, result.primary.edges);

  assert.equal(result.status, "ok");
  assert.ok(expected > 0);
  assert.equal(result.primary.retracedConnectorCount, expected);
});

test("planLeisureTour default real-graph planning completes within 1500ms", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const started = performance.now();
  const result = planLeisureTour(graph, ears, { start: "j-andermatt", budgetSeconds: 8 * 3600 });
  const elapsedMs = performance.now() - started;

  assert.ok(["ok", "degraded"].includes(result.status));
  assert.ok(elapsedMs <= 1500, `planLeisureTour default took ${elapsedMs.toFixed(3)}ms`);
});

test("planLeisureTourAdvanced with five must-visits completes within 1500ms", async () => {
  const [{ graph, ears }, { planLeisureTourAdvanced }] = await Promise.all([realDecomposition, optimizerModule]);
  const mustVisitIds = ["furkapass", "grimselpass", "sustenpass", "nufenenpass-passo-della-novena", "oberalppass"];
  const started = performance.now();
  const result = planLeisureTourAdvanced(graph, ears, mustVisitIds, { start: "j-andermatt", budgetSeconds: 12 * 3600 });
  const elapsedMs = performance.now() - started;

  assert.ok(["ok", "degraded"].includes(result.status));
  assert.ok(elapsedMs <= 1500, `planLeisureTourAdvanced five-stop plan took ${elapsedMs.toFixed(3)}ms`);
});

test("budgetKm mode constrains primary distance within ten percent", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const budgetKm = 160;
  const result = planLeisureTour(graph, ears, {
    start: "j-andermatt",
    budgetKm,
    seed: 7,
    timeBudgetMs: 140,
    kAlternatives: 1,
  });

  assert.equal(result.status, "ok");
  assert.ok(result.primary.totalDistanceKm <= budgetKm * 1.10);
});

test("setting both budgetSeconds and budgetKm returns invalid-budget infeasible", async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticSinglePassFixture();
  const result = planLeisureTour(graph, ears, { start: "base", budgetSeconds: 2400, budgetKm: 40, seed: "two-budgets" });

  assert.equal(result.status, "infeasible");
  assert.equal(result.primary, null);
  assert.equal(result.diagnostics.reason, "invalid-budget");
});

test("non-existent start id returns missing-start infeasible", async () => {
  const [{ planLeisureTour }, graph, ears] = await syntheticSinglePassFixture();
  const result = planLeisureTour(graph, ears, { start: "fake-id", budgetSeconds: 2400, seed: "missing-start" });

  assert.equal(result.status, "infeasible");
  assert.equal(result.primary, null);
  assert.equal(result.diagnostics.reason, "missing-start");
});

test("winter seasonal cutoff keeps primary route off summer-only edges", async () => {
  const [{ graph, ears }, { planLeisureTour }] = await Promise.all([realDecomposition, optimizerModule]);
  const result = planLeisureTour(graph, ears, baselineOptions({
    seasonalCutoff: "2026-12-25",
    seed: 7,
    timeBudgetMs: 160,
    kAlternatives: 1,
  }));

  assert.equal(result.diagnostics.seasonalMask.active, true);
  assert.equal(result.diagnostics.seasonalMask.inSummer, false);
  if (!result.primary) {
    assert.equal(result.status, "degraded");
    assert.ok(result.diagnostics.forbiddenEdgeCount > 0);
    return;
  }
  for (const edgeId of result.primary.edges) {
    const edge = graph.edgeById.get(edgeId);
    assert.ok(edge, `missing edge ${edgeId}`);
    assert.ok(isWinterAllowed(edge), `${edgeId} has winter-blocked season ${edge.season}`);
  }
});

function baselineOptions(extra = {}) {
  return {
    start: "j-andermatt",
    budgetSeconds: 8 * 3600,
    seed: 42,
    kAlternatives: 3,
    ...extra,
  };
}

async function syntheticChoiceFixture() {
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

async function syntheticSinglePassFixture() {
  const [{ planLeisureTour }, { decomposeEars }, graph] = await Promise.all([
    optimizerModule,
    earsModule,
    makeGraph([
      node("base", "junction", 0),
      node("view-pass", "pass", 1, { scenicScore: 0.95 }),
    ], bidirectional("base", "view-pass", { durationS: 600, distanceM: 10000, leisureCost: 25 })),
  ]);
  return [{ planLeisureTour }, graph, decomposeEars(graph)];
}

async function syntheticSymmetricFixture() {
  const [{ planLeisureTour }, { decomposeEars }, graph] = await Promise.all([
    optimizerModule,
    earsModule,
    makeGraph([
      node("base", "junction", 0),
      node("left-pass", "pass", 1, { scenicScore: 0.9 }),
      node("right-pass", "pass", 2, { scenicScore: 0.9 }),
    ], [
      ...bidirectional("base", "left-pass", { durationS: 600, distanceM: 9000, leisureCost: 20 }),
      ...bidirectional("base", "right-pass", { durationS: 600, distanceM: 9000, leisureCost: 20 }),
      ...bidirectional("left-pass", "right-pass", { durationS: 600, distanceM: 9000, leisureCost: 20 }),
    ]),
  ]);
  return [{ planLeisureTour }, graph, decomposeEars(graph)];
}

async function syntheticDisconnectedFixture() {
  const [{ planLeisureTourAdvanced }, { decomposeEars }, graph] = await Promise.all([
    optimizerModule,
    earsModule,
    makeGraph([
      node("base", "junction", 0),
      node("reachable-pass", "pass", 1, { scenicScore: 0.8 }),
      node("isolated-pass", "pass", 2, { scenicScore: 0.8 }),
    ], bidirectional("base", "reachable-pass", { durationS: 600, distanceM: 9000, leisureCost: 20 })),
  ]);
  return [{ planLeisureTourAdvanced }, graph, decomposeEars(graph)];
}

async function syntheticLineRetraceFixture() {
  const [{ planLeisureTourAdvanced }, { decomposeEars }, graph] = await Promise.all([
    optimizerModule,
    earsModule,
    makeGraph([
      node("base", "junction", 0),
      node("near-pass", "pass", 1, { scenicScore: 0.8 }),
      node("far-pass", "pass", 2, { scenicScore: 0.8 }),
    ], [
      ...bidirectional("base", "near-pass", { durationS: 500, distanceM: 9000, leisureCost: 20 }),
      ...bidirectional("near-pass", "far-pass", { durationS: 500, distanceM: 9000, leisureCost: 20 }),
    ]),
  ]);
  return [{ planLeisureTourAdvanced }, graph, decomposeEars(graph)];
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

function assertResultShape(result) {
  assert.ok(["ok", "degraded", "infeasible"].includes(result.status));
  assert.equal(typeof result.status, "string");
  assert.ok(Array.isArray(result.alternatives));
  assert.equal(typeof result.iterations, "number");
  assert.equal(typeof result.elapsedMs, "number");
  assert.equal(typeof result.diagnostics, "object");
  assert.ok(result.primary, "expected a primary tour");
}

function assertPrimaryShape(primary) {
  assert.ok(primary, "expected primary tour");
  for (const field of ["stops", "edges", "earsTraversed"]) assert.ok(Array.isArray(primary[field]), `${field} should be an array`);
  for (const field of ["totalLeisureCost", "totalDurationH", "totalDistanceKm", "scenicSum", "retracedConnectorCount"]) {
    assert.equal(typeof primary[field], "number", `${field} should be numeric`);
  }
  assert.equal(typeof primary.themeCoverage, "object");
  assert.equal(typeof primary.budgetFit, "object");
}

function assertFiniteMetrics(primary) {
  assertPrimaryShape(primary);
  for (const field of ["totalLeisureCost", "totalDurationH", "totalDistanceKm", "scenicSum", "retracedConnectorCount", "score"]) {
    assert.ok(Number.isFinite(primary[field]), `${field} should be finite`);
  }
}

function assertContiguousEdges(graph, tour) {
  assert.ok(tour.edges.length > 0, "expected at least one edge");
  let previousTo = null;
  for (const [index, edgeId] of tour.edges.entries()) {
    const edge = graph.edgeById.get(edgeId);
    assert.ok(edge, `missing edge ${edgeId}`);
    if (index > 0) assert.equal(edge.from, previousTo, `${edgeId} should continue from ${previousTo}`);
    previousTo = edge.to;
  }
  assert.equal(tour.stops[0].nodeId, graph.edgeById.get(tour.edges[0]).from);
  assert.equal(tour.stops.at(-1).nodeId, previousTo);
}

function tourSetKey(tour) {
  const stopSet = [...new Set(tour.stops.map((stop) => stop.id))].sort().join("|");
  const edgeSet = [...new Set(tour.edges)].sort().join("|");
  return `${stopSet}::${edgeSet}`;
}

function tourStructure(tour) {
  return {
    stops: tour.stops.map((stop) => stop.id),
    edges: tour.edges,
  };
}

function stopNodeIds(tour) {
  return tour.stops.map((stop) => stop.nodeId);
}

function passStopIds(tour) {
  return tour.stops
    .filter((stop) => stop.kind === "pass" || stop.passId)
    .map((stop) => stop.passId ?? stop.id);
}

function stopOverlapRatio(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;
  for (const id of leftSet) if (rightSet.has(id)) overlap += 1;
  return overlap / Math.max(1, leftSet.size, rightSet.size);
}

function foodDrinkPoiStops(result) {
  return result.primary.stops.filter((stop) => stop.kind === "poi" && (stop.themes ?? []).includes("food-drink")).length;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countRetracedConnectors(graph, edgeIds) {
  const seen = new Set();
  let count = 0;
  for (const edgeId of edgeIds) {
    const edge = graph.edgeById.get(edgeId);
    if (edge?.kind !== "connector") continue;
    const key = edge.from <= edge.to ? `${edge.from}\0${edge.to}` : `${edge.to}\0${edge.from}`;
    if (seen.has(key)) count += 1;
    else seen.add(key);
  }
  return count;
}

function isWinterAllowed(edge) {
  if (edge.season === undefined || edge.season === "all") return true;
  if (Array.isArray(edge.season)) return edge.season.includes("all") || edge.season.includes("winter");
  return String(edge.season).toLowerCase().includes("winter");
}
