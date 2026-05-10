const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const graphModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "graph.js")).href);
const astarModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "astar.js")).href);
const realGraph = graphModule.then(({ loadLeisureGraph }) =>
  loadLeisureGraph(path.join(repoRoot, "assets", "data", "leisure-graph.v1.json"))
);

test("trivial from equals to returns a zero-cost singleton path", async () => {
  const graph = await syntheticGraph(["a"], []);
  const { leisureAStar } = await astarModule;
  const result = leisureAStar(graph, "a", "a");

  assert.deepEqual(result.path, ["a"]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.totalLeisureCost, 0);
  assert.equal(result.status, "ok");
});

test("direct connector edge returns that edge", async () => {
  const graph = await syntheticGraph(["a", "b"], [
    edge("a", "b", { leisureCost: 7, distanceM: 70, durationS: 17 }),
  ]);
  const { leisureAStar } = await astarModule;
  const result = leisureAStar(graph, "a", "b");

  assert.equal(result.status, "ok");
  assert.deepEqual(result.path, ["a", "b"]);
  assert.deepEqual(result.edges, ["a->b"]);
  assert.equal(result.totalLeisureCost, 7);
});

test("three-node chain returns the expected shortest path", async () => {
  const graph = await syntheticGraph(["a", "b", "c"], [
    edge("a", "b", { leisureCost: 2 }),
    edge("b", "c", { leisureCost: 3 }),
    edge("a", "c", { leisureCost: 9 }),
  ]);
  const { leisureAStar } = await astarModule;
  const result = leisureAStar(graph, "a", "c");

  assert.equal(result.status, "ok");
  assert.deepEqual(result.path, ["a", "b", "c"]);
  assert.deepEqual(result.edges, ["a->b", "b->c"]);
  assert.equal(result.totalLeisureCost, 5);
});

test("disconnected islands return unreachable", async () => {
  const graph = await syntheticGraph(["a", "b", "x", "y"], [
    edge("a", "b"),
    edge("x", "y"),
  ]);
  const { leisureAStar } = await astarModule;
  const result = leisureAStar(graph, "a", "y");

  assert.equal(result.status, "unreachable");
  assert.deepEqual(result.path, []);
  assert.deepEqual(result.edges, []);
});

test("costMode selects paths minimizing leisure, duration, or distance fields", async () => {
  const graph = await syntheticGraph(["a", "b", "c", "d"], [
    edge("a", "b", { leisureCost: 50, distanceM: 1, durationS: 50 }),
    edge("a", "c", { leisureCost: 1, distanceM: 50, durationS: 50 }),
    edge("c", "b", { leisureCost: 1, distanceM: 50, durationS: 50 }),
    edge("a", "d", { leisureCost: 10, distanceM: 5, durationS: 1 }),
    edge("d", "b", { leisureCost: 10, distanceM: 5, durationS: 1 }),
  ]);
  const { leisureAStar } = await astarModule;

  assert.deepEqual(leisureAStar(graph, "a", "b", { costMode: "leisure" }).path, ["a", "c", "b"]);
  assert.deepEqual(leisureAStar(graph, "a", "b", { costMode: "distance" }).path, ["a", "b"]);
  assert.deepEqual(leisureAStar(graph, "a", "b", { costMode: "duration" }).path, ["a", "d", "b"]);
});

test("forbiddenEdges excludes the named edge and finds an alternative", async () => {
  const graph = await syntheticGraph(["a", "b", "c"], [
    edge("a", "b", { id: "direct", leisureCost: 1 }),
    edge("a", "c", { leisureCost: 2 }),
    edge("c", "b", { leisureCost: 2 }),
  ]);
  const { leisureAStar } = await astarModule;
  const result = leisureAStar(graph, "a", "b", { forbiddenEdges: ["direct"] });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.path, ["a", "c", "b"]);
  assert.deepEqual(result.edges, ["a->c", "c->b"]);
});

test("forbiddenEdges excludes roadClass-qualified edge tokens", async () => {
  const graph = await syntheticGraph(["a", "b", "c"], [
    edge("a", "b", { id: "direct", roadClass: "highway", leisureCost: 1 }),
    edge("a", "c", { leisureCost: 2 }),
    edge("c", "b", { leisureCost: 2 }),
  ]);
  const { leisureAStar } = await astarModule;
  const result = leisureAStar(graph, "a", "b", { forbiddenEdges: ["highway:a->b"] });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.path, ["a", "c", "b"]);
  assert.deepEqual(result.edges, ["a->c", "c->b"]);
});

test("forbiddenNodes excludes the named node and skips it", async () => {
  const graph = await syntheticGraph(["a", "b", "c", "d"], [
    edge("a", "b", { leisureCost: 1 }),
    edge("b", "d", { leisureCost: 1 }),
    edge("a", "c", { leisureCost: 3 }),
    edge("c", "d", { leisureCost: 3 }),
  ]);
  const { leisureAStar } = await astarModule;
  const result = leisureAStar(graph, "a", "d", { forbiddenNodes: ["b"] });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.path, ["a", "c", "d"]);
  assert.ok(!result.path.includes("b"));
});

test("usedEdgesPenalty makes A* choose a more expensive fresh alternative", async () => {
  const graph = await syntheticGraph(["a", "b", "c", "d"], [
    edge("a", "b", { leisureCost: 1 }),
    edge("b", "d", { leisureCost: 1 }),
    edge("a", "c", { leisureCost: 3 }),
    edge("c", "d", { leisureCost: 3 }),
  ]);
  const { leisureAStar } = await astarModule;
  const result = leisureAStar(graph, "a", "d", {
    usedEdges: ["a->b"],
    usedEdgesPenalty: 10,
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.path, ["a", "c", "d"]);
  assert.equal(result.totalLeisureCost, 6);
  assert.equal(result.retracedEdgeCount, 0);
});

test("budget exceeded returns budget-exhausted", async () => {
  const graph = await syntheticGraph(["a", "b"], [
    edge("a", "b", { leisureCost: 5 }),
  ]);
  const { leisureAStar } = await astarModule;
  const result = leisureAStar(graph, "a", "b", { budget: { leisureCost: 4 } });

  assert.equal(result.status, "budget-exhausted");
  assert.deepEqual(result.path, []);
});

test("leisure heuristic is admissible against exact remaining costs on a small graph", async () => {
  const [{ haversineM }, graph] = await Promise.all([
    graphModule,
    syntheticGraph(["n0", "n1", "n2", "n3", "goal"], [
      edge("n0", "n1", { leisureCost: 12, distanceM: 120 }),
      edge("n1", "goal", { leisureCost: 12, distanceM: 120 }),
      edge("n0", "n2", { leisureCost: 15, distanceM: 130 }),
      edge("n2", "n3", { leisureCost: 6, distanceM: 80 }),
      edge("n3", "goal", { leisureCost: 6, distanceM: 80 }),
      edge("n1", "n3", { leisureCost: 10, distanceM: 100 }),
    ], { coordinateStep: 0.0001 }),
  ]);
  const goalIndex = graph.nodeIndex.get("goal");
  const goal = graph.nodeList[goalIndex];
  const stats = graph.ensureEdgeStats();
  const exact = exactRemainingCosts(graph, "goal", "leisure");

  for (const node of graph.nodeList) {
    const actual = exact.get(node.id);
    if (!Number.isFinite(actual)) continue;
    const heuristic = haversineM(node, goal) * stats.minLeisurePerM;
    assert.ok(heuristic <= actual + 1e-6, `${node.id} heuristic ${heuristic} > actual ${actual}`);
  }
});

test("bidirectional and unidirectional searches agree on finite leisure cost", async () => {
  const graph = await syntheticGraph(["a", "b", "c", "d", "e"], [
    edge("a", "b", { leisureCost: 2 }),
    edge("b", "e", { leisureCost: 5 }),
    edge("a", "c", { leisureCost: 3 }),
    edge("c", "d", { leisureCost: 1 }),
    edge("d", "e", { leisureCost: 1 }),
    edge("b", "d", { leisureCost: 2 }),
  ], { coordinateStep: 0.0001 });
  const { leisureAStar } = await astarModule;
  const bidirectional = leisureAStar(graph, "a", "e");
  const unidirectional = leisureAStar(graph, "a", "e", { bidirectional: false });

  assert.equal(bidirectional.status, "ok");
  assert.equal(unidirectional.status, "ok");
  assert.equal(bidirectional.totalLeisureCost, unidirectional.totalLeisureCost);
});

test("bidirectional and unidirectional searches agree on five real hero queries", async () => {
  const [graph, { leisureAStar }] = await Promise.all([realGraph, astarModule]);
  const queries = [
    ["furkapass:A", "grimselpass:B"],
    ["sustenpass:A", "furkapass:B"],
    ["klausenpass:A", "sustenpass:B"],
    ["nufenenpass-passo-della-novena:A", "furkapass:B"],
    ["passo-del-bernina:A", "passo-forcola-di-livigno:B"],
  ];

  for (const [from, to] of queries) {
    const bidirectional = leisureAStar(graph, from, to);
    const unidirectional = leisureAStar(graph, from, to, { bidirectional: false });
    assert.equal(bidirectional.status, "ok", `${from}→${to} bidirectional`);
    assert.equal(unidirectional.status, "ok", `${from}→${to} unidirectional`);
    assert.equal(bidirectional.totalLeisureCost, unidirectional.totalLeisureCost, `${from}→${to} cost`);
  }
});

test("real hero query succeeds quickly and matches a curated restricted three-edge path", async () => {
  const [graph, { leisureAStar }] = await Promise.all([realGraph, astarModule]);
  const started = performance.now();
  const result = leisureAStar(graph, "furkapass:A", "grimselpass:B");
  const elapsedMs = performance.now() - started;
  const curatedPath = ["furkapass:A", "grimselpass:A", "grimselpass:S", "grimselpass:B"];
  const curatedEdges = [
    graph.edgeBetween("furkapass:A", "grimselpass:A"),
    graph.edgeBetween("grimselpass:A", "grimselpass:S"),
    graph.edgeBetween("grimselpass:S", "grimselpass:B"),
  ];
  const restricted = leisureAStar(graph, "furkapass:A", "grimselpass:B", {
    forbiddenNodes: graph.nodeIds.filter((id) => !curatedPath.includes(id)),
  });
  const manualCost = round(curatedEdges.reduce((sum, edge) => sum + edge.leisureCost, 0), 3);

  console.log(`A* furkapass:A→grimselpass:B runtime: ${elapsedMs.toFixed(3)}ms`);
  assert.equal(result.status, "ok");
  assert.ok(Number.isFinite(result.totalLeisureCost));
  assert.ok(elapsedMs <= 100, `expected hero query <= 100ms, got ${elapsedMs.toFixed(3)}ms`);
  assert.equal(restricted.status, "ok");
  assert.deepEqual(restricted.path, curatedPath);
  assert.deepEqual(restricted.edges, curatedEdges.map((edge) => edge.id));
  assert.equal(restricted.totalLeisureCost, manualCost);
});

async function syntheticGraph(ids, edges, opts = {}) {
  const { LeisureGraph } = await graphModule;
  const coordinateStep = opts.coordinateStep ?? 0.001;
  const nodes = ids.map((id, index) => ({
    id,
    kind: "junction",
    name: id,
    lat: 46,
    lon: 8 + index * coordinateStep,
  }));
  return new LeisureGraph({
    version: "test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    stats: { nodes: nodes.length, edges: edges.length },
    nodes,
    edges,
  });
}

function edge(from, to, extra = {}) {
  const leisureCost = extra.leisureCost ?? 1;
  return {
    id: `${from}->${to}`,
    from,
    to,
    kind: "connector",
    distanceM: 100,
    durationS: 60,
    leisureCost,
    ...extra,
  };
}

function exactRemainingCosts(graph, goalId, mode) {
  const costs = new Map(graph.nodeIds.map((id) => [id, Infinity]));
  costs.set(goalId, 0);
  const unsettled = new Set(graph.nodeIds);

  while (unsettled.size) {
    let current = null;
    for (const id of unsettled) {
      if (current === null || costs.get(id) < costs.get(current)) current = id;
    }
    if (!Number.isFinite(costs.get(current))) break;
    unsettled.delete(current);
    for (const edge of graph.inEdges.get(current) ?? []) {
      const next = edge.from;
      const candidate = costs.get(current) + rawCost(edge, mode);
      if (candidate < costs.get(next)) costs.set(next, candidate);
    }
  }
  return costs;
}

function rawCost(edge, mode) {
  if (mode === "distance") return Number(edge.distanceM) || 0;
  if (mode === "duration") return Number(edge.durationS) || 0;
  return Number(edge.leisureCost) || 0;
}

function round(value, decimals) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
