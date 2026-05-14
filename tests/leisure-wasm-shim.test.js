const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const wasmShimModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "wasm-shim.js")).href);

// ============================================================================
// A. Lifecycle / IO tests — adapted from prior contract
// ============================================================================

test("wasm-shim failure result marks WebAssembly as unavailable", async () => {
  const previousWarn = console.warn;
  const previousError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const shim = await wasmShimWithFailingLoader();
    const result = await shim.leisurePlanAuto(uiOptions({ start: "j-andermatt" }));

    assert.equal(result.wasmUnavailable, true);
    assert.match(result.routeWarning, /WebAssembly is required/);
    assert.match(result.statusWarning, /WebAssembly is required/);
  } finally {
    console.warn = previousWarn;
    console.error = previousError;
  }
});

test("reportShimError dispatches leisure-wasm-error CustomEvent with structured detail", async () => {
  const restoreEvents = installCustomEventTarget();
  const previousError = console.error;
  console.error = () => {};
  const events = [];
  const listener = (event) => events.push(event.detail);
  globalThis.addEventListener("leisure-wasm-error", listener);

  try {
    const shim = await wasmShimWithFailingGraphState();
    await shim.leisurePlanAuto({}).catch(() => { /* expected only if the failure is not converted */ });
    await Promise.resolve();

    assert.ok(events.length > 0, "at least one leisure-wasm-error event should fire");
    const ev = events[0];
    assert.equal(typeof ev.stage, "string");
    assert.equal(typeof ev.errorName, "string");
    assert.equal(typeof ev.errorMessage, "string");
    assert.equal(typeof ev.timestamp, "number");
  } finally {
    globalThis.removeEventListener("leisure-wasm-error", listener);
    console.error = previousError;
    restoreEvents();
  }
});

test("reportShimErrorOnce dispatches at most one CustomEvent for a single error object", async () => {
  const restoreEvents = installCustomEventTarget();
  const previousError = console.error;
  console.error = () => {};
  const events = [];
  const listener = (event) => events.push(event.detail);
  globalThis.addEventListener("leisure-wasm-error", listener);

  try {
    const shim = await wasmShimWithFailingLoader();
    await shim.leisurePlanAuto({}).catch(() => { /* expected only if the failure is not converted */ });
    await Promise.resolve();

    assert.equal(events.length, 1, "single error should dispatch exactly one CustomEvent");
  } finally {
    globalThis.removeEventListener("leisure-wasm-error", listener);
    console.error = previousError;
    restoreEvents();
  }
});

test("reportShimEvent dispatches leisure-wasm-event on plan completion", async () => {
  const restoreEvents = installCustomEventTarget();
  const previousDebug = console.debug;
  console.debug = () => {};
  const events = [];
  const listener = (event) => events.push(event.detail);
  globalThis.addEventListener("leisure-wasm-event", listener);

  try {
    const shim = await wasmShimWithMockWasm();
    await shim.leisurePlanAuto(uiOptions({ start: "j-start" }));
    await Promise.resolve();

    const completed = events.find((event) => event.name === "plan-completed");
    assert.ok(completed, "plan-completed leisure-wasm-event should fire");
    assert.equal(typeof completed.mode, "string");
    assert.equal(typeof completed.durationMs, "number");
    assert.equal(typeof completed.timestamp, "number");
  } finally {
    globalThis.removeEventListener("leisure-wasm-event", listener);
    console.debug = previousDebug;
    restoreEvents();
  }
});

test("releaseWasmShimResources calls wasm_free_ears before wasm_free_graph, idempotent", async () => {
  const freeOrder = [];
  const shim = await wasmShimWithGraphStateOverride({
    wasm: {
      wasm_free_ears: () => { freeOrder.push("ears"); return true; },
      wasm_free_graph: () => { freeOrder.push("graph"); return true; },
    },
    graphHandle: 1,
    earsHandle: 2,
  });

  await shim.__graphStateForTest();
  shim.releaseWasmShimResources();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepStrictEqual(freeOrder, ["ears", "graph"]);

  freeOrder.length = 0;
  shim.releaseWasmShimResources();
  await Promise.resolve();
  assert.deepStrictEqual(freeOrder, []);
});

test("pagehide cleanup skips BFCache persisted pages and remains reusable", async () => {
  const restoreEvents = installCustomEventTarget();
  const freeOrder = [];
  try {
    const shim = await wasmShimWithGraphStateOverride({
      wasm: {
        wasm_free_ears: () => { freeOrder.push("ears"); return true; },
        wasm_free_graph: () => { freeOrder.push("graph"); return true; },
      },
      graphHandle: 1,
      earsHandle: 2,
    });

    await shim.__graphStateForTest();
    globalThis.dispatchEvent(pagehideEvent(true));
    await Promise.resolve();
    assert.deepStrictEqual(freeOrder, [], "BFCache pagehide should not release resources");

    globalThis.dispatchEvent(pagehideEvent(false));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(freeOrder, ["ears", "graph"]);
  } finally {
    restoreEvents();
  }
});

test("fetchWithTimeout aborts on slow networks with a clear error message", async () => {
  const shim = await wasmShimFetchModule();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });

  try {
    let error;
    try {
      await shim.fetchWithTimeout("https://example.test/slow.json");
    } catch (caught) {
      error = caught;
    }
    const msg = String(error?.message || "");
    assert.match(msg, /^Network timeout after 0\.05s while fetching slow\.json$/,
      "should strip URL to basename only");
    assert.doesNotMatch(msg, /https?:\/\//, "should not include scheme in user-facing message");
    assert.doesNotMatch(msg, /example\.test/, "should not include hostname");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("isNodeWasmFetchError does not classify browser/jsdom fetch errors", async () => {
  const shim = await wasmShimFetchClassifierModule();
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    const error = new Error("Network timeout after 20s while fetching leisure_core_bg.wasm");
    assert.equal(shim.isNodeWasmFetchError(error), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("graphStatePromise clears on rejection so subsequent calls retry", async () => {
  let attempts = 0;
  const shim = await wasmShimGraphStateModule(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("mock graph blocked");
    return JSON.stringify(minimalGraphData());
  });

  await assert.rejects(shim.__graphStateForTest(), /mock graph blocked/);
  await Promise.resolve();
  const state = await shim.__graphStateForTest();

  assert.equal(attempts, 2);
  assert.equal(state.graphHandle, 1);
  assert.equal(state.earsHandle, 2);
});

// ============================================================================
// B. New shim contract — Rust-finalized UiPlanResult flow
// ============================================================================

test("wasm-unavailable result shape matches the documented UiPlanResult fields", async () => {
  const previousWarn = console.warn;
  const previousError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const shim = await wasmShimWithFailingLoader();
    const result = await shim.leisurePlanAuto(uiOptions({ start: "j-andermatt" }));

    assertConsumerFieldsPresent(result);
    assert.equal(result.wasmUnavailable, true);

    // Corridor shape: { autoInclude, suggestions, drawer } — all arrays, drawer empty.
    assert.deepStrictEqual(Object.keys(result.corridor).sort(), ["autoInclude", "drawer", "suggestions"]);
    assert.ok(Array.isArray(result.corridor.autoInclude));
    assert.ok(Array.isArray(result.corridor.suggestions));
    assert.ok(Array.isArray(result.corridor.drawer));
    assert.equal(result.corridor.drawer.length, 0);

    // _routeAlternatives is an empty array, never undefined.
    assert.ok(Array.isArray(result._routeAlternatives));
    assert.equal(result._routeAlternatives.length, 0);

    // _drawMeta.leisureOverlays has all four overlay arrays.
    const overlays = result._drawMeta.leisureOverlays;
    assert.ok(Array.isArray(overlays.lunchZones));
    assert.ok(Array.isArray(overlays.breaks));
    assert.ok(Array.isArray(overlays.corridorSuggestions));
    assert.ok(Array.isArray(overlays.corridorAutoInclude));
  } finally {
    console.warn = previousWarn;
    console.error = previousError;
  }
});

test("corridor reshape: Rust items become legacy suggestions; drawer is []; no items key remains", async () => {
  const wasm = mockWasm({
    wasm_finalize_plan: (gh, plan, routeFacts, ui, advanced) => ({
      ...mockFinalizedPlan(ui, advanced),
      corridor: { items: [{ id: "poi1" }], autoInclude: [{ id: "auto1" }] },
    }),
  });
  const shim = await wasmShimWithMockWasm({ wasm });
  const result = await shim.leisurePlanAuto(uiOptions({ start: "j-start" }));

  assert.equal(result.corridor.suggestions[0].id, "poi1");
  assert.equal(result.corridor.autoInclude[0].id, "auto1");
  assert.equal(result.corridor.drawer.length, 0);
  assert.equal("items" in result.corridor, false, "Rust-shape `items` key must not leak through");
});

test("_routeAlternatives are wrapped with ensurePhase4 thunks and awaiting returns the same wrapper", async () => {
  const wasm = mockWasm({
    wasm_finalize_plan: (gh, plan, routeFacts, ui, advanced) => ({
      ...mockFinalizedPlan(ui, advanced),
      _routeAlternatives: [
        { label: "primary", result: { corridor: null }, draw: { meta: {} }, tour: { stub: true }, tourStops: [] },
        { label: "alt1", result: { corridor: null }, draw: { meta: {} }, tour: { stub: "alt" }, tourStops: [] },
      ],
    }),
  });
  const shim = await wasmShimWithMockWasm({ wasm });
  const result = await shim.leisurePlanAuto(uiOptions({ start: "j-start" }));

  assert.equal(result._routeAlternatives.length, 2);
  assert.equal(typeof result._routeAlternatives[0].ensurePhase4, "function");
  assert.equal(typeof result._routeAlternatives[1].ensurePhase4, "function");

  const wrapper = result._routeAlternatives[1];
  const awaited = await wrapper.ensurePhase4();
  assert.strictEqual(awaited, wrapper, "ensurePhase4 must resolve to the same wrapper for chaining");
});

test("ensurePhase4 mutates alt.result.corridor with reshaped phase4 output", async () => {
  const wasm = mockWasm({
    wasm_finalize_plan: (gh, plan, routeFacts, ui, advanced) => ({
      ...mockFinalizedPlan(ui, advanced),
      _routeAlternatives: [
        { label: "primary", result: { corridor: null }, draw: { meta: {} }, tour: { stub: true }, tourStops: [] },
        { label: "alt1", result: { corridor: null }, draw: { meta: {} }, tour: { stub: "alt" }, tourStops: [] },
      ],
    }),
    wasm_phase4_outputs: () => ({
      corridor: { items: [{ id: "x" }], autoInclude: [] },
      lunchZones: [],
      breaks: [],
      intent: { topPersona: "Test", ambiguous: false, primary: [], serendipity: [], topPersonas: [] },
      overlays: { lunchZones: [], breaks: [], corridorSuggestions: [], corridorAutoInclude: [] },
    }),
  });
  const shim = await wasmShimWithMockWasm({ wasm });
  const result = await shim.leisurePlanAuto(uiOptions({ start: "j-start" }));

  const alt = result._routeAlternatives[1];
  assert.equal(alt.result.corridor, null, "pre-enrichment corridor should be the as-finalized value");

  await alt.ensurePhase4();

  assert.ok(alt.result.corridor, "ensurePhase4 must populate alt.result.corridor");
  assert.equal(alt.result.corridor.suggestions[0].id, "x");
  assert.equal(alt.result.corridor.drawer.length, 0);
  assert.equal("items" in alt.result.corridor, false);
});

test("ensurePhase4 is memoized: second call hits the same promise; single wasm_phase4_outputs invocation", async () => {
  let phase4CallCount = 0;
  const wasm = mockWasm({
    wasm_finalize_plan: (gh, plan, routeFacts, ui, advanced) => ({
      ...mockFinalizedPlan(ui, advanced),
      _routeAlternatives: [
        { label: "primary", result: { corridor: null }, draw: { meta: {} }, tour: { stub: true }, tourStops: [] },
      ],
    }),
    wasm_phase4_outputs: () => {
      phase4CallCount += 1;
      return mockPhase4Outputs();
    },
  });
  const shim = await wasmShimWithMockWasm({ wasm });
  const result = await shim.leisurePlanAuto(uiOptions({ start: "j-start" }));

  const alt = result._routeAlternatives[0];
  const first = await alt.ensurePhase4();
  const second = await alt.ensurePhase4();

  assert.equal(phase4CallCount, 1, "wasm_phase4_outputs must be invoked exactly once across two ensurePhase4 awaits");
  assert.strictEqual(first, alt);
  assert.strictEqual(second, alt);
  assert.strictEqual(first, second);
});

test("optionsForRust threads tzOffsetMinutes and startTime to every wasm call", async () => {
  const originalGetTzOffset = Date.prototype.getTimezoneOffset;
  // JS getTimezoneOffset returns minutes WEST of UTC. Shim negates it to get
  // minutes EAST of UTC. Stub returning -120 → shim should yield 120.
  Date.prototype.getTimezoneOffset = function stubbedGetTimezoneOffset() { return -120; };
  try {
    const wasm = mockWasm();
    const shim = await wasmShimWithMockWasm({ wasm });
    await shim.leisurePlanAuto(uiOptions({
      start: "j-start",
      startTime: new Date(Date.UTC(2026, 5, 15, 8, 0, 0)),
      tripDate: new Date(Date.UTC(2026, 5, 15)),
    }));

    const captured = wasm.__captured.finalizeArgs;
    assert.ok(captured, "wasm_finalize_plan must have been invoked");
    assert.equal(captured.ui.tzOffsetMinutes, 120, "tzOffsetMinutes must be the negated JS offset (East-of-UTC)");
    assert.equal(captured.ui.startTime, "2026-06-15T08:00:00.000Z", "startTime must be normalized to an ISO string");
  } finally {
    Date.prototype.getTimezoneOffset = originalGetTzOffset;
  }
});

test("leisurePlanSelected with empty selectedStops invokes wasm_infeasible_result with 'no-selected-stops'", async () => {
  const wasm = mockWasm({
    wasm_resolve_selected_stop_ids: () => [],
  });
  const shim = await wasmShimWithMockWasm({ wasm });
  const result = await shim.leisurePlanSelected(uiOptions({ start: "j-start" }), []);

  const captured = wasm.__captured.infeasibleArgs;
  assert.ok(captured, "wasm_infeasible_result must be invoked when no stops resolve");
  assert.equal(captured.reason, "no-selected-stops");
  assert.equal(captured.advanced, true, "leisurePlanSelected always passes advanced=true to infeasible_result");
  assert.ok(result && typeof result === "object", "shim still returns a UiPlanResult on infeasible branch");
});

test("OSRM fetch failures are non-fatal: per-alt error → routeFacts[i] = null", async () => {
  let osrmCallCount = 0;
  const failingOsrm = async (coords) => {
    osrmCallCount += 1;
    if (osrmCallCount === 2) throw new Error("mock OSRM failure on alt 1");
    return straightLineOsrmRoute(coords);
  };

  const wasm = mockWasm({
    wasm_build_route_requests: () => [
      { coords: [[8.20, 46.80], [8.21, 46.81]] },
      { coords: [[8.21, 46.81], [8.22, 46.82]] },
    ],
    wasm_finalize_plan: (gh, plan, routeFacts, ui, advanced) => {
      // Capture what the shim hands to Rust.
      wasm.__captured.finalizeArgs = { graphHandle: gh, plan, routeFacts, ui, advanced };
      return mockFinalizedPlan(ui, advanced);
    },
  });

  const previousError = console.error;
  console.error = () => {};
  try {
    const shim = await wasmShimWithMockWasm({ wasm });
    const result = await shim.leisurePlanAuto(uiOptions({ start: "j-start", osrmRoute: failingOsrm }));

    assert.ok(result, "shim should not throw when one OSRM request fails");
    const captured = wasm.__captured.finalizeArgs;
    assert.ok(captured, "wasm_finalize_plan must still be invoked");
    assert.ok(Array.isArray(captured.routeFacts));
    assert.equal(captured.routeFacts.length, 2);
    assert.notEqual(captured.routeFacts[0], null, "first OSRM call succeeded — routeFacts[0] should be populated");
    assert.equal(captured.routeFacts[1], null, "second OSRM call failed — routeFacts[1] must be null (not throw)");
  } finally {
    console.error = previousError;
  }
});

test("ensurePhase4 after releaseWasmShimResources no-ops silently: no enrichment, no leisure-wasm-error", async () => {
  const restoreEvents = installCustomEventTarget();
  const errorEvents = [];
  const errorListener = (event) => errorEvents.push(event.detail);
  globalThis.addEventListener("leisure-wasm-error", errorListener);

  const previousError = console.error;
  console.error = () => {};

  let phase4CallCount = 0;
  const wasm = mockWasm({
    wasm_finalize_plan: (gh, plan, routeFacts, ui, advanced) => ({
      ...mockFinalizedPlan(ui, advanced),
      _routeAlternatives: [
        { label: "primary", result: { corridor: null }, draw: { meta: {} }, tour: { stub: true }, tourStops: [] },
      ],
    }),
    wasm_phase4_outputs: () => {
      phase4CallCount += 1;
      return mockPhase4Outputs();
    },
  });

  try {
    const shim = await wasmShimWithMockWasm({ wasm });
    const result = await shim.leisurePlanAuto(uiOptions({ start: "j-start" }));
    const alt = result._routeAlternatives[0];

    // Simulate BFCache restore / leisure-toggle: release all WASM resources.
    await shim.releaseWasmShimResources();
    await Promise.resolve();

    // Stale ensurePhase4 click after release must be a silent no-op.
    const awaited = await alt.ensurePhase4();

    assert.strictEqual(awaited, alt, "ensurePhase4 must resolve to the same wrapper for chaining");
    assert.equal(phase4CallCount, 0, "wasm_phase4_outputs must NOT be called on a tombstoned handle");
    assert.equal(alt.result.corridor, null, "alt.result must not be enriched after release");
    assert.equal(errorEvents.length, 0, "no leisure-wasm-error event must fire for a stale-state no-op");
  } finally {
    globalThis.removeEventListener("leisure-wasm-error", errorListener);
    console.error = previousError;
    restoreEvents();
  }
});

// ============================================================================
// C. Real-graph smoke — gated on a working WASM artifact
// ============================================================================

test("real-graph smoke: leisurePlanAuto end-to-end builds a UiPlanResult", async (t) => {
  // Probe whether the WASM artifact can load. If the shim's content-hash
  // literal disagrees with the on-disk bundle (pre-F6-C4 rebuild) or the
  // artifact is missing, skip gracefully so this file can be tested on its own.
  let probe;
  try {
    probe = await import(pathToFileURL(path.join(repoRoot, "assets", "wasm", "leisure-core", "leisure_core.js")).href);
  } catch (err) {
    return t.skip(`leisure_core.js failed to import: ${err?.message || err}`);
  }
  if (typeof probe?.default !== "function") {
    return t.skip("leisure_core.js missing default export");
  }

  const shim = await wasmShimModule;
  const result = await shim.leisurePlanAuto({
    start: "j-andermatt",
    targetMode: "distance",
    targetValue: 100,
    osrmRoute: straightLineOsrmRoute,
    tripDate: new Date(Date.UTC(2026, 5, 15)),
    startTime: new Date(Date.UTC(2026, 5, 15, 8, 0, 0)),
    stopsConfig: defaultStopsConfig(),
  });

  if (result?.wasmUnavailable) {
    return t.skip(`WASM artifact not loadable; awaiting C4 rebuild: ${result.error || ""}`);
  }

  assert.ok(Array.isArray(result.tourStops), "tourStops must be an array");
  assert.ok(Array.isArray(result._routeAlternatives), "_routeAlternatives must be an array");
  assert.ok(result.corridor && typeof result.corridor === "object", "corridor must be an object");
  assert.deepStrictEqual(Object.keys(result.corridor).sort(), ["autoInclude", "drawer", "suggestions"],
    "corridor must be reshaped to the legacy { autoInclude, suggestions, drawer } shape");
  assertConsumerFieldsPresent(result);

  // Semantic gates — these would have caught the parse_plan_options budget-derivation
  // regression where targetMode/targetValue weren't translated to budgetKm/budgetSeconds.
  assert.notStrictEqual(result.status, "infeasible",
    `plan should not be infeasible for a sane 100km auto request (reason=${result.reason ?? ""})`);
  assert.ok(result.km > 0, `plan should have positive km, got ${result.km}`);
  assert.ok(result.totalH > 0, `plan should have positive totalH, got ${result.totalH}`);
  assert.ok(result.tourStops.length > 0, "plan should produce at least one tour stop");
  // tripDate must be coerced back to a Date object for legacy app.js (calls .getFullYear() etc).
  assert.ok(result.tripDate instanceof Date,
    `result.tripDate must be a Date (legacy app.js calls .getFullYear() on it); got ${typeof result.tripDate}`);

  // Best-effort cleanup so the shared graphState doesn't linger across tests.
  try { await shim.releaseWasmShimResources(); } catch { /* non-fatal */ }
});

// ============================================================================
// Test helpers
// ============================================================================

// Field list mirrors `app.js consumers` in
// .copilot/session-state/.../files/program-brief.md.
// REQUIRED fields are present on every UiPlanResult (success or failure).
// OPTIONAL fields are wire-omitted when their Rust value is None
// (`#[serde(skip_serializing_if = "Option::is_none")]`); app.js consumers
// treat missing as falsy/absent — that contract is preserved.
const REQUIRED_CONSUMER_FIELDS = [
  "intent", "corridor", "lunchZones", "breaks",
  "routeAlternatives", "routeAlternativeIndex",
  "_latlngs", "_drawMeta",
  "tourStops", "modes", "implicitPasses", "scenicStops",
  "km", "driveH", "dwellH", "extrasH", "extrasParts", "totalH",
  "inRange", "advanced",
  "tripDate", "totalOpen",
  "start",
  "wasmUnavailable",
];
const OPTIONAL_CONSUMER_FIELDS = [
  "routeWarning", "statusWarning", "endNode",
  "_routeAlternatives",
];

function assertConsumerFieldsPresent(result) {
  for (const field of REQUIRED_CONSUMER_FIELDS) {
    assert.ok(field in result, `required consumer field "${field}" must be present on UiPlanResult (got keys: ${Object.keys(result).join(", ")})`);
  }
  for (const field of OPTIONAL_CONSUMER_FIELDS) {
    if (field in result) {
      // present — fine; app.js reads optionally.
      continue;
    }
    // absent — also fine per `skip_serializing_if = "Option::is_none"`.
  }
  // _drawMeta.leisureOverlays is the sub-key app.js reads.
  assert.ok(result._drawMeta && "leisureOverlays" in result._drawMeta,
    "_drawMeta.leisureOverlays must be present");
}

function uiOptions(overrides = {}) {
  return {
    targetMode: "time",
    targetValue: 8,
    targetTol: 0.2,
    openOnly: false,
    kAlternatives: 1,
    tripDate: new Date(Date.UTC(2026, 5, 15)),
    startTime: new Date(Date.UTC(2026, 5, 15, 8, 0, 0)),
    osrmRoute: straightLineOsrmRoute,
    stopsConfig: defaultStopsConfig(),
    ...overrides,
  };
}

function defaultStopsConfig() {
  return {
    passStopMin: 0,
    lunchBreak: "none",
    restBreakOn: false,
    restInterval: 0,
    restDuration: 0,
  };
}

async function straightLineOsrmRoute(coords) {
  const points = String(coords)
    .split(";")
    .map((token) => token.split(",").map(Number))
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  return {
    geom: points,
    distanceKm: points.length * 10,
    durationH: points.length * 0.1,
  };
}

async function wasmShimWithFailingLoader() {
  return wasmShimFromSource((source) => injectLoadWasmImplementation(source, 'return Promise.reject(new Error("mock wasm blocked"));'));
}

async function wasmShimWithFailingGraphState() {
  const key = `__leisureWasmShimError${Date.now()}${Math.random().toString(16).slice(2)}`;
  globalThis[key] = { error: new Error("mock graph state blocked") };
  return wasmShimFromSource((source) => source
    .replace("async function initializeGraphState() {", `async function initializeGraphState() { throw globalThis["${key}"].error;`));
}

async function wasmShimFromSource(transform) {
  const sourcePath = path.join(repoRoot, "assets", "js", "leisure", "wasm-shim.js");
  let source = await fs.readFile(sourcePath, "utf8");
  // Real graph URL would point at the on-disk JSON; redirect to about:blank so
  // helpers that don't override loadGraphText still don't hit the filesystem.
  source = source.replace('const GRAPH_URL = new URL("../../data/leisure-graph.v1.json", import.meta.url).href;', 'const GRAPH_URL = "about:blank";');
  source = transform(source);
  // Distinguish each `data:` import so Node's module cache treats them as new.
  source += `\n// test-import-nonce:${Date.now()}:${Math.random()}`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function injectLoadWasmImplementation(source, body) {
  return source.replace(/(?:async\s+)?function loadWasm\(\) \{/, `function loadWasm() { ${body}`);
}

async function wasmShimWithMockWasm({ wasm = mockWasm(), graphText = () => JSON.stringify(minimalGraphData()) } = {}) {
  const key = `__leisureWasmShimMock${Date.now()}${Math.random().toString(16).slice(2)}`;
  globalThis[key] = { wasm, graphText };
  return wasmShimFromSource((source) => injectLoadWasmImplementation(source, `return Promise.resolve(globalThis["${key}"].wasm);`)
    .replace("async function loadGraphText(url) {", `async function loadGraphText(url) { return globalThis["${key}"].graphText();`));
}

async function wasmShimWithGraphStateOverride(state) {
  const key = `__leisureWasmShimState${Date.now()}${Math.random().toString(16).slice(2)}`;
  globalThis[key] = { state };
  return wasmShimFromSource((source) => source
    .replace("async function initializeGraphState() {", `async function initializeGraphState() { return globalThis["${key}"].state;`)
    .replace("function graphState()", "export function __graphStateForTest()"));
}

async function wasmShimFetchModule() {
  return wasmShimFromSource((source) => source
    .replace("const FETCH_TIMEOUT_MS = 20_000;", "const FETCH_TIMEOUT_MS = 50;")
    .replace("async function fetchWithTimeout", "export async function fetchWithTimeout"));
}

async function wasmShimFetchClassifierModule() {
  return wasmShimFromSource((source) => source
    .replace("function isNodeWasmFetchError", "export function isNodeWasmFetchError"));
}

async function wasmShimGraphStateModule(graphText) {
  const key = `__leisureWasmShimRetry${Date.now()}${Math.random().toString(16).slice(2)}`;
  globalThis[key] = { wasm: mockWasm(), graphText };
  return wasmShimFromSource((source) => injectLoadWasmImplementation(source, `return Promise.resolve(globalThis["${key}"].wasm);`)
    .replace("async function loadGraphText(url) {", `async function loadGraphText(url) { return globalThis["${key}"].graphText();`)
    .replace("function graphState()", "export function __graphStateForTest()"));
}

// ----------------------------------------------------------------------------
// Mock WASM surface — matches the post-F6 contract
// ----------------------------------------------------------------------------

function mockWasm(overrides = {}) {
  const captured = {};
  const base = {
    leisure_core_version: () => "test",
    wasm_load_graph: () => 1,
    wasm_decompose_ears: () => ({ handle: 2 }),
    wasm_leisure_plan_auto: () => mockPlanResult(),
    wasm_leisure_plan_selected: () => mockPlanResult(),
    wasm_leisure_plan_open: () => mockPlanResult(),
    wasm_resolve_selected_stop_ids: () => ["pass-a"],
    wasm_build_route_requests: () => [{ coords: [[8.20, 46.80], [8.21, 46.81]] }],
    wasm_finalize_plan: (gh, plan, routeFacts, ui, advanced) => {
      captured.finalizeArgs = { graphHandle: gh, plan, routeFacts, ui, advanced };
      return mockFinalizedPlan(ui, advanced);
    },
    wasm_phase4_outputs: () => mockPhase4Outputs(),
    wasm_infeasible_result: (reason, ui, advanced) => {
      captured.infeasibleArgs = { reason, ui, advanced };
      return mockInfeasibleResult(ui, advanced);
    },
    wasm_free_graph: () => true,
    wasm_free_ears: () => true,
  };
  Object.assign(base, overrides);
  base.__captured = captured;
  return base;
}

function mockPlanResult() {
  return {
    status: "optimal",
    primary: {
      endNode: "j-end",
      stops: [{ kind: "start", nodeId: "j-start" }],
      path: [],
      totalDistanceKm: 0,
      totalDurationH: 0,
      diagnostics: {},
    },
    alternatives: [],
    diagnostics: {},
  };
}

function mockFinalizedPlan(uiOptions = {}, advanced = false) {
  return {
    start: uiOptions?.start ?? null,
    endNode: undefined,
    tourStops: [],
    modes: [],
    implicitPasses: [],
    scenicStops: [],
    km: 0,
    driveH: 0,
    dwellH: 0,
    extrasH: 0,
    extrasParts: { corridorH: 0, lunchH: 0, breaksH: 0 },
    totalH: 0,
    inRange: false,
    advanced: !!advanced,
    routeWarning: "",
    statusWarning: "",
    tripDate: uiOptions?.tripDate ?? null,
    routeAlternatives: [],
    routeAlternativeIndex: 0,
    totalOpen: 0,
    // Rust ships items + autoInclude; shim reshapes into legacy shape.
    corridor: { items: [], autoInclude: [] },
    lunchZones: [],
    breaks: [],
    intent: { topPersona: "", ambiguous: false, primary: [], serendipity: [], topPersonas: [] },
    _latlngs: [],
    _drawMeta: { leisureOverlays: { lunchZones: [], breaks: [], corridorSuggestions: [], corridorAutoInclude: [] } },
    _routeAlternatives: [],
  };
}

function mockPhase4Outputs() {
  return {
    corridor: { items: [], autoInclude: [] },
    lunchZones: [],
    breaks: [],
    intent: { topPersona: "", ambiguous: false, primary: [], serendipity: [], topPersonas: [] },
    overlays: { lunchZones: [], breaks: [], corridorSuggestions: [], corridorAutoInclude: [] },
  };
}

function mockInfeasibleResult(uiOptions = {}, advanced = false) {
  return {
    ...mockFinalizedPlan(uiOptions, advanced),
    routeWarning: "infeasible",
    statusWarning: "infeasible",
  };
}

function minimalGraphData() {
  return {
    nodes: [{ id: "j-start", name: "Start", kind: "junction", lat: 46.8, lon: 8.2 }],
    edges: [],
  };
}

function installCustomEventTarget() {
  const previous = {
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    dispatchEvent: globalThis.dispatchEvent,
    CustomEvent: globalThis.CustomEvent,
  };
  const target = new EventTarget();
  globalThis.addEventListener = target.addEventListener.bind(target);
  globalThis.removeEventListener = target.removeEventListener.bind(target);
  globalThis.dispatchEvent = target.dispatchEvent.bind(target);
  if (typeof globalThis.CustomEvent !== "function") {
    globalThis.CustomEvent = class CustomEvent extends Event {
      constructor(type, init = {}) {
        super(type);
        this.detail = init.detail;
      }
    };
  }
  return () => {
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    globalThis.dispatchEvent = previous.dispatchEvent;
    globalThis.CustomEvent = previous.CustomEvent;
  };
}

function pagehideEvent(persisted) {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}
