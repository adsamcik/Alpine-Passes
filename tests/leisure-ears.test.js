const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const graphModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "graph.js")).href);
const earsModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "ears.js")).href);
const realGraph = graphModule.then(({ loadLeisureGraph }) =>
  loadLeisureGraph(path.join(repoRoot, "assets", "data", "leisure-graph.v1.json"))
);
const realDecomposition = Promise.all([realGraph, earsModule]).then(([graph, { decomposeEars }]) => ({
  graph,
  ...decomposeEars(graph),
}));

test("diamond graph decomposes to one loop ear containing both passes", async () => {
  const graph = await syntheticGraph([
    node("start", "junction", 0),
    node("end", "junction", 1),
    node("A", "pass", 2),
    node("B", "pass", 3),
  ], [
    connector("start", "A"),
    connector("A", "end"),
    connector("start", "B"),
    connector("B", "end"),
  ]);
  const { decomposeEars } = await earsModule;
  const loops = decomposeEars(graph).ears.filter((ear) => ear.kind === "loop");

  assert.equal(loops.length, 1);
  assert.deepEqual(loops[0].passes, ["A", "B"]);
  assert.deepEqual(new Set(loops[0].edges), new Set(["start->A", "A->end", "start->B", "B->end"]));
});

test("linear chain decomposes to a single path ear and no loops", async () => {
  const graph = await syntheticGraph([
    node("start", "junction", 0),
    node("A", "pass", 1),
    node("B", "pass", 2),
    node("C", "pass", 3),
    node("end", "junction", 4),
  ], [
    connector("start", "A"),
    connector("A", "B"),
    connector("B", "C"),
    connector("C", "end"),
  ]);
  const { decomposeEars } = await earsModule;
  const ears = decomposeEars(graph).ears;

  assert.equal(ears.filter((ear) => ear.kind === "loop").length, 0);
  assert.equal(ears.length, 1);
  assert.equal(ears[0].kind, "path");
  assert.deepEqual(ears[0].passes, ["A", "B", "C"]);
});

test("bridge path compression keeps a four-edge chain as one path ear", async () => {
  const graph = await syntheticGraph([
    node("start", "junction", 0),
    node("j-A", "poi", 1),
    node("pass-X", "pass", 2),
    node("j-B", "poi", 3),
    node("end", "junction", 4),
  ], [
    connector("start", "j-A"),
    connector("j-A", "pass-X"),
    connector("pass-X", "j-B"),
    connector("j-B", "end"),
  ]);
  const { decomposeEars } = await earsModule;
  const ears = decomposeEars(graph).ears;
  const pathEars = ears.filter((ear) => ear.kind === "path" && ear.passes.includes("pass-X"));

  assert.equal(pathEars.length, 1);
  assert.equal(pathEars[0].edges.length, 4);
  assert.deepEqual(new Set(pathEars[0].edges), new Set(["start->j-A", "j-A->pass-X", "pass-X->j-B", "j-B->end"]));
});

test("Y-shape exposes the A-side fork as structurally distinct ears", async () => {
  const graph = await syntheticGraph([
    node("start", "junction", 0),
    node("A", "pass", 1),
    node("B", "pass", 2),
    node("end", "junction", 3),
  ], [
    connector("start", "A"),
    connector("B", "A"),
    connector("A", "end"),
  ]);
  const { decomposeEars } = await earsModule;
  const ears = decomposeEars(graph).ears;
  const edgeSets = ears.map((ear) => new Set(ear.edges));

  assert.equal(ears.filter((ear) => ear.kind === "loop").length, 0);
  assert.ok(edgeSets.some((edges) => edges.has("B->A")), "expected a distinct B-to-A fork ear");
  assert.ok(edgeSets.some((edges) => edges.has("start->A")), "expected start side represented");
  assert.ok(edgeSets.some((edges) => edges.has("A->end")), "expected end side represented");
  assert.ok(ears.every((ear) => ear.attachmentNodes.includes("A") || ear.passes.includes("A")));
});

test("real graph decomposes to at least 200 ears after coverage extension", async () => {
  const { ears } = await realDecomposition;

  assert.ok(ears.length >= 200, `expected at least 200 ears, got ${ears.length}`);
});

test("every real ear has non-empty, de-duplicated passes ordered along its edge walk", async () => {
  const { graph, ears } = await realDecomposition;

  for (const ear of ears) {
    assert.ok(ear.passes.length > 0, `${ear.id} should include at least one pass`);
    assert.deepEqual(ear.passes, [...new Set(ear.passes)], `${ear.id} has duplicate passes`);
    if (ear.kind === "isolated-pass") {
      assert.deepEqual(ear.edges, [], `${ear.id} isolated pass stub should not reference edges`);
      assert.equal(ear.totalLeisureCost, 0, `${ear.id} isolated pass stub should have zero cost`);
      continue;
    }
    assert.ok(passOrderMatchesEdges(graph, ear), `${ear.id} pass order should match edge walk`);
  }
});

test("every real ear edge exists in graph adjacency and can be oriented as a chain", async () => {
  const { graph, ears } = await realDecomposition;

  for (const ear of ears) {
    if (ear.kind === "isolated-pass") {
      assert.deepEqual(ear.edges, [], `${ear.id} isolated pass stub should not reference edges`);
      continue;
    }
    const edges = ear.edges.map((id) => graph.edgeById.get(id));
    for (const edge of edges) {
      assert.ok(edge, `${ear.id} references missing edge ${edge}`);
      assert.ok(graph.outEdges.get(edge.from)?.includes(edge), `${edge.id} missing from outEdges`);
      assert.ok(graph.inEdges.get(edge.to)?.includes(edge), `${edge.id} missing from inEdges`);
    }
    assert.ok(orientedNodeSequences(edges).length > 0, `${ear.id} edges should form a chain`);
  }
});

test("passToEars and junctionToEars index every emitted ear reference", async () => {
  const { graph, ears, passToEars, junctionToEars } = await realDecomposition;
  const passes = (graph.nodesByKind.get("pass") ?? []).map((pass) => pass.id);
  const missingPasses = passes.filter((id) => !passToEars.has(id));

  assert.ok(
    missingPasses.length <= Math.ceil(passes.length * 0.01),
    `too many passes with no emitted ear (${missingPasses.length}): ${missingPasses.slice(0, 20).join(", ")}`
  );
  for (const ear of ears) {
    for (const pass of ear.passes) assert.ok(passToEars.get(pass)?.includes(ear), `${pass} missing ${ear.id}`);
    for (const junction of ear.attachmentNodes.filter((id) => graph.nodeKindOf(id) === "junction")) {
      assert.ok(junctionToEars.get(junction)?.includes(ear), `${junction} missing ${ear.id}`);
    }
  }
});

test("real ear totalLeisureCost equals the rounded sum of referenced edge costs", async () => {
  const { graph, ears } = await realDecomposition;

  for (const ear of ears) {
    const sum = ear.edges.reduce((total, id) => total + Number(graph.edgeById.get(id)?.leisureCost ?? 0), 0);
    assert.ok(Math.abs(ear.totalLeisureCost - round(sum, 3)) <= 1e-6, `${ear.id} cost mismatch`);
  }
});

test("cycle cap emits 32 cheapest loop ears for a dense biconnected component", async () => {
  const nodes = Array.from({ length: 8 }, (_, index) => node(`P${index}`, "pass", index));
  const edges = [];
  let cost = 1;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) edges.push(connector(nodes[i].id, nodes[j].id, cost++));
  }
  const graph = await syntheticGraph(nodes, edges);
  const { decomposeEars } = await earsModule;
  const ears = decomposeEars(graph).ears;

  assert.equal(ears.length, 32);
  assert.ok(ears.every((ear) => ear.kind === "loop"));
  for (let i = 1; i < ears.length; i += 1) {
    assert.ok(ears[i - 1].totalLeisureCost <= ears[i].totalLeisureCost);
  }
});

test("cycle coverage extension admits extra loops to cover all BCC passes", async () => {
  const cheapNodes = Array.from({ length: 12 }, (_, index) => node(`P${index}`, "pass", index));
  const rare = node("P-rare", "pass", cheapNodes.length);
  const edges = [];
  for (let i = 0; i < cheapNodes.length; i += 1) {
    for (let j = i + 1; j < cheapNodes.length; j += 1) edges.push(connector(cheapNodes[i].id, cheapNodes[j].id, 1));
  }
  edges.push(connector("P0", rare.id, 500));
  edges.push(connector(rare.id, "P1", 500));
  const graph = await syntheticGraph(cheapNodes.concat(rare), edges);
  const { decomposeEars } = await earsModule;
  const { ears, passToEars } = decomposeEars(graph);
  const bccPassIds = cheapNodes.map((item) => item.id).concat(rare.id);
  const uncoveredByLoops = bccPassIds.filter((passId) => !passToEars.get(passId)?.some((ear) => ear.kind === "loop"));
  const loopEars = ears.filter((ear) => ear.kind === "loop");

  assert.ok(loopEars.length > 32, `expected coverage extension beyond base cap, got ${loopEars.length}`);
  assert.deepEqual(uncoveredByLoops, []);
});

test("decomposeEars is deterministic for real graph ear order and IDs", async () => {
  const graph = await realGraph;
  const { decomposeEars } = await earsModule;
  const first = decomposeEars(graph).ears.map(earSignature);
  const second = decomposeEars(graph).ears.map(earSignature);

  assert.deepEqual(second, first);
});

async function syntheticGraph(nodes, edges) {
  const { LeisureGraph } = await graphModule;
  return new LeisureGraph({
    version: "test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    stats: { nodes: nodes.length, edges: edges.length },
    nodes,
    edges,
  });
}

function node(id, kind, index) {
  return {
    id,
    kind,
    name: id,
    lat: 46 + index * 0.001,
    lon: 8 + index * 0.001,
  };
}

function connector(from, to, leisureCost = 1) {
  return {
    id: `${from}->${to}`,
    from,
    to,
    kind: "connector",
    distanceM: leisureCost * 100,
    durationS: leisureCost * 60,
    leisureCost,
  };
}

function earSignature(ear) {
  return {
    id: ear.id,
    kind: ear.kind,
    passes: ear.passes,
    edges: ear.edges,
    attachmentNodes: ear.attachmentNodes,
    totalLeisureCost: ear.totalLeisureCost,
  };
}

function passOrderMatchesEdges(graph, ear) {
  const expected = ear.passes;
  for (const sequence of orientedNodeSequences(ear.edges.map((id) => graph.edgeById.get(id)))) {
    const actual = orderedUnique(sequence.map((id) => passIdFor(graph, id)).filter(Boolean));
    if (isSameOrder(expected, actual) || isSameOrder(expected, actual.slice().reverse())) return true;
  }
  return false;
}

function orientedNodeSequences(edges) {
  if (edges.some((edge) => !edge)) return [];
  if (edges.length === 0) return [];
  const out = [];

  for (const [from, to] of [[edges[0].from, edges[0].to], [edges[0].to, edges[0].from]]) {
    walk(1, [from, to]);
  }
  return out;

  function walk(index, nodes) {
    if (index === edges.length) {
      out.push(nodes);
      return;
    }
    const current = nodes[nodes.length - 1];
    const edge = edges[index];
    if (edge.from === current) walk(index + 1, nodes.concat(edge.to));
    if (edge.to === current) walk(index + 1, nodes.concat(edge.from));
  }
}

function passIdFor(graph, nodeId) {
  const node = graph.nodes.get(nodeId);
  if (node?.kind === "pass") return node.id;
  if (node?.kind === "pass-base" || node?.kind === "pass-summit") return node.passId ?? syntheticPassId(node.id);
  return syntheticPassId(nodeId);
}

function syntheticPassId(nodeId) {
  const match = String(nodeId).match(/^(.+):[ABS]$/);
  return match ? match[1] : null;
}

function orderedUnique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function isSameOrder(expected, actual) {
  if (expected.length !== actual.length) return false;
  if (expected.every((value, index) => actual[index] === value)) return true;
  if (expected.length < 2) return false;
  return actual.some((_, index) =>
    expected.every((value, offset) => actual[(index + offset) % actual.length] === value)
  );
}

function round(value, decimals) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
