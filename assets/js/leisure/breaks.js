const DEFAULT_START = "2026-06-15T08:00:00.000Z";
const SAMPLE_S = 10 * 60, MIN_TOUR_S = 45 * 60, MIN_REST_DWELL_S = 15 * 60, MIN_SINCE_STOP_S = 40 * 60, COOLDOWN_S = 40 * 60, CORRIDOR_RADIUS_M = 5000;
const EARTH_RADIUS_M = 6_371_000;
const PERSONA_THRESHOLDS = Object.freeze({ default: 3.5, motorcyclist: 3.0, family: 2.5, gourmet: 4.0, photographer: 3.5, speedrunner: 6.0 });
export function detectBreaks(graph, tour, options = {}) {
  const edges = tourEdges(graph, tour);
  const segments = splitSegments(graph, tour, edges);
  const totalDurationS = totalDriveSeconds(tour, edges);
  const diagnostics = {
    totalDriveH: round(totalDurationS / 3600, 3),
    segmentCount: segments.length,
    packed: Boolean(options.tourPacked),
    suppressedReason: options.tourPacked ? "tour-packed" : null,
  };
  const startTime = validDate(options.startTime) ? new Date(options.startTime) : new Date(DEFAULT_START);
  const persona = Object.prototype.hasOwnProperty.call(PERSONA_THRESHOLDS, options.persona) ? options.persona : "default";
  const threshold = PERSONA_THRESHOLDS[persona];
  const maxBreaksTotal = Math.max(0, Math.trunc(Number(options.maxBreaksTotal ?? 4) || 0));
  const corridorPois = Array.isArray(options.corridorPois) ? options.corridorPois : [];
  const loadCurve = [];
  const breaks = [];
  const allowSuggestions = !options.tourPacked && totalDurationS >= MIN_TOUR_S && maxBreaksTotal > 0;
  let driveClockS = 0;
  let scheduleExtraS = 0;
  let lastBreakDriveS = -Infinity;
  for (let segmentIdx = 0; segmentIdx < segments.length; segmentIdx += 1) {
    const segment = segments[segmentIdx];
    const metrics = segmentMetrics(graph, segment, corridorPois);
    let sinceStopS = 0;
    let loadTotal = 0;
    let loadBoredom = 0;
    let loadEffort = 0;
    let segmentElapsedS = 0;
    let pendingDecompression = false;
    for (const chunk of segmentChunks(graph, segment)) {
      const durationS = chunk.durationS;
      const nextDriveClockS = driveClockS + durationS;
      segmentElapsedS += durationS;
      sinceStopS += durationS;
      if (isHighPassClimax(graph, chunk.edge)) pendingDecompression = true;
      const t = new Date(startTime.getTime() + (nextDriveClockS + scheduleExtraS) * 1000);
      const chunkLoad = mentalLoad(metrics, durationS, t, options.weather);
      loadTotal += chunkLoad.total;
      loadBoredom += chunkLoad.boredom;
      loadEffort += chunkLoad.effort;
      loadCurve.push({
        tourVertexIdx: chunk.tourVertexIdx,
        t,
        boredom: round(chunkLoad.boredom, 3),
        effort: round(chunkLoad.effort, 3),
        total: round(chunkLoad.total, 3),
      });
      const canSuggest = allowSuggestions
        && sinceStopS > MIN_SINCE_STOP_S
        && nextDriveClockS - lastBreakDriveS >= COOLDOWN_S
        && loadTotal > threshold;
      if (canSuggest) {
        const role = pacingRole(metrics, segmentElapsedS, pendingDecompression);
        const candidate = selectCandidate(corridorPois, chunk.point, persona, role);
        const type = candidate ? breakType(candidate, persona, role) : "stretch";
        const dwellS = breakDurationS(type);
        const tStart = t;
        const tEnd = new Date(tStart.getTime() + dwellS * 1000);
        breaks.push({
          id: `break-${breaks.length + 1}`,
          type,
          tStart,
          tEnd,
          atSegmentIdx: segmentIdx,
          atTourVertexIdx: chunk.tourVertexIdx,
          poiCandidate: candidate ? {
            poiId: candidate.poiId,
            name: candidate.name,
            lat: candidate.lat,
            lon: candidate.lon,
            score: candidate.score,
            detourMin: candidate.detourMin,
            categories: candidate.categories,
          } : null,
          reason: reasonFor(type, role, Math.round(sinceStopS / 60)),
          load: {
            boredom: round(loadBoredom, 3),
            effort: round(loadEffort, 3),
            total: round(loadTotal, 3),
          },
          pacingRole: role,
        });
        lastBreakDriveS = nextDriveClockS;
        scheduleExtraS += dwellS;
        sinceStopS = 0;
        loadTotal = 0;
        loadBoredom = 0;
        loadEffort = 0;
        pendingDecompression = false;
      }
      driveClockS = nextDriveClockS;
    }
  }
  return { breaks: capBreaks(breaks, maxBreaksTotal), loadCurve, diagnostics };
}
function tourEdges(graph, tour) {
  const out = [];
  for (const item of Array.isArray(tour?.edges) ? tour.edges : []) {
    const edge = typeof item === "object" && item ? item : edgeById(graph, item);
    if (edge) out.push(edge);
  }
  if (out.length || !Array.isArray(tour?.path)) return out;
  for (let i = 0; i < tour.path.length - 1; i += 1) {
    const edge = edgeBetween(graph, tour.path[i], tour.path[i + 1]);
    if (edge) out.push(edge);
  }
  return out;
}
function splitSegments(graph, tour, edges) {
  const stopRefs = resolveStopRefs(graph, tour, edges);
  const stopIds = stopRefs.map((stop) => stop.id);
  const route = Array.isArray(tour?.path) ? tour.path.map((item) => typeof item === "object" && item ? stopNodeId(item) : item).filter(Boolean) : [];
  const stopVertexIdxs = stopIds.map((id, index) => {
    const routeIdx = route.indexOf(id);
    return routeIdx >= 0 ? routeIdx : index;
  });
  if (edges.length === 0) return [];
  if (stopIds.length < 2) return [{ edges, startVertexIdx: 0, endVertexIdx: Math.max(1, route.length - 1) }];
  const segments = [];
  let current = [];
  let segmentIdx = 0;
  let nextStopId = stopIds[1];
  for (const edge of edges) {
    current.push(edge);
    if (edgeTo(edge) === nextStopId && segmentIdx < stopIds.length - 2) {
      segments.push({ edges: current, startVertexIdx: stopVertexIdxs[segmentIdx], endVertexIdx: stopVertexIdxs[segmentIdx + 1], startStop: stopRefs[segmentIdx], endStop: stopRefs[segmentIdx + 1] });
      current = [];
      segmentIdx += 1;
      nextStopId = stopIds[segmentIdx + 1];
    }
  }
  if (current.length) {
    const endIndex = Math.min(segmentIdx + 1, stopIds.length - 1);
    segments.push({
      edges: current,
      startVertexIdx: stopVertexIdxs[segmentIdx] ?? segmentIdx,
      endVertexIdx: stopVertexIdxs[endIndex] ?? Math.max(segmentIdx + 1, route.length - 1),
      startStop: stopRefs[segmentIdx],
      endStop: stopRefs[endIndex],
    });
  }
  const rawSegments = segments.length ? segments : [{ edges, startVertexIdx: 0, endVertexIdx: Math.max(stopIds.length - 1, route.length - 1) }];
  return mergeShortDwellSegments(rawSegments);
}

function mergeShortDwellSegments(segments) {
  if (segments.length <= 1) return segments;
  const merged = [];
  let current = { ...segments[0], edges: segments[0].edges.slice(), mergedSegmentCount: 1 };
  for (let i = 1; i < segments.length; i += 1) {
    const next = segments[i];
    const dwellSec = finiteNumber(current.endStop?.dwellSec, 0);
    if (dwellSec < MIN_REST_DWELL_S) {
      current = {
        ...current,
        edges: current.edges.concat(next.edges),
        endVertexIdx: next.endVertexIdx,
        endStop: next.endStop,
        mergedSegmentCount: (current.mergedSegmentCount ?? 1) + (next.mergedSegmentCount ?? 1),
      };
    } else {
      merged.push(current);
      current = { ...next, edges: next.edges.slice(), mergedSegmentCount: next.mergedSegmentCount ?? 1 };
    }
  }
  merged.push(current);
  return merged;
}
function segmentMetrics(graph, segment, corridorPois) {
  let durationS = 0;
  let distanceM = 0;
  let scenicWeighted = 0;
  let straightWeighted = 0;
  let curvatureWeighted = 0;
  let elevGainM = 0;
  const roadMix = {};
  for (const edge of segment.edges) {
    const dS = edgeDurationS(edge);
    const dM = edgeDistanceM(edge, graph);
    const scenic = scenicScore(graph, edge);
    const curvature = edgeCurvatureDensity(graph, edge, dM);
    const straight = edgeStraightFraction(graph, edge);
    const roadClass = normalizedRoadClass(edge);
    durationS += dS;
    distanceM += dM;
    scenicWeighted += scenic * dS;
    straightWeighted += straight * dS;
    curvatureWeighted += curvature * dS;
    elevGainM += edgeElevationGainM(graph, edge);
    roadMix[roadClass] = (roadMix[roadClass] || 0) + dM;
  }
  const distanceKm = Math.max(0.001, distanceM / 1000);
  const poiDensity = corridorPoiDensity(corridorPois, segment, graph, distanceKm);
  return {
    durationS,
    distanceKm,
    scenic: clamp01(durationS ? scenicWeighted / durationS : 0.2),
    straightFraction: clamp01(durationS ? straightWeighted / durationS : 0.5),
    curvatureDensity: Math.max(0, durationS ? curvatureWeighted / durationS : 0),
    elevGainPerKm: elevGainM / distanceKm,
    roadMix,
    poiDensity,
    motorwayFraction: roadFraction(roadMix, distanceM, ["motorway", "trunk"]),
    highPassClimax: segment.edges.some((edge) => isHighPassClimax(graph, edge)),
  };
}
function* segmentChunks(graph, segment) {
  const segmentDurationS = Math.max(1, segment.edges.reduce((sum, edge) => sum + edgeDurationS(edge), 0)), vertexSpan = Math.max(0, segment.endVertexIdx - segment.startVertexIdx);
  let remainingInChunk = SAMPLE_S;
  let currentChunkS = 0;
  let point = null;
  let elapsedS = 0;
  for (const edge of segment.edges) {
    let remainingEdgeS = edgeDurationS(edge);
    while (remainingEdgeS > 1e-9) {
      const takeS = Math.min(remainingEdgeS, remainingInChunk);
      currentChunkS += takeS;
      elapsedS += takeS;
      remainingEdgeS -= takeS;
      remainingInChunk -= takeS;
      point = pointAlongEdge(graph, edge, 1 - remainingEdgeS / Math.max(edgeDurationS(edge), 1));
      const vertexIdx = round(segment.startVertexIdx + vertexSpan * (elapsedS / segmentDurationS), 3);
      if (remainingInChunk <= 1e-9) {
        yield { durationS: currentChunkS, edge, point, tourVertexIdx: vertexIdx };
        remainingInChunk = SAMPLE_S;
        currentChunkS = 0;
      }
    }
  }
  if (currentChunkS > 1e-9) yield { durationS: currentChunkS, edge: segment.edges[segment.edges.length - 1], point, tourVertexIdx: round(segment.endVertexIdx, 3) };
}
function mentalLoad(metrics, durationS, t, weather) {
  const durationMin = durationS / 60;
  const boredom = durationMin * metrics.straightFraction * (1 - metrics.scenic) * (1 - Math.min(0.25, metrics.poiDensity * 0.05));
  const effort = durationMin * metrics.curvatureDensity * Math.max(0, metrics.elevGainPerKm - 30) / 100;
  const total = boredom + effort + circadianPenalty(t) + glarePenalty(t, weather);
  return { boredom, effort, total };
}
function circadianPenalty(t) {
  const minutes = t.getHours() * 60 + t.getMinutes();
  return triangular(minutes, 14 * 60 + 30, 75, 0.4) + triangular(minutes, 17 * 60, 60, 0.2);
}
function glarePenalty(t, weather) {
  if (weather !== "sunny") return 0;
  const hour = t.getHours() + t.getMinutes() / 60;
  return hour < 9 || hour >= 17 ? 0.3 : 0;
}
function pacingRole(metrics, segmentElapsedS, pendingDecompression) {
  if (pendingDecompression) return "decompression";
  const progress = segmentElapsedS / Math.max(metrics.durationS, 1);
  if (metrics.motorwayFraction >= 0.7 && metrics.durationS >= 90 * 60 && progress >= 0.35 && progress <= 0.75) return "micro-surprise";
  return null;
}
function selectCandidate(pois, point, persona, role) {
  if (!Array.isArray(pois) || pois.length === 0 || !validCoord(point)) return null;
  const candidates = [];
  for (const poi of pois) {
    const lat = Number(poi?.lat);
    const lon = Number(poi?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const distanceM = haversineM(point, { lat, lon });
    if (distanceM > CORRIDOR_RADIUS_M) continue;
    const detourMin = finiteNumber(poi.detourMin, 0);
    const cats = poiTokens(poi);
    const scenic = normalizedScore(poi.scenicScore ?? poi.score);
    const score = -detourMin * 3
      + facilityMatch(cats)
      + scenic * 3
      + dwellFit(detourMin)
      + personaBonus(cats, persona)
      + roleBonus(cats, scenic, poi, role);
    candidates.push({
      poiId: String(poi.poiId ?? poi.id ?? poi.name ?? `poi-${candidates.length + 1}`),
      name: String(poi.name ?? poi.poiId ?? poi.id ?? "POI"),
      lat,
      lon,
      detourMin: round(detourMin, 1),
      score: round(score, 3),
      categories: cats,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.detourMin - b.detourMin || a.poiId.localeCompare(b.poiId));
  return candidates[0]?.score >= 1 ? candidates[0] : null;
}
function facilityMatch(cats) {
  let score = 0;
  if (hasAny(cats, ["cafe", "coffee", "restaurant", "food", "food-drink", "cafe-bistro", "restaurant-cafe"])) score += 2;
  if (hasAny(cats, ["viewpoint", "viewpoints", "viewpoint-panorama", "panoramic-view", "scenic", "hidden-gem", "mountain-summit"])) score += 2;
  if (hasAny(cats, ["playground", "park", "picnic"])) score += 2;
  if (hasAny(cats, ["fuel", "gas", "petrol", "charging"])) score += 2;
  if (hasAny(cats, ["settlement", "village", "valley"])) score += 1;
  return score;
}
function personaBonus(cats, persona) {
  if (persona === "family" && hasAny(cats, ["playground", "restaurant", "picnic", "park"])) return 3;
  if (persona === "motorcyclist" && hasAny(cats, ["viewpoint", "viewpoints", "viewpoint-panorama", "panoramic-view", "drivers-road"])) return 3;
  if (persona === "gourmet" && hasAny(cats, ["cafe", "coffee", "food", "food-drink", "restaurant", "cafe-bistro", "restaurant-cafe"])) return 3;
  if (persona === "photographer" && hasAny(cats, ["viewpoint", "viewpoints", "viewpoint-panorama", "panoramic-view", "scenic", "hidden-gem", "mountain-summit"])) return 3;
  if (persona === "speedrunner" && hasAny(cats, ["fuel", "gas", "petrol", "charging"])) return 3;
  return 0;
}
function roleBonus(cats, scenic, poi, role) {
  if (role === "decompression") {
    return (hasAny(cats, ["settlement", "village", "valley", "restaurant", "cafe"]) ? 2 : 0) + (scenic <= 0.45 ? 1.5 : -0.5);
  }
  if (role === "micro-surprise") {
    const popularity = normalizedScore(poi.popularity ?? poi.popularityScore ?? 0.2);
    return scenic >= 0.65 && popularity <= 0.4 ? 2.5 : 0;
  }
  return 0;
}
function dwellFit(detourMin) { return detourMin <= 5 ? 1 : (detourMin <= 10 ? 0.5 : 0); }
function breakType(candidate, persona, role) {
  const cats = candidate.categories;
  if (hasAny(cats, ["fuel", "gas", "petrol", "charging"])) return "fuel";
  if (hasAny(cats, ["viewpoint", "viewpoints", "viewpoint-panorama", "panoramic-view", "scenic", "hidden-gem", "mountain-summit"])) return "viewpoint";
  if (hasAny(cats, ["cafe", "coffee"])) return "coffee";
  if (hasAny(cats, ["restaurant", "food", "food-drink", "cafe-bistro", "restaurant-cafe"])) return persona === "gourmet" ? "coffee" : "rest";
  if (hasAny(cats, ["playground", "park", "picnic", "settlement", "village", "valley"]) || role === "decompression") return "rest";
  return role === "micro-surprise" ? "viewpoint" : "stretch";
}
function reasonFor(type, role, minutes) {
  if (role === "decompression") return "Decompression stop after a high pass descent";
  if (role === "micro-surprise") return "Micro-surprise stop to break a long motorway run";
  return `${type} break after ${minutes} minutes of accumulated driving load`;
}
function breakDurationS(type) { return type === "stretch" || type === "fuel" ? 10 * 60 : (type === "coffee" || type === "viewpoint" ? 15 * 60 : 20 * 60); }
function capBreaks(breaks, maxBreaksTotal) {
  if (breaks.length <= maxBreaksTotal) return breaks.map((item, index) => ({ ...item, id: `break-${index + 1}` }));
  const keep = new Set(breaks
    .map((item, index) => ({ index, load: Number(item.load?.total) || 0, time: item.tStart.getTime() }))
    .sort((a, b) => b.load - a.load || a.time - b.time)
    .slice(0, maxBreaksTotal)
    .map((item) => item.index));
  return breaks
    .filter((_, index) => keep.has(index))
    .sort((a, b) => a.tStart - b.tStart)
    .map((item, index) => ({ ...item, id: `break-${index + 1}` }));
}
function corridorPoiDensity(pois, segment, graph, distanceKm) {
  if (!Array.isArray(pois) || pois.length === 0) return 0;
  let count = 0;
  const points = segment.edges.flatMap((edge) => [nodeById(graph, edgeFrom(edge)), nodeById(graph, edgeTo(edge))]).filter(validCoord);
  for (const poi of pois) {
    const point = { lat: Number(poi?.lat), lon: Number(poi?.lon) };
    if (validCoord(point) && points.some((routePoint) => haversineM(point, routePoint) <= CORRIDOR_RADIUS_M)) count += 1;
  }
  return count / Math.max(distanceKm, 1);
}
function edgeCurvatureDensity(graph, edge, distanceM) {
  const points = edgePoints(graph, edge);
  if (points.length < 3) return edgeKindCurvature(edge);
  const headings = [];
  for (let i = 0; i < points.length - 1; i += 1) headings.push(bearingRad(points[i], points[i + 1]));
  let turn = 0;
  for (let i = 1; i < headings.length; i += 1) turn += Math.abs(angleDelta(headings[i - 1], headings[i]));
  return Math.max(edgeKindCurvature(edge), turn / Math.max(0.2, distanceM / 1000));
}
function edgeStraightFraction(graph, edge) {
  const points = edgePoints(graph, edge);
  if (points.length < 3) return normalizedRoadClass(edge) === "motorway" ? 0.95 : 0.85;
  const headings = [];
  for (let i = 0; i < points.length - 1; i += 1) headings.push(bearingRad(points[i], points[i + 1]));
  let turn = 0;
  for (let i = 1; i < headings.length; i += 1) turn += Math.abs(angleDelta(headings[i - 1], headings[i]));
  return clamp01(1 - Math.min(1, turn / Math.PI));
}
function edgeKindCurvature(edge) {
  if (edge?.kind === "pass-climb" || normalizedRoadClass(edge) === "mountain") return 0.7;
  if (normalizedRoadClass(edge) === "motorway") return 0.05;
  return 0.1;
}
function edgeElevationGainM(graph, edge) {
  for (const key of ["elevGainM", "elevationGainM", "ascentM", "upM"]) {
    const value = Number(edge?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const from = nodeById(graph, edgeFrom(edge));
  const to = nodeById(graph, edgeTo(edge));
  const direct = Number(to?.elev ?? to?.elevationM) - Number(from?.elev ?? from?.elevationM);
  if (Number.isFinite(direct) && direct > 0) return direct;
  if (edge?.kind === "pass-climb" && String(edgeTo(edge)).endsWith(":S")) {
    const summit = summitElevation(graph, edge);
    if (Number.isFinite(summit)) return Math.max(300, summit - 1000);
  }
  return 0;
}
function isHighPassClimax(graph, edge) {
  const to = nodeById(graph, edgeTo(edge));
  const elev = Number(to?.elev ?? to?.elevationM ?? summitElevation(graph, edge));
  return Number.isFinite(elev) && elev > 1500 && (edge?.kind === "pass-climb" || String(edgeTo(edge)).endsWith(":S"));
}
function summitElevation(graph, edge) {
  const passId = edge?.passId ?? String(edgeFrom(edge)).split(":")[0] ?? String(edgeTo(edge)).split(":")[0];
  const pass = nodeById(graph, passId);
  return Number(pass?.elev ?? pass?.elevationM);
}
function scenicScore(graph, edge) {
  const direct = normalizedScore(edge?.scenicScore ?? edge?.score);
  if (direct > 0) return direct;
  const from = nodeById(graph, edgeFrom(edge));
  const to = nodeById(graph, edgeTo(edge));
  const values = [from, to].map((node) => normalizedScore(node?.scenicScore ?? node?.score)).filter((value) => value > 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0.2;
}
function normalizedRoadClass(edge) {
  const raw = String(edge?.roadClass ?? edge?.highway ?? edge?.kind ?? "secondary").toLowerCase();
  if (raw.includes("motorway") || raw.includes("trunk") || raw.includes("highway")) return raw.includes("trunk") ? "trunk" : "motorway";
  if (raw.includes("pass") || raw.includes("mountain") || raw.includes("alpine")) return "mountain";
  if (raw.includes("primary")) return "primary";
  return raw.includes("secondary") ? "secondary" : raw;
}
function roadFraction(roadMix, distanceM, classes) {
  if (distanceM <= 0) return 0;
  return classes.reduce((sum, klass) => sum + (roadMix[klass] || 0), 0) / distanceM;
}
function edgePoints(graph, edge) {
  const geom = Array.isArray(edge?.geometry) ? edge.geometry.map(coordPair).filter(validCoord) : [];
  if (geom.length >= 2) return geom;
  return [nodeById(graph, edgeFrom(edge)), nodeById(graph, edgeTo(edge))].filter(validCoord);
}
function pointAlongEdge(graph, edge, fraction) {
  const points = edgePoints(graph, edge);
  if (!points.length) return null;
  if (points.length === 1) return points[0];
  const index = Math.min(points.length - 2, Math.max(0, Math.floor(clamp01(fraction) * (points.length - 1))));
  const local = clamp01(fraction) * (points.length - 1) - index;
  const a = points[index];
  const b = points[index + 1];
  return { lat: a.lat + (b.lat - a.lat) * local, lon: a.lon + (b.lon - a.lon) * local };
}
function coordPair(pair) {
  if (Array.isArray(pair) && pair.length >= 2) return { lat: Number(pair[0]), lon: Number(pair[1]) };
  if (pair && typeof pair === "object") return { lat: Number(pair.lat), lon: Number(pair.lon) };
  return null;
}
function edgeById(graph, id) {
  if (id === undefined || id === null) return null;
  if (graph?.edgeById instanceof Map) return graph.edgeById.get(id) ?? null;
  if (graph?.edgeById && typeof graph.edgeById === "object") return graph.edgeById[id] ?? null;
  return (graph?.edgeList ?? graph?.edges ?? []).find((edge) => edge.id === id || `${edge.from}->${edge.to}` === id) ?? null;
}
function edgeBetween(graph, from, to) {
  return edgeById(graph, `${from}->${to}`)
    ?? (graph?.edgeByKey instanceof Map ? graph.edgeByKey.get(`${from}->${to}`) : null)
    ?? (typeof graph?.edgeBetween === "function" ? graph.edgeBetween(from, to) : null);
}
function nodeById(graph, id) {
  if (!id) return null;
  if (graph?.nodeById instanceof Map) return graph.nodeById.get(id) ?? null;
  if (graph?.nodes instanceof Map) return graph.nodes.get(id) ?? null;
  if (graph?.nodeById && typeof graph.nodeById === "object") return graph.nodeById[id] ?? null;
  return (Array.isArray(graph?.nodes) ? graph.nodes : graph?.nodeList ?? []).find((node) => node?.id === id) ?? null;
}
function edgeDurationS(edge) {
  return Math.max(0, finiteNumber(edge?.durationS, finiteNumber(edge?.durationMin, 0) * 60));
}
function edgeDistanceM(edge, graph) {
  const explicit = finiteNumber(edge?.distanceM, finiteNumber(edge?.distanceKm, 0) * 1000);
  if (explicit > 0) return explicit;
  const from = nodeById(graph, edgeFrom(edge));
  const to = nodeById(graph, edgeTo(edge));
  return validCoord(from) && validCoord(to) ? haversineM(from, to) : 0;
}
function totalDriveSeconds(tour, edges) {
  const edgeTotal = edges.reduce((sum, edge) => sum + edgeDurationS(edge), 0);
  if (edgeTotal > 0) return edgeTotal;
  return finiteNumber(tour?.totalDurationS, finiteNumber(tour?.totalDurationH, 0) * 3600);
}
function resolveStopRefs(graph, tour, edges) {
  const routeIds = new Set(edges.flatMap((edge) => [edgeFrom(edge), edgeTo(edge)]).filter(Boolean));
  return (Array.isArray(tour?.stops) ? tour.stops : []).map((stop, index) => {
    const direct = stopNodeId(stop);
    const id = routeIds.has(direct) ? direct : nearestRouteNodeId(graph, stop, routeIds) ?? direct;
    return id ? { id, stop, index, dwellSec: dwellSecForStop(tour, stop, id, index) } : null;
  }).filter(Boolean);
}
function nearestRouteNodeId(graph, stop, routeIds) {
  if (!validCoord(stop)) return null;
  let best = null, bestDistance = Infinity;
  for (const id of routeIds) {
    const node = nodeById(graph, id), distance = validCoord(node) ? haversineM(stop, node) : Infinity;
    if (distance < bestDistance) { best = id; bestDistance = distance; }
  }
  return bestDistance <= CORRIDOR_RADIUS_M ? best : null;
}
function edgeFrom(edge) { return edge?.from ?? edge?.source; }
function edgeTo(edge) { return edge?.to ?? edge?.target; }
function stopNodeId(stop) { return stop?.nodeId ?? stop?.node?.id ?? stop?.vertexId ?? stop?.id; }
function dwellSecForStop(tour, stop, id, index) {
  const direct = Number(stop?.dwellSec ?? stop?.dwellS ?? stop?.visitDwellSec);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const spec = tour?.dwellSecPerStop ?? tour?.dwellSecByStop ?? tour?.stopDwellSec;
  if (Number.isFinite(Number(spec))) return Math.max(0, Number(spec));
  if (spec instanceof Map) return Math.max(0, Number(spec.get(id) ?? spec.get(stop?.id) ?? spec.get(index) ?? 0) || 0);
  if (spec && typeof spec === "object") return Math.max(0, Number(spec[id] ?? spec[stop?.id] ?? spec[index] ?? 0) || 0);
  return 0;
}
function poiTokens(poi) {
  const values = [poi?.categories, poi?.themes, poi?.kind, poi?.type].flatMap((value) => Array.isArray(value) ? value : String(value ?? "").split(","));
  return values.map(normalizeToken).filter(Boolean);
}
function hasAny(tokens, choices) {
  const tokenSet = new Set((tokens ?? []).map(normalizeToken).filter(Boolean));
  return choices.some((choice) => tokenSet.has(normalizeToken(choice)));
}
function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s_]+/g, "-");
}
function normalizedScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number > 1 ? clamp01(number / 100) : clamp01(number);
}
function validDate(value) { const date = new Date(value); return Number.isFinite(date.getTime()); }
function validCoord(point) { return Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon)); }
function finiteNumber(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function triangular(value, center, width, amplitude) {
  const distance = Math.abs(value - center);
  return distance >= width ? 0 : amplitude * (1 - distance / width);
}
function bearingRad(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  return Math.atan2(Math.sin(dLon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon));
}
function angleDelta(a, b) { return Math.atan2(Math.sin(b - a), Math.cos(b - a)); }
function haversineM(a, b) {
  const lat1 = toRad(Number(a.lat));
  const lat2 = toRad(Number(b.lat));
  const dLat = toRad(Number(b.lat) - Number(a.lat));
  const dLon = toRad(Number(b.lon) - Number(a.lon));
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
function toRad(value) { return Number(value) * Math.PI / 180; }
function clamp01(value) { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
function round(value, decimals = 3) { const scale = 10 ** decimals; return Math.round((Number(value) || 0) * scale) / scale; }
