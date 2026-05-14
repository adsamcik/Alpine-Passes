// Must match the legacy localStorage bridge literals in assets/js/app.js.
export const LEISURE_PLANNER_FLAG_KEY = "alpine.planner.leisure.v1";
export const LEISURE_PLANNER_END_NODE_KEY = "alpine.planner.endNode";

const GRAPH_URL = new URL("../../data/leisure-graph.v1.json", import.meta.url).href;
const FETCH_TIMEOUT_MS = 20_000;
// Auto-updated by tools/leisure/build-wasm.mjs at build time. Used to
// cache-bust the WASM binary against stale glue JS on deploys.
const WASM_CONTENT_HASH = "4bb04d8b177c";
const SHIM_REPORTED = Symbol.for("alpine.leisure.shimReported");

let graphStatePromise = null;
let wasmReadyPromise = null;

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
 * @param {object} [uiOptions={}] UI options from app.js.
 * @returns {Promise<object>} UI-shaped result for rendering and route alternatives.
 */
export async function leisurePlanAuto(uiOptions = {}) {
  return planCommon(uiOptions, "auto", null, false);
}

/**
 * Build a leisure tour through selected UI stops and translate it for rendering.
 *
 * @param {object} [uiOptions={}] UI options from app.js.
 * @param {object[]} [selectedStops=[]] UI-selected pass/POI stops.
 * @returns {Promise<object>} UI-shaped selected-tour result for rendering.
 */
export async function leisurePlanSelected(uiOptions = {}, selectedStops = []) {
  return planCommon(uiOptions, "selected", selectedStops, true);
}

async function planCommon(uiOptions, mode, selectedStops, advanced) {
  const startedAt = Date.now();
  let state;
  try { state = await graphState(); }
  catch (error) { return wasmUnavailableResult(uiOptions, advanced, error); }

  try {
    const uiForRust = optionsForRust(uiOptions, leisureEndNodeOverride());

    let planResult, planMode;
    if (mode === "selected") {
      const ids = state.wasm.wasm_resolve_selected_stop_ids(state.graphHandle, selectedStops);
      if (!Array.isArray(ids) || ids.length === 0) {
        return reshapeForLegacyAppJs(state.wasm.wasm_infeasible_result("no-selected-stops", uiForRust, true));
      }
      planResult = state.wasm.wasm_leisure_plan_selected(state.graphHandle, state.earsHandle, ids, uiForRust);
      planMode = "selected";
    } else {
      const isOpen = uiForRust.endNode && typeof uiForRust.start === "string" && typeof uiForRust.endNode === "string";
      planResult = isOpen
        ? state.wasm.wasm_leisure_plan_open(state.graphHandle, state.earsHandle, uiForRust.start, uiForRust.endNode, uiForRust)
        : state.wasm.wasm_leisure_plan_auto(state.graphHandle, state.earsHandle, uiForRust);
      planMode = isOpen ? "open" : "auto";
    }

    const routeRequests = state.wasm.wasm_build_route_requests(state.graphHandle, planResult, uiForRust) ?? [];
    const routeFacts = await Promise.all(
      routeRequests.map((req) => fetchOsrmFacts(req, uiOptions?.osrmRoute))
    );
    const finalized = state.wasm.wasm_finalize_plan(
      state.graphHandle, planResult, routeFacts, uiForRust, advanced);
    const result = reshapeForLegacyAppJs(
      withLazyAlternativeEnrichment(finalized, state, uiForRust));

    reportShimEvent("plan-completed", { mode: planMode, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    return planFailureResult(state, uiOptions, advanced, error);
  }
}

function graphState() {
  if (!graphStatePromise) {
    graphStatePromise = initializeGraphState();
    const pending = graphStatePromise;
    pending.catch((error) => {
      if (graphStatePromise === pending) graphStatePromise = null;
      reportShimErrorOnce("graph-state-init", error);
    });
  }
  return graphStatePromise;
}

function loadWasm() {
  if (!wasmReadyPromise) {
    wasmReadyPromise = (async () => {
      try {
        const wasm = await import("../../wasm/leisure-core/leisure_core.js");
        const wasmUrl = new URL("../../wasm/leisure-core/leisure_core_bg.wasm", import.meta.url);
        wasmUrl.searchParams.set("v", WASM_CONTENT_HASH);
        try {
          if (typeof globalThis.fetch !== "function") throw new Error("fetch unavailable");
          const response = await fetchWithTimeout(wasmUrl.href);
          if (!response.ok) throw new Error(`WASM fetch failed: ${response.status}`);
          const bytes = await response.arrayBuffer();
          await wasm.default({ module_or_path: bytes });
        } catch (error) {
          if (!isNodeWasmFetchError(error)) throw error;
          const { readFile } = await import("node:fs/promises");
          const bytes = await readFile(new URL("../../wasm/leisure-core/leisure_core_bg.wasm", import.meta.url));
          await wasm.default({ module_or_path: bytes });
        }
        reportShimEvent("wasm-ready", { version: wasm.leisure_core_version?.() });
        return wasm;
      } catch (error) {
        wasmReadyPromise = null;
        reportShimErrorOnce("wasm-init", error);
        throw error;
      }
    })();
  }
  return wasmReadyPromise;
}

async function initializeGraphState() {
  const [wasm, graphText] = await Promise.all([loadWasm(), loadGraphText(GRAPH_URL)]);
  let graphHandle;
  try {
    graphHandle = wasm.wasm_load_graph(graphText);
  } catch (error) {
    if (!/invalid type:\s*string/i.test(errorMessage(error))) throw error;
    graphHandle = wasm.wasm_load_graph(JSON.parse(graphText));
  }
  if (!Number.isInteger(graphHandle)) throw new Error(`Invalid WASM graph handle: ${graphHandle}`);
  const ears = wasm.wasm_decompose_ears(graphHandle);
  const earsHandle = Number.isInteger(ears) ? ears : ears?.handle;
  if (!Number.isInteger(earsHandle)) throw new Error("Invalid WASM ears handle");
  return { wasm, graphHandle, earsHandle, ears, released: false };
}

async function loadGraphText(url) {
  if (typeof globalThis.fetch === "function") {
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) throw new Error(`Graph fetch failed: ${response.status} ${response.statusText}`);
      return response.text();
    } catch (error) {
      if (!isNodeWasmFetchError(error)) {
        reportShimError("graph-fetch", error);
        throw error;
      }
    }
  }
  try {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    return readFile(fileURLToPath(url), "utf8");
  } catch (error) {
    reportShimError("graph-fetch", error);
    throw error;
  }
}

async function fetchWithTimeout(url, options = {}) {
  if (typeof globalThis.AbortController !== "function") return globalThis.fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await globalThis.fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      const filename = String(url).split("/").pop()?.split(/[?#]/)[0] || "resource";
      throw new Error(`Network timeout after ${FETCH_TIMEOUT_MS / 1000}s while fetching ${filename}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function releaseWasmShimResources() {
  if (!graphStatePromise) return;
  const pending = graphStatePromise;
  graphStatePromise = null;
  wasmReadyPromise = null;
  try {
    const state = await pending;
    // Mark released BEFORE freeing handles so any in-flight ensurePhase4
    // thunks that check this flag can no-op silently without an error event.
    state.released = true;
    try {
      if (state?.wasm && Number.isInteger(state.earsHandle)) state.wasm.wasm_free_ears(state.earsHandle);
    } catch (error) {
      reportShimError("wasm-free-ears", error);
    }
    try {
      if (state?.wasm && Number.isInteger(state.graphHandle)) state.wasm.wasm_free_graph(state.graphHandle);
    } catch (error) {
      reportShimError("wasm-free-graph", error);
    }
  } catch {
    /* graph state never resolved; nothing to free */
  }
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("beforeunload", () => releaseWasmShimResources());
  globalThis.addEventListener("pagehide", (event) => {
    if (event?.persisted) return;
    releaseWasmShimResources();
  });
}

function optionsForRust(uiOptions, endNodeOverride) {
  const out = { ...uiOptions };
  if (endNodeOverride && !out.endNode) out.endNode = endNodeOverride;
  out.tzOffsetMinutes = computeTzOffsetMinutes();
  out.startTime = resolveStartTimeIso(uiOptions.startTime, uiOptions.tripDate);
  out.tripDate = resolveTripDateString(uiOptions.tripDate);
  return out;
}

function resolveTripDateString(tripDate) {
  if (tripDate == null) return undefined;
  if (typeof tripDate === "string") return tripDate;
  const date = tripDate instanceof Date ? tripDate : new Date(tripDate);
  if (Number.isNaN(date.getTime())) return undefined;
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resolveStartTimeIso(startTime, tripDate) {
  if (startTime) {
    const iso = isoStringOrNull(startTime);
    if (iso) return iso;
  }
  if (tripDate) {
    if (typeof tripDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(tripDate)) {
      return `${tripDate}T08:00:00.000Z`;
    }
    const iso = isoStringOrNull(tripDate);
    if (iso) return iso;
  }
  return null;
}

function isoStringOrNull(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

async function fetchOsrmFacts(routeRequest, osrmRoute) {
  if (typeof osrmRoute !== "function") return null;
  const coords = routeRequest?.coords;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  // routeRequest.coords are [lon, lat] pairs (Rust RouteRequest contract).
  const coordsStr = coords.map(([lon, lat]) => `${lon},${lat}`).join(";");
  try {
    const resp = await osrmRoute(coordsStr);
    if (!resp) return null;
    return { geom: resp.geom, distanceKm: resp.distanceKm, durationH: resp.durationH };
  } catch (err) {
    reportShimError("osrm-fetch", err);
    return null;
  }
}

function withLazyAlternativeEnrichment(finalized, state, uiForRust) {
  const alts = Array.isArray(finalized?._routeAlternatives) ? finalized._routeAlternatives : [];
  const wrapped = alts.map((alt) => {
    let phase4Promise = null;
    const wrappedAlt = {
      label: alt.label,
      result: alt.result,
      draw: alt.draw,
    };
    Object.defineProperty(wrappedAlt, "tour", { value: alt.tour, enumerable: false });
    Object.defineProperty(wrappedAlt, "tourStops", { value: alt.tourStops, enumerable: false });
    wrappedAlt.ensurePhase4 = function ensurePhase4() {
      // Guard: if the WASM state was released (e.g. BFCache restore + leisure-
      // toggle, or beforeunload), skip silently without firing an error event.
      // The handle is tombstoned; calling wasm_phase4_outputs would throw.
      if (state.released) return Promise.resolve(wrappedAlt);
      if (!phase4Promise) {
        phase4Promise = (async () => {
          try {
            // Re-check inside the async boundary in case release raced here.
            if (state.released) return;
            const phase4 = state.wasm.wasm_phase4_outputs(
              state.graphHandle, alt.tour, alt.tourStops, uiForRust);
            applyPhase4InPlace(wrappedAlt.result, wrappedAlt.draw?.meta, phase4);
          } catch (err) {
            // If release happened mid-thunk, swallow silently.
            if (state.released) return;
            reportShimError("phase4-enrich", err);
          }
        })();
      }
      return phase4Promise.then(() => wrappedAlt);
    };
    return wrappedAlt;
  });
  return { ...finalized, _routeAlternatives: wrapped };
}

function applyPhase4InPlace(result, drawMeta, phase4) {
  if (!result || !phase4) return;
  result.corridor = reshapeCorridor(phase4.corridor);
  result.lunchZones = phase4.lunchZones ?? [];
  result.breaks = phase4.breaks ?? [];
  result.intent = phase4.intent ?? { topPersona: "", ambiguous: false, primary: [], serendipity: [], topPersonas: [] };
  if (drawMeta) drawMeta.leisureOverlays = phase4.overlays ?? defaultOverlays();
}

function reshapeForLegacyAppJs(result) {
  if (result?.corridor) result.corridor = reshapeCorridor(result.corridor);
  if (Array.isArray(result?._routeAlternatives)) {
    for (const alt of result._routeAlternatives) {
      if (alt?.result?.corridor) alt.result.corridor = reshapeCorridor(alt.result.corridor);
      if (alt?.result) alt.result.tripDate = reshapeTripDate(alt.result.tripDate);
    }
  }
  if (result) result.tripDate = reshapeTripDate(result.tripDate);
  return result;
}

// Rust serialises trip_date as an ISO `YYYY-MM-DD` string (Option<String>).
// Legacy app.js consumes `r.tripDate` as a Date object (calls .getFullYear()
// etc. via formatTripDate/daysBetweenDates). Coerce here so the shim
// preserves the pre-migration contract.
function reshapeTripDate(value) {
  if (value == null || value instanceof Date) return value ?? null;
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function reshapeCorridor(corridor) {
  if (!corridor) return { autoInclude: [], suggestions: [], drawer: [] };
  if ("suggestions" in corridor && !("items" in corridor)) return corridor;
  return {
    autoInclude: corridor.autoInclude ?? [],
    suggestions: corridor.items ?? corridor.suggestions ?? [],
    drawer: [],
  };
}

function defaultOverlays() {
  return { lunchZones: [], breaks: [], corridorSuggestions: [], corridorAutoInclude: [] };
}

function wasmUnavailableResult(uiOptions, advanced, error) {
  const message = `WebAssembly is required for the leisure planner: ${errorMessage(error)}`;
  reportShimErrorOnce("plan", error);
  return {
    start: uiOptions?.start ?? null,
    endNode: undefined,
    tourStops: [],
    modes: [],
    implicitPasses: [],
    scenicStops: [],
    km: 0, driveH: 0, dwellH: 0, extrasH: 0,
    extrasParts: { corridorH: 0, lunchH: 0, breaksH: 0 },
    totalH: 0,
    inRange: false,
    advanced: !!advanced,
    routeWarning: message,
    statusWarning: message,
    tripDate: uiOptions?.tripDate ?? null,
    routeAlternatives: [],
    routeAlternativeIndex: 0,
    totalOpen: 0,
    corridor: { autoInclude: [], suggestions: [], drawer: [] },
    lunchZones: [],
    breaks: [],
    intent: { topPersona: "", ambiguous: false, primary: [], serendipity: [], topPersonas: [] },
    _latlngs: [],
    _drawMeta: { leisureOverlays: defaultOverlays() },
    _routeAlternatives: [],
    wasmUnavailable: true,
    error: errorMessage(error),
  };
}

function planFailureResult(state, uiOptions, advanced, error) {
  reportShimErrorOnce("plan", error);
  if (state?.wasm?.wasm_infeasible_result) {
    try {
      const uiForRust = optionsForRust(uiOptions, leisureEndNodeOverride());
      return reshapeForLegacyAppJs(state.wasm.wasm_infeasible_result(
        "wasm-error: " + errorMessage(error), uiForRust, !!advanced));
    } catch { /* fall through */ }
  }
  return wasmUnavailableResult(uiOptions, advanced, error);
}

function isNodeWasmFetchError(error) {
  const isGenuineNode = typeof process !== "undefined"
    && typeof process.release?.name === "string"
    && process.release.name === "node"
    && typeof window === "undefined";
  if (!isGenuineNode) return false;

  const msg = String(error?.message || error || "");
  const code = error?.cause?.code || error?.code;
  return code === "ERR_INVALID_URL"
    || code === "ERR_NETWORK"
    || /fetch is not defined|fetch failed/i.test(msg);
}

function errorMessage(error) {
  return String(error?.message || error || "unknown error");
}

function computeTzOffsetMinutes() {
  try {
    // JS returns minutes west of UTC; Rust planner wants minutes east of UTC.
    return -new Date().getTimezoneOffset();
  } catch {
    return 0;
  }
}

function reportShimError(stage, error) {
  const payload = {
    stage,
    errorName: error?.name ?? "Error",
    errorMessage: String(error?.message ?? error ?? "unknown"),
    timestamp: Date.now(),
  };
  globalThis.console?.error?.("[leisure-wasm-shim]", payload);
  try {
    globalThis.dispatchEvent?.(new CustomEvent("leisure-wasm-error", { detail: payload }));
  } catch { /* no-op */ }
}

function reportShimErrorOnce(stage, error) {
  if (!error || error[SHIM_REPORTED]) return;
  reportShimError(stage, error);
  try {
    error[SHIM_REPORTED] = true;
  } catch { /* frozen error objects can still be reported once per catcher */ }
}

function reportShimEvent(name, detail = {}) {
  const payload = { name, ...detail, timestamp: Date.now() };
  globalThis.console?.debug?.("[leisure-wasm-shim]", payload);
  try {
    globalThis.dispatchEvent?.(new CustomEvent("leisure-wasm-event", { detail: payload }));
  } catch { /* no-op */ }
}

function leisureEndNodeOverride() {
  try {
    const value = globalThis.localStorage?.getItem(LEISURE_PLANNER_END_NODE_KEY);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
