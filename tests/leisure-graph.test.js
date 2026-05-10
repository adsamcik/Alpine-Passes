const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const repoRoot = path.resolve(__dirname, "..");
const graphPath = path.join(repoRoot, "assets", "data", "leisure-graph.v1.json");
const calibrationTruthPath = path.join(repoRoot, "tools", "leisure", "calibration-truth.json");
const graphSource = fs.readFileSync(graphPath, "utf8");
const graph = JSON.parse(graphSource);
const calibrationTruth = JSON.parse(fs.readFileSync(calibrationTruthPath, "utf8"));
const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
const passNodes = graph.nodes.filter((node) => node.kind === "pass");
const passBaseNodes = graph.nodes.filter((node) => node.kind === "pass-base");
const passSummitNodes = graph.nodes.filter((node) => node.kind === "pass-summit");
const poiNodes = graph.nodes.filter((node) => node.kind === "poi");
const junctionNodes = graph.nodes.filter((node) => node.kind === "junction");
const routeCoords = buildRouteCoordMap();
const edgeByKey = new Map(graph.edges.map((edge) => [`${edge.from}->${edge.to}`, edge]));

test("leisure graph schema has required top-level fields and matching stats", () => {
  for (const field of ["version", "generatedAt", "stats", "nodes", "edges"]) {
    assert.ok(Object.hasOwn(graph, field), `missing top-level ${field}`);
  }

  assert.equal(typeof graph.version, "string");
  assert.ok(Number.isFinite(Date.parse(graph.generatedAt)));
  assert.ok(Array.isArray(graph.nodes));
  assert.ok(Array.isArray(graph.edges));
  assert.equal(graph.stats.nodes, graph.nodes.length);
  assert.equal(graph.stats.passes + graph.stats.passBases + graph.stats.passSummits + graph.stats.pois + graph.stats.junctions, graph.nodes.length);
  assert.equal(graph.stats.edges, graph.edges.length);
});

test("leisure graph nodes have stable IDs, coordinates, and kind-specific data", () => {
  const ids = new Set();
  for (const [index, node] of graph.nodes.entries()) {
    assert.equal(typeof node.id, "string", `node ${index} id`);
    assert.equal(typeof node.kind, "string", `${node.id} kind`);
    assert.equal(typeof node.name, "string", `${node.id} name`);
    assertFiniteCoord(node, node.id);
    assert.ok(!ids.has(node.id), `duplicate node id ${node.id}`);
    ids.add(node.id);
  }

  for (const pass of passNodes) {
    assert.doesNotMatch(pass.id, /^p\d+$/, `${pass.id} should be a stable slug, not an ordinal id`);
    assertFiniteNumber(pass.scenicScore, `${pass.id} scenicScore`);
    assertBaseCoord(pass.baseA, `${pass.id}:A`);
    assertBaseCoord(pass.baseB, `${pass.id}:B`);
    const baseA = nodeById.get(`${pass.id}:A`);
    const summit = nodeById.get(`${pass.id}:S`);
    const baseB = nodeById.get(`${pass.id}:B`);
    assert.equal(baseA?.kind, "pass-base", `${pass.id} missing base A node`);
    assert.equal(summit?.kind, "pass-summit", `${pass.id} missing summit node`);
    assert.equal(baseB?.kind, "pass-base", `${pass.id} missing base B node`);
    assert.deepEqual([baseA.lat, baseA.lon], pass.baseA);
    assert.deepEqual([summit.lat, summit.lon], [pass.lat, pass.lon]);
    assert.deepEqual([baseB.lat, baseB.lon], pass.baseB);
  }

  assert.equal(passBaseNodes.length, passNodes.length * 2);
  assert.equal(passSummitNodes.length, passNodes.length);

  for (const poi of poiNodes) {
    assertFiniteNumber(poi.score, `${poi.id} score`);
    assert.ok(Array.isArray(poi.categories), `${poi.id} categories`);
  }

  for (const junction of junctionNodes) {
    for (const forbidden of ["scenicScore", "score", "categories", "baseA", "baseB", "themes", "summitParking", "viewpoints", "visitDwellSec"]) {
      assert.equal(Object.hasOwn(junction, forbidden), false, `${junction.id} should not expose ${forbidden}`);
    }
  }
});

test("leisure graph edges reference valid route stops and pass climb typing is complete", () => {
  for (const [index, edge] of graph.edges.entries()) {
    assert.equal(typeof edge.kind, "string", `edge ${index} kind`);
    assertFiniteNumber(edge.distanceM, `edge ${index} distanceM`);
    assert.ok(edge.distanceM > 0, `edge ${index} distanceM > 0`);
    assertFiniteNumber(edge.durationS, `edge ${index} durationS`);
    assert.ok(edge.durationS > 0, `edge ${index} durationS > 0`);
    assertFiniteNumber(edge.leisureCost, `edge ${index} leisureCost`);
    assert.ok(edge.leisureCost >= 0, `edge ${index} leisureCost >= 0`);
    assert.ok(routeCoords.has(edge.from), `edge ${index} has unknown from ${edge.from}`);
    assert.ok(routeCoords.has(edge.to), `edge ${index} has unknown to ${edge.to}`);

    if (edge.kind === "connector") {
      assert.notEqual(edge.from, edge.to, `connector ${edge.from}->${edge.to} should not self-loop`);
      assert.notEqual(stopOwner(edge.from), stopOwner(edge.to), `connector ${edge.from}->${edge.to} links one stop owner`);
      assert.ok(edge.source === "osrm" || edge.source === "fallback", `connector ${edge.from}->${edge.to} source`);
    }
  }

  for (const pass of passNodes) {
    const expected = new Set([
      `${pass.id}:A->${pass.id}:S`,
      `${pass.id}:S->${pass.id}:A`,
      `${pass.id}:S->${pass.id}:B`,
      `${pass.id}:B->${pass.id}:S`,
    ]);
    const actual = graph.edges
      .filter((edge) => edge.kind === "pass-climb" && edge.passId === pass.id)
      .map((edge) => `${edge.from}->${edge.to}`);
    assert.deepEqual(new Set(actual), expected, `${pass.id} should have all four directed pass-climb edges`);
  }
});

test("pass out-and-back costs are strictly higher than corresponding traverses", () => {
  const failures = [];
  for (const pass of passNodes) {
    const aOut = requiredEdge(`${pass.id}:A`, `${pass.id}:A`);
    const bOut = requiredEdge(`${pass.id}:B`, `${pass.id}:B`);
    const aTraverse = requiredEdge(`${pass.id}:A`, `${pass.id}:S`).leisureCost
      + requiredEdge(`${pass.id}:S`, `${pass.id}:B`).leisureCost;
    const bTraverse = requiredEdge(`${pass.id}:B`, `${pass.id}:S`).leisureCost
      + requiredEdge(`${pass.id}:S`, `${pass.id}:A`).leisureCost;

    if (!(aOut.leisureCost > aTraverse)) failures.push(`${pass.id} A ${pass.name}: out=${aOut.leisureCost} traverse=${round(aTraverse)}`);
    if (!(bOut.leisureCost > bTraverse)) failures.push(`${pass.id} B ${pass.name}: out=${bOut.leisureCost} traverse=${round(bTraverse)}`);
  }

  assert.deepEqual(failures, [], `out-and-back invariant failures:\n${failures.slice(0, 20).join("\n")}`);
});

test("fallback connector distances stay within haversine sanity bounds", () => {
  const failures = [];
  for (const edge of graph.edges.filter((item) => item.kind === "connector")) {
    if (edge.source !== "fallback") continue;
    const from = routeCoords.get(edge.from);
    const to = routeCoords.get(edge.to);
    const direct = haversineM(from, to);
    if (!(direct > 0 && edge.distanceM >= direct && edge.distanceM <= direct * 2)) {
      failures.push(`${edge.from}->${edge.to} distance=${edge.distanceM} haversine=${Math.round(direct)} ratio=${round(edge.distanceM / direct)}`);
    }
  }

  assert.deepEqual(failures, [], `connector geometry sanity failures:\n${failures.slice(0, 20).join("\n")}`);
});

test("passes and POIs are reachable from at least one junction over directed edges", () => {
  const seen = new Set(junctionNodes.map((node) => node.id));
  const queue = [...seen];
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }

  for (let index = 0; index < queue.length; index += 1) {
    for (const next of adjacency.get(queue[index]) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }

  const isolated = [];
  for (const pass of passNodes) {
    if (![`${pass.id}:A`, `${pass.id}:S`, `${pass.id}:B`].some((stopId) => seen.has(stopId))) {
      isolated.push(`${pass.id} ${pass.name}`);
    }
  }
  for (const poi of poiNodes) {
    if (!seen.has(poi.id)) isolated.push(`${poi.id} ${poi.name}`);
  }

  if (isolated.length) console.warn(`isolated leisure nodes (${isolated.length}): ${isolated.join("; ")}`);
  const maxIsolated = Math.ceil((passNodes.length + poiNodes.length) * 0.04);
  assert.ok(isolated.length <= maxIsolated, `expected at most ${maxIsolated} isolated pass/POI nodes, found ${isolated.length}`);
});

test("hero calibration stays aligned with curated scenic scores", () => {
  const rawBySignature = new Map(loadRawPasses().map((raw) => [rawPassSignature(raw), raw]));
  const heroSubstrings = calibrationTruth.heroes.map(normalizeName);
  const rows = passNodes.map((node) => {
    const raw = rawBySignature.get(nodePassSignature(node)) ?? {};
    return {
      id: node.id,
      curated: normalizeScore01(raw.sc),
      scenic: node.scenicScore,
      hero: isHeroPass(raw, heroSubstrings),
    };
  });
  const curatedRows = rows.filter((row) => row.curated > 0);
  const spearman = spearmanCorrelation(curatedRows.map((row) => row.scenic), curatedRows.map((row) => row.curated));
  const topQuartile = new Set(rows
    .slice()
    .sort((a, b) => b.scenic - a.scenic)
    .slice(0, Math.ceil(rows.length / 4))
    .map((row) => row.id));
  const heroes = rows.filter((row) => row.hero);
  const heroesTopQuartile = heroes.filter((row) => topQuartile.has(row.id)).length / heroes.length;

  assert.ok(spearman >= calibrationTruth.thresholds.spearman, `Spearman ${spearman}`);
  assert.ok(heroesTopQuartile >= calibrationTruth.thresholds.heroQuartile, `heroes in top quartile ${heroesTopQuartile}`);
});

test("leisure graph gzip asset stays within budget", () => {
  const gzipBytes = zlib.gzipSync(graphSource).length;

  assert.ok(gzipBytes <= 6 * 1024 * 1024, `gzip size ${gzipBytes} exceeds 6 MB`);
  assert.equal(graph.stats.gzipBytes, gzipBytes);
});

test("leisure graph stats match counted node and edge kinds", () => {
  assert.equal(graph.stats.passes, passNodes.length);
  assert.equal(graph.stats.passBases, passBaseNodes.length);
  assert.equal(graph.stats.passSummits, passSummitNodes.length);
  assert.equal(graph.stats.pois, poiNodes.length);
  assert.equal(graph.stats.junctions, junctionNodes.length);
  assert.equal(graph.stats.nodes, graph.nodes.length);
  assert.equal(graph.stats.edges, graph.edges.length);
});

test("leisure graph reporting metrics are available for diagnostics", () => {
  const connectorOutDegrees = new Map();
  for (const edge of graph.edges.filter((item) => item.kind === "connector")) {
    connectorOutDegrees.set(edge.from, (connectorOutDegrees.get(edge.from) ?? 0) + 1);
  }

  const outAndBackRatios = [];
  for (const pass of passNodes) {
    const aTraverse = requiredEdge(`${pass.id}:A`, `${pass.id}:S`).leisureCost
      + requiredEdge(`${pass.id}:S`, `${pass.id}:B`).leisureCost;
    const bTraverse = requiredEdge(`${pass.id}:B`, `${pass.id}:S`).leisureCost
      + requiredEdge(`${pass.id}:S`, `${pass.id}:A`).leisureCost;
    outAndBackRatios.push(requiredEdge(`${pass.id}:A`, `${pass.id}:A`).leisureCost / aTraverse);
    outAndBackRatios.push(requiredEdge(`${pass.id}:B`, `${pass.id}:B`).leisureCost / bTraverse);
  }

  const scenicByKind = Object.fromEntries([...groupBy(graph.nodes, (node) => node.kind)]
    .map(([kind, nodes]) => [kind, round(mean(nodes.map((node) => (
      Number.isFinite(node.scenicScore) ? node.scenicScore : Number.isFinite(node.score) ? node.score / 10 : null
    )).filter(Number.isFinite)))]));

  console.log(`median connector kNearest outdegree: ${median([...connectorOutDegrees.values()])}`);
  console.log(`average out-and-back/traverse leisureCost ratio: ${round(mean(outAndBackRatios))}`);
  console.log(`mean scenicScore by kind: ${JSON.stringify(scenicByKind)}`);
  assert.ok(true);
});

function buildRouteCoordMap() {
  const coords = new Map();
  for (const node of graph.nodes) {
    coords.set(node.id, { lat: node.lat, lon: node.lon });
    if (node.kind === "pass") {
      coords.set(`${node.id}:S`, { lat: node.lat, lon: node.lon });
      coords.set(`${node.id}:A`, { lat: node.baseA[0], lon: node.baseA[1] });
      coords.set(`${node.id}:B`, { lat: node.baseB[0], lon: node.baseB[1] });
    }
  }
  return coords;
}

function requiredEdge(from, to) {
  const edge = edgeByKey.get(`${from}->${to}`);
  assert.ok(edge, `missing edge ${from}->${to}`);
  return edge;
}

function stopOwner(stopId) {
  const match = /^(.*):[ASB]$/.exec(stopId);
  return match ? match[1] : stopId;
}

function assertBaseCoord(pair, label) {
  assert.ok(Array.isArray(pair), `${label} base coordinate`);
  assert.equal(pair.length, 2, `${label} base coordinate length`);
  assertFiniteNumber(pair[0], `${label} lat`);
  assertFiniteNumber(pair[1], `${label} lon`);
}

function assertFiniteCoord(point, label) {
  assertFiniteNumber(point.lat, `${label} lat`);
  assertFiniteNumber(point.lon, `${label} lon`);
}

function assertFiniteNumber(value, label) {
  assert.equal(typeof value, "number", label);
  assert.ok(Number.isFinite(value), label);
}

function haversineM(a, b) {
  const earthRadiusM = 6_371_000;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(h));
}

function toRad(value) {
  return Number(value) * Math.PI / 180;
}

function loadRawPasses() {
  const source = fs.readFileSync(path.join(repoRoot, "assets", "js", "passes-data.js"), "utf8");
  const match = source.match(/const ALPS_RAW = (.*);\s*$/s);
  assert.ok(match, "Could not parse ALPS_RAW");
  return JSON.parse(match[1]);
}

function rawPassSignature(pass) {
  return [
    normalizeName(pass.n),
    roundCoord(Number(pass.la)),
    roundCoord(Number(pass.lo)),
  ].join("|");
}

function nodePassSignature(node) {
  return [
    normalizeName(node.name),
    roundCoord(Number(node.lat)),
    roundCoord(Number(node.lon)),
  ].join("|");
}

function normalizeScore01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number > 1.5 ? number / 10 : number));
}

function isHeroPass(pass, heroSubstrings) {
  const haystack = normalizeName([pass.n, pass.wt, pass.td, pass.rs].filter(Boolean).join(" "));
  return heroSubstrings.some((hero) => haystack.includes(hero));
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function spearmanCorrelation(xs, ys) {
  return pearson(rank(xs), rank(ys));
}

function rank(values) {
  const sorted = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].value === sorted[i].value) j += 1;
    const avg = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k += 1) ranks[sorted[k].index] = avg;
    i = j;
  }
  return ranks;
}

function pearson(xs, ys) {
  const n = xs.length;
  const meanX = mean(xs);
  const meanY = mean(ys);
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  return denX && denY ? num / Math.sqrt(denX * denY) : 0;
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function roundCoord(value) {
  return Math.round(Number(value) * 100_000) / 100_000;
}
