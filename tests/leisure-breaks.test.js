const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const breaksModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "breaks.js")).href);

test("short tour under forty-five minutes emits no breaks", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = lineFixture(40);

  const result = detectBreaks(graph, tour);

  assert.equal(result.breaks.length, 0);
});

test("long monotonous secondary-road tour emits at least one break", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = lineFixture(240, { roadClass: "secondary", scenicScore: 0.02 });

  const result = detectBreaks(graph, tour);

  assert.ok(result.breaks.length >= 1);
  assert.ok(result.loadCurve[result.loadCurve.length - 1].tourVertexIdx > result.loadCurve[0].tourVertexIdx);
});

test("motorcyclist mountain road suggests one stretch or viewpoint break", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = lineFixture(50, { roadClass: "mountain", curvy: true, scenicScore: 0.25, elevGainM: 800 });

  const result = detectBreaks(graph, tour, { persona: "motorcyclist" });

  assert.equal(result.breaks.length, 1);
  assert.ok(["stretch", "viewpoint"].includes(result.breaks[0].type));
});

test("tourPacked suppresses breaks with packed diagnostics", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = lineFixture(240);

  const result = detectBreaks(graph, tour, { tourPacked: true });

  assert.deepEqual(result.breaks, []);
  assert.ok(result.loadCurve.length > 0);
  assert.equal(result.diagnostics.packed, true);
  assert.equal(typeof result.diagnostics.suppressedReason, "string");
});

test("empty corridor POIs fall back to stretch break without candidate", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = lineFixture(180);

  const result = detectBreaks(graph, tour, { corridorPois: [] });

  assert.ok(result.breaks.length >= 1);
  assert.equal(result.breaks[0].type, "stretch");
  assert.equal(result.breaks[0].poiCandidate, null);
});

test("family persona selects a family-friendly corridor POI", async () => {
  const { detectBreaks } = await breaksModule;
  const fixture = lineFixture(180);
  const pois = [
    poiAt(fixture, 5, { id: "view", categories: ["viewpoint"], score: 0.7 }),
    poiAt(fixture, 5, { id: "play", categories: ["playground", "restaurant"], score: 0.6 }),
  ];

  const result = detectBreaks(fixture.graph, fixture.tour, { persona: "family", corridorPois: pois });
  const selected = pois.find((poi) => poi.id === result.breaks[0].poiCandidate.poiId);

  assert.ok(selected.categories.some((category) => ["playground", "restaurant"].includes(category)));
  assert.ok(result.breaks[0].poiCandidate.categories.includes("playground"));
});

test("cooldown keeps suggested breaks at least forty minutes apart", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = lineFixture(360);

  const result = detectBreaks(graph, tour);

  for (let i = 1; i < result.breaks.length; i += 1) {
    const gapMin = (result.breaks[i].tStart - result.breaks[i - 1].tStart) / 60000;
    assert.ok(gapMin >= 40, `gap ${gapMin}min`);
  }
});

test("decompression role appears after a two-thousand-metre pass climax", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = passFixture();

  const result = detectBreaks(graph, tour, { corridorPois: [{ id: "valley-cafe", name: "Valley cafe", lat: 46.03, lon: 8.05, score: 0.2, categories: ["settlement", "restaurant"] }] });

  assert.ok(result.breaks.length >= 1);
  assert.equal(result.breaks[0].pacingRole, "decompression");
});

test("sunny early start applies glare penalty in the first ninety minutes", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = lineFixture(120);
  const startTime = new Date(2026, 5, 1, 6, 0, 0);

  const sunny = detectBreaks(graph, tour, { startTime, weather: "sunny" });
  const plain = detectBreaks(graph, tour, { startTime, weather: null });
  const sunnyTotal = sum(sunny.loadCurve.slice(0, 9).map((point) => point.total));
  const plainTotal = sum(plain.loadCurve.slice(0, 9).map((point) => point.total));

  assert.ok(sunnyTotal > plainTotal + 2.4, `${sunnyTotal} vs ${plainTotal}`);
});

test("same inputs produce deterministic normalized break output", async () => {
  const { detectBreaks } = await breaksModule;
  const fixture = lineFixture(240);
  const options = { corridorPois: [poiAt(fixture, 5, { id: "cafe", categories: ["cafe"], score: 0.5 })] };

  const first = normalizeBreaks(detectBreaks(fixture.graph, fixture.tour, options).breaks);
  const second = normalizeBreaks(detectBreaks(fixture.graph, fixture.tour, options).breaks);

  assert.deepEqual(second, first);
});

test("eight-hour synthetic tour stays within the fifty millisecond target", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = lineFixture(480);

  const started = performance.now();
  const result = detectBreaks(graph, tour);
  const elapsedMs = performance.now() - started;

  assert.ok(result.loadCurve.length > 0);
  assert.ok(elapsedMs <= 50, `detectBreaks took ${elapsedMs.toFixed(3)}ms`);
});

test("maxBreaksTotal enforces the requested cap", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = lineFixture(480);

  const result = detectBreaks(graph, tour, { maxBreaksTotal: 1 });

  assert.equal(result.breaks.length, 1);
});

function lineFixture(totalMinutes, options = {}) {
  const edgeMinutes = options.edgeMinutes ?? 10;
  const edgeCount = Math.ceil(totalMinutes / edgeMinutes);
  const nodes = [];
  const edges = [];
  for (let i = 0; i <= edgeCount; i += 1) {
    nodes.push({ id: `n${i}`, kind: "junction", name: `Node ${i}`, lat: 46 + (options.curvy && i % 2 ? 0.01 : 0), lon: 8 + i * 0.01, elev: 800 + i * (options.elevGainM ? 20 : 0) });
  }
  for (let i = 0; i < edgeCount; i += 1) {
    const from = nodes[i];
    const to = nodes[i + 1];
    const durationMin = Math.min(edgeMinutes, totalMinutes - i * edgeMinutes);
    const id = `${from.id}->${to.id}`;
    edges.push({
      id,
      from: from.id,
      to: to.id,
      kind: options.roadClass === "mountain" ? "pass-climb" : "connector",
      roadClass: options.roadClass ?? "secondary",
      distanceM: durationMin * 1000,
      durationS: durationMin * 60,
      scenicScore: options.scenicScore ?? 0.05,
      elevGainM: options.elevGainM ?? 0,
      geometry: options.curvy
        ? [[from.lat, from.lon], [from.lat + 0.02, from.lon + 0.004], [to.lat - 0.02, to.lon - 0.004], [to.lat, to.lon]]
        : [[from.lat, from.lon], [to.lat, to.lon]],
    });
  }
  return makeFixture(nodes, edges);
}

function passFixture() {
  const nodes = [
    { id: "base", kind: "junction", name: "Base", lat: 46, lon: 8, elev: 900 },
    { id: "big-pass", kind: "pass", name: "Big Pass", lat: 46.01, lon: 8.01, elev: 2100 },
    { id: "big-pass:S", kind: "pass-summit", name: "Big Pass summit", lat: 46.01, lon: 8.01, elev: 2100 },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `v${index}`, kind: "junction", name: `Valley ${index}`, lat: 46.02, lon: 8.02 + index * 0.01, elev: 900 })),
  ];
  const route = ["base", "big-pass:S", ...nodes.slice(3).map((node) => node.id)];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = [];
  for (let i = 0; i < route.length - 1; i += 1) {
    const from = byId.get(route[i]);
    const to = byId.get(route[i + 1]);
    edges.push({
      id: `${from.id}->${to.id}`,
      from: from.id,
      to: to.id,
      kind: i === 0 ? "pass-climb" : "connector",
      passId: i === 0 ? "big-pass" : undefined,
      roadClass: i === 0 ? "mountain" : "secondary",
      distanceM: 5000,
      durationS: 600,
      scenicScore: i === 0 ? 0.7 : 0.1,
      geometry: [[from.lat, from.lon], [to.lat, to.lon]],
    });
  }
  return makeFixture(nodes, edges);
}

function makeFixture(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const graph = { nodes: nodeById, nodeById, edgeById, edgeList: edges };
  const tour = {
    stops: [nodes[0], nodes[nodes.length - 1]].map((node) => ({ id: node.id, nodeId: node.id, lat: node.lat, lon: node.lon })),
    edges: edges.map((edge) => edge.id),
    path: nodes.map((node) => node.id),
    totalDurationH: sum(edges.map((edge) => edge.durationS)) / 3600,
    totalDistanceKm: sum(edges.map((edge) => edge.distanceM)) / 1000,
  };
  return { graph, tour, nodes, edges };
}

function poiAt(fixture, nodeIndex, overrides = {}) {
  const node = fixture.nodes[nodeIndex];
  return {
    id: overrides.id ?? `poi-${nodeIndex}`,
    name: overrides.name ?? `POI ${nodeIndex}`,
    lat: node.lat,
    lon: node.lon,
    score: overrides.score ?? 0.5,
    detourMin: overrides.detourMin ?? 0,
    categories: overrides.categories ?? [],
  };
}

function normalizeBreaks(breaks) {
  return breaks.map((item) => ({
    ...item,
    tStart: item.tStart.toISOString(),
    tEnd: item.tEnd.toISOString(),
  }));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
