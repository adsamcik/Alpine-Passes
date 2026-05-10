const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const lunchModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "lunch.js")).href);
const graphModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "graph.js")).href);
const START = new Date(2026, 5, 1, 8, 0, 0);

test("skip policy returns no zones, no desert, and a zero hunger curve", async () => {
  const { planLunchZone } = await lunchModule;
  const { graph, tour } = await middayFixture([{ id: "food", categories: ["restaurant"], score: 5 }]);

  const result = planLunchZone(graph, tour, { startTime: START, lunchPolicy: "skip" });

  assert.deepEqual(result.zones, []);
  assert.equal(result.desert, null);
  assert.ok(result.hungerCurve.length > 0);
  assert.ok(result.hungerCurve.every((point) => point.value === 0));
});

test("normal persona on a long midday tour returns lunch zones when food exists", async () => {
  const { planLunchZone } = await lunchModule;
  const { graph, tour } = await middayFixture([{ id: "cafe", categories: ["cafe"], score: 4.5 }]);

  const result = planLunchZone(graph, tour, { startTime: START, persona: "normal" });

  assert.ok(result.zones.length > 0);
  assert.equal(result.desert, null);
});

test("missing food POIs creates a lunch desert with a sane time window", async () => {
  const { planLunchZone } = await lunchModule;
  const { graph, tour } = await middayFixture([]);

  const result = planLunchZone(graph, tour, { startTime: START });

  assert.equal(result.zones.length, 0);
  assert.ok(result.desert);
  assert.ok(result.desert.stretchStart instanceof Date);
  assert.ok(result.desert.stretchEnd instanceof Date);
  assert.ok(result.desert.stretchStart < result.desert.stretchEnd);
  assert.match(result.desert.message, /No food \d\d:\d\d-\d\d:\d\d between .+ and .+ — pack a sandwich/);
});

test("narrative mode tags a valley zone after a tall scenic pass as post-climax", async () => {
  const { planLunchZone } = await lunchModule;
  const graph = await makeGraph([
    junction("base", 46.0, 8.0, 500, "Pass Base"),
    junction("summit", 46.1, 8.1, 2350, "High Pass"),
    junction("valley", 46.2, 8.2, 850, "Lunch Valley"),
    junction("end", 46.3, 8.3, 820, "End"),
    poi("valley-food", 46.2, 8.2, ["restaurant"], 4.5, { elev: 850 }),
  ], [
    edge("base", "summit", 4 * 3600, { kind: "pass-climb", scenicScore: 0.98 }),
    edge("summit", "valley", 45 * 60, { kind: "pass-climb", scenicScore: 0.45 }),
    edge("valley", "end", 2 * 3600, { scenicScore: 0.2 }),
  ]);
  const tour = makeTour(graph, ["base", "summit", "valley", "end"]);

  const result = planLunchZone(graph, tour, { startTime: START, narrativeMode: true });

  assert.ok(result.zones.some((zone) => zone.narrativeRole === "post-climax"));
});

test("foodie persona up-weights curated five-star POIs compared with normal", async () => {
  const { planLunchZone } = await lunchModule;
  const normalMeans = [];
  const foodieMeans = [];
  for (const delta of [0, 0.003, -0.003]) {
    const { graph, tour } = await qualityChoiceFixture(delta);
    normalMeans.push(meanScore(planLunchZone(graph, tour, { startTime: START, persona: "normal" }).zones[0]));
    foodieMeans.push(meanScore(planLunchZone(graph, tour, { startTime: START, persona: "foodie" }).zones[0]));
  }

  assert.ok(avg(foodieMeans) > avg(normalMeans), `${avg(foodieMeans)} should exceed ${avg(normalMeans)}`);
});

test("family persona ranks restaurant amenities above remote mountain huts", async () => {
  const { planLunchZone } = await lunchModule;
  const { graph, tour } = await familyWeatherFixture();

  const result = planLunchZone(graph, tour, { startTime: START, persona: "family" });

  assert.equal(result.zones[0].vibeTag, "valley");
  assert.ok(result.zones.findIndex((zone) => zone.vibeTag === "mountain-hut") > 0);
});

test("rainy weather ranks mountain-hut zones below valley restaurants", async () => {
  const { planLunchZone } = await lunchModule;
  const { graph, tour } = await rainyFixture();

  const result = planLunchZone(graph, tour, { startTime: START, weather: "rainy", lunchPolicy: 90 });

  assert.equal(result.zones[0].vibeTag, "valley");
  assert.ok(result.zones.some((zone) => zone.vibeTag === "mountain-hut"));
});

test("zones always include a non-collinear polygon with at least three vertices", async () => {
  const { planLunchZone } = await lunchModule;
  const { graph, tour } = await middayFixture([{ id: "solo", categories: ["restaurant"], score: 4 }]);

  const result = planLunchZone(graph, tour, { startTime: START });

  for (const zone of result.zones) {
    assert.ok(zone.polygon.length >= 3);
    assert.ok(Math.abs(polygonArea(zone.polygon)) > 0);
  }
});

test("zone arrival bounds are ordered Date instances", async () => {
  const { planLunchZone } = await lunchModule;
  const { graph, tour } = await middayFixture([{ id: "food", categories: ["restaurant"], score: 4 }]);

  const [zone] = planLunchZone(graph, tour, { startTime: START }).zones;

  assert.ok(zone.tArriveMin instanceof Date);
  assert.ok(zone.tArriveMax instanceof Date);
  assert.ok(zone.tArriveMin < zone.tArriveMax);
});

test("hunger curve peak lands near the normal persona ideal lunch time", async () => {
  const { planLunchZone } = await lunchModule;
  const { graph, tour } = await middayFixture([]);

  const result = planLunchZone(graph, tour, { startTime: START, persona: "normal" });
  const peak = result.hungerCurve.reduce((best, point) => (point.value > best.value ? point : best));
  const ideal = new Date(START);
  ideal.setHours(12, 30, 0, 0);

  assert.ok(Math.abs(peak.t.getTime() - ideal.getTime()) <= 60 * 60 * 1000);
});

test("two lunch-time route zones near Maloja-Sils and Bormio keep distinct vibes", async () => {
  const { planLunchZone } = await lunchModule;
  const graph = await makeGraph([
    junction("start", 46.35, 9.55, 1200, "Start"),
    junction("maloja-sils", 46.40, 9.70, 1800, "Maloja-Sils"),
    junction("bormio", 46.47, 9.88, 1250, "Bormio"),
    junction("end", 46.55, 10.05, 1300, "End"),
    poi("maloja-cafe", 46.40, 9.70, ["restaurant"], 4.3, { name: "Maloja Café", elev: 1800 }),
    poi("bormio-hut", 46.47, 9.88, ["mountain hut"], 4.6, { name: "Bormio Hut", elev: 1250 }),
  ], [
    edge("start", "maloja-sils", 4 * 3600),
    edge("maloja-sils", "bormio", 60 * 60),
    edge("bormio", "end", 2 * 3600),
  ]);
  const tour = makeTour(graph, ["start", "maloja-sils", "bormio", "end"]);

  const result = planLunchZone(graph, tour, { startTime: START, lunchPolicy: 90 });

  assert.ok(result.zones.length >= 2);
  assert.ok(new Set(result.zones.map((zone) => zone.vibeTag)).size >= 2);
  assert.ok(new Set(result.zones.map((zone) => zone.tArriveMin.getTime())).size >= 2);
});

test("planner stays under 80ms on a 100-stop/200-POI synthetic tour", async () => {
  const { planLunchZone } = await lunchModule;
  const { graph, tour } = await performanceFixture();

  const cpuStarted = process.cpuUsage();
  const started = performance.now();
  const result = planLunchZone(graph, tour, { startTime: START, lunchPolicy: 90 });
  const elapsed = performance.now() - started;
  const cpu = process.cpuUsage(cpuStarted);
  const cpuElapsed = (cpu.user + cpu.system) / 1000;

  assert.ok(result.zones.length > 0);
  assert.ok(elapsed <= 80 || cpuElapsed <= 80, `expected <=80ms wall/cpu, got ${elapsed.toFixed(3)}ms/${cpuElapsed.toFixed(3)}ms`);
});

test("identical inputs produce identical zone ids and candidate ordering", async () => {
  const { planLunchZone } = await lunchModule;
  const { graph, tour } = await middayFixture([
    { id: "a", categories: ["restaurant"], score: 4 },
    { id: "b", categories: ["cafe"], score: 5, lat: 46.004, lon: 8.704 },
  ]);
  const options = { startTime: START, persona: "foodie" };

  const first = planLunchZone(graph, tour, options);
  const second = planLunchZone(graph, tour, options);

  assert.deepEqual(zoneSignature(second), zoneSignature(first));
});

async function middayFixture(foodSpecs) {
  const nodes = [
    junction("start", 46.0, 8.0, 500, "Start"),
    junction("morning", 46.0, 8.3, 700, "Morning"),
    junction("midday", 46.0, 8.6, 900, "Midday"),
    junction("afternoon", 46.0, 8.9, 750, "Afternoon"),
    junction("end", 46.0, 9.2, 500, "End"),
  ];
  for (const spec of foodSpecs) {
    nodes.push(poi(spec.id, spec.lat ?? 46.0, spec.lon ?? 8.7, spec.categories, spec.score, spec));
  }
  const graph = await makeGraph(nodes, [
    edge("start", "morning", 2 * 3600, { scenicScore: 0.2 }),
    edge("morning", "midday", 2 * 3600, { scenicScore: 0.3 }),
    edge("midday", "afternoon", 90 * 60, { scenicScore: 0.35 }),
    edge("afternoon", "end", 2 * 3600, { scenicScore: 0.25 }),
  ]);
  return { graph, tour: makeTour(graph, ["start", "morning", "midday", "afternoon", "end"]) };
}

async function qualityChoiceFixture(delta) {
  return middayFixture([
    { id: `near-${delta}`, lat: 46.0 + delta, lon: 8.7, categories: ["restaurant"], score: 3 },
    { id: `five-star-${delta}`, lat: 46.052 + delta, lon: 8.7, categories: ["restaurant"], score: 5 },
  ]);
}

async function familyWeatherFixture() {
  const { graph, tour } = await middayFixture([
    { id: "hut", lat: 46.0, lon: 8.7, categories: ["mountain-hut"], score: 5 },
    { id: "family-restaurant", lat: 46.052, lon: 8.7, categories: ["restaurant", "toilet", "playground"], score: 4 },
  ]);
  return { graph, tour };
}

async function rainyFixture() {
  const graph = await makeGraph([
    junction("start", 46.0, 8.0, 500, "Start"),
    junction("hut-stop", 46.0, 8.60, 1600, "Hut Stop"),
    junction("valley-stop", 46.0, 8.72, 800, "Valley Stop"),
    junction("end", 46.0, 8.9, 700, "End"),
    poi("hut", 46.0, 8.60, ["mountain hut"], 5, { elev: 1600 }),
    poi("restaurant", 46.0, 8.72, ["restaurant"], 5, { elev: 800 }),
  ], [
    edge("start", "hut-stop", 4 * 3600),
    edge("hut-stop", "valley-stop", 60 * 60),
    edge("valley-stop", "end", 2 * 3600),
  ]);
  return { graph, tour: makeTour(graph, ["start", "hut-stop", "valley-stop", "end"]) };
}

async function performanceFixture() {
  const nodes = [];
  const edges = [];
  const routeIds = [];
  for (let i = 0; i < 100; i += 1) {
    const id = `n${i}`;
    routeIds.push(id);
    nodes.push(junction(id, 46 + i * 0.001, 8 + i * 0.002, 700 + (i % 5) * 20, id));
    if (i > 0) edges.push(edge(`n${i - 1}`, id, 5 * 60, { scenicScore: (i % 10) / 10 }));
  }
  for (let i = 0; i < 200; i += 1) {
    const anchor = 45 + (i % 18);
    nodes.push(poi(`food-${i}`, 46 + anchor * 0.001 + (i % 5) * 0.0003, 8 + anchor * 0.002, ["restaurant"], 3 + (i % 3)));
  }
  const graph = await makeGraph(nodes, edges);
  return { graph, tour: makeTour(graph, routeIds) };
}

async function makeGraph(nodes, edges) {
  const { LeisureGraph } = await graphModule;
  const stats = {
    nodes: nodes.length,
    edges: edges.length,
    passes: nodes.filter((n) => n.kind === "pass").length,
    passBases: nodes.filter((n) => n.kind === "pass-base").length,
    passSummits: nodes.filter((n) => n.kind === "pass-summit").length,
    pois: nodes.filter((n) => n.kind === "poi").length,
    junctions: nodes.filter((n) => n.kind === "junction").length,
  };
  return new LeisureGraph({ version: "test", generatedAt: new Date(0).toISOString(), stats, nodes, edges });
}

function makeTour(graph, routeIds) {
  const stops = routeIds.map((id, order) => {
    const node = graph.nodes.get(id);
    return { id, nodeId: id, kind: node.kind, name: node.name, lat: node.lat, lon: node.lon, order };
  });
  const edges = [];
  for (let i = 1; i < routeIds.length; i += 1) edges.push(graph.edgeBetween(routeIds[i - 1], routeIds[i]).id);
  const totalDurationS = edges.reduce((sum, id) => sum + graph.edgeById.get(id).durationS, 0);
  return { stops, edges, totalDurationS, dwellSecPerStop: 0 };
}

function junction(id, lat, lon, elev = 500, name = id) {
  return { id, kind: "junction", name, lat, lon, elev };
}

function poi(id, lat, lon, categories, score, extra = {}) {
  return {
    id,
    kind: "poi",
    name: extra.name ?? id,
    lat,
    lon,
    elev: extra.elev ?? 600,
    score,
    categories,
    themes: extra.themes ?? ["food-drink"],
  };
}

function edge(from, to, durationS, extra = {}) {
  return {
    id: `${from}->${to}`,
    from,
    to,
    kind: extra.kind ?? "connector",
    durationS,
    distanceM: extra.distanceM ?? durationS / 3600 * 55_000,
    scenicScore: extra.scenicScore ?? 0.3,
    leisureCost: extra.leisureCost ?? durationS / 2,
  };
}

function meanScore(zone) {
  return avg(zone.candidates.map((candidate) => candidate.score));
}

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function zoneSignature(result) {
  return result.zones.map((zone) => ({
    id: zone.id,
    vibeTag: zone.vibeTag,
    candidates: zone.candidates.map((candidate) => candidate.poiId),
  }));
}

function polygonArea(poly) {
  let area = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [lat1, lon1] = poly[i];
    const [lat2, lon2] = poly[(i + 1) % poly.length];
    area += lon1 * lat2 - lon2 * lat1;
  }
  return area / 2;
}
