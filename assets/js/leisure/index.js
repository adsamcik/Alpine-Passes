import { loadLeisureGraph } from "./graph.js";
import { decomposeEars } from "./ears.js";
import { planLeisureTour, planLeisureTourAdvanced } from "./optimizer.js";
import { findCorridorPois } from "./corridor.js";
import { planLunchZone } from "./lunch.js";
import { detectBreaks } from "./breaks.js";
import { inferIntent, surfaceIntentPois } from "./intent.js";
import { arrayFrom, breakPersonaFor, emptyCorridor, enrichBreakPoint, infeasibleResult, lunchPersonaFor, lunchPolicyFor, normalizeCorridorItems, optimizerOptions, phaseStartTime, projectedOpenPassCount, resolveSelectedStopId, safePhase, topIntentPersonas, translatePlannerResult } from "./lib/ui-translation.js";

// Must match the legacy localStorage bridge literals in assets/js/app.js.
export const LEISURE_PLANNER_FLAG_KEY = "alpine.planner.leisure.v1";
export const LEISURE_PLANNER_END_NODE_KEY = "alpine.planner.endNode";
const GRAPH_URL = new URL("../../data/leisure-graph.v1.json", import.meta.url).href;

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
  const options = optimizerOptions(uiOptions, leisureEndNodeOverride());
  const planned = planLeisureTour(graph, ears, options);
  return translatePlannerResult(planned, { graph, uiOptions, advanced: false, phase4Outputs, defaultOsrmRoute: globalThis.window?.osrmRoute });
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
  const options = optimizerOptions({ ...uiOptions, openOnly: false, forbiddenPassIds: [] }, leisureEndNodeOverride());
  const planned = planLeisureTourAdvanced(graph, ears, mustVisitIds, options);
  return translatePlannerResult(planned, { graph, uiOptions, advanced: true, phase4Outputs, defaultOsrmRoute: globalThis.window?.osrmRoute });
}

function graphState() {
  graphStatePromise ??= loadLeisureGraph(GRAPH_URL).then((graph) => ({
    graph,
    ears: decomposeEars(graph),
  }));
  return graphStatePromise;
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


function leisureEndNodeOverride() {
  try {
    const value = globalThis.localStorage?.getItem(LEISURE_PLANNER_END_NODE_KEY);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

