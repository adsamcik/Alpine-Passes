import { arrayFrom, breakPersonaFor, emptyCorridor, emptyPhase4Outputs, enrichBreakPoint, infeasibleResult, lunchPersonaFor, lunchPolicyFor, normalizeCorridorItems, optimizerOptions, phaseStartTime, projectedOpenPassCount, resolveSelectedStopId, safePhase, topIntentPersonas, translatePlannerResult } from "./lib/ui-translation.js";
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
  try {
    const state = await graphState();
    const options = optimizerOptions(uiOptions, leisureEndNodeOverride());
    const planned = options.endNode && typeof options.start === "string" && typeof options.endNode === "string"
      ? fromWasm(state.wasm.wasm_leisure_plan_open(state.graphHandle, state.earsHandle, options.start, options.endNode, options))
      : fromWasm(state.wasm.wasm_leisure_plan_auto(state.graphHandle, state.earsHandle, options));
    return translatePlannerResult(planned, { graph: state.graph, uiOptions, advanced: false, phase4Outputs, defaultOsrmRoute: globalThis.window?.osrmRoute, wasmState: state });
  } catch (error) {
    return wasmFailureResult(error, uiOptions, false);
  }
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
  try {
    const state = await graphState();
    const { graph } = state;
    const mustVisitIds = selectedStops.map((stop) => resolveSelectedStopId(stop, graph)).filter(Boolean);
    if (mustVisitIds.length === 0) return infeasibleResult("no-selected-stops", uiOptions, true, null, projectedOpenPassCount(graph, uiOptions));
    const options = optimizerOptions({ ...uiOptions, openOnly: false, forbiddenPassIds: [] }, leisureEndNodeOverride());
    const planned = fromWasm(state.wasm.wasm_leisure_plan_selected(state.graphHandle, state.earsHandle, mustVisitIds, options));
    return translatePlannerResult(planned, { graph, uiOptions, advanced: true, phase4Outputs, defaultOsrmRoute: globalThis.window?.osrmRoute, wasmState: state });
  } catch (error) {
    return wasmFailureResult(error, uiOptions, true);
  }
}

function graphState() {
  graphStatePromise ??= initializeGraphState();
  return graphStatePromise;
}

let wasmReadyPromise = null;

async function loadWasm() {
  if (!wasmReadyPromise) {
    const wasm = await import("../../wasm/leisure-core/leisure_core.js");
    try {
      await wasm.default();
    } catch (error) {
      if (!isNodeWasmFetchError(error)) throw error;
      const { readFile } = await import("node:fs/promises");
      const bytes = await readFile(new URL("../../wasm/leisure-core/leisure_core_bg.wasm", import.meta.url));
      await wasm.default({ module_or_path: bytes });
    }
    wasmReadyPromise = wasm;
  }
  return wasmReadyPromise;
}

async function initializeGraphState() {
  const [wasm, graphText] = await Promise.all([loadWasm(), loadGraphText(GRAPH_URL)]);
  let graphData = null;
  let graphHandle;
  try {
    graphHandle = fromWasm(wasm.wasm_load_graph(graphText));
  } catch (error) {
    // Compatibility with pre-Phase-4a generated WASM bundles that only accept object-shaped graph data.
    if (!/invalid type:\s*string/i.test(errorMessage(error))) throw error;
    graphData = JSON.parse(graphText);
    graphHandle = fromWasm(wasm.wasm_load_graph(graphData));
  }
  if (!Number.isInteger(graphHandle)) throw new Error(`Invalid WASM graph handle: ${graphHandle}`);
  graphData ??= JSON.parse(graphText);
  const ears = fromWasm(wasm.wasm_decompose_ears(graphHandle));
  const earsHandle = Number.isInteger(ears) ? ears : ears?.handle;
  if (!Number.isInteger(earsHandle)) throw new Error("Invalid WASM ears handle");
  return { wasm, graph: new LeisureGraphShim(graphData), graphHandle, earsHandle, ears };
}

async function loadGraphText(url) {
  if (typeof globalThis.fetch === "function") {
    try {
      const response = await globalThis.fetch(url);
      if (response.ok) return response.text();
    } catch (error) {
      if (!isNodeWasmFetchError(error)) throw error;
    }
  }
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  return readFile(fileURLToPath(url), "utf8");
}

class LeisureGraphShim {
  constructor(data) {
    this.data = data ?? {};
    this.rawNodes = Array.isArray(this.data.nodes) ? this.data.nodes : [];
    this.rawEdges = Array.isArray(this.data.edges) ? this.data.edges : [];
    this.nodes = new Map();
    this.nodesByKind = new Map();
    this.passTriplets = new Map();
    this.passIdByNodeId = new Map();
    this.edgeById = new Map();
    this.edgeByKey = new Map();
    for (const node of this.rawNodes) {
      if (!node?.id) continue;
      this.nodes.set(node.id, node);
      appendToMapArray(this.nodesByKind, node.kind, node);
    }
    for (const edge of this.rawEdges) {
      if (!edge?.from || !edge?.to) continue;
      const id = edgeIdOf(edge);
      const key = edgeKey(edge.from, edge.to);
      const stored = { ...edge, id, key };
      this.edgeById.set(id, stored);
      this.edgeByKey.set(key, stored);
    }
    this._buildPassIndexes();
  }

  _buildPassIndexes() {
    for (const pass of this.nodesByKind.get("pass") ?? []) {
      this.passTriplets.set(pass.id, { pass, A: null, S: null, B: null });
      this.passIdByNodeId.set(pass.id, pass.id);
    }
    for (const node of this.rawNodes) {
      if (node?.kind !== "pass-base" && node?.kind !== "pass-summit") continue;
      const passId = node.passId ?? passIdFromSyntheticId(node.id);
      if (!passId) continue;
      if (!this.passTriplets.has(passId)) this.passTriplets.set(passId, { pass: this.nodes.get(passId) ?? null, A: null, S: null, B: null });
      const triplet = this.passTriplets.get(passId);
      if (node.kind === "pass-base" && node.side === "A") triplet.A = node;
      if (node.kind === "pass-base" && node.side === "B") triplet.B = node;
      if (node.kind === "pass-summit") triplet.S = node;
      this.passIdByNodeId.set(node.id, passId);
    }
  }

  passSidesFor(passId) {
    const resolvedPassId = this.passIdByNodeId.get(passId) ?? passIdFromSyntheticId(passId) ?? passId;
    const triplet = this.passTriplets.get(resolvedPassId);
    if (!triplet) return null;
    return { pass: triplet.pass ?? null, A: triplet.A ?? null, S: triplet.S ?? null, B: triplet.B ?? null, baseA: triplet.A ?? null, summit: triplet.S ?? null, baseB: triplet.B ?? null };
  }

  nodeKindOf(nodeId) {
    return this.nodes.get(nodeId)?.kind;
  }

  edgeBetween(fromId, toId) {
    return this.edgeByKey.get(edgeKey(fromId, toId)) ?? null;
  }
}

function edgeIdOf(edge) {
  return edge?.id ?? edgeKey(edge?.from, edge?.to);
}

function edgeKey(fromId, toId) {
  return `${fromId}->${toId}`;
}

function appendToMapArray(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function passIdFromSyntheticId(nodeId) {
  const match = String(nodeId).match(/^(.+):[ABS]$/);
  return match ? match[1] : null;
}

function isNodeWasmFetchError(error) {
  return typeof process !== "undefined" && /fetch|file|URL/i.test(String(error?.message || error));
}

function phase4Outputs(graph, tour, tourStops, uiOptions = {}, wasmState = null) {
  const wasm = wasmState?.wasm;
  const graphHandle = wasmState?.graphHandle;
  if (!wasm || !Number.isInteger(graphHandle)) return emptyPhase4Outputs();
  const startTime = phaseStartTime(uiOptions);
  const startTimeIso = isoString(startTime);
  const themes = arrayFrom(uiOptions.themes ?? uiOptions.poiPrefs?.themes);
  const personas = arrayFrom(uiOptions.personas ?? uiOptions.poiPrefs?.preset);
  const weather = uiOptions.weather ?? null;
  const corridorResult = safePhase("corridor", () => fromWasm(wasm.wasm_suggest_corridor(graphHandle, tour, {
    themes,
    personas,
    maxAutoIncludePerHour: uiOptions.maxAutoIncludePerHour ?? uiOptions.corridor?.maxAutoIncludePerHour ?? 1,
    autoIncludeMaxDetourMin: uiOptions.autoIncludeMaxDetourMin ?? uiOptions.corridor?.autoIncludeMaxDetourMin,
    suggestMaxDetourMin: uiOptions.suggestMaxDetourMin ?? uiOptions.corridor?.suggestMaxDetourMin,
    maxSuggestionsTotal: uiOptions.maxSuggestionsTotal ?? uiOptions.corridor?.maxSuggestionsTotal ?? 12,
  })), emptyCorridor());
  const corridor = {
    autoInclude: normalizeCorridorItems(corridorResult.autoInclude),
    suggestions: normalizeCorridorItems(corridorResult.suggestions),
    drawer: normalizeCorridorItems(corridorResult.drawer),
  };
  const lunchPersona = lunchPersonaFor(personas);
  const lunchResult = safePhase("lunch", () => fromWasm(wasm.wasm_find_lunch_area(graphHandle, tour, {
    startTime: startTimeIso,
    persona: lunchPersona,
    lunchPolicy: lunchPolicyFor(uiOptions.stopsConfig?.lunchBreak),
    narrativeMode: true,
    weather,
  })), { zones: [] });
  const breaksResult = safePhase("breaks", () => fromWasm(wasm.wasm_suggest_breaks(graphHandle, tour, {
    startTime: startTimeIso,
    persona: breakPersonaFor(personas),
    weather,
    tourPacked: tourStops.length >= 8,
    corridorPois: corridor.suggestions,
    maxBreaksTotal: 4,
  })), { breaks: [] });
  const intentDistribution = safePhase("intent", () => fromWasm(wasm.wasm_infer_intent(tourStops, {
    themeChips: themes,
    budgetTier: uiOptions.budgetTier,
    withChild: uiOptions.withChild ?? personas.includes("family"),
    startTime: startTimeIso,
    weather,
  })), emptyIntentDistribution());
  const corridorPois = [...corridor.autoInclude, ...corridor.suggestions];
  const intentCandidates = corridorPois.map(intentCandidateFromCorridorItem);
  const surfaced = safePhase("intent-surface", () => fromWasm(wasm.wasm_surface_intent_pois(tour, intentCandidates, intentDistribution, { topK: 12 })), { primary: [], serendipity: [], diagnostics: {} });
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


function wasmFailureResult(error, uiOptions = {}, advanced = false) {
  try { globalThis.console?.warn?.("leisure WASM planner failed", error); } catch {}
  const result = infeasibleResult("wasm-unavailable", uiOptions, advanced);
  const message = `WebAssembly is required for the leisure planner: ${errorMessage(error)}`;
  result.routeWarning = message;
  result.statusWarning = message;
  result.wasmUnavailable = true;
  return result;
}

function errorMessage(error) {
  return String(error?.message || error || "unknown error");
}

function fromWasm(value) {
  return value;
}

function isoString(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function emptyIntentDistribution() {
  return { topPersona: "Balanced", ambiguous: false, effectiveTagVector: {}, entropy: 0, pastDismissedTags: {} };
}

function intentCandidateFromCorridorItem(item) {
  return {
    ...item,
    id: item.id ?? item.poiId,
    poiId: item.poiId ?? item.id,
    kind: "poi",
    name: item.name ?? item.poiName ?? item.poiId ?? item.id,
    score: Number(item.score) || 0,
    themes: item.themes ?? [],
    categories: item.categories ?? [],
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

