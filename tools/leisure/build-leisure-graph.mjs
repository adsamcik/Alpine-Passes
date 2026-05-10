#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { extractAssignedArray } from "./lib/extract.mjs";
import {
  clamp,
  coordFromPair,
  dedupePoints,
  fallbackGeometry,
  haversineM,
  isValidCoord,
  normalizeName,
  pointSegmentDistanceM,
  polylineLengthM,
  roundCoord,
  roundNumber,
  segmentProjection,
  slug,
  toLatLonArray,
} from "./lib/geo.mjs";
import {
  leisureCost,
  osrmChunkHash,
  selectKNearestCandidates,
  shortHash,
  statsFor,
  zScore,
} from "./lib/scoring.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const PATHS = {
  passes: path.join(REPO_ROOT, "assets", "js", "passes-data.js"),
  poiDir: path.join(REPO_ROOT, "assets", "js"),
  junctions: path.join(__dirname, "junctions.json"),
  calibrationTruth: path.join(__dirname, "calibration-truth.json"),
  cacheDir: path.join(REPO_ROOT, "validation", "cache"),
  output: path.join(REPO_ROOT, "assets", "data", "leisure-graph.v1.json"),
};

const USER_AGENT = "Alpine-Passes leisure graph builder/1.0 (public API cache; contact: github.com)";
const ALPINE_BOX = { minLat: 44, maxLat: 47.8, minLon: 5.5, maxLon: 14.0 };
const DEFAULT_LIMIT_N = 300;
const TOP_POI_COUNT = 50;
const K_NEAREST = 12;
const MAX_CONNECTOR_M = 300_000;
const OSRM_CHUNK = 50;
const OSRM_MIN_INTERVAL_MS = 1_000;
const OVERPASS_MIN_INTERVAL_MS = 1_000;
const ELEVATION_BATCH = 80;
const ELEVATION_INTERVAL_MS = 5_000;
const GZIP_BUDGET_BYTES = 6 * 1024 * 1024;
const PASS_DESCENT_FACTOR = 0.85; // Alpine descents are modeled as 15% faster than climbs, with unchanged distance.
const OUT_AND_BACK_COST_MULTIPLIER = 1.6;
const OUT_AND_BACK_TRAVERSE_MARGIN = 1.05;

const NON_DRIVING_HIGHWAYS = new Set([
  "footway",
  "path",
  "cycleway",
  "steps",
  "bridleway",
  "pedestrian",
  "service",
  "platform",
  "corridor",
]);
const NON_DRIVING_HIGHWAY_REGEX = `^(${[...NON_DRIVING_HIGHWAYS].join("|")})$`;

const apiClock = {
  osrm: 0,
  overpass: 0,
  elevation: 0,
};
const throttleChains = new Map();

const warnings = [];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(PATHS.cacheDir, { recursive: true });
  await mkdir(path.dirname(PATHS.output), { recursive: true });

  const passes = await loadPasses();
  const pois = await loadPois();
  const junctions = await loadJunctions();
  const calibrationTruth = await loadCalibrationTruth();
  const selected = selectNodeSet(passes, pois, junctions, args.limitN);
  const scenicMap = await loadScenicCache();

  console.log(`selected nodes: passes=${selected.passes.length} pois=${selected.pois.length} junctions=${selected.junctions.length}`);

  const overpassReport = await loadOverpassForPasses(selected.passes, args);
  const featureTable = buildPassFeatures(selected.passes, scenicMap, overpassReport.byPassId);
  const elevationReport = await loadElevations([
    ...selected.passes.map((pass) => ({ id: pass.id, lat: pass.la, lon: pass.lo })),
    ...selected.pois.map((poi) => ({ id: poi.id, lat: poi.la, lon: poi.lo })),
    ...selected.junctions,
  ], args);

  const passNodes = buildPassNodes(selected.passes, featureTable, overpassReport.byPassId, elevationReport.byId);
  const poiNodes = buildPoiNodes(selected.pois, elevationReport.byId);
  const junctionNodes = selected.junctions.map((junction) => ({
    id: junction.id,
    kind: "junction",
    name: junction.name,
    lat: roundCoord(junction.lat),
    lon: roundCoord(junction.lon),
    elev: Math.round(finiteOrNull(elevationReport.byId.get(junction.id)) ?? 0),
  }));

  const routing = buildConnectorRoutingPoints(passNodes, poiNodes, junctionNodes, featureTable);
  const osrmReport = await loadOsrmMatrix(routing.points, args);
  const edges = buildEdges(passNodes, poiNodes, junctionNodes, featureTable, overpassReport.byPassId, routing, osrmReport.matrix);
  const passRoutingNodes = buildPassRoutingNodes(passNodes);
  const nodes = [
    ...passNodes.map(stripPrivateFields),
    ...passRoutingNodes,
    ...poiNodes.map(stripPrivateFields),
    ...junctionNodes,
  ];

  const graph = {
    version: "1",
    generatedAt: new Date().toISOString(),
    stats: {
      passes: passNodes.length,
      passBases: passNodes.length * 2,
      passSummits: passNodes.length,
      pois: poiNodes.length,
      junctions: junctionNodes.length,
      nodes: nodes.length,
      edges: edges.length,
      gzipBytes: 0,
    },
    nodes,
    edges,
  };

  finalizeGzipBytes(graph);
  const serialized = serializeGraph(graph);

  const calibration = calibrate(passNodes, calibrationTruth);
  const gateFailures = validateBuildGates(graph, passNodes, calibration, calibrationTruth, serialized);
  if (gateFailures.length) {
    printSummary(graph.stats, calibration, {
      overpass: overpassReport,
      osrm: osrmReport,
      elevation: elevationReport,
    }, false);
    for (const failure of gateFailures) console.error(failure);
    process.exitCode = 1;
    return;
  }

  await writeFile(PATHS.output, serialized, "utf8");
  printSummary(graph.stats, calibration, {
    overpass: overpassReport,
    osrm: osrmReport,
    elevation: elevationReport,
  }, true);
}

function parseArgs(argv) {
  const args = {
    noCache: false,
    limitN: DEFAULT_LIMIT_N,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-cache") {
      args.noCache = true;
    } else if (arg === "--limit-n") {
      args.limitN = parsePositiveInt(argv[++i], "--limit-n");
    } else if (arg.startsWith("--limit-n=")) {
      args.limitN = parsePositiveInt(arg.slice("--limit-n=".length), "--limit-n");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer`);
  }
  return parsed;
}

async function loadPasses() {
  const source = await readFile(PATHS.passes, "utf8");
  const { value } = extractAssignedArray(source, "ALPS_RAW");
  const passes = value
    .map((rawPass, index) => ({
      pass: normalizePass(rawPass, index),
      missingBaseA: coordFromPair(rawPass.bA) === null,
      missingBaseB: coordFromPair(rawPass.bB) === null,
    }))
    .filter(({ pass, missingBaseA, missingBaseB }) => {
      const inBox = pass.la >= ALPINE_BOX.minLat
        && pass.la <= ALPINE_BOX.maxLat
        && pass.lo >= ALPINE_BOX.minLon
        && pass.lo <= ALPINE_BOX.maxLon;
      if (!inBox) return false;
      if (!isValidCoord({ lat: pass.la, lon: pass.lo })) return false;
      if (missingBaseA || missingBaseB) {
        const sides = [missingBaseA ? "A" : null, missingBaseB ? "B" : null].filter(Boolean).join("/");
        warnOnce(`pass ${pass.n} has no usable b${sides}; synthetic base${missingBaseA && missingBaseB ? "s were" : " was"} generated`);
      }
      return true;
    })
    .map(({ pass }) => pass);
  return assignStablePassIds(passes);
}

function normalizePass(pass, index) {
  const summit = { lat: Number(pass.la), lon: Number(pass.lo) };
  const baseA = coordFromPair(pass.bA) ?? fallbackBase(summit, -1);
  const baseB = coordFromPair(pass.bB) ?? fallbackBase(summit, 1);
  return {
    ...pass,
    cacheId: `p${index + 1}`,
    sourceIndex: index,
    n: String(pass.n ?? `Pass ${index + 1}`),
    la: summit.lat,
    lo: summit.lon,
    e: finiteOrNull(pass.e),
    bA: [roundCoord(baseA.lat), roundCoord(baseA.lon)],
    bB: [roundCoord(baseB.lat), roundCoord(baseB.lon)],
  };
}

function assignStablePassIds(passes) {
  const bases = passes.map(stablePassBase);
  const counts = new Map();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);

  const used = new Set();
  return passes.map((pass, index) => {
    const base = bases[index];
    const collisionHash = shortHash(`${pass.n}|${pass.la}|${pass.lo}|${pass.e ?? ""}`).slice(0, 6);
    let id = counts.get(base) > 1 ? `${base}-${collisionHash}` : base;
    let attempt = 1;
    while (used.has(id)) {
      id = `${base}-${shortHash(`${collisionHash}|${pass.cacheId}|${attempt}`).slice(0, 6)}`;
      attempt += 1;
    }
    used.add(id);
    return { ...pass, id };
  });
}

function stablePassBase(pass) {
  return slug(pass.n) || `pass-${pass.sourceIndex + 1}`;
}

function fallbackBase(summit, direction) {
  return {
    lat: summit.lat,
    lon: summit.lon + direction * 0.06,
  };
}

async function loadPois() {
  let files = [];
  try {
    files = (await readdir(PATHS.poiDir))
      .filter((file) => /-pois\.js$/i.test(file))
      .sort();
  } catch (error) {
    warnOnce(`could not list POI files: ${error.message}`);
    return [];
  }

  const pois = [];
  for (const file of files) {
    const fullPath = path.join(PATHS.poiDir, file);
    try {
      const source = await readFile(fullPath, "utf8");
      const match = /(?:const|let|var)\s+([A-Z0-9_]+_POIS)\s*=/.exec(source);
      const { value, name } = extractAssignedArray(source, match?.[1]);
      if (!Array.isArray(value)) throw new Error(`${name ?? file} did not parse to an array`);
      for (const poi of value) {
        if (!isValidCoord({ lat: Number(poi.la), lon: Number(poi.lo) })) continue;
        pois.push({
          ...poi,
          sourceFile: file,
          la: Number(poi.la),
          lo: Number(poi.lo),
          score: normalizePoiScore(poi),
        });
      }
    } catch (error) {
      warnOnce(`could not parse ${path.join("assets", "js", file)}: ${error.message}`);
    }
  }

  return pois
    .sort((a, b) => b.score - a.score || String(a.n).localeCompare(String(b.n)))
    .map((poi, index) => ({
      ...poi,
      id: `poi${index + 1}`,
      n: String(poi.n ?? `POI ${index + 1}`),
    }));
}

function normalizePoiScore(poi) {
  const raw = finiteOrNull(poi.score) ?? finiteOrNull(poi.sc) ?? 0;
  return clamp(raw, 0, 10);
}

async function loadJunctions() {
  const data = JSON.parse(await readFile(PATHS.junctions, "utf8"));
  return data
    .filter((junction) => isValidCoord(junction))
    .map((junction) => ({
      id: String(junction.id || `j-${slug(junction.name)}`),
      name: String(junction.name),
      lat: Number(junction.lat),
      lon: Number(junction.lon),
    }));
}

async function loadCalibrationTruth() {
  const data = JSON.parse(await readFile(PATHS.calibrationTruth, "utf8"));
  const heroes = Array.isArray(data.heroes)
    ? data.heroes.map(normalizeName).filter(Boolean)
    : [];
  const thresholds = data.thresholds ?? {};
  const spearman = finiteOrNull(thresholds.spearman);
  const heroQuartile = finiteOrNull(thresholds.heroQuartile);
  if (!heroes.length) throw new Error(`${path.relative(REPO_ROOT, PATHS.calibrationTruth)} must define at least one hero substring`);
  if (spearman === null || heroQuartile === null) {
    throw new Error(`${path.relative(REPO_ROOT, PATHS.calibrationTruth)} must define numeric spearman and heroQuartile thresholds`);
  }
  return {
    heroes,
    thresholds: {
      spearman,
      heroQuartile,
    },
  };
}

function selectNodeSet(passes, pois, junctions, limitN) {
  let selectedPasses = passes.slice();
  let selectedPois = pois.slice(0, TOP_POI_COUNT);
  let selectedJunctions = junctions.slice();
  const requestedTotal = selectedPasses.length + selectedPois.length + selectedJunctions.length;

  if (requestedTotal <= limitN) {
    return { passes: selectedPasses, pois: selectedPois, junctions: selectedJunctions };
  }

  if (selectedJunctions.length > limitN) {
    warnOnce(`node cap ${limitN} leaves room for only ${limitN} junctions; passes and POIs omitted`);
    return { passes: [], pois: [], junctions: selectedJunctions.slice(0, limitN) };
  }

  const poiRoom = Math.max(0, limitN - selectedJunctions.length);
  if (selectedPois.length > poiRoom) {
    selectedPois = selectedPois.slice(0, poiRoom);
    selectedPasses = [];
    warnOnce(`node cap ${limitN} left room for ${selectedPois.length} POIs after junctions; passes omitted`);
    return { passes: selectedPasses, pois: selectedPois, junctions: selectedJunctions };
  }

  const remainingAfterJunctionsAndPois = limitN - selectedJunctions.length - selectedPois.length;
  if (selectedPasses.length > remainingAfterJunctionsAndPois) {
    const keepIds = new Set(selectedPasses
      .slice()
      .sort(passPrioritySort)
      .slice(0, remainingAfterJunctionsAndPois)
      .map((pass) => pass.id));
    selectedPasses = selectedPasses.filter((pass) => keepIds.has(pass.id));
    warnOnce(`node cap ${limitN} required keeping ${selectedPasses.length} of ${passes.length} Alpine-box passes after reserving ${selectedPois.length} POIs and ${selectedJunctions.length} junctions`);
  }

  return { passes: selectedPasses, pois: selectedPois, junctions: selectedJunctions };
}

function passPrioritySort(a, b) {
  const scoreA = normalizeScore01(a.sc) * 3 + Number(a.e ?? 0) / 3_000 + normalizeScore01(a.qAp);
  const scoreB = normalizeScore01(b.sc) * 3 + Number(b.e ?? 0) / 3_000 + normalizeScore01(b.qAp);
  return scoreB - scoreA || a.sourceIndex - b.sourceIndex;
}

async function loadScenicCache() {
  const file = path.join(PATHS.cacheDir, "scenic-results-iter3-scaled.json");
  if (!existsSync(file)) {
    warnOnce("scenic-results-iter3-scaled.json missing; scenic features will use source-data proxies");
    return new Map();
  }

  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const entries = Array.isArray(parsed.enriched) ? parsed.enriched : [];
    return new Map(entries.map((entry) => [normalizeName(entry.n), entry]));
  } catch (error) {
    warnOnce(`could not parse scenic cache: ${error.message}`);
    return new Map();
  }
}

async function loadOverpassForPasses(passes, args) {
  const byPassId = new Map();
  const report = {
    byPassId,
    cached: 0,
    fetched: 0,
    failed: 0,
    skippedByCircuit: 0,
  };
  let consecutiveFailures = 0;

  for (const pass of passes) {
    const cachePath = path.join(PATHS.cacheDir, `overpass-${pass.cacheId ?? pass.id}.json`);
    if (!args.noCache && existsSync(cachePath)) {
      try {
        byPassId.set(pass.id, JSON.parse(await readFile(cachePath, "utf8")));
        report.cached += 1;
        continue;
      } catch (error) {
        warnOnce(`could not read ${path.relative(REPO_ROOT, cachePath)}: ${error.message}`);
      }
    }

    if (consecutiveFailures >= 4) {
      report.skippedByCircuit += 1;
      continue;
    }

    try {
      const processed = await fetchOverpassForPass(pass);
      await writeJson(cachePath, processed);
      byPassId.set(pass.id, processed);
      report.fetched += 1;
      consecutiveFailures = 0;
    } catch (error) {
      report.failed += 1;
      consecutiveFailures += 1;
      if (report.failed <= 4) {
        warnOnce(`Overpass unavailable for ${pass.n}: ${error.message}`);
      }
    }
  }

  if (report.skippedByCircuit) {
    warnOnce(`Overpass circuit breaker skipped ${report.skippedByCircuit} passes; scenic validation cache and fallback geometries were used`);
  }

  return report;
}

async function fetchOverpassForPass(pass) {
  const lat = Number(pass.la);
  const lon = Number(pass.lo);
  const bbox = overpassBboxForPass(pass);
  const query = `
[out:json][timeout:25];
(
  way(${bbox})["highway"]["highway"!~"${NON_DRIVING_HIGHWAY_REGEX}"];
  node(${bbox})["natural"~"^(peak|glacier|water)$"];
  way(${bbox})["natural"~"^(glacier|water)$"];
  relation(${bbox})["natural"~"^(glacier|water)$"];
  node(${bbox})["tourism"="viewpoint"];
  way(${bbox})["tourism"="viewpoint"];
  node(around:1200,${lat},${lon})["amenity"="parking"];
  way(${bbox})["landuse"~"^(meadow|grass|grassland|heath|scrub|fell|alpine)$"];
  way(${bbox})["natural"~"^(grassland|fell|scrub|heath|bare_rock|scree)$"];
  way(${bbox})["landuse"~"^(forest|orchard|vineyard)$"];
  way(${bbox})["natural"="wood"];
);
out body center geom;
`;

  await throttle("overpass", OVERPASS_MIN_INTERVAL_MS);
  const json = await fetchJson("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: new URLSearchParams({ data: query }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": USER_AGENT,
    },
    retryStatuses: new Set([429, 500, 502, 503, 504]),
    timeoutMs: 15_000,
    retries: 2,
  });
  return processOverpass(pass, json);
}

function overpassBboxForPass(pass) {
  const summit = { lat: Number(pass.la), lon: Number(pass.lo) };
  const bases = [coordFromPair(pass.bA), coordFromPair(pass.bB)].filter(Boolean);
  const latSpan = Math.max(0.05, ...bases.map((base) => Math.abs(base.lat - summit.lat))) + 0.02;
  const lonSpan = Math.max(0.05, ...bases.map((base) => Math.abs(base.lon - summit.lon))) + 0.02;
  return [
    roundNumber(summit.lat - latSpan, 5),
    roundNumber(summit.lon - lonSpan, 5),
    roundNumber(summit.lat + latSpan, 5),
    roundNumber(summit.lon + lonSpan, 5),
  ].join(",");
}

function processOverpass(pass, json) {
  const summit = { lat: pass.la, lon: pass.lo };
  const peaks = new Set();
  const glaciers = new Set();
  const waters = new Set();
  const viewpoints = [];
  const roadWays = [];
  const parkingCandidates = [];
  let openLand = 0;
  let closedLand = 0;

  for (const element of json.elements ?? []) {
    const tags = element.tags ?? {};
    const natural = tags.natural;
    const coord = elementCoord(element);

    if (element.type === "way" && tags.highway && isDrivingHighway(tags.highway) && Array.isArray(element.geometry)) {
      const geometry = sampleGeometry(element.geometry
        .map((point) => ({ lat: Number(point.lat), lon: Number(point.lon) }))
        .filter(isValidCoord), 36);
      if (geometry.length >= 2) {
        roadWays.push({
          highway: String(tags.highway).toLowerCase(),
          geometry: geometry.map((point) => [roundCoord(point.lat), roundCoord(point.lon)]),
        });
      }
    }

    if (natural === "peak" && coord && haversineM(coord, summit) <= 8_000) {
      peaks.add(element.id ?? `${coord.lat},${coord.lon}`);
    }
    if (natural === "glacier") glaciers.add(element.id ?? coordKey(coord));
    if (natural === "water") waters.add(element.id ?? coordKey(coord));
    if (tags.tourism === "viewpoint" && coord) {
      viewpoints.push({
        lat: roundCoord(coord.lat),
        lon: roundCoord(coord.lon),
        name: tags.name ? String(tags.name) : undefined,
      });
    }
    if (tags.amenity === "parking" && coord) parkingCandidates.push(coord);
    if (isOpenLand(tags)) openLand += 1;
    if (isClosedLand(tags)) closedLand += 1;
  }

  const parking = parkingCandidates
    .sort((a, b) => haversineM(a, summit) - haversineM(b, summit))[0] ?? null;
  const openness = openLand + closedLand > 0 ? openLand / (openLand + closedLand) : null;

  return {
    id: pass.id,
    fetchedAt: new Date().toISOString(),
    peakCount: peaks.size,
    glacierCount: glaciers.size,
    waterCount: waters.size,
    viewpointCount: viewpoints.length,
    viewpoints: viewpoints.slice(0, 8),
    summitParking: parking ? { lat: roundCoord(parking.lat), lon: roundCoord(parking.lon) } : null,
    openness,
    roadWays: roadWays.slice(0, 40),
  };
}

function isOpenLand(tags) {
  return /^(meadow|grass|grassland|heath|scrub|fell|alpine)$/i.test(tags.landuse ?? "")
    || /^(grassland|fell|scrub|heath|bare_rock|scree)$/i.test(tags.natural ?? "");
}

function isClosedLand(tags) {
  return /^(forest|orchard|vineyard)$/i.test(tags.landuse ?? "") || /^wood$/i.test(tags.natural ?? "");
}

function elementCoord(element) {
  if (Number.isFinite(Number(element.lat)) && Number.isFinite(Number(element.lon))) {
    return { lat: Number(element.lat), lon: Number(element.lon) };
  }
  if (element.center && Number.isFinite(Number(element.center.lat)) && Number.isFinite(Number(element.center.lon))) {
    return { lat: Number(element.center.lat), lon: Number(element.center.lon) };
  }
  if (Array.isArray(element.geometry) && element.geometry.length) {
    const mid = element.geometry[Math.floor(element.geometry.length / 2)];
    return { lat: Number(mid.lat), lon: Number(mid.lon) };
  }
  return null;
}

function coordKey(coord) {
  return coord ? `${roundCoord(coord.lat)},${roundCoord(coord.lon)}` : "";
}

function buildPassFeatures(passes, scenicMap, overpassByPassId) {
  const rawRows = passes.map((pass) => {
    const scenic = scenicMap.get(normalizeName(pass.n)) ?? {};
    const overpass = overpassByPassId.get(pass.id) ?? {};
    const curated = normalizeScore01(pass.sc ?? scenic.sc);
    const qSummit = normalizeScore01(pass.qSm ?? pass.sg?.sI);
    const peakCount = finiteOrNull(overpass.peakCount) ?? finiteOrNull(scenic.peakCount) ?? 0;
    const glacierCount = finiteOrNull(overpass.glacierCount) ?? finiteOrNull(scenic.glacierCount) ?? 0;
    const waterCount = finiteOrNull(overpass.waterCount) ?? 0;
    const viewpointCount = finiteOrNull(overpass.viewpointCount)
      ?? (Array.isArray(pass.viewpoints) ? pass.viewpoints.length : null)
      ?? finiteOrNull(scenic.vps)
      ?? 0;
    const openness = finiteOrNull(overpass.openness)
      ?? finiteOrNull(scenic.openness)
      ?? clamp(((finiteOrNull(pass.e) ?? 1_500) - 1_100) / 1_700, 0.15, 0.95);
    return {
      pass,
      curated,
      qSummit,
      peakCount,
      glacierCount,
      waterCount,
      viewpointCount,
      openness,
      summitRaw: qSummit || Math.log1p(peakCount),
      glacierRaw: Math.log1p(glacierCount),
    };
  });

  const zStats = {
    curated: statsFor(rawRows.map((row) => row.curated)),
    summit: statsFor(rawRows.map((row) => row.summitRaw)),
    openness: statsFor(rawRows.map((row) => row.openness)),
    glacier: statsFor(rawRows.map((row) => row.glacierRaw)),
  };
  const maxPeak = Math.max(1, ...rawRows.map((row) => row.peakCount));
  const maxGlacier = Math.max(1, ...rawRows.map((row) => row.glacierCount));

  const table = new Map();
  for (const row of rawRows) {
    const scenicWeight = clamp(
      0.4 * zScore(row.curated, zStats.curated)
        + 0.3 * zScore(row.summitRaw, zStats.summit)
        + 0.2 * zScore(row.openness, zStats.openness)
        + 0.1 * zScore(row.glacierRaw, zStats.glacier),
      0,
      0.5,
    );
    const peakN = Math.log1p(row.peakCount) / Math.log1p(maxPeak);
    const glacierN = Math.log1p(row.glacierCount) / Math.log1p(maxGlacier);
    const scenicScore = clamp(
      0.72 * row.curated
        + 0.10 * (row.qSummit || peakN)
        + 0.10 * row.openness
        + 0.08 * glacierN,
      0,
      1,
    );
    table.set(row.pass.id, {
      ...row,
      peakN,
      glacierN,
      scenicWeight,
      scenicScore,
      themes: passThemes(row, scenicScore),
    });
  }
  return table;
}

function passThemes(row, scenicScore) {
  const themes = new Set();
  if (scenicScore >= 0.82) themes.add("iconic");
  if ((row.pass.e ?? 0) >= 2_000) themes.add("high-alpine");
  if (row.openness >= 0.65 || row.viewpointCount > 0) themes.add("panoramic-view");
  if (row.glacierCount > 0) themes.add("glacier");
  if (row.waterCount > 0) themes.add("alpine-lake");
  if (normalizeScore01(row.pass.qAp) >= 0.8) themes.add("drivers-road");
  if (Array.isArray(row.pass.cr) || (row.pass.e ?? 0) >= 1_900) themes.add("summer-only");
  if (row.viewpointCount > 2) themes.add("viewpoints");
  return [...themes];
}

async function loadElevations(records, args) {
  const coords = records.map((record) => ({
    id: record.id,
    lat: roundCoord(record.lat),
    lon: roundCoord(record.lon),
  }));
  const hash = shortHash(JSON.stringify(coords.map(({ lat, lon }) => [lat, lon])));
  const cachePath = path.join(PATHS.cacheDir, `elev-${hash}.json`);
  const report = {
    byId: new Map(),
    cached: false,
    fetchedBatches: 0,
    failedBatches: 0,
  };

  if (!args.noCache && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8"));
      applyElevationArray(records, cached, report.byId);
      report.cached = true;
      return report;
    } catch (error) {
      warnOnce(`could not read ${path.relative(REPO_ROOT, cachePath)}: ${error.message}`);
    }
  }

  const elevations = new Array(coords.length).fill(null);
  let consecutiveFailures = 0;
  for (let start = 0; start < coords.length; start += ELEVATION_BATCH) {
    if (consecutiveFailures >= 2) {
      report.failedBatches += Math.ceil((coords.length - start) / ELEVATION_BATCH);
      break;
    }
    if (start > 0) await throttle("elevation", ELEVATION_INTERVAL_MS);
    const chunk = coords.slice(start, start + ELEVATION_BATCH);
    try {
      const batch = await fetchElevationBatch(chunk);
      for (let i = 0; i < batch.length; i += 1) elevations[start + i] = finiteOrNull(batch[i]);
      report.fetchedBatches += 1;
      consecutiveFailures = 0;
    } catch (error) {
      report.failedBatches += 1;
      consecutiveFailures += 1;
      warnOnce(`Open-Meteo elevation batch failed: ${error.message}`);
    }
  }

  await writeJson(cachePath, elevations);
  applyElevationArray(records, elevations, report.byId);
  return report;
}

async function fetchElevationBatch(coords) {
  const url = new URL("https://api.open-meteo.com/v1/elevation");
  url.searchParams.set("latitude", coords.map((coord) => coord.lat).join(","));
  url.searchParams.set("longitude", coords.map((coord) => coord.lon).join(","));
  const json = await fetchJson(url, {
    headers: { "User-Agent": USER_AGENT },
    retryStatuses: new Set([429, 500, 502, 503, 504]),
    timeoutMs: 15_000,
    retries: 2,
    retryDelayMs: ELEVATION_INTERVAL_MS,
  });
  if (!Array.isArray(json.elevation)) throw new Error("response had no elevation array");
  return json.elevation;
}

function applyElevationArray(records, elevations, byId) {
  if (!Array.isArray(elevations)) return;
  for (let i = 0; i < records.length && i < elevations.length; i += 1) {
    const elev = finiteOrNull(elevations[i]);
    if (elev !== null) byId.set(records[i].id, elev);
  }
}

function buildPassNodes(passes, featureTable, overpassByPassId, elevationById) {
  return passes.map((pass) => {
    const feature = featureTable.get(pass.id);
    const overpass = overpassByPassId.get(pass.id) ?? {};
    const sourceParking = normalizePoint(pass.summitParking);
    const viewpoints = mergeViewpoints(pass.viewpoints, overpass.viewpoints);
    return {
      id: pass.id,
      kind: "pass",
      name: pass.n,
      lat: roundCoord(pass.la),
      lon: roundCoord(pass.lo),
      elev: Math.round(finiteOrNull(pass.e) ?? finiteOrNull(elevationById.get(pass.id)) ?? 0),
      baseA: pass.bA.map(roundCoord),
      baseB: pass.bB.map(roundCoord),
      scenicScore: roundNumber(feature.scenicScore, 4),
      themes: feature.themes,
      summitParking: sourceParking ?? overpass.summitParking ?? null,
      viewpoints,
      _pass: pass,
    };
  });
}

function buildPassRoutingNodes(passNodes) {
  return passNodes.flatMap((node) => ([
    {
      id: `${node.id}:A`,
      kind: "pass-base",
      passId: node.id,
      side: "A",
      name: `${node.name} base A`,
      lat: node.baseA[0],
      lon: node.baseA[1],
      scenicScore: node.scenicScore,
    },
    {
      id: `${node.id}:S`,
      kind: "pass-summit",
      passId: node.id,
      name: `${node.name} summit`,
      lat: node.lat,
      lon: node.lon,
      elev: node.elev,
      scenicScore: node.scenicScore,
    },
    {
      id: `${node.id}:B`,
      kind: "pass-base",
      passId: node.id,
      side: "B",
      name: `${node.name} base B`,
      lat: node.baseB[0],
      lon: node.baseB[1],
      scenicScore: node.scenicScore,
    },
  ]));
}

function buildPoiNodes(pois, elevationById) {
  return pois.map((poi) => {
    const score = normalizePoiScore(poi);
    const categories = [
      ...(Array.isArray(poi.categories) ? poi.categories : []),
      ...(poi.cat ? [poi.cat] : []),
    ].filter(Boolean);
    const themes = Array.isArray(poi.themes) ? [...new Set(poi.themes.map(String))] : [];
    return {
      id: poi.id,
      kind: "poi",
      name: poi.n,
      lat: roundCoord(poi.la),
      lon: roundCoord(poi.lo),
      score: roundNumber(score, 2),
      categories: [...new Set(categories.map(String))],
      themes,
      visitDwellSec: Math.max(900, Math.round((finiteOrNull(poi.dur) ?? 1.5) * 3_600)),
      elev: Math.round(finiteOrNull(poi.e) ?? finiteOrNull(elevationById.get(poi.id)) ?? 0),
      _scenicWeight: clamp(0.38 * (score / 10) + (themes.includes("panoramic-view") ? 0.06 : 0) + (themes.includes("iconic") ? 0.05 : 0), 0, 0.5),
    };
  });
}

function mergeViewpoints(sourceViewpoints, overpassViewpoints) {
  const merged = [];
  if (Array.isArray(sourceViewpoints)) {
    for (const item of sourceViewpoints) {
      const point = normalizePoint(item);
      if (point) merged.push(point);
    }
  }
  if (Array.isArray(overpassViewpoints)) {
    for (const item of overpassViewpoints) {
      const point = normalizePoint(item);
      if (point) merged.push(point);
    }
  }
  const seen = new Set();
  return merged.filter((point) => {
    const key = coordKey(point);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function normalizePoint(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const coord = coordFromPair(value);
    return coord ? { lat: roundCoord(coord.lat), lon: roundCoord(coord.lon) } : null;
  }
  if (isValidCoord(value)) {
    const point = { lat: roundCoord(value.lat), lon: roundCoord(value.lon) };
    if (value.name) point.name = String(value.name);
    return point;
  }
  return null;
}

function buildConnectorRoutingPoints(passNodes, poiNodes, junctionNodes, featureTable) {
  const points = [];
  for (const node of passNodes) {
    const feature = featureTable.get(node.id);
    points.push({
      id: `${node.id}:A`,
      cacheId: `${node._pass.cacheId ?? node.id}:A`,
      nodeId: node.id,
      name: node.name,
      passId: node.id,
      kind: "pass-base",
      side: "A",
      lat: node.baseA[0],
      lon: node.baseA[1],
      scenicWeight: feature.scenicWeight,
    });
    points.push({
      id: `${node.id}:B`,
      cacheId: `${node._pass.cacheId ?? node.id}:B`,
      nodeId: node.id,
      name: node.name,
      passId: node.id,
      kind: "pass-base",
      side: "B",
      lat: node.baseB[0],
      lon: node.baseB[1],
      scenicWeight: feature.scenicWeight,
    });
  }
  for (const node of poiNodes) {
    points.push({
      id: node.id,
      nodeId: node.id,
      name: node.name,
      kind: "poi",
      lat: node.lat,
      lon: node.lon,
      scenicWeight: node._scenicWeight,
    });
  }
  for (const node of junctionNodes) {
    points.push({
      id: node.id,
      nodeId: node.id,
      name: node.name,
      kind: "junction",
      lat: node.lat,
      lon: node.lon,
      scenicWeight: 0,
    });
  }
  return {
    points,
    indexById: new Map(points.map((point, index) => [point.id, index])),
  };
}

async function loadOsrmMatrix(points, args) {
  const matrix = createMatrix(points.length);
  const report = {
    matrix,
    cachedChunks: 0,
    fetchedChunks: 0,
    failedChunks: 0,
    skippedByCircuit: 0,
    sampleSeededCells: await seedSampleMatrix(points, matrix),
  };
  let consecutiveFailures = 0;

  for (let sourceStart = 0; sourceStart < points.length; sourceStart += OSRM_CHUNK) {
    const sourceIndexes = range(sourceStart, Math.min(sourceStart + OSRM_CHUNK, points.length));
    for (let destStart = 0; destStart < points.length; destStart += OSRM_CHUNK) {
      const destIndexes = range(destStart, Math.min(destStart + OSRM_CHUNK, points.length));
      const cacheKey = osrmChunkHash(points, sourceIndexes, destIndexes);
      const cachePath = path.join(PATHS.cacheDir, `osrm-table-${cacheKey}.json`);

      if (!args.noCache && existsSync(cachePath)) {
        try {
          applyOsrmChunk(matrix, sourceIndexes, destIndexes, JSON.parse(await readFile(cachePath, "utf8")));
          report.cachedChunks += 1;
          continue;
        } catch (error) {
          warnOnce(`could not read ${path.relative(REPO_ROOT, cachePath)}: ${error.message}`);
        }
      }

      if (consecutiveFailures >= 5) {
        report.skippedByCircuit += 1;
        continue;
      }

      try {
        const chunk = await fetchOsrmChunk(points, sourceIndexes, destIndexes);
        await writeJson(cachePath, chunk);
        applyOsrmChunk(matrix, sourceIndexes, destIndexes, chunk);
        report.fetchedChunks += 1;
        consecutiveFailures = 0;
      } catch (error) {
        report.failedChunks += 1;
        consecutiveFailures += 1;
        if (report.failedChunks <= 5) warnOnce(`OSRM table chunk failed: ${error.message}`);
      }
    }
  }

  if (report.skippedByCircuit) {
    warnOnce(`OSRM circuit breaker skipped ${report.skippedByCircuit} chunks; haversine duration fallback was used`);
  }
  return report;
}

async function seedSampleMatrix(points, matrix) {
  const file = path.join(PATHS.cacheDir, "sample-matrix.json");
  if (!existsSync(file)) return 0;
  try {
    const sample = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(sample.sample) || !Array.isArray(sample.durations) || !Array.isArray(sample.distances)) return 0;
    const sampleByKey = new Map();
    sample.sample.forEach((entry, index) => {
      const key = sampleMatrixKey(entry);
      if (key !== null && !sampleByKey.has(key)) sampleByKey.set(key, index);
    });
    const pointToSample = points.map((point) => {
      const key = sampleMatrixKey(point);
      return key === null ? undefined : sampleByKey.get(key);
    });
    let seeded = 0;
    for (let i = 0; i < points.length; i += 1) {
      const si = pointToSample[i];
      if (si === undefined) continue;
      for (let j = 0; j < points.length; j += 1) {
        const sj = pointToSample[j];
        if (sj === undefined) continue;
        const duration = finiteOrNull(sample.durations[si]?.[sj]);
        const distance = finiteOrNull(sample.distances[si]?.[sj]);
        if (duration !== null && distance !== null) {
          matrix.durations[i][j] = duration;
          matrix.distances[i][j] = distance;
          seeded += 1;
        }
      }
    }
    return seeded;
  } catch (error) {
    warnOnce(`could not reuse sample-matrix.json: ${error.message}`);
    return 0;
  }
}

function sampleMatrixKey(entry) {
  const name = normalizeName(entry.name ?? entry.n ?? entry.nodeId ?? entry.id);
  if (!name) return null;
  const side = entry.side === undefined || entry.side === null ? "" : String(entry.side).toUpperCase();
  return `${name}\0${side}`;
}

function createMatrix(size) {
  return {
    durations: Array.from({ length: size }, () => new Array(size).fill(null)),
    distances: Array.from({ length: size }, () => new Array(size).fill(null)),
  };
}

function range(start, end) {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

async function fetchOsrmChunk(points, sourceIndexes, destIndexes) {
  const unique = [];
  const keyToIndex = new Map();
  const localIndex = (point) => {
    const key = `${roundCoord(point.lat)},${roundCoord(point.lon)}`;
    if (!keyToIndex.has(key)) {
      keyToIndex.set(key, unique.length);
      unique.push(point);
    }
    return keyToIndex.get(key);
  };
  const sources = sourceIndexes.map((index) => localIndex(points[index]));
  const destinations = destIndexes.map((index) => localIndex(points[index]));
  const coords = unique.map((point) => `${roundCoord(point.lon)},${roundCoord(point.lat)}`).join(";");
  const url = new URL(`https://router.project-osrm.org/table/v1/driving/${coords}`);
  url.searchParams.set("sources", sources.join(";"));
  url.searchParams.set("destinations", destinations.join(";"));
  url.searchParams.set("annotations", "duration,distance");

  await throttle("osrm", OSRM_MIN_INTERVAL_MS);
  const json = await fetchJson(url, {
    headers: { "User-Agent": USER_AGENT },
    retryStatuses: new Set([429, 500, 502, 503, 504]),
    timeoutMs: 20_000,
    retries: 2,
  });
  if (json.code && json.code !== "Ok") throw new Error(`OSRM returned ${json.code}`);
  return {
    durations: json.durations,
    distances: json.distances,
  };
}

function applyOsrmChunk(matrix, sourceIndexes, destIndexes, chunk) {
  for (let r = 0; r < sourceIndexes.length; r += 1) {
    for (let c = 0; c < destIndexes.length; c += 1) {
      const duration = finiteOrNull(chunk.durations?.[r]?.[c]);
      const distance = finiteOrNull(chunk.distances?.[r]?.[c]);
      if (duration !== null) matrix.durations[sourceIndexes[r]][destIndexes[c]] = duration;
      if (distance !== null) matrix.distances[sourceIndexes[r]][destIndexes[c]] = distance;
    }
  }
}

function buildEdges(passNodes, poiNodes, junctionNodes, featureTable, overpassByPassId, routing, matrix) {
  const edges = [];
  for (const node of passNodes) {
    edges.push(...buildPassEdges(node, featureTable.get(node.id), overpassByPassId.get(node.id)));
  }
  edges.push(...buildConnectorEdges(routing.points, matrix));
  return edges;
}

function buildPassEdges(node, feature, overpass) {
  const pass = node._pass;
  const summit = { lat: node.lat, lon: node.lon };
  const baseA = { lat: node.baseA[0], lon: node.baseA[1] };
  const baseB = { lat: node.baseB[0], lon: node.baseB[1] };
  const sideAUp = buildPassSide(pass, "A", baseA, summit, feature, overpass, "up");
  const sideADown = buildPassSide(pass, "A", baseA, summit, feature, overpass, "down");
  const sideBUp = buildPassSide(pass, "B", baseB, summit, feature, overpass, "up");
  const sideBDown = buildPassSide(pass, "B", baseB, summit, feature, overpass, "down");
  const traverseFromA = combinePassMetrics(sideAUp, sideBDown);
  const traverseFromB = combinePassMetrics(sideBUp, sideADown);
  const oabA = outAndBackMetrics(sideAUp, sideADown, traverseFromA);
  const oabB = outAndBackMetrics(sideBUp, sideBDown, traverseFromB);
  const season = passSeason(pass);
  const edges = [
    passClimbEdge(`${node.id}:A`, `${node.id}:S`, node.id, "A", sideAUp, feature, season),
    passClimbEdge(`${node.id}:S`, `${node.id}:A`, node.id, "A", sideADown, feature, season),
    passClimbEdge(`${node.id}:S`, `${node.id}:B`, node.id, "B", sideBDown, feature, season),
    passClimbEdge(`${node.id}:B`, `${node.id}:S`, node.id, "B", sideBUp, feature, season),
  ];
  edges.push(passOutAndBackEdge(`${node.id}:A`, node.id, "A", sideAUp, sideADown, oabA, feature, season));
  edges.push(passOutAndBackEdge(`${node.id}:B`, node.id, "B", sideBUp, sideBDown, oabB, feature, season));
  return edges;
}

function buildPassSide(pass, side, base, summit, feature, overpass, direction = "up") {
  const picked = pickRoadGeometry(pass, base, summit, overpass);
  const geometryPoints = picked.geometry.length >= 2 ? picked.geometry : fallbackGeometry(base, summit);
  const direct = haversineM(base, summit);
  const distanceM = Math.max(polylineLengthM(geometryPoints), direct * 1.35);
  const speed = (pass.e ?? 0) >= 2_000 ? 10.3 : 11.7;
  const baseDurationS = distanceM / speed;
  const durationS = direction === "down" ? baseDurationS * PASS_DESCENT_FACTOR : baseDurationS;
  const roadClass = picked.roadClass ?? (((pass.e ?? 0) >= 1_800) ? "secondary" : "primary");
  return {
    side,
    direction,
    distanceM,
    durationS,
    leisureCost: leisureCost(durationS, roadClass, feature.scenicWeight),
    roadClass,
    geometry: direction === "down" ? geometryPoints.slice().reverse() : geometryPoints,
  };
}

function combinePassMetrics(first, second) {
  return {
    distanceM: first.distanceM + second.distanceM,
    durationS: first.durationS + second.durationS,
    leisureCost: first.leisureCost + second.leisureCost,
  };
}

function outAndBackMetrics(upSide, downSide, traverse) {
  const natural = combinePassMetrics(upSide, downSide);
  return {
    distanceM: natural.distanceM,
    durationS: Math.max(natural.durationS, traverse.durationS * OUT_AND_BACK_TRAVERSE_MARGIN),
    leisureCost: Math.max(
      natural.leisureCost * OUT_AND_BACK_COST_MULTIPLIER,
      traverse.leisureCost * OUT_AND_BACK_TRAVERSE_MARGIN,
    ),
  };
}

function pickRoadGeometry(pass, base, summit, overpass) {
  if (!overpass?.roadWays?.length) {
    return { geometry: fallbackGeometry(base, summit), roadClass: null };
  }
  const direct = haversineM(base, summit);
  const threshold = clamp(direct * 0.22, 450, 1_600);
  const points = [];
  const classCounts = new Map();

  for (const way of overpass.roadWays) {
    if (!isDrivingHighway(way.highway)) continue;
    const geometry = (way.geometry ?? []).map(([lat, lon]) => ({ lat, lon })).filter(isValidCoord);
    let accepted = 0;
    for (const point of geometry) {
      const t = segmentProjection(point, base, summit);
      if (t < -0.15 || t > 1.15) continue;
      if (pointSegmentDistanceM(point, base, summit) <= threshold) {
        points.push({ ...point, t });
        accepted += 1;
      }
    }
    if (accepted) {
      const cls = normalizeRoadClass(way.highway);
      classCounts.set(cls, (classCounts.get(cls) ?? 0) + accepted);
    }
  }

  if (points.length < 4) {
    return { geometry: fallbackGeometry(base, summit), roadClass: topRoadClass(classCounts) };
  }

  points.sort((a, b) => a.t - b.t);
  const geometry = sampleGeometry(dedupePoints([
    base,
    ...points.map((point) => ({ lat: point.lat, lon: point.lon })),
    summit,
  ]), 34);
  if (polylineLengthM(geometry) < direct * 0.6) {
    return { geometry: fallbackGeometry(base, summit), roadClass: topRoadClass(classCounts) };
  }
  return {
    geometry,
    roadClass: topRoadClass(classCounts),
  };
}

function topRoadClass(classCounts) {
  let top = null;
  let topCount = -1;
  for (const [cls, count] of classCounts) {
    if (count > topCount) {
      top = cls;
      topCount = count;
    }
  }
  return top;
}

function sampleGeometry(points, maxPoints) {
  const deduped = dedupePoints(points);
  if (deduped.length <= maxPoints) return deduped;
  const out = [];
  const step = (deduped.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) {
    out.push(deduped[Math.round(i * step)]);
  }
  return dedupePoints(out);
}

function passClimbEdge(from, to, passId, sideName, side, feature, season) {
  return {
    from,
    to,
    kind: "pass-climb",
    passId,
    side: sideName,
    distanceM: Math.round(side.distanceM),
    durationS: Math.round(side.durationS),
    scenicScore: roundNumber(feature.scenicScore, 4),
    leisureCost: roundNumber(side.leisureCost, 2),
    season,
    geometry: toLatLonArray(side.geometry),
  };
}

function passOutAndBackEdge(nodeId, passId, sideName, upSide, downSide, metrics, feature, season) {
  return {
    from: nodeId,
    to: nodeId,
    kind: "pass-out-and-back",
    passId,
    side: sideName,
    distanceM: Math.round(metrics.distanceM),
    durationS: Math.round(metrics.durationS),
    scenicScore: roundNumber(feature.scenicScore, 4),
    leisureCost: roundNumber(metrics.leisureCost, 2),
    season,
    geometry: toLatLonArray([...upSide.geometry, ...downSide.geometry.slice(1)]),
  };
}

function buildConnectorEdges(points, matrix) {
  const edges = [];
  const seen = new Set();

  for (let i = 0; i < points.length; i += 1) {
    const from = points[i];
    const candidates = [];
    for (let j = 0; j < points.length; j += 1) {
      if (i === j) continue;
      const to = points[j];
      if (from.passId && from.passId === to.passId) continue;
      const direct = haversineM(from, to);
      const osrmMetric = osrmMetricFor(matrix, i, j);
      if (direct > MAX_CONNECTOR_M && osrmMetric === null) continue;
      const metric = osrmMetric ?? fallbackMetricFor(points, i, j, direct);
      if (!(metric.distanceM > 0) || !(metric.durationS > 0)) continue;
      const scenicWeight = clamp(((from.scenicWeight ?? 0) + (to.scenicWeight ?? 0)) / 2, 0, 0.5);
      const roadClass = inferRoadClass(metric.distanceM, metric.durationS, from, to);
      const candidateLeisureCost = leisureCost(metric.durationS, roadClass, scenicWeight);
      candidates.push({
        to,
        distanceM: metric.distanceM,
        durationS: metric.durationS,
        roadClass,
        isHighway: roadClass === "motorway" || roadClass === "trunk",
        leisureCost: candidateLeisureCost,
        source: metric.source,
      });
    }

    selectKNearestCandidates(candidates, K_NEAREST)
      .forEach((candidate) => {
        const key = `${from.id}->${candidate.to.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push({
          from: from.id,
          to: candidate.to.id,
          kind: "connector",
          distanceM: Math.round(candidate.distanceM),
          durationS: Math.round(candidate.durationS),
          leisureCost: roundNumber(candidate.leisureCost, 2),
          roadClass: candidate.roadClass,
          isHighway: candidate.isHighway,
          source: candidate.source,
        });
      });
  }

  return edges;
}

function osrmMetricFor(matrix, i, j) {
  const distance = finiteOrNull(matrix.distances[i]?.[j]);
  const duration = finiteOrNull(matrix.durations[i]?.[j]);
  if (distance !== null && duration !== null && distance > 0 && duration > 0) {
    return { distanceM: distance, durationS: duration, source: "osrm" };
  }
  return null;
}

function fallbackMetricFor(points, i, j, direct = haversineM(points[i], points[j])) {
  const estimatedDistance = direct * fallbackRoadFactor(points[i], points[j], direct);
  const estimatedSpeed = estimatedDistance > 80_000 ? 21.5 : estimatedDistance > 30_000 ? 17.5 : 13.5;
  return {
    distanceM: estimatedDistance,
    durationS: estimatedDistance / estimatedSpeed,
    source: "fallback",
  };
}

function fallbackRoadFactor(a, b, direct) {
  if (a.kind === "pass-base" || b.kind === "pass-base") return direct > 80_000 ? 1.32 : 1.48;
  return direct > 80_000 ? 1.22 : 1.35;
}

function inferRoadClass(distanceM, durationS, from, to) {
  const speedKmh = (distanceM / Math.max(1, durationS)) * 3.6;
  if (from.kind === "pass-base" || to.kind === "pass-base") {
    if (speedKmh > 78 && distanceM > 90_000) return "primary";
    if (speedKmh > 58) return "secondary";
    return "tertiary";
  }
  if (speedKmh > 105 && distanceM > 80_000) return "motorway";
  if (speedKmh > 88 && distanceM > 60_000) return "trunk";
  if (speedKmh > 62) return "primary";
  if (speedKmh > 42) return "secondary";
  return "tertiary";
}

function normalizeRoadClass(value) {
  const raw = String(value ?? "").toLowerCase();
  if (raw.includes("motorway")) return "motorway";
  if (raw.includes("trunk")) return "trunk";
  if (raw.includes("primary")) return "primary";
  if (raw.includes("secondary")) return "secondary";
  if (raw.includes("tertiary")) return "tertiary";
  if (raw.includes("track")) return "track";
  if (raw.includes("unclassified") || raw.includes("residential") || raw.includes("service")) return "unclassified";
  return "default";
}

function isDrivingHighway(value) {
  const classes = String(value ?? "")
    .toLowerCase()
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  return classes.some((item) => !NON_DRIVING_HIGHWAYS.has(item));
}

function passSeason(pass) {
  if (Array.isArray(pass.cr) && pass.cr.length) return "summer";
  if ((pass.e ?? 0) >= 1_900) return "summer";
  return "all";
}

function calibrate(passNodes, calibrationTruth) {
  const allRows = passNodes
    .map((node) => ({
      node,
      curated: normalizeScore01(node._pass.sc),
      scenic: node.scenicScore,
      hero: isHeroPass(node._pass, calibrationTruth.heroes),
    }));
  const rows = allRows.filter((row) => row.curated > 0);
  const spearman = rows.length >= 3
    ? spearmanCorrelation(rows.map((row) => row.scenic), rows.map((row) => row.curated))
    : 0;
  const sorted = allRows.slice().sort((a, b) => b.scenic - a.scenic);
  const topQuartile = new Set(sorted.slice(0, Math.ceil(sorted.length / 4)).map((row) => row.node.id));
  const heroes = allRows.filter((row) => row.hero);
  const heroTop = heroes.filter((row) => topQuartile.has(row.node.id)).length;
  return {
    spearman,
    heroCount: heroes.length,
    heroTopQuartile: heroTop,
    heroTopQuartileRate: heroes.length ? heroTop / heroes.length : 0,
  };
}

function isHeroPass(pass, heroSubstrings) {
  const haystack = normalizeName([pass.n, pass.wt, pass.td, pass.rs].filter(Boolean).join(" "));
  return heroSubstrings.some((hero) => haystack.includes(hero));
}

function validateBuildGates(graph, passNodes, calibration, calibrationTruth, serialized) {
  const failures = [];
  const gzipBytes = gzipSize(serialized);
  if (gzipBytes !== graph.stats.gzipBytes) {
    failures.push(`ERROR: gzip size accounting mismatch: stats.gzipBytes=${graph.stats.gzipBytes} actual=${gzipBytes}.`);
  }
  if (graph.stats.gzipBytes > GZIP_BUDGET_BYTES) {
    failures.push(`ERROR: ${path.relative(REPO_ROOT, PATHS.output)} gzip size ${graph.stats.gzipBytes} exceeds 6MB; rerun with --limit-n or lower DEFAULT_LIMIT_N.`);
  }
  if (calibration.spearman < calibrationTruth.thresholds.spearman || calibration.heroTopQuartileRate < calibrationTruth.thresholds.heroQuartile) {
    failures.push(`ERROR: calibration failed before writing JSON: Spearman=${calibration.spearman.toFixed(3)} threshold=${calibrationTruth.thresholds.spearman}, heroesTopQuartile=${percent(calibration.heroTopQuartileRate)} threshold=${percent(calibrationTruth.thresholds.heroQuartile)}.`);
  }
  failures.push(...validateStructuralInvariants(graph, passNodes));
  return failures;
}

function validateStructuralInvariants(graph, passNodes) {
  const failures = [];
  const edgeByKey = new Map(graph.edges.map((edge) => [`${edge.from}->${edge.to}`, edge]));
  const oabFailures = [];

  for (const pass of passNodes) {
    const aUp = edgeByKey.get(`${pass.id}:A->${pass.id}:S`);
    const aDown = edgeByKey.get(`${pass.id}:S->${pass.id}:A`);
    const bUp = edgeByKey.get(`${pass.id}:B->${pass.id}:S`);
    const bDown = edgeByKey.get(`${pass.id}:S->${pass.id}:B`);
    const aOut = edgeByKey.get(`${pass.id}:A->${pass.id}:A`);
    const bOut = edgeByKey.get(`${pass.id}:B->${pass.id}:B`);
    if (!aUp || !aDown || !bUp || !bDown || !aOut || !bOut) {
      oabFailures.push(`${pass.id} ${pass.name}: missing one or more pass climb/out-and-back edges`);
      continue;
    }

    const aTraverseCost = aUp.leisureCost + bDown.leisureCost;
    const bTraverseCost = bUp.leisureCost + aDown.leisureCost;
    const aTraverseDuration = aUp.durationS + bDown.durationS;
    const bTraverseDuration = bUp.durationS + aDown.durationS;
    if (!(aOut.leisureCost > aTraverseCost)) {
      oabFailures.push(`${pass.id} ${pass.name} side A cost: out=${aOut.leisureCost} traverse=${roundNumber(aTraverseCost, 2)}`);
    }
    if (!(bOut.leisureCost > bTraverseCost)) {
      oabFailures.push(`${pass.id} ${pass.name} side B cost: out=${bOut.leisureCost} traverse=${roundNumber(bTraverseCost, 2)}`);
    }
    if (!(aOut.durationS > aTraverseDuration)) {
      oabFailures.push(`${pass.id} ${pass.name} side A duration: out=${aOut.durationS} traverse=${roundNumber(aTraverseDuration, 2)}`);
    }
    if (!(bOut.durationS > bTraverseDuration)) {
      oabFailures.push(`${pass.id} ${pass.name} side B duration: out=${bOut.durationS} traverse=${roundNumber(bTraverseDuration, 2)}`);
    }
  }
  if (oabFailures.length) {
    failures.push(`ERROR: out-and-back must be strictly more expensive than traversing the pass:\n${oabFailures.join("\n")}`);
  }

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const passIds = new Set(passNodes.map((node) => node.id));
  const badRefs = [];
  for (const [index, edge] of graph.edges.entries()) {
    if (!edgeEndpointResolves(edge.from, nodeIds, passIds)) badRefs.push(`edge ${index} from=${edge.from}`);
    if (!edgeEndpointResolves(edge.to, nodeIds, passIds)) badRefs.push(`edge ${index} to=${edge.to}`);
  }
  if (badRefs.length) {
    failures.push(`ERROR: edges reference unknown nodes:\n${badRefs.join("\n")}`);
  }

  const costFields = ["distanceM", "durationS", "leisureCost"];
  const badCostFields = [];
  for (const [index, edge] of graph.edges.entries()) {
    for (const field of costFields) {
      if (typeof edge[field] !== "number" || !Number.isFinite(edge[field])) {
        badCostFields.push(`edge ${index} ${edge.from}->${edge.to} ${field}=${edge[field]}`);
      }
    }
  }
  if (badCostFields.length) {
    failures.push(`ERROR: edges contain null/NaN/Infinity cost fields:\n${badCostFields.join("\n")}`);
  }

  return failures;
}

function edgeEndpointResolves(id, nodeIds, passIds) {
  if (nodeIds.has(id)) return true;
  const match = /^(.+):([ABS])$/.exec(String(id));
  return Boolean(match && passIds.has(match[1]));
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
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
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

async function fetchJson(url, options = {}) {
  const retries = options.retries ?? 2;
  const retryStatuses = options.retryStatuses ?? new Set();
  const retryDelayMs = options.retryDelayMs ?? 1_500;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        body: options.body,
        headers: options.headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const text = await response.text().catch(() => "");
        const error = new Error(`HTTP ${response.status}${text ? ` ${text.slice(0, 120)}` : ""}`);
        if (attempt < retries && retryStatuses.has(response.status)) {
          await sleep(Number.isFinite(retryAfter) ? retryAfter * 1_000 : retryDelayMs * (attempt + 1));
          continue;
        }
        throw error;
      }
      return await response.json();
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError ?? new Error("fetch failed");
}

async function throttle(channel, minIntervalMs) {
  const prev = throttleChains.get(channel) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const elapsed = Date.now() - (apiClock[channel] ?? 0);
    if (elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed);
    apiClock[channel] = Date.now();
  });
  throttleChains.set(channel, next);
  await next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeScore01(value) {
  const number = finiteOrNull(value);
  if (number === null) return 0;
  return clamp(number > 1.5 ? number / 10 : number, 0, 1);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function writeJson(file, value) {
  return writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

function serializeGraph(graph) {
  return `${JSON.stringify(graph)}\n`;
}

function finalizeGzipBytes(graph) {
  // gzipBytes is embedded in the payload, so compute it to a fixed point before writing.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const size = gzipSize(serializeGraph(graph));
    if (graph.stats.gzipBytes === size) return;
    graph.stats.gzipBytes = size;
  }
  const nextSize = gzipSize(serializeGraph(graph));
  if (graph.stats.gzipBytes !== nextSize) {
    warnOnce(`gzipBytes did not converge after 8 attempts; stored=${graph.stats.gzipBytes} next=${nextSize}`);
  }
}

function gzipSize(value) {
  return zlib.gzipSync(typeof value === "string" ? value : JSON.stringify(value)).length;
}

function stripPrivateFields(node) {
  return Object.fromEntries(Object.entries(node).filter(([key]) => !key.startsWith("_")));
}

function warnOnce(message) {
  if (warnings.includes(message)) return;
  warnings.push(message);
}

function printSummary(stats, calibration, reports, wroteOutput) {
  console.log(`${wroteOutput ? "wrote" : "did not write"} ${path.relative(REPO_ROOT, PATHS.output)}`);
  console.log(`stats: passes=${stats.passes} passBases=${stats.passBases} passSummits=${stats.passSummits} pois=${stats.pois} junctions=${stats.junctions} nodes=${stats.nodes} edges=${stats.edges} gzipBytes=${stats.gzipBytes}`);
  console.log(`calibration: spearman=${calibration.spearman.toFixed(3)} heroesTopQuartile=${calibration.heroTopQuartile}/${calibration.heroCount} (${percent(calibration.heroTopQuartileRate)})`);
  console.log(`cache: overpass cached=${reports.overpass.cached} fetched=${reports.overpass.fetched} failed=${reports.overpass.failed} skipped=${reports.overpass.skippedByCircuit}; osrm cached=${reports.osrm.cachedChunks} fetched=${reports.osrm.fetchedChunks} failed=${reports.osrm.failedChunks} skipped=${reports.osrm.skippedByCircuit} sampleSeededCells=${reports.osrm.sampleSeededCells}; elevation cached=${reports.elevation.cached} fetchedBatches=${reports.elevation.fetchedBatches} failedBatches=${reports.elevation.failedBatches}`);
  if (warnings.length) {
    console.warn(`warnings (${warnings.length}):`);
    for (const message of warnings.slice(0, 20)) console.warn(`- ${message}`);
    if (warnings.length > 20) console.warn(`- ... ${warnings.length - 20} more`);
  }
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
