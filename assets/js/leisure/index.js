import { loadLeisureGraph } from "./graph.js";
import { decomposeEars } from "./ears.js";
import { planLeisureTour, planLeisureTourAdvanced } from "./optimizer.js";
import { findCorridorPois } from "./corridor.js";
import { planLunchZone } from "./lunch.js";
import { detectBreaks } from "./breaks.js";
import { inferIntent, surfaceIntentPois } from "./intent.js";
import { resolvePassIdSet } from "./lib/optimizer-planning.js";

// Must match the legacy localStorage bridge literals in assets/js/app.js.
export const LEISURE_PLANNER_FLAG_KEY = "alpine.planner.leisure.v1";
export const LEISURE_PLANNER_END_NODE_KEY = "alpine.planner.endNode";
const GRAPH_URL = new URL("../../data/leisure-graph.v1.json", import.meta.url).href;
const DEFAULT_K_ALTERNATIVES = 3;
const DEFAULT_TIME_BUDGET_MS = 1_000;
const MAX_OSRM_WAYPOINTS = 80;
const FALLBACK_SPEED_KMH = 45;
const AVG_SPEED_KMH = 55;
const APPROX_ROUTE_WARNING = "Could not fetch detailed route geometry; map line is approximate.";

let graphStatePromise = null;

/**
 * UI-shaped result returned by the leisure façade.
 *
 * @typedef {object} UiPlanResult
 * @property {object} start UI start point `{ id?, name, lat, lon }`.
 * @property {string|undefined} endNode Resolved endpoint node id. Closed-loop tours use `start.id`.
 * @property {object[]} tourStops UI-compatible pass/POI stops. Open A→B
 * tours include start/end sentinels around intermediate stops; closed loops
 * keep the start implicit.
 * @property {{passIdx:number,enterSide:number,exitSide:number,mode:string}[]} modes Stop traversal modes.
 * @property {object[]} implicitPasses Passes inferred from path traversal but not selected by the optimizer.
 * @property {object[]} scenicStops Suggested scenic/break stops for rendering.
 * @property {number} km Route distance in kilometres.
 * @property {number} driveH Driving duration in hours.
 * @property {number} dwellH POI dwell duration in hours.
 * @property {number} extrasH Break/scenic-stop duration in hours.
 * @property {object} extrasParts Breakdown consumed by the legacy UI.
 * @property {number} totalH Total drive + dwell + extras duration in hours.
 * @property {boolean} inRange Whether the final result fits the requested target tolerance.
 * @property {boolean} advanced True for selected-stop planning.
 * @property {string} routeWarning Non-fatal route warning for the UI.
 * @property {string} statusWarning Non-fatal status warning for the UI.
 * @property {Date|string|null} tripDate Trip date used for seasonal masking.
 * @property {object[]} routeAlternatives Summaries for route alternative buttons.
 * @property {number} totalOpen Projected open/restricted pass shortlist count.
 * @property {{autoInclude:object[],suggestions:object[],drawer:object[]}} [corridor] Optional along-route POI detours.
 * @property {object[]} [lunchZones] Optional lunch zone polygons, capped at two.
 * @property {object[]} [breaks] Optional driving break suggestions.
 * @property {{topPersona:string,ambiguous:boolean,primary:object[],serendipity:object[],topPersonas?:string[]}} [intent] Optional intent-persona POI surface.
 */
/**
 * Return whether the leisure planner feature flag is enabled.
 *
 * @returns {boolean} True when localStorage contains the leisure planner flag.
 */
export function isLeisurePlannerEnabled() {
  try { return globalThis.localStorage?.getItem(LEISURE_PLANNER_FLAG_KEY) === "1"; }
  catch { return false; }
}

/**
 * Build an automatic leisure tour and translate it into the legacy UI contract.
 *
 * @param {object} [uiOptions={}] UI options from app.js: start, optional `endNode`
 * node id or `{lat, lon, name?}` endpoint, target mode/value/tolerance, seasonal
 * filters, POI preferences, stops config, and an `osrmRoute(coords)` helper.
 * @returns {Promise<UiPlanResult>} UI-shaped result for rendering and route alternatives.
 */
export async function leisurePlanAuto(uiOptions = {}) {
  const { graph, ears } = await graphState();
  const options = optimizerOptions(uiOptions);
  const planned = planLeisureTour(graph, ears, options);
  return translatePlannerResult(planned, graph, uiOptions, false);
}

/**
 * Build a leisure tour through selected UI stops and translate it for rendering.
 *
 * @param {object} [uiOptions={}] UI options from app.js: start, optional `endNode`
 * node id or `{lat, lon, name?}` endpoint, target mode/value/tolerance, seasonal
 * filters, POI preferences, stops config, and an `osrmRoute(coords)` helper.
 * @param {object[]} [selectedStops=[]] UI-selected pass/POI stops; id/passId/nodeId resolve must-visits.
 * @returns {Promise<UiPlanResult>} UI-shaped selected-tour result for rendering.
 */
export async function leisurePlanSelected(uiOptions = {}, selectedStops = []) {
  const { graph, ears } = await graphState();
  const mustVisitIds = selectedStops.map((stop) => resolveSelectedStopId(stop, graph)).filter(Boolean);
  if (mustVisitIds.length === 0) return infeasibleResult("no-selected-stops", uiOptions, true, null, projectedOpenPassCount(graph, uiOptions));
  const options = optimizerOptions({ ...uiOptions, openOnly: false, forbiddenPassIds: [] });
  const planned = planLeisureTourAdvanced(graph, ears, mustVisitIds, options);
  return translatePlannerResult(planned, graph, uiOptions, true);
}

function graphState() {
  graphStatePromise ??= loadLeisureGraph(GRAPH_URL).then((graph) => ({
    graph,
    ears: decomposeEars(graph),
  }));
  return graphStatePromise;
}

function optimizerOptions(uiOptions) {
  const targetMode = uiOptions.targetMode === "time" ? "time" : "distance";
  const targetValue = positiveNumber(uiOptions.targetValue, targetMode === "time" ? 6 : 200);
  const hasBudgetSeconds = Number.isFinite(Number(uiOptions.budgetSeconds));
  const hasBudgetKm = Number.isFinite(Number(uiOptions.budgetKm));
  const options = {
    start: optimizerPoint(uiOptions.start),
    endNode: normalizeEndNode(uiOptions.endNode ?? leisureEndNodeOverride()),
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

async function translatePlannerResult(planned, graph, uiOptions, advanced) {
  const totalOpen = projectedOpenPassCount(graph, uiOptions);
  if (planned?.status === "infeasible" || !planned?.primary) {
    return infeasibleResult(planned?.diagnostics?.reason || "infeasible", uiOptions, advanced, planned, totalOpen);
  }

  const tours = [planned.primary, ...(planned.alternatives || [])].filter(Boolean);
  const alternatives = [];
  const phase4Cache = new Map();
  for (let i = 0; i < tours.length; i += 1) {
    alternatives.push(await translateTour(tours[i], i, graph, uiOptions, advanced, planned.status, totalOpen, planned.diagnostics?.reason ?? "", phase4Cache, i === 0));
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

async function translateTour(tour, index, graph, uiOptions, advanced, status, totalOpen, reason = "", phase4Cache = new Map(), includePhase4 = true) {
  const start = normalizeStart(uiOptions.start, graph, tour);
  const endNode = resultEndNode(tour, start);
  const optimizerStops = displayStops(tour);
  const plannerStops = optimizerStops.map((stop) => mapLeisureStop(stop, graph)).filter(Boolean);
  const tourStops = openRouteTourStops(plannerStops, start, endNode, tour, graph);
  const modes = deriveModes(tour.path || [], tourStops, graph);
  const plannerModes = deriveModes(tour.path || [], plannerStops, graph);
  const route = await routeForTour(tour, graph, start, uiOptions);
  const latlngs = route.geom.map(([lon, lat]) => [lat, lon]);
  const km = finiteOr(route.distanceKm, tour.totalDistanceKm);
  const driveH = finiteOr(route.durationH, tour.totalDurationH);
  const dwellH = roundHours(plannerStops.reduce((sum, stop) => sum + (Number(stop.visitDwellSec) || 0), 0) / 3600);
  const extras = computeExtrasApprox(plannerStops, driveH, uiOptions.stopsConfig, uiOptions);
  const totalH = roundHours(driveH + dwellH + extras.extrasH);
  const computePhase4 = () => {
    if (!phase4Cache.has(index)) phase4Cache.set(index, phase4Outputs(graph, tour, plannerStops, uiOptions));
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

function applyPhase4(result, drawMeta, phase4) {
  result.corridor = phase4.corridor;
  result.lunchZones = phase4.lunchZones;
  result.breaks = phase4.breaks;
  result.intent = phase4.intent;
  drawMeta.leisureOverlays = phase4.overlays;
}

function phase4Outputs(graph, tour, tourStops, uiOptions = {}) {
  const startTime = phaseStartTime(uiOptions);
  const themes = arrayFrom(uiOptions.themes ?? uiOptions.poiPrefs?.themes);
  const personas = arrayFrom(uiOptions.personas ?? uiOptions.poiPrefs?.preset);
  const weather = uiOptions.weather ?? null;
  const corridorResult = safePhase("corridor", () => findCorridorPois(graph, tour, {
    themes,
    personas,
    maxAutoIncludePerHour: uiOptions.maxAutoIncludePerHour ?? uiOptions.corridor?.maxAutoIncludePerHour ?? 1,
    autoIncludeMaxDetourMin: uiOptions.autoIncludeMaxDetourMin ?? uiOptions.corridor?.autoIncludeMaxDetourMin,
    suggestMaxDetourMin: uiOptions.suggestMaxDetourMin ?? uiOptions.corridor?.suggestMaxDetourMin,
    maxSuggestionsTotal: uiOptions.maxSuggestionsTotal ?? uiOptions.corridor?.maxSuggestionsTotal ?? 12,
  }), emptyCorridor());
  const corridor = {
    autoInclude: normalizeCorridorItems(corridorResult.autoInclude),
    suggestions: normalizeCorridorItems(corridorResult.suggestions),
    drawer: normalizeCorridorItems(corridorResult.drawer),
  };
  const lunchPersona = lunchPersonaFor(personas);
  const lunchResult = safePhase("lunch", () => planLunchZone(graph, tour, {
    startTime,
    persona: lunchPersona,
    lunchPolicy: lunchPolicyFor(uiOptions.stopsConfig?.lunchBreak),
    narrativeMode: true,
    weather,
  }), { zones: [] });
  const breaksResult = safePhase("breaks", () => detectBreaks(graph, tour, {
    startTime,
    persona: breakPersonaFor(personas),
    weather,
    tourPacked: tourStops.length >= 8,
    corridorPois: corridor.suggestions,
    maxBreaksTotal: 4,
  }), { breaks: [] });
  const intentDistribution = safePhase("intent", () => inferIntent({
    pinnedStops: tourStops,
    themeChips: themes,
    budgetTier: uiOptions.budgetTier,
    withChild: uiOptions.withChild ?? personas.includes("family"),
    startTime,
    weather,
  }), inferIntent({}));
  const corridorPois = [...corridor.autoInclude, ...corridor.suggestions];
  const surfaced = safePhase("intent-surface", () => surfaceIntentPois(graph, tour, intentDistribution, { topK: 12, corridorPois }), { primary: [], serendipity: [], diagnostics: {} });
  const topPersonas = topIntentPersonas(intentDistribution);
  const lunchZones = arrayFrom(lunchResult.zones).slice(0, 2);
  const breaks = arrayFrom(breaksResult.breaks).map((item) => enrichBreakPoint(item, tour, graph));
  return {
    corridor,
    lunchZones,
    breaks,
    intent: {
      topPersona: intentDistribution.topPersona || surfaced.diagnostics?.topPersona || "Balanced",
      ambiguous: Boolean(intentDistribution.ambiguous),
      primary: arrayFrom(surfaced.primary),
      serendipity: arrayFrom(surfaced.serendipity),
      topPersonas,
    },
    overlays: {
      lunchZones,
      breaks,
      corridorSuggestions: corridor.suggestions,
      corridorAutoInclude: corridor.autoInclude,
    },
  };
}

async function routeForTour(tour, graph, start, uiOptions) {
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

  const osrmRoute = uiOptions.osrmRoute || globalThis.window?.osrmRoute;
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

function projectedOpenPassCount(graph, uiOptions = {}) {
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

function isSeasonallyClosedPass(pass, graph, tripDate) {
  const date = parseTripDate(tripDate);
  if (!date) return false;
  const month = date.getUTCMonth() + 1;
  if (![11, 12, 1, 2, 3, 4].includes(month)) return false;
  const sides = graph.passSidesFor?.(pass.id);
  const elev = Number(pass.elev ?? sides?.summit?.elev ?? sides?.S?.elev);
  return Number.isFinite(elev) && elev > 1700;
}

function parseTripDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function routePoints(tour, graph, start) {
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

function compressedPath(path, graph) {
  if (path.length <= MAX_OSRM_WAYPOINTS) return path;
  const important = path.filter((nodeId, index) => {
    if (index === 0 || index === path.length - 1) return true;
    const node = graph.nodes.get(nodeId);
    return node?.kind === "pass-base" || node?.kind === "pass-summit" || node?.kind === "poi";
  });
  return important.length <= MAX_OSRM_WAYPOINTS ? important : important.filter((_, i) => i === 0 || i === important.length - 1 || i % Math.ceil(important.length / MAX_OSRM_WAYPOINTS) === 0);
}

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

function displayStops(tour) {
  return (tour.stops || []).filter((stop) => stop?.kind !== "start" && stop?.kind !== "end" && stop?.kind !== "return" && !stop?.returnToStart);
}

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

function endpointStopForEndNode(endNode, graph) {
  if (!endNode) return null;
  if (typeof endNode === "string") {
    return endpointStop(graph.nodes.get(endNode) || { id: endNode, name: endNode }, "end");
  }
  return endpointStop(endNode, "end");
}

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

function sameStop(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && String(a.id) === String(b.id)) return true;
  return Math.abs(Number(a.lat) - Number(b.lat)) < 1e-6 && Math.abs(Number(a.lon) - Number(b.lon)) < 1e-6;
}

function mapLeisureStop(stop, graph) {
  if (stop.kind === "poi") return mapPoiStop(stop, graph);
  if (stop.kind === "pass" || stop.passId) return mapPassStop(stop, graph);
  return uiPoint(stop);
}

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

function isInRange(km, totalH, tour, uiOptions) {
  const mode = uiOptions.targetMode || (tour.budgetFit?.mode === "seconds" ? "time" : "distance");
  const target = positiveNumber(uiOptions.targetValue, NaN);
  const tol = Math.max(0.05, Number(uiOptions.targetTol ?? uiOptions.targetTolerance ?? 0.2) || 0.2);
  if (!Number.isFinite(target)) return !!tour.budgetFit?.within;
  return mode === "time"
    ? Math.abs(totalH - target) <= target * tol
    : Math.abs(km - target) <= target * tol;
}

function resolveSelectedStopId(stop, graph) {
  const id = typeof stop === "string" ? stop : stop?.id;
  if (id && (graph.nodes.has(id) || graph.passTriplets?.has(id) || graph.passIdByNodeId.has(id))) return id;
  if (stop?.isPoi) return matchPoiByName(stop, graph)?.id || null;
  return id || null;
}

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

function infeasibleResult(reason, uiOptions, advanced, planned = null, totalOpen = 0) {
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

function infeasibleEndNode(endNode) {
  if (typeof endNode === "string") return endNode;
  if (endNode && Number.isFinite(Number(endNode.lat)) && Number.isFinite(Number(endNode.lon ?? endNode.lng))) return normalizeEndNode(endNode);
  return null;
}

function emptyCorridor() {
  return { autoInclude: [], suggestions: [], drawer: [] };
}

function emptyPhase4Outputs() {
  return {
    corridor: emptyCorridor(),
    lunchZones: [],
    breaks: [],
    intent: { topPersona: "", ambiguous: false, primary: [], serendipity: [], topPersonas: [] },
    overlays: { lunchZones: [], breaks: [], corridorSuggestions: [], corridorAutoInclude: [] },
  };
}

function safePhase(label, fn, fallback) {
  try { return fn() ?? fallback; }
  catch (error) {
    try { globalThis.console?.warn?.(`leisure ${label} phase failed`, error); } catch {}
    return fallback;
  }
}

function phaseStartTime(uiOptions = {}) {
  if (uiOptions.startTime instanceof Date && !Number.isNaN(uiOptions.startTime.getTime())) return new Date(uiOptions.startTime);
  const parsed = uiOptions.startTime ? new Date(uiOptions.startTime) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  const tripDate = parseTripDate(uiOptions.tripDate) || new Date();
  tripDate.setHours(8, 0, 0, 0);
  return tripDate;
}

function arrayFrom(value) {
  if (value == null) return [];
  if (value instanceof Set) return [...value];
  return Array.isArray(value) ? value.filter((item) => item != null) : [value];
}

function lunchPolicyFor(value) {
  if (value === "0" || value === 0 || value === "none" || value === "skip") return "skip";
  return value ?? "auto";
}

function normalizeCorridorItems(items) {
  return arrayFrom(items).map((item) => ({
    ...item,
    id: item.id ?? item.poiId,
    name: item.name ?? item.poiName ?? item.poiId,
  }));
}

function lunchPersonaFor(personas = []) {
  const lower = personas.map((item) => String(item).toLowerCase());
  if (lower.includes("family")) return "family";
  if (lower.some((item) => ["food", "foodie", "gourmet", "wine"].includes(item))) return "foodie";
  return "normal";
}

function breakPersonaFor(personas = []) {
  const lower = personas.map((item) => String(item).toLowerCase());
  if (lower.includes("family")) return "family";
  if (lower.some((item) => ["photo", "photographer"].includes(item))) return "photographer";
  if (lower.some((item) => ["food", "foodie", "gourmet", "wine"].includes(item))) return "gourmet";
  return lower[0] || "default";
}

function topIntentPersonas(intent = {}) {
  return Object.entries(intent)
    .filter(([key, value]) => key !== "entropy" && typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([persona]) => persona);
}

function enrichBreakPoint(item, tour, graph) {
  const out = { ...item };
  const point = item?.poiCandidate || graph?.nodes?.get?.(tour?.path?.[item?.atTourVertexIdx]);
  if (Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon))) {
    out.lat = Number(point.lat);
    out.lon = Number(point.lon);
  }
  return out;
}

function optimizerPoint(point) {
  if (typeof point === "string") return point;
  return point;
}

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

function leisureEndNodeOverride() {
  try {
    const value = globalThis.localStorage?.getItem(LEISURE_PLANNER_END_NODE_KEY);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

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

function resultEndNode(tour, start) {
  return isClosedTour(tour) ? (start.id ?? tour?.endNode) : tour?.endNode;
}

function isClosedTour(tour) {
  const firstNodeId = tour?.stops?.[0]?.nodeId;
  return !tour?.endNode || tour.endNode === firstNodeId || (tour.stops || []).some((stop) => stop?.returnToStart);
}

function uiPoint(point) {
  return {
    id: point.id,
    name: point.name,
    kind: point.kind,
    lat: Number(point.lat),
    lon: Number(point.lon),
  };
}

function pointOf(point) {
  return { lat: Number(point?.lat), lon: Number(point?.lon ?? point?.lng) };
}

function pushPoint(points, point) {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
  const prev = points[points.length - 1];
  if (prev && Math.abs(prev.lat - point.lat) < 1e-6 && Math.abs(prev.lon - point.lon) < 1e-6) return;
  points.push(point);
}

function qualityOf(node) {
  const raw = node?.quality ?? node?.scenicScore ?? node?.score ?? 0;
  const value = Number(raw) || 0;
  return value > 1 ? Math.min(1, value / 10) : Math.max(0, value);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteOr(primary, fallback = 0) {
  const value = Number(primary);
  return Number.isFinite(value) ? value : (Number(fallback) || 0);
}

function roundHours(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function haversineRouteKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1], points[i]);
  return total;
}

function haversineKm(a, b) {
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return 0;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
