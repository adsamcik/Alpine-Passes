import { edgeKey, haversineM } from "./graph.js";
const FOOD_RADIUS_M = 8_000;
const CLUSTER_EPS_M = 4_000;
const POLYGON_PAD_M = 500;
const SAMPLE_STEP_S = 5 * 60;
const SIDE_ROAD_M_PER_MIN = 500;
const BIG_PASS_GAIN_M = 800, POST_EFFORT_WINDOW_S = 45 * 60, QUALITY_SCORE_SCALE = 5;
const PERSONA_IDEAL = Object.freeze({
  early: [11, 45],
  normal: [12, 30],
  late: [13, 30],
  foodie: [12, 30],
  family: [12, 0],
});
const FOOD_CATEGORIES = new Set(["restaurant", "cafe", "cafe-bistro", "restaurant-cafe", "alpine-hut", "mountain-hut", "mountain-restaurant", "alpine-restaurant"]);
const VALLEY_CATEGORIES = new Set(["restaurant", "cafe"]);
const HUT_CATEGORIES = new Set(["alpine-hut", "mountain-hut"]);
const FAMILY_CATEGORIES = new Set(["playground", "park", "toilet"]);
/**
 * Builds deterministic lunch-zone suggestions for an already planned leisure tour.
 *
 * @param {import("./graph.js").LeisureGraph} graph
 * @param {{stops?: object[], edges?: (string|object)[], totalDurationS?: number, dwellSecPerStop?: number|object|Map}} tour
 * @param {object} [options={}]
 * @returns {{zones: object[], desert: object|null, hungerCurve: {t: Date, value: number}[]}}
 */
export function planLunchZone(graph, tour, options = {}) {
  const opts = normalizeOptions(options);
  const profile = buildProfile(graph, tour, opts.startTime);
  if (profile.totalDurationS === 0) return { zones: [], desert: null, hungerCurve: [] };
  const curve = buildHungerCurve(profile, opts);
  if (opts.lunchPolicy === "skip") {
    return { zones: [], desert: null, hungerCurve: curve.map((p) => ({ t: p.t, value: 0 })) };
  }
  const peak = curve.reduce((best, item) => (item.value > best.value ? item : best));
  const window = lunchWindow(curve, peak, opts.lunchPolicy);
  const candidates = findFoodCandidates(graph, profile, window, peak.tSec);
  if (candidates.length === 0) {
    return {
      zones: [],
      desert: makeDesert(profile, window),
      hungerCurve: curve.map(publicCurvePoint),
    };
  }
  const narrative = opts.narrativeMode ? narrativeContext(profile) : null;
  const zones = clusterCandidates(candidates)
    .map((cluster) => buildZone(cluster, profile, window, peak.tSec, opts, narrative))
    .sort(compareZones)
    .map((zone) => ({
      id: zone.id,
      polygon: zone.polygon,
      centroid: zone.centroid,
      tArriveMin: zone.tArriveMin,
      tArriveMax: zone.tArriveMax,
      candidates: zone.candidates,
      score: round(zone.score, 4),
      vibeTag: zone.vibeTag,
      narrativeRole: zone.narrativeRole,
    }));
  return { zones, desert: null, hungerCurve: curve.map(publicCurvePoint) };
}
function normalizeOptions(options) {
  const startTime = options.startTime instanceof Date ? new Date(options.startTime) : new Date();
  if (!(options.startTime instanceof Date)) startTime.setHours(8, 0, 0, 0);
  const persona = Object.hasOwn(PERSONA_IDEAL, options.persona) ? options.persona : "normal";
  const rawPolicy = options.lunchPolicy ?? "auto";
  let lunchPolicy = rawPolicy === "skip" ? "skip" : rawPolicy === "auto" ? "auto" : Number(rawPolicy);
  if (lunchPolicy !== "skip" && lunchPolicy !== "auto" && (!Number.isFinite(lunchPolicy) || lunchPolicy <= 0)) lunchPolicy = "auto";
  return {
    startTime,
    persona,
    lunchPolicy,
    narrativeMode: options.narrativeMode !== false,
    weather: ["sunny", "rainy", "snow"].includes(options.weather) ? options.weather : null,
  };
}
function buildProfile(graph, tour = {}, startTime) {
  const edges = (Array.isArray(tour.edges) ? tour.edges : []).map((raw) => resolveEdge(graph, raw)).filter(Boolean);
  const stopMap = stopsByNodeId(tour);
  const vertices = [];
  const segments = [];
  let tSec = 0;
  let sM = 0;
  if (edges.length > 0) {
    let last = pointFromNode(graph, edges[0].from);
    if (last) vertices.push(makeVertex(last, 0, 0, 0));
    for (const [edgeIndex, edge] of edges.entries()) {
      const from = pointFromNode(graph, edge.from);
      const to = pointFromNode(graph, edge.to);
      if (!from || !to) continue;
      if (!last || last.id !== from.id) {
        vertices.push(makeVertex(from, vertices.length, sM, tSec));
        last = from;
      }
      if (edgeIndex > 0) tSec += dwellFor(tour.dwellSecPerStop, stopMap.get(from.id), from.id);
      const durationS = positiveNumber(edge.durationS, fallbackDurationS(from, to, edge));
      const distanceM = positiveNumber(edge.distanceM, haversineM(from, to));
      const startT = tSec;
      const startS = sM;
      const line = expandedLine(edge, from, to);
      const lineDistance = lineLengthM(line) || distanceM;
      let traversed = 0;
      for (let i = 1; i < line.length; i += 1) {
        const step = haversineM(line[i - 1], line[i]);
        traversed += Number.isFinite(step) ? step : 0;
        const ratio = Math.min(1, lineDistance > 0 ? traversed / lineDistance : i / (line.length - 1));
        vertices.push(makeVertex(line[i], vertices.length, startS + distanceM * ratio, startT + durationS * ratio, edge, from, to));
      }
      segments.push(makeSegment(edge, from, to, startT, tSec + durationS, startS, sM + distanceM));
      tSec += durationS;
      sM += distanceM;
      last = to;
    }
  } else {
    const points = (tour.stops ?? []).map((stop) => pointFromStopOrNode(graph, stop)).filter(Boolean);
    if (points.length > 0) vertices.push(makeVertex(points[0], 0, 0, 0));
    for (let i = 1; i < points.length; i += 1) {
      const from = points[i - 1];
      const to = points[i];
      tSec += dwellFor(tour.dwellSecPerStop, stopMap.get(from.id), from.id);
      const edge = graph?.edgeBetween?.(from.id, to.id) ?? graph?.edgeById?.get?.(edgeKey(from.id, to.id)) ?? null;
      const durationS = positiveNumber(edge?.durationS, fallbackDurationS(from, to, edge));
      const distanceM = positiveNumber(edge?.distanceM, haversineM(from, to));
      const startT = tSec;
      const startS = sM;
      tSec += durationS;
      sM += distanceM;
      vertices.push(makeVertex(to, vertices.length, sM, tSec, edge, from, to));
      segments.push(makeSegment(edge ?? { from: from.id, to: to.id }, from, to, startT, tSec, startS, sM));
    }
  }
  const declared = Number(tour.totalDurationS);
  if (segments.length === 0 && Number.isFinite(declared) && declared > 0 && vertices.length === 1) tSec = declared;
  const scenicScores = segments.map((s) => s.scenicScore).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    startTime,
    vertices,
    segments,
    totalDurationS: Math.max(tSec, Number.isFinite(declared) ? declared : 0),
    scenicThreshold: scenicScores.length ? scenicScores[Math.floor((scenicScores.length - 1) * 0.9)] : Infinity,
  };
}
function resolveEdge(graph, raw) {
  if (typeof raw === "string") {
    return graph?.edgeById?.get?.(raw) ?? graph?.edgeByKey?.get?.(raw) ?? edgeFromId(raw);
  }
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id ?? raw.edgeId;
  return (id && graph?.edgeById?.get?.(id)) || raw;
}
function edgeFromId(id) {
  const [from, to] = String(id).split("->");
  return from && to ? { id, from, to } : null;
}
function buildHungerCurve(profile, opts) {
  const total = Math.max(0, profile.totalDurationS);
  const samples = [];
  for (let tSec = 0; tSec < total; tSec += SAMPLE_STEP_S) samples.push(hungerAt(profile, opts, tSec));
  samples.push(hungerAt(profile, opts, total));
  return samples;
}
function hungerAt(profile, opts, tSec) {
  const date = new Date(profile.startTime.getTime() + tSec * 1000);
  const [hour, minute] = PERSONA_IDEAL[opts.persona];
  const ideal = new Date(profile.startTime);
  ideal.setHours(hour, minute, 0, 0);
  const sigmaMin = opts.persona === "foodie" ? 45 : 30;
  const deltaMin = (date.getTime() - ideal.getTime()) / 60_000;
  const idealScore = Math.exp(-0.5 * (deltaMin / sigmaMin) ** 2);
  const pressure = clamp01((tSec / 3600 - 4) / 2) * 0.55;
  const postEffort = recentlyAfterBigPass(profile, tSec) ? 0.3 : 0;
  const segment = segmentAt(profile, tSec);
  const scenicAnti = segment && segment.scenicScore >= profile.scenicThreshold ? -0.2 : 0;
  return { t: date, tSec, value: round(Math.max(0, idealScore + pressure + postEffort + scenicAnti), 4) };
}
function recentlyAfterBigPass(profile, tSec) {
  for (const segment of profile.segments) {
    if (segment.gainM < BIG_PASS_GAIN_M) continue;
    if (tSec >= segment.endT && tSec <= segment.endT + POST_EFFORT_WINDOW_S) return true;
  }
  return false;
}
function lunchWindow(curve, peak, policy) {
  if (typeof policy === "number") {
    const half = policy * 30;
    return { minSec: Math.max(0, peak.tSec - half), maxSec: peak.tSec + half };
  }
  const halfValue = peak.value / 2;
  let left = curve.findIndex((item) => item === peak);
  let right = left;
  while (left > 0 && curve[left - 1].value >= halfValue) left -= 1;
  while (right < curve.length - 1 && curve[right + 1].value >= halfValue) right += 1;
  return { minSec: curve[left]?.tSec ?? Math.max(0, peak.tSec - 45 * 60), maxSec: curve[right]?.tSec ?? peak.tSec + 45 * 60 };
}
function findFoodCandidates(graph, profile, window, peakSec) {
  const routePoints = routePointsInWindow(profile, window);
  const pois = graph?.nodesByKind?.get?.("poi") ?? [];
  const out = [];
  for (const poi of pois) {
    if (!isFoodPoi(poi) || !hasCoord(poi)) continue;
    const nearest = nearestPoint(routePoints, poi);
    if (!nearest || nearest.distanceM > FOOD_RADIUS_M) continue;
    const categories = normalizeTokens(poi.categories ?? poi.category);
    const themes = normalizeTokens(poi.themes);
    out.push({
      poiId: String(poi.id),
      name: poi.name ?? String(poi.id),
      lat: Number(poi.lat),
      lon: Number(poi.lon),
      elev: finiteNumber(poi.elev),
      rawScore: finiteNumber(poi.score ?? poi.rating ?? poi.scenicScore, 0),
      score: round(finiteNumber(poi.score ?? poi.rating ?? poi.scenicScore, 0), 2),
      categories,
      themes,
      detourMin: round(nearest.distanceM / SIDE_ROAD_M_PER_MIN * 2, 2),
      sM: nearest.point.sM,
      tSec: nearest.point.tSec,
      driftMin: Math.abs((nearest.point.tSec ?? peakSec) - peakSec) / 60,
    });
  }
  return out.sort(compareCandidates);
}
function isFoodPoi(poi) {
  const themes = normalizeTokens(poi?.themes);
  if (themes.includes("food-drink")) return true;
  const categories = normalizeTokens(poi?.categories ?? poi?.category);
  return categories.some((category) => FOOD_CATEGORIES.has(category));
}
function routePointsInWindow(profile, window) {
  const points = profile.vertices
    .filter((v) => v.tSec >= window.minSec - 1 && v.tSec <= window.maxSec + 1)
    .map(routePoint);
  for (let tSec = Math.max(0, window.minSec); tSec <= window.maxSec + 1; tSec += SAMPLE_STEP_S) {
    const point = pointAtTime(profile, tSec);
    if (point) points.push(point);
  }
  for (const tSec of [window.minSec, window.maxSec]) {
    const point = pointAtTime(profile, tSec);
    if (point) points.push(point);
  }
  return points.length ? points : profile.vertices.map(routePoint);
}
function clusterCandidates(candidates) {
  const sorted = candidates.slice().sort((a, b) => a.sM - b.sM || a.poiId.localeCompare(b.poiId));
  const seen = new Set();
  const clusters = [];
  for (const candidate of sorted) {
    if (seen.has(candidate.poiId)) continue;
    const cluster = [];
    const stack = [candidate];
    seen.add(candidate.poiId);
    while (stack.length) {
      const current = stack.pop();
      cluster.push(current);
      for (const other of sorted) {
        if (seen.has(other.poiId)) continue;
        if (planarDistanceM(current, other) <= CLUSTER_EPS_M) {
          seen.add(other.poiId);
          stack.push(other);
        }
      }
    }
    clusters.push(cluster.sort(compareCandidates));
  }
  return clusters.sort((a, b) => a[0].sM - b[0].sM || a[0].poiId.localeCompare(b[0].poiId));
}
function buildZone(cluster, profile, window, peakSec, opts, narrative) {
  const centroid = clusterCentroid(cluster);
  const vibeTag = vibeFor(cluster);
  const polygon = clampPolygon(expandedHull(cluster, centroid), cluster, profile);
  const meanQuality = mean(cluster.map((c) => normalizedQuality(c.rawScore)));
  const entropy = categoryEntropy(cluster);
  const scenic = scenicAround(profile, mean(cluster.map((c) => c.tSec)));
  const avgDetour = mean(cluster.map((c) => c.detourMin));
  const halfArriveWindowSec = Math.max(60, window.maxSec - window.minSec) / 2;
  const arrivalSec = mean(cluster.map((c) => c.tSec)) + avgDetour * 30;
  const drift = mean(cluster.map((c) => c.driftMin));
  let score = 1.2 * Math.log1p(cluster.length) + 0.9 * meanQuality + 0.35 * entropy + 0.45 * scenic - 0.06 * avgDetour - 0.01 * drift;
  if (opts.persona === "foodie") score += 1.5 * meanQuality + (cluster.some((c) => c.rawScore >= 5) ? 0.8 : 0);
  if (opts.persona === "family") {
    score += 0.55 * mean(cluster.map((c) => hasAny(c.categories, FAMILY_CATEGORIES) ? 1 : 0));
    if (vibeTag === "mountain-hut") score -= 0.8 + 0.02 * avgDetour;
  }
  if (opts.weather === "rainy" && vibeTag === "mountain-hut") score -= 0.3;
  const narrativeRole = qualifiesPostClimax(narrative, cluster, centroid) ? "post-climax" : null;
  if (narrativeRole) score += 0.7;
  const id = `lunch-${cluster.map((c) => c.poiId).sort()[0]}`;
  return {
    id,
    polygon,
    centroid: [round(centroid.lat, 6), round(centroid.lon, 6)],
    tArriveMin: new Date(profile.startTime.getTime() + Math.max(0, arrivalSec - halfArriveWindowSec) * 1000),
    tArriveMax: new Date(profile.startTime.getTime() + Math.max(0, arrivalSec + halfArriveWindowSec) * 1000),
    candidates: cluster.map(publicCandidate),
    score,
    vibeTag,
    narrativeRole,
  };
}
function publicCandidate(c) {
  return {
    poiId: c.poiId,
    name: c.name,
    lat: c.lat,
    lon: c.lon,
    score: c.score,
    categories: c.categories.slice(),
    themes: c.themes.slice(),
    detourMin: c.detourMin,
  };
}
function vibeFor(cluster) {
  if (cluster.every((c) => hasAny(c.categories, HUT_CATEGORIES))) return "mountain-hut";
  if (cluster.every((c) => hasAny(c.categories, VALLEY_CATEGORIES))) return "valley";
  return "hidden";
}
function narrativeContext(profile) {
  let climax = null;
  for (const segment of profile.segments) {
    const rank = finiteNumber(segment.scenicScore, 0) + (segment.kind === "pass-climb" ? 0.25 : 0);
    if (!climax || rank > climax.rank || (rank === climax.rank && segment.endT < climax.endT)) climax = { ...segment, rank };
  }
  if (!climax) return null;
  const climaxElev = Math.max(finiteNumber(climax.from.elev, -Infinity), finiteNumber(climax.to.elev, -Infinity));
  if (!Number.isFinite(climaxElev)) return null;
  return { minT: climax.endT + 30 * 60, maxT: climax.endT + 45 * 60, elev: climaxElev };
}
function qualifiesPostClimax(narrative, cluster, centroid) {
  if (!narrative) return false;
  const t = mean(cluster.map((c) => c.tSec));
  const elevs = cluster.map((c) => c.elev).filter(Number.isFinite);
  const elev = elevs.length ? mean(elevs) : finiteNumber(centroid.elev);
  return t >= narrative.minT && t <= narrative.maxT && Number.isFinite(elev) && narrative.elev - elev >= 300;
}
function makeDesert(profile, window) {
  const start = new Date(profile.startTime.getTime() + window.minSec * 1000);
  const end = new Date(profile.startTime.getTime() + window.maxSec * 1000);
  const a = namedPointAt(profile, window.minSec);
  const b = namedPointAt(profile, window.maxSec);
  return {
    stretchStart: start,
    stretchEnd: end,
    message: `No food ${formatHm(start)}-${formatHm(end)} between ${a} and ${b} — pack a sandwich`,
  };
}
function expandedHull(cluster, centroid) { // Approximate radial 500 m pad, not a true Minkowski offset.
  if (cluster.length === 1) return diamond(centroid);
  const points = cluster.map((p) => toXY(p, centroid)).sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id));
  if (points.length === 2 || Math.abs(polygonAreaXY(points)) < 1) return rectangle(cluster[0], cluster[1], centroid);
  const hull = monotoneHull(points);
  if (hull.length < 3 || Math.abs(polygonAreaXY(hull)) < 1) return rectangle(cluster[0], cluster.at(-1), centroid);
  return hull.map((p) => {
    const len = Math.hypot(p.x, p.y) || 1;
    return fromXY({ x: p.x + p.x / len * POLYGON_PAD_M, y: p.y + p.y / len * POLYGON_PAD_M }, centroid);
  });
}
function diamond(c) {
  const dLat = metersToLat(POLYGON_PAD_M);
  const dLon = metersToLon(POLYGON_PAD_M, c.lat);
  return [[c.lat + dLat, c.lon], [c.lat, c.lon + dLon], [c.lat - dLat, c.lon], [c.lat, c.lon - dLon]];
}
function rectangle(a, b, centroid) {
  const pa = toXY(a, centroid);
  const pb = toXY(b, centroid);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * POLYGON_PAD_M;
  const ny = dx / len * POLYGON_PAD_M;
  return [
    fromXY({ x: pa.x + nx, y: pa.y + ny }, centroid),
    fromXY({ x: pb.x + nx, y: pb.y + ny }, centroid),
    fromXY({ x: pb.x - nx, y: pb.y - ny }, centroid),
    fromXY({ x: pa.x - nx, y: pa.y - ny }, centroid),
  ];
}
function monotoneHull(points) {
  const lower = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function clampPolygon(polygon, cluster, profile) {
  if (!profile.vertices.some((v) => Number.isFinite(v.elev)) || !cluster.some((c) => Number.isFinite(c.elev))) return polygon.map(roundCoord);
  const filtered = polygon.filter(([lat, lon]) => {
    const nearestCandidate = nearestPoint(cluster, { lat, lon });
    const nearestRoute = nearestPoint(profile.vertices.filter((v) => Number.isFinite(v.elev)), { lat, lon });
    return !nearestCandidate || !nearestRoute || Math.abs(nearestCandidate.point.elev - nearestRoute.point.elev) <= 300;
  });
  return (filtered.length >= 3 ? filtered : polygon).map(roundCoord);
}
function pointAtTime(profile, tSec) {
  if (profile.segments.length === 0) return profile.vertices[0] ? routePoint(profile.vertices[0]) : null;
  const segment = segmentAt(profile, tSec) ?? (tSec < profile.segments[0].startT ? profile.segments[0] : profile.segments.at(-1));
  const ratio = clamp01((tSec - segment.startT) / Math.max(1, segment.endT - segment.startT));
  return {
    lat: segment.from.lat + (segment.to.lat - segment.from.lat) * ratio,
    lon: segment.from.lon + (segment.to.lon - segment.from.lon) * ratio,
    elev: interpolateMaybe(segment.from.elev, segment.to.elev, ratio),
    sM: segment.startS + (segment.endS - segment.startS) * ratio,
    tSec,
  };
}
function segmentAt(profile, tSec) {
  return profile.segments.find((s) => tSec >= s.startT && tSec <= s.endT) ?? null;
}
function makeSegment(edge, from, to, startT, endT, startS, endS) {
  return {
    edge,
    from,
    to,
    startT,
    endT,
    startS,
    endS,
    kind: edge?.kind,
    scenicScore: finiteNumber(edge?.scenicScore),
    gainM: finiteNumber(edge?.elevationGainM ?? edge?.gainM ?? edge?.ascentM, Math.abs(finiteNumber(to.elev, 0) - finiteNumber(from.elev, 0))),
  };
}
function makeVertex(point, index, sM, tSec, edge = null, from = null, to = null) {
  return { ...point, index, sM, tSec, edge, elev: finiteNumber(point.elev), onPassClimb: edge?.kind === "pass-climb", from, to };
}
function pointFromNode(graph, id) {
  return pointOf(graph?.nodes?.get?.(id) ?? graph?.nodeById?.get?.(id));
}
function pointFromStopOrNode(graph, item) {
  if (typeof item === "string") return pointFromNode(graph, item);
  return pointOf((item?.nodeId && graph?.nodes?.get?.(item.nodeId)) || (item?.id && graph?.nodes?.get?.(item.id)) || item);
}
function pointOf(value) {
  if (!hasCoord(value)) return null;
  return { id: String(value.nodeId ?? value.id ?? ""), name: value.name ?? value.id, lat: Number(value.lat), lon: Number(value.lon), elev: finiteNumber(value.elev) };
}
function expandedLine(edge, from, to) {
  const geometry = Array.isArray(edge?.geometry) ? edge.geometry.map((p, i) => geometryPoint(p, edge, i)).filter(Boolean) : [];
  const line = [from, ...geometry, to];
  return line.filter((p, i) => i === 0 || haversineM(line[i - 1], p) > 1);
}
function geometryPoint(point, edge, index) {
  if (Array.isArray(point) && point.length >= 2) return { id: `${edge.id ?? edgeKey(edge.from, edge.to)}:g${index}`, lat: Number(point[0]), lon: Number(point[1]) };
  if (hasCoord(point)) return pointOf({ ...point, id: point.id ?? `${edge.id ?? edgeKey(edge.from, edge.to)}:g${index}` });
  return null;
}
function stopsByNodeId(tour = {}) {
  const map = new Map();
  for (const [index, stop] of (tour.stops ?? []).entries()) {
    const id = String(stop?.nodeId ?? stop?.id ?? "");
    if (id) map.set(id, { ...stop, index });
  }
  return map;
}
function dwellFor(spec, stop, id) {
  if (!stop) return 0;
  if (Number.isFinite(Number(spec))) return Math.max(0, Number(spec));
  if (spec instanceof Map) return Math.max(0, Number(spec.get(id) ?? spec.get(stop.id) ?? 0) || 0);
  if (spec && typeof spec === "object") return Math.max(0, Number(spec[id] ?? spec[stop.id] ?? spec[stop.index] ?? 0) || 0);
  return 0;
}
function namedPointAt(profile, tSec) {
  const target = pointAtTime(profile, tSec);
  const nearest = target ? nearestPoint(profile.vertices.filter((v) => v.name || v.id), target) : null;
  return nearest?.point?.name ?? nearest?.point?.id ?? "route point";
}
function scenicAround(profile, tSec) {
  const scenic = finiteNumber(segmentAt(profile, tSec)?.scenicScore, 0);
  return scenic > 1 ? scenic / 10 : scenic; // Supports normalized 0..1 and legacy 0..10 scenic scores.
}
function publicCurvePoint(point) { return { t: point.t, value: point.value }; }
function compareZones(a, b) {
  return b.score - a.score
    || a.id.localeCompare(b.id)
    || a.centroid[0] - b.centroid[0]
    || a.centroid[1] - b.centroid[1];
}
function compareCandidates(a, b) {
  return a.detourMin - b.detourMin || b.rawScore - a.rawScore || a.poiId.localeCompare(b.poiId);
}
function clusterCentroid(cluster) {
  const elevs = cluster.map((c) => c.elev).filter(Number.isFinite);
  return {
    lat: mean(cluster.map((c) => c.lat)),
    lon: mean(cluster.map((c) => c.lon)),
    elev: elevs.length ? mean(elevs) : NaN,
  };
}
function categoryEntropy(cluster) {
  const counts = new Map();
  for (const c of cluster) for (const category of c.categories) counts.set(category, (counts.get(category) ?? 0) + 1);
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (total <= 0 || counts.size <= 1) return 0;
  let h = 0;
  for (const n of counts.values()) {
    const p = n / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(counts.size);
}
function normalizedQuality(score) {
  return clamp01(score / QUALITY_SCORE_SCALE);
}
function nearestPoint(points, target) {
  let best = null;
  for (const point of points) {
    const distanceM = planarDistanceM(point, target);
    if (!Number.isFinite(distanceM)) continue;
    if (!best || distanceM < best.distanceM - 1e-6 || (Math.abs(distanceM - best.distanceM) <= 1e-6 && String(point.id ?? "").localeCompare(String(best.point.id ?? "")) < 0)) {
      best = { point, distanceM };
    }
  }
  return best;
}
function planarDistanceM(a, b) {
  if (!hasCoord(a) || !hasCoord(b)) return Infinity;
  const lat = (Number(a.lat) + Number(b.lat)) * Math.PI / 360;
  return Math.hypot((Number(a.lon) - Number(b.lon)) * 111_320 * Math.cos(lat), (Number(a.lat) - Number(b.lat)) * 111_320);
}
function routePoint(v) {
  return { id: v.id, name: v.name, lat: v.lat, lon: v.lon, elev: v.elev, sM: v.sM, tSec: v.tSec };
}
function normalizeTokens(values) {
  const list = Array.isArray(values) || values instanceof Set ? [...values] : values == null ? [] : [values];
  return [...new Set(list.flatMap((value) => String(value).split(",")).map(normalizeToken).filter(Boolean))];
}
function normalizeToken(value) {
  return String(value).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s_]+/g, "-");
}
function hasAny(values, set) {
  return values.some((value) => set.has(value));
}
function hasCoord(point) { return Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon)); }
function positiveNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function finiteNumber(value, fallback = NaN) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function fallbackDurationS(from, to, edge) {
  const distanceM = positiveNumber(edge?.distanceM, haversineM(from, to));
  return distanceM / 55_000 * 3600;
}
function lineLengthM(points) {
  let sum = 0;
  for (let i = 1; i < points.length; i += 1) sum += finiteNumber(haversineM(points[i - 1], points[i]), 0);
  return sum;
}
function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}
function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
function roundCoord(coord) {
  return [round(coord[0], 6), round(coord[1], 6)];
}
function formatHm(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function toXY(point, origin) {
  const latM = 111_320;
  const lonM = 111_320 * Math.cos(origin.lat * Math.PI / 180);
  return { id: point.poiId ?? point.id ?? "", x: (point.lon - origin.lon) * lonM, y: (point.lat - origin.lat) * latM };
}
function fromXY(point, origin) {
  return [origin.lat + point.y / 111_320, origin.lon + point.x / (111_320 * Math.cos(origin.lat * Math.PI / 180))];
}
function metersToLat(meters) {
  return meters / 111_320;
}
function metersToLon(meters, lat) {
  return meters / (111_320 * Math.cos(lat * Math.PI / 180));
}
function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
function polygonAreaXY(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}
function interpolateMaybe(a, b, ratio) {
  return Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * ratio : NaN;
}
