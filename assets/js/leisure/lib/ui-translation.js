import { resolvePassIdSet } from "./optimizer-planning.js";

/**
 * Shared UI-translation helpers used by both the JS-only planner
 * (assets/js/leisure/index.js) and the WASM-backed shim
 * (assets/js/leisure/wasm-shim.js).
 *
 * Helpers are pure functions with no module state. Functions that need UI or
 * runtime services receive them through parameters/callbacks; safePhase is the
 * only exported helper that intentionally logs caught Phase 4 errors.
 */

export const DEFAULT_K_ALTERNATIVES = 3;
export const DEFAULT_TIME_BUDGET_MS = 1_000;
const MAX_OSRM_WAYPOINTS = 80;
const FALLBACK_SPEED_KMH = 45;
export const AVG_SPEED_KMH = 55;
export const APPROX_ROUTE_WARNING = "Could not fetch detailed route geometry; map line is approximate.";
/**
 * Build optimizer options from UI options without reading UI/global state.
 */
export function optimizerOptions(uiOptions, endNodeOverride = null) {
  const targetMode = uiOptions.targetMode === "time" ? "time" : "distance";
  const targetValue = positiveNumber(uiOptions.targetValue, targetMode === "time" ? 6 : 200);
  const hasBudgetSeconds = Number.isFinite(Number(uiOptions.budgetSeconds));
  const hasBudgetKm = Number.isFinite(Number(uiOptions.budgetKm));
  const options = {
    start: optimizerPoint(uiOptions.start),
    endNode: normalizeEndNode(uiOptions.endNode ?? endNodeOverride),
    endSnapMaxDistanceM: uiOptions.endSnapMaxDistanceM,
    themes: uiOptions.themes ?? [],
    personas: uiOptions.personas ?? [],
    forbiddenPassIds: uiOptions.forbiddenPassIds ?? [],
    seasonalCutoff: uiOptions.openOnly ? uiOptions.tripDate ?? null : null,
    kAlternatives: uiOptions.kAlternatives ?? DEFAULT_K_ALTERNATIVES,
    timeBudgetMs: uiOptions.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    seed: uiOptions.seed,
  };
  if (hasBudgetSeconds || hasBudgetKm) {
    if (hasBudgetSeconds) options.budgetSeconds = Number(uiOptions.budgetSeconds);
    if (hasBudgetKm) options.budgetKm = Number(uiOptions.budgetKm);
  } else if (targetMode === "time") {
    options.budgetSeconds = targetValue * 3600;
  } else {
    options.budgetKm = targetValue;
  }
  return options;
}

/**
 * Translate an optimizer result into the legacy leisure UI contract.
 */
export async function translatePlannerResult(planned, ctx = {}) {
  const {
    graph,
    uiOptions = {},
    advanced = false,
    phase4Outputs = () => emptyPhase4Outputs(),
    defaultOsrmRoute = null,
    wasmState = null,
  } = ctx;
  const totalOpen = projectedOpenPassCount(graph, uiOptions);
  if (planned?.status === "infeasible" || !planned?.primary) {
    return infeasibleResult(planned?.diagnostics?.reason || "infeasible", uiOptions, advanced, planned, totalOpen);
  }

  const tours = [planned.primary, ...(planned.alternatives || [])].filter(Boolean);
  const alternatives = [];
  const phase4Cache = new Map();
  for (let i = 0; i < tours.length; i += 1) {
    alternatives.push(await translateTour(tours[i], i, {
      graph,
      uiOptions,
      advanced,
      status: planned.status,
      totalOpen,
      reason: planned.diagnostics?.reason ?? "",
      phase4Cache,
      includePhase4: i === 0,
      phase4Outputs,
      defaultOsrmRoute,
      wasmState,
    }));
  }
  const summaries = alternatives.map((alt, index) => ({
    index,
    label: alt.label,
    endNode: alt.result.endNode,
    km: alt.result.km,
    driveH: alt.result.driveH,
    totalH: alt.result.totalH,
  }));
  alternatives.forEach((alt, index) => {
    alt.result.routeAlternatives = summaries;
    alt.result.routeAlternativeIndex = index;
  });

  return {
    ...alternatives[0].result,
    routeAlternatives: summaries,
    _routeAlternatives: alternatives,
    _latlngs: alternatives[0].draw.latlngs,
    _drawMeta: alternatives[0].draw.meta,
    diagnostics: planned.diagnostics,
  };
}

async function translateTour(tour, index, ctx) {
  const {
    graph,
    uiOptions,
    advanced,
    status,
    totalOpen,
    reason = "",
    phase4Cache = new Map(),
    includePhase4 = true,
    phase4Outputs,
    defaultOsrmRoute = null,
    wasmState = null,
  } = ctx;
  const start = normalizeStart(uiOptions.start, graph, tour);
  const endNode = resultEndNode(tour, start);
  const optimizerStops = displayStops(tour);
  const plannerStops = optimizerStops.map((stop) => mapLeisureStop(stop, graph)).filter(Boolean);
  const tourStops = openRouteTourStops(plannerStops, start, endNode, tour, graph);
  const modes = deriveModes(tour.path || [], tourStops, graph);
  const plannerModes = deriveModes(tour.path || [], plannerStops, graph);
  const route = await routeForTour(tour, graph, start, uiOptions, defaultOsrmRoute);
  const latlngs = route.geom.map(([lon, lat]) => [lat, lon]);
  const km = finiteOr(route.distanceKm, tour.totalDistanceKm);
  const driveH = finiteOr(route.durationH, tour.totalDurationH);
  const dwellH = roundHours(plannerStops.reduce((sum, stop) => sum + (Number(stop.visitDwellSec) || 0), 0) / 3600);
  const extras = computeExtrasApprox(plannerStops, driveH, uiOptions.stopsConfig, uiOptions);
  const totalH = roundHours(driveH + dwellH + extras.extrasH);
  const computePhase4 = () => {
    if (!phase4Cache.has(index)) phase4Cache.set(index, phase4Outputs(graph, tour, plannerStops, uiOptions, wasmState));
    return phase4Cache.get(index);
  };
  const phase4 = includePhase4 ? computePhase4() : emptyPhase4Outputs();
  const result = {
    status,
    reason,
    start,
    endNode,
    tourStops,
    modes,
    implicitPasses: implicitPassesFromPath(tour.path || [], plannerStops, graph),
    scenicStops: scenicStopsApprox(plannerStops, plannerModes, extras.parts),
    km,
    driveH,
    dwellH,
    extrasH: extras.extrasH,
    extrasParts: extras.parts,
    totalH,
    inRange: advanced ? true : isInRange(km, totalH, tour, uiOptions),
    advanced,
    routeWarning: route._routeWarning || (status === "degraded" ? "Leisure optimizer returned a degraded tour." : ""),
    statusWarning: "",
    tripDate: uiOptions.tripDate ?? null,
    matched: plannerStops.length,
    poolSize: plannerStops.length,
    totalOpen,
    targetMode: uiOptions.targetMode || "distance",
    targetValue: uiOptions.targetValue,
    targetTol: uiOptions.targetTol ?? uiOptions.targetTolerance ?? 0.2,
    openOnly: !!uiOptions.openOnly,
    poiPrefs: uiOptions.poiPrefs ?? null,
    corridor: phase4.corridor,
    lunchZones: phase4.lunchZones,
    breaks: phase4.breaks,
    intent: phase4.intent,
  };
  const alternative = {
    label: index === 0 ? "Leisure best" : `Leisure alternative ${index + 1}`,
    result,
    draw: {
      start,
      tourStops,
      latlngs,
      meta: { driveH, dwellH, extras, stopsConfig: uiOptions.stopsConfig, start, endNode, leisureOverlays: phase4.overlays },
    },
  };
  alternative.ensurePhase4 = () => {
    applyPhase4(alternative.result, alternative.draw.meta, computePhase4());
    return alternative;
  };
  return alternative;
}

/**
 * Apply deferred Phase 4 enrichment to a translated route alternative.
 */
function applyPhase4(result, drawMeta, phase4) {
  result.corridor = phase4.corridor;
  result.lunchZones = phase4.lunchZones;
  result.breaks = phase4.breaks;
  result.intent = phase4.intent;
  drawMeta.leisureOverlays = phase4.overlays;
}

/**
 * Resolve detailed or approximate route geometry for a translated tour.
 */
export async function routeForTour(tour, graph, start, uiOptions, defaultOsrmRoute = null) {
  const points = routePoints(tour, graph, start);
  const approximateRoute = () => {
    const geom = points.map((point) => [point.lon, point.lat]);
    const distanceKm = haversineRouteKm(points);
    return {
      _routeWarning: APPROX_ROUTE_WARNING,
      geom,
      distanceKm,
      durationH: distanceKm / AVG_SPEED_KMH,
    };
  };

  const osrmRoute = uiOptions.osrmRoute || defaultOsrmRoute;
  if (typeof osrmRoute !== "function") return approximateRoute();
  const coords = points.map((point) => `${point.lon},${point.lat}`).join(";");
  let route;
  try {
    route = (await osrmRoute(coords)) || {};
  } catch {
    return approximateRoute();
  }
  const geom = Array.isArray(route.geom) && route.geom.length >= 2
    ? route.geom
    : points.map((point) => [point.lon, point.lat]);
  const distanceKm = Number.isFinite(Number(route.distanceKm))
    ? Number(route.distanceKm)
    : finiteOr(tour.totalDistanceKm, haversineRouteKm(points));
  const durationH = Number.isFinite(Number(route.durationH))
    ? Number(route.durationH)
    : finiteOr(tour.totalDurationH, distanceKm / FALLBACK_SPEED_KMH);
  return { ...route, geom, distanceKm, durationH };
}

/**
 * Count passes visible to the UI after seasonal/forbidden filtering.
 */
export function projectedOpenPassCount(graph, uiOptions = {}) {
  const passes = graph?.nodesByKind?.get("pass") ?? [];
  const forbiddenPassIds = resolvePassIdSet(graph, uiOptions.forbiddenPassIds);
  let count = 0;
  for (const pass of passes) {
    if (!pass?.id || forbiddenPassIds.has(pass.id)) continue;
    if (uiOptions.openOnly && isSeasonallyClosedPass(pass, graph, uiOptions.tripDate)) continue;
    count += 1;
  }
  return count;
}

/**
 * Return whether a pass is seasonally closed for the supplied trip date.
 */
function isSeasonallyClosedPass(pass, graph, tripDate) {
  const date = parseTripDate(tripDate);
  if (!date) return false;
  const month = date.getUTCMonth() + 1;
  if (![11, 12, 1, 2, 3, 4].includes(month)) return false;
  const sides = graph.passSidesFor?.(pass.id);
  const elev = Number(pass.elev ?? sides?.summit?.elev ?? sides?.S?.elev);
  return Number.isFinite(elev) && elev > 1700;
}

/**
 * Parse a UI trip date into a Date, returning null for invalid input.
 */
function parseTripDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Build de-duplicated route points from a tour path.
 */
export function routePoints(tour, graph, start) {
  const path = compressedPath(tour.path || pathFromEdges(tour.edges), graph);
  const points = [pointOf(start)];
  for (const nodeId of path) {
    const node = graph.nodes.get(nodeId);
    if (node) pushPoint(points, pointOf(node));
  }
  if (isClosedTour(tour)) {
    pushPoint(points, pointOf(start));
  } else {
    const end = graph.nodes.get(tour.endNode);
    if (end) pushPoint(points, pointOf(end));
  }
  return points;
}

/**
 * Reduce long paths to the OSRM waypoint budget while preserving important nodes.
 */
function compressedPath(path, graph) {
  if (path.length <= MAX_OSRM_WAYPOINTS) return path;
  const important = path.filter((nodeId, index) => {
    if (index === 0 || index === path.length - 1) return true;
    const node = graph.nodes.get(nodeId);
    return node?.kind === "pass-base" || node?.kind === "pass-summit" || node?.kind === "poi";
  });
  return important.length <= MAX_OSRM_WAYPOINTS ? important : important.filter((_, i) => i === 0 || i === important.length - 1 || i % Math.ceil(important.length / MAX_OSRM_WAYPOINTS) === 0);
}

/**
 * Derive a node path from optimizer edge ids.
 */
function pathFromEdges(edges = []) {
  const path = [];
  for (const edgeId of edges) {
    const [from, to] = String(edgeId).split("->");
    if (!from || !to) continue;
    if (path.length === 0) path.push(from);
    if (path[path.length - 1] !== from) path.push(from);
    path.push(to);
  }
  return path;
}

/**
 * Filter optimizer bookkeeping stops out of the UI stop list.
 */
function displayStops(tour) {
  return (tour.stops || []).filter((stop) => stop?.kind !== "start" && stop?.kind !== "end" && stop?.kind !== "return" && !stop?.returnToStart);
}

/**
 * Add start/end sentinels for open A-to-B tours.
 */
function openRouteTourStops(plannerStops, start, endNode, tour, graph) {
  if (isClosedTour(tour)) return plannerStops;
  const stops = [];
  const startStop = endpointStop(start, "start");
  if (startStop && !sameStop(plannerStops[0], startStop)) stops.push(startStop);
  stops.push(...plannerStops);
  const endStop = endpointStopForEndNode(endNode, graph);
  if (endStop && !sameStop(stops[stops.length - 1], endStop)) stops.push(endStop);
  return stops;
}

/**
 * Build an endpoint stop from an end node id or point.
 */
function endpointStopForEndNode(endNode, graph) {
  if (!endNode) return null;
  if (typeof endNode === "string") {
    return endpointStop(graph.nodes.get(endNode) || { id: endNode, name: endNode }, "end");
  }
  return endpointStop(endNode, "end");
}

/**
 * Build a UI endpoint sentinel stop.
 */
function endpointStop(point, kind) {
  if (!point) return null;
  return {
    id: point.id,
    name: point.displayName || point.name || point.id || (kind === "start" ? "Start" : "End"),
    displayName: point.displayName || point.name || point.id || (kind === "start" ? "Start" : "End"),
    kind,
    isEndpoint: true,
    lat: Number(point.lat),
    lon: Number(point.lon ?? point.lng),
  };
}

/**
 * Compare two UI stops by id or nearly equal coordinates.
 */
function sameStop(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && String(a.id) === String(b.id)) return true;
  return Math.abs(Number(a.lat) - Number(b.lat)) < 1e-6 && Math.abs(Number(a.lon) - Number(b.lon)) < 1e-6;
}

/**
 * Map an optimizer stop into a UI pass/POI/point stop.
 */
function mapLeisureStop(stop, graph) {
  if (stop.kind === "poi") return mapPoiStop(stop, graph);
  if (stop.kind === "pass" || stop.passId) return mapPassStop(stop, graph);
  return uiPoint(stop);
}

/**
 * Map a pass optimizer stop into a UI pass stop.
 */
function mapPassStop(stop, graph) {
  const passId = stop.passId || stop.id;
  const sides = graph.passSidesFor(passId);
  const pass = sides?.pass || graph.nodes.get(passId) || stop;
  const summit = sides?.summit || sides?.S || graph.nodes.get(`${passId}:S`) || pass;
  const baseA = sides?.baseA || sides?.A || graph.nodes.get(`${passId}:A`);
  const baseB = sides?.baseB || sides?.B || graph.nodes.get(`${passId}:B`);
  return {
    id: passId,
    name: pass.name || stop.name || passId,
    kind: "pass",
    lat: Number(pass.lat ?? summit.lat ?? stop.lat),
    lon: Number(pass.lon ?? summit.lon ?? stop.lon),
    elev: pass.elev ?? summit.elev ?? null,
    quality: qualityOf(pass),
    qScenic: qualityOf(pass),
    qSummit: qualityOf(pass),
    qApproach: qualityOf(pass),
    scenicScore: qualityOf(pass),
    themes: pass.themes || stop.themes || [],
    viewpoints: Array.isArray(pass.viewpoints) ? pass.viewpoints : [],
    baseA: baseA ? uiPoint(baseA) : null,
    baseB: baseB ? uiPoint(baseB) : null,
    summitParking: pass.summitParking ? uiPoint(pass.summitParking) : (summit ? uiPoint(summit) : null),
  };
}

/**
 * Map a POI optimizer stop into a UI POI stop.
 */
function mapPoiStop(stop, graph) {
  const node = graph.nodes.get(stop.nodeId || stop.id) || matchPoiByName(stop, graph) || stop;
  const dwell = Number(node.visitDwellSec ?? stop.visitDwellSec) || 0;
  const categories = node.categories || stop.categories || [];
  return {
    id: node.id || stop.id,
    name: node.name || stop.name || node.id || stop.id,
    kind: "poi",
    lat: Number(node.lat ?? stop.lat),
    lon: Number(node.lon ?? stop.lon),
    isPoi: true,
    visitDwellSec: dwell,
    dwellMin: Math.round(dwell / 60),
    dwellH: roundHours(dwell / 3600),
    poiCategory: node.poiCategory || node.category || categories[0] || "sight",
    poiThemes: node.poiThemes || node.themes || stop.themes || [],
    quality: qualityOf(node),
    scenicScore: qualityOf(node),
  };
}

/**
 * Derive UI traversal modes for tour stops from a route path.
 */
function deriveModes(path, tourStops, graph) {
  return tourStops.map((stop, passIdx) => {
    if (stop.isPoi) return { passIdx, enterSide: 0, exitSide: 0, mode: "poi" };
    if (stop.isEndpoint || stop.kind === "start" || stop.kind === "end" || stop.kind === "junction") {
      return { passIdx, enterSide: 0, exitSide: 0, mode: "endpoint" };
    }
    const sideSeq = path
      .filter((nodeId) => (graph.passIdByNodeId.get(nodeId) || nodeId) === stop.id)
      .map((nodeId) => String(nodeId).match(/:([AB])$/)?.[1])
      .filter(Boolean);
    const enter = sideSeq[0] || "A";
    const exit = sideSeq[sideSeq.length - 1] || enter;
    return {
      passIdx,
      enterSide: enter === "B" ? 1 : 0,
      exitSide: exit === "B" ? 1 : 0,
      mode: enter !== exit ? "traverse" : "out-and-back",
    };
  });
}

/**
 * Find path-traversed passes that are not explicit optimizer stops.
 */
function implicitPassesFromPath(path, tourStops, graph) {
  const explicit = new Set(tourStops.filter((stop) => !stop.isPoi).map((stop) => stop.id));
  const out = [];
  const seen = new Set();
  for (const nodeId of path) {
    const passId = graph.passIdByNodeId.get(nodeId);
    if (!passId || explicit.has(passId) || seen.has(passId)) continue;
    seen.add(passId);
    const stop = mapPassStop({ id: passId, passId, kind: "pass" }, graph);
    if (stop) out.push(stop);
  }
  return out;
}

/**
 * Approximate UI extra time for pass stops, lunch, and rest breaks.
 */
function computeExtrasApprox(tourStops, driveH, cfg = {}, uiOptions = {}) {
  const passStops = tourStops.filter((stop) => stop.kind === "pass");
  const passStopMin = Math.max(0, Number(cfg.passStopMin) || 0);
  const passStopMins = passStops.map(() => passStopMin);
  const passStopH = passStopMins.reduce((sum, min) => sum + min, 0) / 60;
  let lunchH = 0;
  let lunchAuto = false;
  if ((cfg.lunchBreak ?? "auto") === "auto") {
    const anchor = uiOptions.targetMode === "time" ? Number(uiOptions.targetValue) || driveH : driveH;
    if (anchor >= 4) { lunchH = 0.75; lunchAuto = true; }
  } else {
    lunchH = Math.max(0, Number(cfg.lunchBreak) || 0) / 60;
  }
  const restInterval = Number(cfg.restInterval) || 0;
  const restDuration = Math.max(0, Number(cfg.restDuration) || 0);
  const restCount = cfg.restBreakOn && restInterval > 0 && driveH > restInterval
    ? Math.max(0, Math.ceil(driveH / restInterval) - 1)
    : 0;
  const restH = (restCount * restDuration) / 60;
  return {
    extrasH: roundHours(passStopH + lunchH + restH),
    parts: {
      passStopH,
      lunchH,
      restH,
      lunchAuto,
      restCount,
      passN: passStops.length,
      passStopMins,
      passStopUniform: new Set(passStopMins).size <= 1,
    },
  };
}

/**
 * Build approximate scenic/rest stops from pass stops and extra-time parts.
 */
function scenicStopsApprox(tourStops, modes, extrasParts) {
  let passIndex = 0;
  return tourStops.map((stop, order) => {
    if (stop.isPoi) return null;
    if (stop.kind !== "pass") return null;
    const stopMin = extrasParts.passStopMins?.[passIndex++] ?? 0;
    if (stopMin <= 0 && !extrasParts.restH) return null;
    const point = stop.summitParking || { lat: stop.lat, lon: stop.lon };
    return {
      id: `${stop.id}:leisure-scenic:${order}`,
      passId: stop.id,
      passName: stop.name,
      order,
      name: point.name || `${stop.name} viewpoint`,
      kind: point.kind || "viewpoint",
      kindLabel: "viewpoint",
      point,
      side: modes?.[order]?.enterSide === 1 ? "B" : "A",
      quality: stop.quality || 0,
      source: "leisure",
      stopMin,
      restMin: 0,
      restNumbers: [],
    };
  }).filter(Boolean);
}

/**
 * Check whether a translated result fits the requested UI target tolerance.
 */
function isInRange(km, totalH, tour, uiOptions) {
  const mode = uiOptions.targetMode || (tour.budgetFit?.mode === "seconds" ? "time" : "distance");
  const target = positiveNumber(uiOptions.targetValue, NaN);
  const tol = Math.max(0.05, Number(uiOptions.targetTol ?? uiOptions.targetTolerance ?? 0.2) || 0.2);
  if (!Number.isFinite(target)) return !!tour.budgetFit?.within;
  return mode === "time"
    ? Math.abs(totalH - target) <= target * tol
    : Math.abs(km - target) <= target * tol;
}

/**
 * Resolve a selected UI stop to an optimizer node/pass id.
 */
export function resolveSelectedStopId(stop, graph) {
  const id = typeof stop === "string" ? stop : stop?.id;
  if (id && (graph.nodes.has(id) || graph.passTriplets?.has(id) || graph.passIdByNodeId.has(id))) return id;
  if (stop?.isPoi) return matchPoiByName(stop, graph)?.id || null;
  return id || null;
}

/**
 * Find the nearest graph POI with the same normalized name as a UI stop.
 */
function matchPoiByName(stop, graph) {
  const name = normalizeName(stop?.name);
  if (!name) return null;
  let best = null;
  for (const poi of graph.nodesByKind.get("poi") || []) {
    if (normalizeName(poi.name) !== name) continue;
    const distance = haversineRouteKm([pointOf(stop), pointOf(poi)]);
    if (!best || distance < best.distance) best = { node: poi, distance };
  }
  return best?.node || null;
}

/**
 * Build the legacy UI result shape for infeasible planning.
 */
export function infeasibleResult(reason, uiOptions, advanced, planned = null, totalOpen = 0) {
  const start = normalizeStart(uiOptions.start);
  return {
    status: "infeasible",
    reason,
    error: reason,
    start,
    endNode: infeasibleEndNode(uiOptions.endNode),
    tourStops: [],
    modes: [],
    implicitPasses: [],
    scenicStops: [],
    km: 0,
    driveH: 0,
    dwellH: 0,
    extrasH: 0,
    extrasParts: {},
    totalH: 0,
    inRange: false,
    advanced,
    routeWarning: "",
    statusWarning: "",
    tripDate: uiOptions.tripDate ?? null,
    routeAlternatives: [],
    totalOpen,
    diagnostics: planned?.diagnostics ?? null,
  };
}

/**
 * Normalize an infeasible-result end-node value for the UI.
 */
function infeasibleEndNode(endNode) {
  if (typeof endNode === "string") return endNode;
  if (endNode && Number.isFinite(Number(endNode.lat)) && Number.isFinite(Number(endNode.lon ?? endNode.lng))) return normalizeEndNode(endNode);
  return null;
}

/**
 * Return an empty Phase 4 corridor payload.
 */
export function emptyCorridor() {
  return { autoInclude: [], suggestions: [], drawer: [] };
}

/**
 * Return empty Phase 4 enrichment payloads.
 */
export function emptyPhase4Outputs() {
  return {
    corridor: emptyCorridor(),
    lunchZones: [],
    breaks: [],
    intent: { topPersona: "", ambiguous: false, primary: [], serendipity: [], topPersonas: [] },
    overlays: { lunchZones: [], breaks: [], corridorSuggestions: [], corridorAutoInclude: [] },
  };
}

/**
 * Run a Phase 4 callback with fallback; logs a warning when the callback throws.
 */
export function safePhase(label, fn, fallback) {
  try { return fn() ?? fallback; }
  catch (error) {
    try { globalThis.console?.warn?.(`leisure ${label} phase failed`, error); } catch {}
    return fallback;
  }
}

/**
 * Resolve the Phase 4 start time from UI options.
 */
export function phaseStartTime(uiOptions = {}) {
  if (uiOptions.startTime instanceof Date && !Number.isNaN(uiOptions.startTime.getTime())) return new Date(uiOptions.startTime);
  const parsed = uiOptions.startTime ? new Date(uiOptions.startTime) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  const tripDate = parseTripDate(uiOptions.tripDate) || new Date();
  tripDate.setHours(8, 0, 0, 0);
  return tripDate;
}

/**
 * Normalize nullable, scalar, array, or Set values into an array.
 */
export function arrayFrom(value) {
  if (value == null) return [];
  if (value instanceof Set) return [...value];
  return Array.isArray(value) ? value.filter((item) => item != null) : [value];
}

/**
 * Normalize UI lunch-break options into a lunch policy.
 */
export function lunchPolicyFor(value) {
  if (value === "0" || value === 0 || value === "none" || value === "skip") return "skip";
  return value ?? "auto";
}

/**
 * Normalize corridor POI item ids and names for the UI.
 */
export function normalizeCorridorItems(items) {
  return arrayFrom(items).map((item) => ({
    ...item,
    id: item.id ?? item.poiId,
    name: item.name ?? item.poiName ?? item.poiId,
  }));
}

/**
 * Resolve the lunch persona from UI persona chips.
 */
export function lunchPersonaFor(personas = []) {
  const lower = personas.map((item) => String(item).toLowerCase());
  if (lower.includes("family")) return "family";
  if (lower.some((item) => ["food", "foodie", "gourmet", "wine"].includes(item))) return "foodie";
  return "normal";
}

/**
 * Resolve the break persona from UI persona chips.
 */
export function breakPersonaFor(personas = []) {
  const lower = personas.map((item) => String(item).toLowerCase());
  if (lower.includes("family")) return "family";
  if (lower.some((item) => ["photo", "photographer"].includes(item))) return "photographer";
  if (lower.some((item) => ["food", "foodie", "gourmet", "wine"].includes(item))) return "gourmet";
  return lower[0] || "default";
}

/**
 * Return the top scored intent personas from an intent distribution.
 */
export function topIntentPersonas(intent = {}) {
  return Object.entries(intent)
    .filter(([key, value]) => key !== "entropy" && typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([persona]) => persona);
}

/**
 * Copy coordinates from a break candidate source point when available.
 */
export function enrichBreakPoint(item, tour, graph) {
  const out = { ...item };
  const point = item?.poiCandidate || graph?.nodes?.get?.(tour?.path?.[item?.atTourVertexIdx]);
  if (Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon))) {
    out.lat = Number(point.lat);
    out.lon = Number(point.lon);
  }
  return out;
}

/**
 * Normalize the UI start point shape expected by the optimizer.
 */
function optimizerPoint(point) {
  if (typeof point === "string") return point;
  return point;
}

/**
 * Normalize a UI end-node id or coordinate endpoint.
 */
function normalizeEndNode(endNode) {
  if (typeof endNode === "string") {
    const trimmed = endNode.trim();
    return trimmed ? trimmed : null;
  }
  if (endNode && Number.isFinite(Number(endNode.lat)) && Number.isFinite(Number(endNode.lon ?? endNode.lng))) {
    return {
      lat: Number(endNode.lat),
      lon: Number(endNode.lon ?? endNode.lng),
      name: endNode.name,
    };
  }
  return null;
}

/**
 * Normalize a UI start value using graph/tour fallback coordinates.
 */
function normalizeStart(start, graph = null, tour = null) {
  if (typeof start === "string") {
    const node = graph?.nodes?.get(start) || graph?.nodes?.get(tour?.stops?.[0]?.nodeId);
    return {
      id: node?.id ?? start,
      name: node?.name || start,
      displayName: node?.name || start,
      lat: Number(node?.lat),
      lon: Number(node?.lon),
    };
  }
  const point = pointOf(start);
  const tourStartNodeId = tour?.stops?.[0]?.nodeId;
  const tourStartNode = graph?.nodes?.get(tourStartNodeId);
  const id = start?.id ?? tourStartNodeId;
  return {
    ...(start || {}),
    ...(id ? { id } : {}),
    name: start?.displayName || start?.name || "Start",
    displayName: start?.displayName || start?.name || "Start",
    lat: Number.isFinite(point.lat) ? point.lat : Number(tourStartNode?.lat),
    lon: Number.isFinite(point.lon) ? point.lon : Number(tourStartNode?.lon),
  };
}

/**
 * Resolve the UI end-node value for a translated tour.
 */
function resultEndNode(tour, start) {
  return isClosedTour(tour) ? (start.id ?? tour?.endNode) : tour?.endNode;
}

/**
 * Return whether a tour ends at its start.
 */
function isClosedTour(tour) {
  const firstNodeId = tour?.stops?.[0]?.nodeId;
  return !tour?.endNode || tour.endNode === firstNodeId || (tour.stops || []).some((stop) => stop?.returnToStart);
}

/**
 * Copy a graph point into the UI point shape.
 */
function uiPoint(point) {
  return {
    id: point.id,
    name: point.name,
    kind: point.kind,
    lat: Number(point.lat),
    lon: Number(point.lon),
  };
}

/**
 * Extract numeric latitude/longitude from a UI or graph point.
 */
export function pointOf(point) {
  return { lat: Number(point?.lat), lon: Number(point?.lon ?? point?.lng) };
}

/**
 * Append a finite point when it is not a coordinate duplicate of the previous point.
 */
function pushPoint(points, point) {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
  const prev = points[points.length - 1];
  if (prev && Math.abs(prev.lat - point.lat) < 1e-6 && Math.abs(prev.lon - point.lon) < 1e-6) return;
  points.push(point);
}

/**
 * Normalize graph quality/scenic score values onto 0..1.
 */
function qualityOf(node) {
  const raw = node?.quality ?? node?.scenicScore ?? node?.score ?? 0;
  const value = Number(raw) || 0;
  return value > 1 ? Math.min(1, value / 10) : Math.max(0, value);
}

/**
 * Return a positive number or fallback.
 */
export function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Return a finite number or numeric fallback.
 */
function finiteOr(primary, fallback = 0) {
  const value = Number(primary);
  return Number.isFinite(value) ? value : (Number(fallback) || 0);
}

/**
 * Round an hour value to two decimals.
 */
function roundHours(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * Normalize a display name for matching.
 */
export function normalizeName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Sum Haversine distances across route points in kilometres.
 */
function haversineRouteKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1], points[i]);
  return total;
}

/**
 * Compute Haversine distance between two points in kilometres.
 */
export function haversineKm(a, b) {
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return 0;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
