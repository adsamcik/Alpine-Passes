import { edgeKey, haversineM } from "./graph.js";

// Side-road detours use a conservative 50 km/h local-road speed.  The
// terrain factor inflates straight-line distance for winding Alpine roads;
// pass-climb vertices use the steeper factor because access roads are slower.
const SIDE_ROAD_SPEED_KMH = 50;
const DEFAULT_TERRAIN_FACTOR = 1.4;
const PASS_CLIMB_TERRAIN_FACTOR = 1.7;
const DRAWER_MAX_DETOUR_MIN = 30, DRAWER_MIN_SCORE = 5;
const AVG_ROUTE_SPEED_KMH = 55, EARTH_RADIUS_KM = 6_371, EPS = 1e-9;

const DEFAULT_OPTIONS = Object.freeze({
  bufferKm: 5, autoIncludeMaxDetourMin: 4, autoIncludeMinScore: 7,
  suggestMaxDetourMin: 20, suggestMinScore: 6, themes: [], personas: [],
  maxAutoIncludePerHour: 1, maxSuggestionsTotal: 12, excludeIds: null,
  detourBudgetMin: null, mode: "default",
});

const PERSONA_THEMES = Object.freeze({
  scenic: ["viewpoint-panorama", "mountain-summit", "alpine-lake", "glacier", "waterfall-gorge", "national-park", "panoramic-view", "viewpoints", "high-alpine"],
  photographer: ["viewpoint-panorama", "mountain-summit", "alpine-lake", "glacier", "panoramic-view", "photogenic", "viewpoints"],
  driver: ["drivers-road", "alpine-pass", "mountain-summit", "viewpoint-panorama", "bridge-engineering", "special-experience", "high-alpine"],
  touring: ["drivers-road", "viewpoint-panorama", "old-town", "castle-fortress", "monastery-church", "museum-cultural", "scenic-railway", "village", "historic"],
  family: ["alpine-lake", "village", "old-town", "castle-fortress", "museum-cultural", "special-experience", "scenic-railway", "family-friendly"],
  hiker: ["glacier", "alpine-lake", "national-park", "mountain-summit", "waterfall-gorge", "viewpoint-panorama", "hike-required"],
  food: ["food-drink", "cafe-bistro", "restaurant-cafe"],
});

// Public API: browser-only CPU corridor POI inclusion around an optimizer tour.
export function findCorridorPois(graph, tour, options = {}) {
  const opts = normalizeOptions(options);
  const reference = buildTourReference(graph, tour);
  if (reference.vertices.length === 0) return emptyResult({ routeVertexCount: 0, candidatesScanned: 0 });

  const pois = graph?.nodesByKind?.get?.("poi") ?? [];
  const tourIds = idsInTour(tour);
  const candidates = [];
  let candidatesScanned = 0;
  let corridorPoiCount = 0;
  let skippedExcluded = 0;

  for (const poi of pois) {
    candidatesScanned += 1;
    const poiId = String(poi?.id ?? "");
    if (!poiId || opts.excludeIds.has(poiId) || tourIds.has(poiId)) {
      skippedExcluded += 1;
      continue;
    }
    if (!hasCoord(poi)) continue;

    const nearest = nearestTourVertex(reference.vertices, poi);
    if (!nearest || nearest.distanceKm > opts.bufferKm * 1.5 + EPS) continue;
    corridorPoiCount += 1;

    const terrainFactor = nearest.vertex.onPassClimb ? PASS_CLIMB_TERRAIN_FACTOR : DEFAULT_TERRAIN_FACTOR;
    const detourKm = nearest.distanceKm * terrainFactor * 2;
    const detourMin = detourKm / SIDE_ROAD_SPEED_KMH * 60;
    const score = scoreOf(poi);
    if (detourMin > DRAWER_MAX_DETOUR_MIN + EPS || score < DRAWER_MIN_SCORE) continue;

    const categories = normalizeTokens(poi.categories ?? poi.category ?? poi.poiCategory);
    const themes = normalizeTokens(poi.themes ?? poi.poiThemes);
    const insertionIndex = insertionIndexForS(reference, nearest.vertex.s);
    const candidate = {
      poiId,
      poiName: poi.name ?? poiId,
      lat: Number(poi.lat),
      lon: Number(poi.lon),
      score,
      themes,
      categories,
      detourMin,
      detourKm,
      offRouteKm: nearest.distanceKm,
      insertionIndex,
      bucket: Math.floor((nearest.vertex.tSec || 0) / 3600),
      rankScore: 0,
    };
    candidate.rankScore = rankScore(candidate, opts);
    candidates.push(candidate);
  }

  candidates.sort(compareCandidates);
  const autoInitial = [], suggestionInitial = [], drawer = [];

  for (const candidate of candidates) {
    if (isAuto(candidate, opts)) autoInitial.push(candidate);
    else if (isSuggestion(candidate, opts)) suggestionInitial.push(candidate);
    else drawer.push(candidate);
  }

  const fairness = applyAutoFairness(autoInitial, opts.maxAutoIncludePerHour);
  let autoInclude = fairness.autoInclude;
  let suggestions = uniqueByPoiId([...suggestionInitial, ...fairness.overflow]);

  const budget = applyDetourBudget(autoInclude, opts.detourBudgetMin);
  autoInclude = budget.autoInclude;
  suggestions = uniqueByPoiId([...suggestions, ...budget.overflow]);

  const rankedSuggestions = rankSuggestionsMmr(suggestions, opts.maxSuggestionsTotal);
  const drawerFinal = uniqueByPoiId([
    ...drawer,
    ...rankedSuggestions.overflow,
  ]).filter((item) => !autoInclude.some((auto) => auto.poiId === item.poiId)
    && !rankedSuggestions.selected.some((suggestion) => suggestion.poiId === item.poiId));

  autoInclude.sort(compareRouteOrder);
  drawerFinal.sort(compareCandidates);

  const autoIncludedDetourSum = autoInclude.reduce((sum, item) => sum + item.detourMin, 0);
  return {
    autoInclude: autoInclude.map((item) => toPublicItem(item, "auto", opts)),
    suggestions: rankedSuggestions.selected.map((item) => toPublicItem(item, "suggestion", opts)),
    drawer: drawerFinal.map((item) => toPublicItem(item, "drawer", opts)),
    diagnostics: {
      candidatesScanned,
      corridorPoiCount,
      softEligibleCount: candidates.length,
      routeVertexCount: reference.vertices.length,
      routeLengthKm: round(reference.totalKm, 3),
      autoIncludedDetourSum: round(autoIncludedDetourSum, 2),
      fairnessOverflowCount: fairness.overflow.length,
      budgetOverflowCount: budget.overflow.length,
      suggestionOverflowCount: rankedSuggestions.overflow.length,
      skippedExcluded,
      bufferKm: opts.bufferKm,
      mode: opts.mode,
    },
  };
}

function normalizeOptions(options) {
  const merged = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  const themeTokens = normalizeTokens(merged.themes);
  const personaTokens = normalizeTokens(merged.personas);
  const personaThemeTokens = normalizeTokens(personaTokens.flatMap((persona) => PERSONA_THEMES[persona] ?? [persona]));
  return {
    ...merged,
    bufferKm: numberOr(merged.bufferKm, DEFAULT_OPTIONS.bufferKm, Number.MIN_VALUE),
    autoIncludeMaxDetourMin: numberOr(merged.autoIncludeMaxDetourMin, DEFAULT_OPTIONS.autoIncludeMaxDetourMin, 0),
    autoIncludeMinScore: numberOr(merged.autoIncludeMinScore, DEFAULT_OPTIONS.autoIncludeMinScore),
    suggestMaxDetourMin: numberOr(merged.suggestMaxDetourMin, DEFAULT_OPTIONS.suggestMaxDetourMin, 0),
    suggestMinScore: numberOr(merged.suggestMinScore, DEFAULT_OPTIONS.suggestMinScore),
    maxAutoIncludePerHour: Math.max(0, Math.trunc(numberOr(merged.maxAutoIncludePerHour, DEFAULT_OPTIONS.maxAutoIncludePerHour))),
    maxSuggestionsTotal: Math.max(0, Math.trunc(numberOr(merged.maxSuggestionsTotal, DEFAULT_OPTIONS.maxSuggestionsTotal))),
    excludeIds: merged.excludeIds instanceof Set ? merged.excludeIds : new Set(merged.excludeIds ?? []),
    detourBudgetMin: merged.detourBudgetMin == null ? null : numberOr(merged.detourBudgetMin, 0, 0),
    mode: merged.mode === "hidden-gem" ? "hidden-gem" : "default",
    themeTokens,
    personaTokens,
    personaThemeTokens,
  };
}

function buildTourReference(graph, tour = {}) {
  const reference = routeReference(graph, tour);
  if (reference.vertices.length === 0) return { vertices: [], stopRefs: [], totalKm: 0, totalDurationS: 0 };

  const declaredDurationS = durationSecondsOf(tour);
  if (declaredDurationS > 0 && reference.totalDurationS > 0) {
    const scale = declaredDurationS / reference.totalDurationS;
    for (const vertex of reference.vertices) vertex.tSec *= scale;
    reference.totalDurationS = declaredDurationS;
  }

  return { ...reference, stopRefs: stopRefsForTour(tour, reference.vertices) };
}

function routeReference(graph, tour = {}) {
  const edgeSequence = routeEdges(graph, tour);
  if (edgeSequence.length > 0) return referenceFromEdges(graph, edgeSequence);
  const points = (tour.stops ?? []).map((stop) => pointFromStopOrGraph(graph, stop)).filter(Boolean);
  return referenceFromPoints(graph, points);
}

function routeEdges(graph, tour = {}) {
  const fromEdges = edgesFromRawList(graph, tour.edges);
  if (fromEdges.length > 0) return fromEdges;
  return edgesFromPath(graph, tour.path);
}

function edgesFromRawList(graph, edges = []) {
  if (!Array.isArray(edges)) return [];
  const out = [];
  for (const raw of edges) {
    const edge = resolveEdge(graph, raw);
    if (!edge?.from || !edge?.to) continue;
    out.push(edge);
  }
  return out;
}

function edgesFromPath(graph, path = []) {
  if (!Array.isArray(path)) return [];
  const ids = path.map((item) => typeof item === "object" && item ? item.nodeId ?? item.id : item).filter(Boolean);
  const out = [];
  for (let i = 1; i < ids.length; i += 1) {
    const edge = graph?.edgeBetween?.(ids[i - 1], ids[i])
      ?? graph?.edgeById?.get?.(edgeKey(ids[i - 1], ids[i]))
      ?? null;
    if (edge?.from && edge?.to) out.push(edge);
  }
  return out;
}

function referenceFromEdges(graph, edges) {
  const vertices = [];
  let totalKm = 0;
  let totalDurationS = 0;
  for (const edge of edges) {
    const from = pointFromStopOrGraph(graph, edge.from);
    const to = pointFromStopOrGraph(graph, edge.to);
    if (!from || !to) continue;
    const distanceKm = edgeDistanceKm(edge, from, to);
    const durationS = edgeDurationS(edge, distanceKm);
    const line = expandedLine(edge, from, to);
    const lineKm = lineLengthKm(line);
    if (edge?.kind === "pass-climb" && vertices.length > 0) vertices[vertices.length - 1].onPassClimb = true;
    if (vertices.length === 0) vertices.push(makeVertex(line[0], 0, totalKm, totalDurationS, edge?.kind === "pass-climb"));
    else if (vertices[vertices.length - 1].id !== from.id) vertices.push(makeVertex(from, vertices.length, totalKm, totalDurationS, edge?.kind === "pass-climb"));
    let traversedKm = 0;
    for (let i = 1; i < line.length; i += 1) {
      traversedKm += haversineM(line[i - 1], line[i]) / 1000;
      const ratio = clamp01(lineKm > EPS ? traversedKm / lineKm : i / Math.max(1, line.length - 1));
      vertices.push(makeVertex(line[i], vertices.length, totalKm + distanceKm * ratio, totalDurationS + durationS * ratio, edge?.kind === "pass-climb"));
    }
    totalKm += distanceKm;
    totalDurationS += durationS;
    if (vertices.length > 0) {
      vertices[vertices.length - 1].s = totalKm;
      vertices[vertices.length - 1].tSec = totalDurationS;
    }
  }
  return { vertices, stopRefs: [], totalKm, totalDurationS };
}

function referenceFromPoints(graph, points) {
  if (points.length === 0) return { vertices: [], stopRefs: [], totalKm: 0, totalDurationS: 0 };
  let totalKm = 0;
  let totalDurationS = 0;
  const vertices = [makeVertex(points[0], 0, 0, 0)];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const edge = edgeBetweenPoints(graph, previous, current);
    const distanceKm = edgeDistanceKm(edge, previous, current);
    const durationS = edgeDurationS(edge, distanceKm);
    if (edge?.kind === "pass-climb") vertices[vertices.length - 1].onPassClimb = true;
    totalKm += distanceKm;
    totalDurationS += durationS;
    vertices.push(makeVertex(current, i, totalKm, totalDurationS, edge?.kind === "pass-climb"));
  }
  return { vertices, stopRefs: [], totalKm, totalDurationS };
}

function resolveEdge(graph, raw) {
  if (typeof raw === "string") {
    const byId = graph?.edgeById?.get?.(raw);
    if (byId) return byId;
    const [from, to] = raw.split("->");
    return from && to ? { id: raw, from, to } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const id = raw.edgeId ?? raw.id;
  return (id && graph?.edgeById?.get?.(id)) || raw;
}

function edgeBetweenPoints(graph, a, b) {
  return graph?.edgeBetween?.(a.id, b.id)
    ?? graph?.edgeById?.get?.(edgeKey(a.id, b.id))
    ?? null;
}

function pointFromStopOrGraph(graph, item) {
  if (typeof item === "string") return pointOf(graph?.nodes?.get?.(item));
  const id = item?.nodeId ?? item?.id;
  return pointOf((id && graph?.nodes?.get?.(id)) || item);
}

function pointOf(value) {
  if (!value || !hasCoord(value)) return null;
  return { id: String(value.nodeId ?? value.id ?? ""), lat: Number(value.lat), lon: Number(value.lon) };
}

function expandedLine(edge, from, to) {
  const geometry = Array.isArray(edge?.geometry) ? edge.geometry.map((point, index) => geometryPoint(point, edge, index)).filter(Boolean) : [];
  const line = [from, ...geometry, to];
  return line.filter((point, index) => index === 0 || haversineM(line[index - 1], point) > 1);
}

function geometryPoint(point, edge, index) {
  const id = `${edge?.id ?? edgeKey(edge?.from, edge?.to)}:g${index}`;
  if (Array.isArray(point) && point.length >= 2) return { id, lat: Number(point[0]), lon: Number(point[1]) };
  if (point && typeof point === "object" && hasCoord(point)) return { id: String(point.id ?? id), lat: Number(point.lat), lon: Number(point.lon) };
  return null;
}

function edgeDistanceKm(edge, from, to) {
  return numberOr(Number(edge?.distanceM) / 1000, haversineM(from, to) / 1000, Number.MIN_VALUE);
}

function edgeDurationS(edge, distanceKm) {
  return numberOr(Number(edge?.durationS), distanceKm / AVG_ROUTE_SPEED_KMH * 3600, Number.MIN_VALUE);
}

function lineLengthKm(line) {
  let sum = 0;
  for (let i = 1; i < line.length; i += 1) sum += haversineM(line[i - 1], line[i]) / 1000;
  return sum;
}

function makeVertex(point, index, s, tSec, onPassClimb = false) {
  const latRad = toRad(point.lat);
  return { id: point.id, lat: point.lat, lon: point.lon, latRad, lonRad: toRad(point.lon), cosLat: Math.cos(latRad), index, s, tSec, onPassClimb };
}

function stopRefsForTour(tour, vertices) {
  const stops = Array.isArray(tour?.stops) ? tour.stops : [];
  if (stops.length === 0) return [];
  const refs = [];
  let startIndex = 0;
  for (const [order, stop] of stops.entries()) {
    const id = String(stop?.nodeId ?? stop?.id ?? "");
    const found = vertices.findIndex((vertex, index) => index >= startIndex && vertex.id === id);
    if (found >= 0) {
      refs.push({ order, id, s: vertices[found].s });
      startIndex = found + 1;
    }
  }
  return refs;
}

function insertionIndexForS(reference, s) {
  const stopRefs = reference.stopRefs;
  if (stopRefs.length === 0) return 0;
  let insertionIndex = 1;
  for (const ref of stopRefs) {
    if (ref.s <= s + EPS) insertionIndex = ref.order + 1;
    else break;
  }
  const closed = stopRefs.length > 1 && stopRefs[0].id && stopRefs[0].id === stopRefs.at(-1).id;
  return Math.min(insertionIndex, Math.max(1, closed ? stopRefs.length - 1 : stopRefs.length));
}

function idsInTour(tour = {}) {
  const ids = new Set();
  for (const stop of tour.stops ?? []) {
    if (stop?.id) ids.add(String(stop.id));
    if (stop?.nodeId) ids.add(String(stop.nodeId));
  }
  return ids;
}

function nearestTourVertex(vertices, poi) {
  const lat = Number(poi.lat), lon = Number(poi.lon);
  const latRad = toRad(lat), lonRad = toRad(lon);
  const cosLat = Math.cos(latRad);
  let bestApprox = Infinity;
  let bestVertex = null;
  for (const candidate of vertices) {
    const candidateApprox = ((candidate.lon - lon) * cosLat) ** 2 + (candidate.lat - lat) ** 2;
    if (candidateApprox < bestApprox - EPS || (Math.abs(candidateApprox - bestApprox) <= EPS && (!bestVertex || candidate.index < bestVertex.index))) {
      bestApprox = candidateApprox;
      bestVertex = candidate;
    }
  }
  if (!bestVertex) return null;
  const h = Math.sin((bestVertex.latRad - latRad) / 2) ** 2 + cosLat * bestVertex.cosLat * Math.sin((bestVertex.lonRad - lonRad) / 2) ** 2;
  return { vertex: bestVertex, distanceKm: 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h))) };
}

function applyAutoFairness(candidates, capPerHour) {
  if (capPerHour <= 0) return { autoInclude: [], overflow: candidates.slice().sort(compareCandidates) };
  const counts = new Map();
  const autoInclude = [];
  const overflow = [];
  for (const candidate of candidates.slice().sort(compareCandidates)) {
    const bucket = candidate.bucket;
    const count = counts.get(bucket) ?? 0;
    if (count < capPerHour) {
      autoInclude.push(candidate);
      counts.set(bucket, count + 1);
    } else {
      overflow.push(candidate);
    }
  }
  return { autoInclude, overflow };
}

function applyDetourBudget(candidates, budgetMin) {
  if (budgetMin == null) return { autoInclude: candidates.slice(), overflow: [] };
  const autoInclude = [];
  const overflow = [];
  let used = 0;
  for (const candidate of candidates.slice().sort(compareCandidates)) {
    if (used + candidate.detourMin <= budgetMin + EPS) {
      autoInclude.push(candidate);
      used += candidate.detourMin;
    } else {
      overflow.push(candidate);
    }
  }
  return { autoInclude, overflow };
}

function rankSuggestionsMmr(candidates, maxSuggestions) {
  const pool = uniqueByPoiId(candidates).sort(compareCandidates);
  const selected = [];
  while (pool.length > 0 && selected.length < maxSuggestions) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const score = pool[i].rankScore - categorySimilarity(pool[i], selected) * 2.5;
      if (score > bestScore + EPS
        || (Math.abs(score - bestScore) <= EPS && compareCandidates(pool[i], pool[bestIndex]) < 0)) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]);
  }
  return { selected, overflow: pool.sort(compareCandidates) };
}

function categorySimilarity(candidate, selected) {
  if (selected.length === 0 || candidate.categories.length === 0) return 0;
  let max = 0;
  for (const item of selected) {
    const union = new Set([...candidate.categories, ...item.categories]);
    if (union.size === 0) continue;
    const overlap = candidate.categories.filter((category) => item.categories.includes(category)).length;
    max = Math.max(max, overlap / union.size);
  }
  return max;
}

function rankScore(candidate, opts) {
  let value = candidate.score;
  if (opts.mode === "hidden-gem") {
    const popularity = Math.max(1, candidate.categories.length);
    value = value / Math.log(popularity + 1);
    if (candidate.themes.includes("hidden-gem")) value *= 1.2;
  }
  const themeHits = countOverlap(candidate.themes, opts.themeTokens)
    + countOverlap(candidate.categories, opts.themeTokens);
  const personaHits = countOverlap(candidate.themes, opts.personaThemeTokens)
    + countOverlap(candidate.categories, opts.personaThemeTokens)
    + countOverlap(candidate.categories, opts.personaTokens);
  return value + themeHits * 2 + personaHits * 1.2 - candidate.detourMin * 0.03;
}

function isAuto(candidate, opts) {
  return candidate.detourMin <= opts.autoIncludeMaxDetourMin + EPS
    && candidate.score >= opts.autoIncludeMinScore;
}

function isSuggestion(candidate, opts) {
  return candidate.detourMin <= opts.suggestMaxDetourMin + EPS
    && candidate.score >= opts.suggestMinScore;
}

function toPublicItem(candidate, tier, opts) {
  return {
    poiId: candidate.poiId,
    poiName: candidate.poiName,
    lat: candidate.lat,
    lon: candidate.lon,
    score: round(candidate.score, 2),
    themes: candidate.themes.slice(),
    categories: candidate.categories.slice(),
    detourMin: round(candidate.detourMin, 1),
    detourKm: round(candidate.detourKm, 2),
    insertionIndex: candidate.insertionIndex,
    reason: reasonFor(candidate, tier, opts),
  };
}

function reasonFor(candidate, tier, opts) {
  const label = humanLabel(candidate.categories[0] ?? candidate.themes[0] ?? "stop");
  if (opts.mode === "hidden-gem" && (candidate.categories.length <= 1 || candidate.themes.includes("hidden-gem"))) {
    return `Hidden gem: ${formatNumber(candidate.offRouteKm, 1)} km off-route`;
  }
  if (tier === "auto") return `Auto: ${Math.round(candidate.detourMin)} min round-trip detour, score ${formatNumber(candidate.score, 1)} ${label}`;
  if (tier === "suggestion") return `Suggest: ${Math.round(candidate.detourMin)} min round-trip detour ${label}`;
  return `Explore: ${Math.round(candidate.detourMin)} min round-trip detour ${label}`;
}

function compareCandidates(a, b) {
  return (b.rankScore - a.rankScore)
    || (b.score - a.score)
    || (a.detourMin - b.detourMin)
    || (a.insertionIndex - b.insertionIndex)
    || a.poiId.localeCompare(b.poiId);
}

function compareRouteOrder(a, b) {
  return (a.insertionIndex - b.insertionIndex)
    || (a.detourMin - b.detourMin)
    || (b.rankScore - a.rankScore)
    || a.poiId.localeCompare(b.poiId);
}

function uniqueByPoiId(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item.poiId)) continue;
    seen.add(item.poiId);
    out.push(item);
  }
  return out;
}

function scoreOf(poi) { return numberOr(poi?.score ?? poi?.scenicScore ?? poi?.quality, 0); }

function normalizeTokens(values) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  return [...new Set(list.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
}

function countOverlap(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(b);
  return a.reduce((sum, item) => sum + (set.has(item) ? 1 : 0), 0);
}

function durationSecondsOf(tour = {}) {
  if (Number.isFinite(Number(tour.totalDurationS)) && Number(tour.totalDurationS) > 0) return Number(tour.totalDurationS);
  if (Number.isFinite(Number(tour.totalDurationH)) && Number(tour.totalDurationH) > 0) return Number(tour.totalDurationH) * 3600;
  return 0;
}

function hasCoord(point) { return Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon)); }

function numberOr(value, fallback, min = -Infinity) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function humanLabel(value) { return String(value).replace(/-/g, " "); }

function formatNumber(value, digits) {
  return round(value, digits).toLocaleString("en-US", { maximumFractionDigits: digits });
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function clamp01(value) { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }

function toRad(value) { return value * Math.PI / 180; }

function emptyResult(extraDiagnostics = {}) {
  return {
    autoInclude: [],
    suggestions: [],
    drawer: [],
    diagnostics: {
      candidatesScanned: 0,
      corridorPoiCount: 0,
      softEligibleCount: 0,
      autoIncludedDetourSum: 0,
      ...extraDiagnostics,
    },
  };
}
