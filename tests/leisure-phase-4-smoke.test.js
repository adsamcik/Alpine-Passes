const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const graphPath = path.join(repoRoot, "assets", "data", "leisure-graph.v1.json");
const graphModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "graph.js")).href);
const earsModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "ears.js")).href);
const optimizerModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "optimizer.js")).href);
const corridorModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "corridor.js")).href);
const lunchModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "lunch.js")).href);
const breaksModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "breaks.js")).href);
const intentModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "intent.js")).href);

const realGraph = graphModule.then(({ loadLeisureGraph }) => loadLeisureGraph(graphPath));
const realDecomposition = Promise.all([realGraph, earsModule]).then(([graph, { decomposeEars }]) => ({
  graph,
  ears: decomposeEars(graph),
}));

test("real graph end-to-end Phase 4 smoke covers corridor, lunch, breaks, and intent", { timeout: 20_000 }, async () => {
  const [
    { graph, ears },
    { LeisureGraph, haversineM },
    { planLeisureTour },
    { findCorridorPois },
    { planLunchZone },
    { detectBreaks },
    { inferIntent, surfaceIntentPois },
  ] = await Promise.all([realDecomposition, graphModule, optimizerModule, corridorModule, lunchModule, breaksModule, intentModule]);
  const planned = planLeisureTour(graph, ears, {
    start: "j-andermatt",
    budgetSeconds: 4 * 3600,
    seed: 42,
    timeBudgetMs: 5_000,
    kAlternatives: 1,
    themes: ["panoramic-view", "drivers-road"],
  });
  assert.equal(planned.status, "ok");
  assert.ok(planned.primary.stops.length >= 6, "expected a six-stop alpine tour including return");

  const tour = {
    ...planned.primary,
    path: planned.primary.stops.map((stop) => stop.nodeId ?? stop.id),
  };
  const probes = geometryProbePois(graph, tour, haversineM, 3);
  assert.equal(probes.length, 3, "real graph route should expose three geometry-only probe POIs");
  const augmented = new LeisureGraph({ ...graph.data, nodes: [...graph.rawNodes, ...probes], edges: graph.rawEdges });
  const corridor = findCorridorPois(augmented, tour, {
    autoIncludeMaxDetourMin: 2,
    suggestMaxDetourMin: 10,
    maxAutoIncludePerHour: 10,
    personas: ["photographer", "driver"],
  });
  const corridorPois = [...corridor.autoInclude, ...corridor.suggestions];
  const startTime = new Date(2026, 5, 15, 15, 0, 0);
  const lunch = planLunchZone(augmented, tour, { startTime });
  const breaks = detectBreaks(augmented, tour, { startTime, corridorPois });
  const intent = surfaceIntentPois(
    augmented,
    tour,
    inferIntent({ pinnedStops: tour.stops.filter((stop) => stop.kind === "pass") }),
    { corridorPois, topK: 6 }
  );
  const totalDriveS = sumEdgeField(graph, tour, "durationS");

  assert.ok(corridorPois.length >= 3, `expected at least three corridor POIs, got ${corridorPois.length}`);
  if (spansLocalLunch(startTime, totalDriveS)) assert.ok(lunch.zones.length >= 1, "lunch window should produce a zone");
  if (totalDriveS > 90 * 60) assert.ok(breaks.breaks.length >= 1, "long alpine drive should suggest a break");
  assert.ok(intent.diagnostics.topPersona, "intent surfacing should report a top persona");
  console.log(`phase4-smoke corridor=${corridorPois.length} breaks=${breaks.breaks.length} routeVertices=${corridor.diagnostics.routeVertexCount}`);
});

test("corridor densifies a 100 km geometry edge and finds POIs away from sparse waypoints", async () => {
  const [{ findCorridorPois }, { graph, tour, routeLine, waypointLine, poi }] = await Promise.all([
    corridorModule,
    densifiedCorridorFixture(),
  ]);

  const result = findCorridorPois(graph, tour, { autoIncludeMaxDetourMin: 2, suggestMaxDetourMin: 10 });
  const found = [...result.autoInclude, ...result.suggestions].find((item) => item.poiId === poi.id);

  assert.ok(found, "expected geometry-only POI in corridor result");
  assert.ok(minDistanceKm(poi, routeLine) <= 5);
  assert.ok(minDistanceKm(poi, waypointLine) > 5);
});

test("corridor round-trip detour math stays aligned with lunch detours", async () => {
  const [{ findCorridorPois }, { planLunchZone }, fixture] = await Promise.all([
    corridorModule,
    lunchModule,
    detourEquivalenceFixture(),
  ]);
  const corridor = findCorridorPois(fixture.graph, fixture.tour, { autoIncludeMaxDetourMin: 0, suggestMaxDetourMin: 10 });
  const lunch = planLunchZone(fixture.graph, fixture.tour, { startTime: new Date(2026, 5, 1, 10, 0, 0), lunchPolicy: 90 });
  const corridorPoi = [...corridor.autoInclude, ...corridor.suggestions].find((item) => item.poiId === "food");
  const lunchPoi = lunch.zones.flatMap((zone) => zone.candidates).find((item) => item.poiId === "food");

  assert.ok(corridorPoi);
  assert.ok(lunchPoi);
  assert.ok(Math.abs(corridorPoi.detourMin - lunchPoi.detourMin) <= 1, `${corridorPoi.detourMin} vs ${lunchPoi.detourMin}`);
});

test("corridor routeLengthKm follows edge distance sums instead of sparse haversine chords", async () => {
  const [{ findCorridorPois }, { graph, tour }] = await Promise.all([corridorModule, densifiedCorridorFixture()]);
  const result = findCorridorPois(graph, tour);
  const expectedKm = sumEdgeField(graph, tour, "distanceM") / 1000;

  assert.ok(Math.abs(result.diagnostics.routeLengthKm - expectedKm) / expectedKm <= 0.05);
});

test("breaks merge short summit-photo dwells and detect a break on a 2.7h alpine tour", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = alpineCuratedBreakFixture();

  const result = detectBreaks(graph, tour);

  assert.ok(result.breaks.length >= 1, "expected at least one break after merged alpine load");
});

test("breaks keep a four-hour motorway tour at three or more breaks", async () => {
  const { detectBreaks } = await breaksModule;
  const { graph, tour } = motorwayBreakFixture(240);

  const result = detectBreaks(graph, tour);

  assert.ok(result.breaks.length >= 3, `expected >=3 breaks, got ${result.breaks.length}`);
});

test("intent feedback for kind pass moves Photographer and ThrillRider non-trivially", async () => {
  const { inferIntent, updateIntent } = await intentModule;
  const baseline = inferIntent({});
  const updated = updateIntent(baseline, { kind: "pin", target: { kind: "pass" } });

  assert.ok(updated.Photographer > baseline.Photographer);
  assert.ok(updated.ThrillRider > baseline.ThrillRider);
});

test("lunch empty tour returns empty zones and no desert", async () => {
  const { planLunchZone } = await lunchModule;
  const { LeisureGraph } = await graphModule;
  const graph = new LeisureGraph({ version: "test", generatedAt: new Date(0).toISOString(), stats: { nodes: 0, edges: 0 }, nodes: [], edges: [] });

  const result = planLunchZone(graph, { stops: [], edges: [], totalDurationS: 0 }, { startTime: new Date(2026, 5, 1, 12, 0, 0) });

  assert.deepEqual(result.zones, []);
  assert.equal(result.desert, null);
  assert.deepEqual(result.hungerCurve, []);
});

async function densifiedCorridorFixture() {
  const { LeisureGraph } = await graphModule;
  const nodes = [
    junction("a", 0, 0),
    junction("b", 0, deg(100)),
    poi("geometry-view", deg(25), deg(50), ["viewpoint-panorama"], 9.5, { themes: ["panoramic-view"] }),
  ];
  const edge = routeEdge("a", "b", 100_000, 2 * 3600, {
    geometry: [[0, 0], [deg(25), deg(50)], [0, deg(100)]],
  });
  const graph = new LeisureGraph({ version: "test", generatedAt: new Date(0).toISOString(), stats: { nodes: nodes.length, edges: 1 }, nodes, edges: [edge] });
  return {
    graph,
    tour: makeTour(["a", "b"], [edge.id], 2 * 3600),
    routeLine: [{ lat: 0, lon: 0 }, { lat: deg(25), lon: deg(50) }, { lat: 0, lon: deg(100) }],
    waypointLine: [nodes[0], nodes[1]],
    poi: nodes[2],
  };
}

async function detourEquivalenceFixture() {
  const { LeisureGraph } = await graphModule;
  const nodes = [
    junction("start", 0, 0),
    junction("end", 0, deg(50)),
    poi("food", deg(1), deg(25), ["restaurant"], 8),
  ];
  const edge = routeEdge("start", "end", 50_000, 5 * 3600, {
    geometry: [[0, 0], [0, deg(25)], [0, deg(50)]],
  });
  const graph = new LeisureGraph({ version: "test", generatedAt: new Date(0).toISOString(), stats: { nodes: nodes.length, edges: 1 }, nodes, edges: [edge] });
  return { graph, tour: makeTour(["start", "end"], [edge.id], 5 * 3600) };
}

function alpineCuratedBreakFixture() {
  const ids = ["approach", "pass-a:A", "pass-a:S", "pass-a:B", "pass-b:A", "pass-b:S", "pass-b:B"];
  const nodes = ids.map((id, index) => ({
    id,
    kind: id.endsWith(":S") ? "pass-summit" : id.includes("pass-") ? "pass-base" : "junction",
    name: id,
    lat: 46 + index * 0.01,
    lon: 8 + (index % 2 ? 0.01 : 0),
    elev: id.endsWith(":S") ? 2100 : 900,
  }));
  const edges = [];
  for (let i = 0; i < ids.length - 1; i += 1) {
    edges.push(routeEdge(ids[i], ids[i + 1], 8_000, 27 * 60, {
      kind: "pass-climb",
      roadClass: "mountain",
      scenicScore: 0.18,
      elevGainM: 800,
      geometry: [[nodes[i].lat, nodes[i].lon], [nodes[i].lat + 0.015, nodes[i].lon + 0.006], [nodes[i + 1].lat, nodes[i + 1].lon]],
    }));
  }
  return makePlainFixture(nodes, edges, ids, 5 * 60);
}

function motorwayBreakFixture(totalMinutes) {
  const edgeMinutes = 10;
  const edgeCount = Math.ceil(totalMinutes / edgeMinutes);
  const nodes = Array.from({ length: edgeCount + 1 }, (_, index) => junction(`m${index}`, 45, 8 + index * 0.02));
  const edges = [];
  for (let i = 0; i < edgeCount; i += 1) {
    const durationS = Math.min(edgeMinutes, totalMinutes - i * edgeMinutes) * 60;
    edges.push(routeEdge(nodes[i].id, nodes[i + 1].id, durationS / 60 * 1800, durationS, {
      kind: "connector",
      roadClass: "motorway",
      scenicScore: 0.01,
    }));
  }
  return makePlainFixture(nodes, edges, nodes.map((node) => node.id), 0, true);
}

function makePlainFixture(nodes, edges, routeIds, dwellSec, endpointsOnly = false) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const graph = { nodes: nodeById, nodeById, edgeById, edgeList: edges };
  const stopIds = endpointsOnly ? [routeIds[0], routeIds.at(-1)] : routeIds;
  const tour = {
    stops: stopIds.map((id) => ({ ...nodeById.get(id), nodeId: id, dwellSec })),
    path: routeIds,
    edges: edges.map((edge) => edge.id),
    totalDurationS: edges.reduce((sum, edge) => sum + edge.durationS, 0),
    dwellSecPerStop: dwellSec,
  };
  return { graph, tour };
}

function geometryProbePois(graph, tour, haversineM, count) {
  const stopNodes = tour.path.map((id) => graph.nodes.get(id)).filter(Boolean);
  const probes = [];
  for (const edgeId of tour.edges) {
    const edge = graph.edgeById.get(edgeId);
    if (!Array.isArray(edge?.geometry)) continue;
    for (const raw of edge.geometry) {
      const point = coord(raw);
      if (!point) continue;
      const stopDistanceKm = Math.min(...stopNodes.map((node) => haversineM(node, point))) / 1000;
      if (stopDistanceKm > 5.2 && probes.every((probe) => haversineM(probe, point) > 3000)) {
        probes.push({
          id: `phase4-probe-${probes.length + 1}`,
          kind: "poi",
          name: `Phase 4 probe ${probes.length + 1}`,
          lat: point.lat,
          lon: point.lon,
          score: 9.5,
          categories: ["viewpoint-panorama"],
          themes: ["panoramic-view"],
        });
        break;
      }
    }
    if (probes.length >= count) break;
  }
  return probes;
}

function makeTour(routeIds, edgeIds, totalDurationS) {
  return {
    stops: routeIds.map((id, order) => ({ id, nodeId: id, lat: null, lon: null, order })),
    path: routeIds,
    edges: edgeIds,
    totalDurationS,
    dwellSecPerStop: 0,
  };
}

function routeEdge(from, to, distanceM, durationS, extra = {}) {
  return { id: `${from}->${to}`, from, to, kind: "connector", roadClass: "secondary", distanceM, durationS, leisureCost: 1, scenicScore: 0.2, ...extra };
}

function junction(id, lat, lon) {
  return { id, kind: "junction", name: id, lat, lon, elev: 800 };
}

function poi(id, lat, lon, categories, score, extra = {}) {
  return { id, kind: "poi", name: id, lat, lon, categories, score, themes: [], ...extra };
}

function minDistanceKm(point, line) {
  const { haversineM } = requireGraphSyncShim;
  return Math.min(...line.map((candidate) => haversineM(point, candidate) / 1000));
}

const requireGraphSyncShim = {
  haversineM(a, b) {
    const lat1 = toRad(Number(a.lat));
    const lat2 = toRad(Number(b.lat));
    const dLat = toRad(Number(b.lat) - Number(a.lat));
    const dLon = toRad(Number(b.lon) - Number(a.lon));
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
  },
};

function sumEdgeField(graph, tour, field) {
  return tour.edges.reduce((sum, edgeId) => sum + (Number(graph.edgeById.get(edgeId)?.[field]) || 0), 0);
}

function spansLocalLunch(startTime, totalDriveS) {
  const start = startTime.getHours() + startTime.getMinutes() / 60;
  const end = start + totalDriveS / 3600;
  return start <= 14 && end >= 11;
}

function coord(point) {
  if (Array.isArray(point) && point.length >= 2) return { lat: Number(point[0]), lon: Number(point[1]) };
  if (point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon))) return { lat: Number(point.lat), lon: Number(point.lon) };
  return null;
}

function deg(km) {
  return km / 111.195;
}

function toRad(value) {
  return value * Math.PI / 180;
}
