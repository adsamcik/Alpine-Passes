const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const graphModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "graph.js")).href);
const corridorModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "corridor.js")).href);

test("empty tour returns empty corridor tiers", async () => {
  const [{ findCorridorPois }, graph] = await Promise.all([
    corridorModule,
    makeGraph([poi("p", 0, 0, { score: 9 })]),
  ]);

  const result = findCorridorPois(graph, { stops: [], edges: [] });

  assert.deepEqual(result.autoInclude, []);
  assert.deepEqual(result.suggestions, []);
  assert.deepEqual(result.drawer, []);
});

test("POI directly on a tour vertex has zero detour and auto-includes when qualified", async () => {
  const [{ findCorridorPois }, graph] = await Promise.all([
    corridorModule,
    makeGraph([poi("on-route", 0, 0, { score: 8.5, categories: ["viewpoint"] })]),
  ]);

  const result = findCorridorPois(graph, baseTour());

  assert.equal(result.autoInclude.length, 1);
  assert.equal(result.autoInclude[0].poiId, "on-route");
  assert.equal(result.autoInclude[0].detourMin, 0);
});

test("POI four kilometres from a tour vertex reports a reasonable side-road detour", async () => {
  const [{ findCorridorPois }, graph] = await Promise.all([
    corridorModule,
    makeGraph([poi("four-km", 4, 0, { score: 8.5, categories: ["viewpoint"] })]),
  ]);

  const result = findCorridorPois(graph, baseTour());
  const item = result.suggestions.find((candidate) => candidate.poiId === "four-km");

  assert.ok(item, "expected four-km POI as a suggestion");
  assert.ok(item.detourMin >= 13 && item.detourMin <= 14, `detour ${item.detourMin}`);
});

test("POI thirty kilometres away is outside the corridor tiers", async () => {
  const [{ findCorridorPois }, graph] = await Promise.all([
    corridorModule,
    makeGraph([poi("far-away", 30, 0, { score: 10 })]),
  ]);

  const result = findCorridorPois(graph, baseTour());

  assert.equal(result.autoInclude.length + result.suggestions.length + result.drawer.length, 0);
});

test("autoIncludeMaxDetourMin can cut near POIs out of auto-inclusion", async () => {
  const [{ findCorridorPois }, graph] = await Promise.all([
    corridorModule,
    makeGraph([poi("near", 4, 0, { score: 9 })]),
  ]);

  const result = findCorridorPois(graph, baseTour(), { autoIncludeMaxDetourMin: 1 });

  assert.equal(result.autoInclude.length, 0);
  assert.equal(result.suggestions[0].poiId, "near");
});

test("excludeIds removes a corridor POI from every tier", async () => {
  const [{ findCorridorPois }, graph] = await Promise.all([
    corridorModule,
    makeGraph([poi("skip-me", 0, 0, { score: 9 })]),
  ]);

  const result = findCorridorPois(graph, baseTour(), { excludeIds: new Set(["skip-me"]) });

  assert.equal(result.autoInclude.length + result.suggestions.length + result.drawer.length, 0);
});

test("requested themes boost matching POIs to the top of suggestions", async () => {
  const pois = [
    poi("plain-view", 3, 0, { score: 8.5, categories: ["viewpoint"], themes: ["panoramic-view"] }),
    poi("food-stop", 3, 0, { score: 7, categories: ["restaurant"], themes: ["food-drink"] }),
  ];
  const [{ findCorridorPois }, graph] = await Promise.all([corridorModule, makeGraph(pois)]);

  const result = findCorridorPois(graph, baseTour(), { themes: ["food-drink"], autoIncludeMaxDetourMin: 0 });

  assert.equal(result.suggestions[0].poiId, "food-stop");
});

test("maxAutoIncludePerHour zero moves all auto candidates to suggestions", async () => {
  const [{ findCorridorPois }, graph] = await Promise.all([
    corridorModule,
    makeGraph([poi("auto-poi", 0, 0, { score: 9 })]),
  ]);

  const result = findCorridorPois(graph, baseTour(), { maxAutoIncludePerHour: 0 });

  assert.equal(result.autoInclude.length, 0);
  assert.equal(result.suggestions[0].poiId, "auto-poi");
});

test("maxSuggestionsTotal caps suggestion count", async () => {
  const pois = Array.from({ length: 6 }, (_, i) => poi(`suggest-${i}`, 4 + i * 0.1, 0, { score: 7 + i * 0.1 }));
  const [{ findCorridorPois }, graph] = await Promise.all([corridorModule, makeGraph(pois)]);

  const result = findCorridorPois(graph, baseTour(), { maxSuggestionsTotal: 3 });

  assert.equal(result.suggestions.length, 3);
  assert.ok(result.drawer.length >= 3);
});

test("detourBudgetMin limits accepted auto-include detour sum", async () => {
  const pois = Array.from({ length: 3 }, (_, i) => poi(`auto-${i}`, 2 + i * 0.1, 0, { score: 9 - i * 0.1 }));
  const [{ findCorridorPois }, graph] = await Promise.all([corridorModule, makeGraph(pois)]);

  const result = findCorridorPois(graph, baseTour(), {
    autoIncludeMaxDetourMin: 10,
    maxAutoIncludePerHour: 10,
    detourBudgetMin: 5,
  });
  const sum = result.autoInclude.reduce((total, item) => total + item.detourMin, 0);

  assert.ok(sum <= 5, `auto detour sum ${sum}`);
  assert.ok(result.suggestions.length > 0);
});

test("hidden-gem mode ranks sparse high-score POIs over equally scored popular POIs", async () => {
  const pois = [
    poi("popular", 3, 0, { score: 9, categories: ["viewpoint", "museum", "restaurant", "lake"] }),
    poi("gem", 3, 0, { score: 9, categories: ["viewpoint"] }),
  ];
  const [{ findCorridorPois }, graph] = await Promise.all([corridorModule, makeGraph(pois)]);

  const result = findCorridorPois(graph, baseTour(), { mode: "hidden-gem", autoIncludeMaxDetourMin: 0 });

  assert.equal(result.suggestions[0].poiId, "gem");
});

test("diagnostic counts cover corridor result counts", async () => {
  const pois = [
    poi("auto", 0, 0, { score: 9 }),
    poi("suggest", 4, 0, { score: 8 }),
    poi("far", 30, 0, { score: 10 }),
  ];
  const [{ findCorridorPois }, graph] = await Promise.all([corridorModule, makeGraph(pois)]);

  const result = findCorridorPois(graph, baseTour());

  assert.ok(result.diagnostics.candidatesScanned >= result.diagnostics.corridorPoiCount);
  assert.ok(result.diagnostics.corridorPoiCount >= result.autoInclude.length + result.suggestions.length);
});

test("insertionIndex can point after the final non-return tour stop", async () => {
  const routeNodes = [routeNode("a", 0), routeNode("b", 1), routeNode("c", 2), routeNode("d", 3)];
  const [{ findCorridorPois }, graph] = await Promise.all([
    corridorModule,
    makeGraph([poi("after-last", 0, 3, { score: 9 })], routeNodes),
  ]);

  const result = findCorridorPois(graph, tourForRoute(routeNodes, 240));

  assert.equal(result.autoInclude[0].insertionIndex, 4);
});

test("corridor POI scan stays under 100ms for 100 POIs and a 50-stop tour", async () => {
  const routeNodes = Array.from({ length: 50 }, (_, i) => routeNode(`r${i}`, i));
  const pois = Array.from({ length: 100 }, (_, i) => poi(`p${i}`, 1 + (i % 5) * 0.2, i % 50, { score: 6 + (i % 4) }));
  const [{ findCorridorPois }, graph] = await Promise.all([corridorModule, makeGraph(pois, routeNodes)]);
  const tour = tourForRoute(routeNodes, 50 * 60);
  const started = performance.now();

  const result = findCorridorPois(graph, tour);
  const elapsedMs = performance.now() - started;

  assert.ok(result.autoInclude.length + result.suggestions.length + result.drawer.length > 0);
  assert.ok(elapsedMs < 100, `corridor scan took ${elapsedMs.toFixed(3)}ms`);
});

async function makeGraph(pois = [], routeNodes = [routeNode("a", 0), routeNode("b", 10)]) {
  const { LeisureGraph } = await graphModule;
  const edges = [];
  for (let i = 0; i < routeNodes.length - 1; i += 1) {
    edges.push(edge(routeNodes[i].id, routeNodes[i + 1].id, {
      distanceM: 1000,
      durationS: 60,
      leisureCost: 1,
    }));
  }
  return new LeisureGraph({
    version: "test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    stats: { nodes: routeNodes.length + pois.length, edges: edges.length },
    nodes: [...routeNodes, ...pois],
    edges,
  });
}

function baseTour() {
  return tourForRoute([routeNode("a", 0), routeNode("b", 10)], 600);
}

function tourForRoute(routeNodes, totalDurationS) {
  return {
    stops: routeNodes.map((node, order) => ({ id: node.id, nodeId: node.id, lat: node.lat, lon: node.lon, order })),
    path: routeNodes.map((node) => node.id),
    edges: routeNodes.slice(0, -1).map((node, index) => `${node.id}->${routeNodes[index + 1].id}`),
    totalDurationS,
  };
}

function routeNode(id, alongKm) {
  return { id, kind: "junction", name: id, lat: 0, lon: deg(alongKm) };
}

function poi(id, offKm, alongKm, extra = {}) {
  return {
    id,
    kind: "poi",
    name: id,
    lat: deg(offKm),
    lon: deg(alongKm),
    score: 8,
    categories: ["viewpoint"],
    themes: [],
    visitDwellSec: 900,
    ...extra,
  };
}

function edge(from, to, extra = {}) {
  return {
    id: `${from}->${to}`,
    from,
    to,
    kind: "connector",
    distanceM: 100,
    durationS: 60,
    leisureCost: 1,
    ...extra,
  };
}

function deg(km) {
  return km / 111.195;
}
