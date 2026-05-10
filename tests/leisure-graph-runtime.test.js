const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const graphPath = path.join(repoRoot, "assets", "data", "leisure-graph.v1.json");
const graphModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "graph.js")).href);
const realGraph = graphModule.then(({ loadLeisureGraph }) => loadLeisureGraph(graphPath));

test("loadLeisureGraph works in Node via fs fallback and builds non-empty runtime indexes", async () => {
  const graph = await realGraph;

  assert.ok(graph.nodes instanceof Map);
  assert.ok(graph.nodes.size > 0);
  assert.ok(graph.outEdges instanceof Map);
  assert.ok(graph.inEdges instanceof Map);
  assert.ok([...graph.outEdges.values()].some((edges) => edges.length > 0));
  assert.ok([...graph.inEdges.values()].some((edges) => edges.length > 0));
});

test("validate returns ok for the real leisure graph", async () => {
  const graph = await realGraph;

  assert.deepEqual(graph.validate(), { ok: true });
});

test("nodes Map supports direct lookup and nodesByKind partitions all runtime nodes", async () => {
  const graph = await realGraph;
  const furka = graph.nodes.get("furkapass");
  const kinds = ["pass", "pass-base", "pass-summit", "poi", "junction"];
  const partitionTotal = kinds.reduce((sum, kind) => sum + (graph.nodesByKind.get(kind)?.length ?? 0), 0);

  assert.equal(furka?.id, "furkapass");
  assert.equal(graph.nodeIndex.get("furkapass"), graph.nodeList.indexOf(furka));
  assert.equal(partitionTotal, graph.nodes.size);
  for (const kind of kinds) {
    for (const node of graph.nodesByKind.get(kind) ?? []) assert.equal(node.kind, kind);
  }
});

test("outEdges and inEdges are mirror images for every directed edge", async () => {
  const graph = await realGraph;

  for (const edge of graph.edgeList) {
    assert.ok(graph.outEdges.get(edge.from)?.includes(edge), `${edge.id} missing from outEdges[${edge.from}]`);
    assert.ok(graph.inEdges.get(edge.to)?.includes(edge), `${edge.id} missing from inEdges[${edge.to}]`);
  }
});

test("edgeBetween returns the identical edge object stored in adjacency maps", async () => {
  const graph = await realGraph;
  const edge = graph.edgeList.find((item) => item.kind === "connector");

  assert.ok(edge, "expected at least one connector edge");
  assert.equal(graph.edgeBetween(edge.from, edge.to), edge);
  assert.equal(graph.outEdges.get(edge.from).find((item) => item.to === edge.to), edge);
});

test("passSidesFor returns canonical hero triplets and graceful partial triplets", async () => {
  const [{ LeisureGraph }, graph] = await Promise.all([graphModule, realGraph]);
  const furka = graph.passSidesFor("furkapass");
  const partial = new LeisureGraph(makeData([
    node("pX", "pass"),
    node("pX:A", "pass-base", { passId: "pX", side: "A" }),
    node("pX:S", "pass-summit", { passId: "pX" }),
  ], []));
  const partialSides = partial.passSidesFor("pX");

  assert.deepEqual([furka.pass.id, furka.A.id, furka.S.id, furka.B.id], [
    "furkapass",
    "furkapass:A",
    "furkapass:S",
    "furkapass:B",
  ]);
  assert.equal(furka.baseA, furka.A);
  assert.equal(furka.summit, furka.S);
  assert.equal(furka.baseB, furka.B);
  assert.equal(partialSides.pass.id, "pX");
  assert.equal(partialSides.A.id, "pX:A");
  assert.equal(partialSides.S.id, "pX:S");
  assert.equal(partialSides.B, null);
  assert.equal(partial.passSidesFor("pX:A").pass.id, "pX");
});

test("nodeKindOf resolves real node IDs and synthetic pass-side references", async () => {
  const [{ LeisureGraph }, graph] = await Promise.all([graphModule, realGraph]);
  const synthetic = new LeisureGraph(makeData([
    node("pX", "pass"),
    node("pX:A", "pass-base", { passId: "pX", side: "A" }),
    node("pX:S", "pass-summit", { passId: "pX" }),
    node("pX:B", "pass-base", { passId: "pX", side: "B" }),
  ], []));

  assert.equal(graph.nodeKindOf("furkapass"), "pass");
  assert.equal(graph.nodeKindOf("furkapass:A"), "pass-base");
  assert.equal(graph.nodeKindOf("furkapass:S"), "pass-summit");
  assert.equal(graph.nodeKindOf("furkapass:B"), "pass-base");
  assert.equal(synthetic.nodeKindOf("pX:A"), "pass-base");
  assert.equal(synthetic.nodeKindOf("pX:S"), "pass-summit");
  assert.equal(synthetic.nodeKindOf("pX:B"), "pass-base");
});

test("nearestNodes returns monotonic haversine-sorted, kind-filtered, k-bounded results", async () => {
  const { LeisureGraph, haversineM } = await graphModule;
  const graph = new LeisureGraph(makeData([
    node("near-poi", "poi", { lat: 0, lon: 0.001 }),
    node("middle-poi", "poi", { lat: 0, lon: 0.004 }),
    node("far-poi", "poi", { lat: 0, lon: 0.02 }),
    node("closer-pass", "pass", { lat: 0, lon: 0.0001 }),
  ], []));
  const results = graph.nearestNodes(0, 0, ["poi"], 2);

  assert.deepEqual(results.map((item) => item.node.id), ["near-poi", "middle-poi"]);
  assert.equal(results.length, 2);
  assert.ok(results.every((item) => item.node.kind === "poi"));
  assert.ok(results[0].distanceM <= results[1].distanceM);
  assert.equal(results[0].distanceM, haversineM({ lat: 0, lon: 0 }, graph.nodes.get("near-poi")));
});

test("deterministic sample of 50 node IDs has outEdge cardinality matching raw edges", async () => {
  const graph = await realGraph;
  const sample = graph.nodeIds.filter((_, index) => index % 20 === 0).slice(0, 50);

  assert.equal(sample.length, 50);
  for (const id of sample) {
    assert.equal(
      graph.outEdges.get(id)?.length ?? 0,
      graph.rawEdges.filter((edge) => edge.from === id).length,
      `${id} out-edge count`
    );
  }
});

test("validate reports deliberate orphan edge endpoints in synthetic graphs", async () => {
  const { LeisureGraph } = await graphModule;
  const graph = new LeisureGraph(makeData([
    node("a", "junction"),
  ], [
    edge("a", "missing-node"),
  ]));
  const result = graph.validate();

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("missing-node")), result.errors.join("\n"));
});

test("validate reports pass out-and-back costs that are not costlier than traverses", async () => {
  const { LeisureGraph } = await graphModule;
  const graph = new LeisureGraph(makeData([
    node("pBad", "pass"),
    node("pBad:A", "pass-base", { passId: "pBad", side: "A" }),
    node("pBad:S", "pass-summit", { passId: "pBad" }),
    node("pBad:B", "pass-base", { passId: "pBad", side: "B" }),
  ], [
    edge("pBad:A", "pBad:S", { kind: "pass-climb", passId: "pBad", leisureCost: 10 }),
    edge("pBad:S", "pBad:A", { kind: "pass-climb", passId: "pBad", leisureCost: 10 }),
    edge("pBad:S", "pBad:B", { kind: "pass-climb", passId: "pBad", leisureCost: 10 }),
    edge("pBad:B", "pBad:S", { kind: "pass-climb", passId: "pBad", leisureCost: 10 }),
    edge("pBad:A", "pBad:A", { kind: "pass-out-and-back", passId: "pBad", leisureCost: 20 }),
    edge("pBad:B", "pBad:B", { kind: "pass-out-and-back", passId: "pBad", leisureCost: 25 }),
  ]));
  const result = graph.validate();

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("pBad A out-and-back is not costlier")));
});

test("building twice from the same JSON has identical counts and isolated mutable indexes", async () => {
  const { LeisureGraph } = await graphModule;
  const source = JSON.stringify(makeData([
    node("a", "junction"),
    node("b", "junction", { lat: 0, lon: 0.01 }),
  ], [
    edge("a", "b", { leisureCost: 7 }),
  ]));
  const first = new LeisureGraph(JSON.parse(source));
  const second = new LeisureGraph(JSON.parse(source));

  assert.deepEqual(
    [first.nodes.size, first.edgeList.length, first.outEdges.get("a").length, first.inEdges.get("b").length],
    [second.nodes.size, second.edgeList.length, second.outEdges.get("a").length, second.inEdges.get("b").length]
  );
  assert.notEqual(first.nodes, second.nodes);
  assert.notEqual(first.outEdges.get("a"), second.outEdges.get("a"));
  assert.notEqual(first.edgeBetween("a", "b"), second.edgeBetween("a", "b"));
  first.outEdges.get("a").pop();
  first.edgeBetween("a", "b").leisureCost = 99;
  assert.equal(second.outEdges.get("a").length, 1);
  assert.equal(second.edgeBetween("a", "b").leisureCost, 7);
});

function makeData(nodes, edges) {
  return {
    version: "test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    stats: { nodes: nodes.length, edges: edges.length },
    nodes,
    edges: edges.map((item) => ({
      id: `${item.from}->${item.to}`,
      kind: "connector",
      distanceM: 100,
      durationS: 60,
      leisureCost: 1,
      ...item,
    })),
  };
}

function node(id, kind, extra = {}) {
  return {
    id,
    kind,
    name: id,
    lat: 46,
    lon: 8,
    ...extra,
  };
}

function edge(from, to, extra = {}) {
  return { from, to, ...extra };
}
