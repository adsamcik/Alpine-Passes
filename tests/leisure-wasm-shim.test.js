const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const jsApiModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "index.js")).href);
const wasmShimModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "wasm-shim.js")).href);

for (const scenario of parityScenarios()) {
  test(`WASM shim parity: ${scenario.name}`, { timeout: 90_000 }, async () => {
    const previousWarn = console.warn;
    console.warn = () => {};
    try {
      const [jsApi, wasmShim] = await Promise.all([jsApiModule, wasmShimModule]);
      const [jsResult, wasmResult] = await Promise.all([
        scenario.run(jsApi),
        scenario.run(wasmShim),
      ]);
      assert.deepStrictEqual(normalizeUiPlan(wasmResult, scenario), normalizeUiPlan(jsResult, scenario));
      assertBreakIndexBounds(wasmResult, jsResult, scenario);
      assertReasonParity(wasmResult, jsResult, scenario);
      scenario.assert?.(wasmResult);
    } finally {
      console.warn = previousWarn;
    }
  });
}


test("intent.topPersonas matches between WASM shim and JS reference", { timeout: 90_000 }, async () => {
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    const [jsApi, wasmShim] = await Promise.all([jsApiModule, wasmShimModule]);
    const scenarioOptions = uiOptions({
      start: "j-bellinzona",
      targetValue: 8,
      seed: "r5-intent-personas",
      timeBudgetMs: 50,
      includePois: true,
      themes: ["panoramic-view", "food-drink"],
      personas: ["photographer", "family"],
      maxSuggestionsTotal: 8,
    });
    const [jsResult, wasmResult] = await Promise.all([
      jsApi.leisurePlanAuto(scenarioOptions),
      wasmShim.leisurePlanAuto(scenarioOptions),
    ]);

    assert.ok(Array.isArray(wasmResult.intent.topPersonas));
    assert.ok(Array.isArray(jsResult.intent.topPersonas));
    assert.ok(wasmResult.intent.topPersonas.length > 0, "WASM topPersonas should not be empty");
    assert.deepStrictEqual(
      wasmResult.intent.topPersonas,
      jsResult.intent.topPersonas,
      "topPersonas should be identical between WASM and JS",
    );
  } finally {
    console.warn = previousWarn;
  }
});

// NOTE: wasm-shim.js contains a fallback retry that calls wasm_load_graph
// with a parsed object after legacy bundles reject string input. The current
// checked-in bundle accepts strings natively, and this test file intentionally
// does not modify the production shim to force the retry. Follow-up: add a
// wasm-bindgen-test or shim debug hook that exercises the JsValue-object branch.
test("wasm-shim failure result marks WebAssembly as unavailable", async () => {
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    const shim = await wasmShimWithFailingLoader();
    const result = await shim.leisurePlanAuto(uiOptions({ start: "j-andermatt" }));

    assert.equal(result.wasmUnavailable, true);
    assert.match(result.routeWarning, /WebAssembly is required/);
    assert.match(result.statusWarning, /WebAssembly is required/);
  } finally {
    console.warn = previousWarn;
  }
});

test("wasm-shim phase4 returns empty outputs when wasm state is uninitialized", async () => {
  const [{ translatePlannerResult }, { phase4Outputs }] = await Promise.all([
    import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "lib", "ui-translation.js")).href),
    wasmShimPhase4Module(),
  ]);
  const result = await translatePlannerResult({
    status: "degraded",
    primary: {
      stops: [{ kind: "start", nodeId: "j-test" }],
      path: [],
      totalDistanceKm: 0,
      totalDurationH: 0,
      diagnostics: { reason: "wasm-uninitialized" },
    },
    alternatives: [],
    diagnostics: { reason: "wasm-uninitialized" },
  }, {
    graph: minimalGraph(),
    uiOptions: { start: { id: "j-test", name: "Test", lat: 46.8, lon: 8.2 } },
    phase4Outputs,
    wasmState: { wasm: null, graphHandle: null },
  });

  assert.deepEqual(result.corridor, { autoInclude: [], suggestions: [], drawer: [] });
  assert.deepEqual(result.lunchZones, []);
  assert.deepEqual(result.breaks, []);
  assert.deepEqual(result.intent, { topPersona: "", ambiguous: false, primary: [], serendipity: [], topPersonas: [] });
  assert.deepEqual(result._drawMeta.leisureOverlays, { lunchZones: [], breaks: [], corridorSuggestions: [], corridorAutoInclude: [] });
});

test("TZ matrix: lunch zone hunger curve shifts deterministically with tzOffsetMinutes", { timeout: 90_000 }, async () => {
  const baseline = await runPlanWithMockTimezone(0);
  const baseTime = baseline.lunchZones[0]?.tArriveMin;
  assert.equal(baseTime, 720);

  for (const offset of [120, -300, 840, -720]) {
    const result = await runPlanWithMockTimezone(offset);
    const shiftedTime = result.lunchZones[0]?.tArriveMin;
    assert.equal(shiftedTime - baseTime, offset, `offset ${offset} should shift lunch arrival by ${offset} minutes`);
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
    assert.equal(ev.userAgent, undefined, "userAgent should not be in default payload");
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

test("rapid flag toggle does not allocate parallel WASM graphs (app-level race)", async () => {
  // Extract the lifecycle functions from app.js by source-slicing them out and
  // running them in a vm sandbox with a mocked dynamic import. This drives the
  // exact rapid off-to-on path that production users can hit by spamming the
  // debug flag toggle, without booting the full DOM/MapLibre UI.
  const vm = require("node:vm");
  const fsSync = require("node:fs");
  const repoRoot = path.resolve(__dirname, "..");
  const source = fsSync.readFileSync(path.join(repoRoot, "assets", "js", "app.js"), "utf8");
  const start = source.indexOf("let leisurePlannerModulePromise = null;");
  assert.notEqual(start, -1, "marker `let leisurePlannerModulePromise = null;` should exist in app.js");
  const end = source.indexOf("function syncLeisureFlagControl(", start);
  assert.notEqual(end, -1, "marker `function syncLeisureFlagControl(` should exist after the lifecycle block");
  // Replace the dynamic `import(...)` call with a sandbox-injected `__loadShim()`
  // so the vm context can return a controllable mock without resolving a real
  // ES module URL.
  const lifecycle = source.slice(start, end).replace(
    /import\("\.\/leisure\/wasm-shim\.js"\)/,
    "__loadShim()",
  );

  // Mock module records release order and load count so the test can assert
  // no parallel allocations and a clean release-then-reload sequence.
  const loadOrder = [];
  let activeGraphCount = 0;
  let maxParallelGraphs = 0;
  let loadResolver = null;
  let releaseResolver = null;
  const __loadShim = () => {
    loadOrder.push("load");
    activeGraphCount += 1;
    maxParallelGraphs = Math.max(maxParallelGraphs, activeGraphCount);
    return new Promise((resolve) => {
      loadResolver = () => resolve({
        releaseWasmShimResources: () => new Promise((resolveRelease) => {
          loadOrder.push("release");
          releaseResolver = () => {
            activeGraphCount -= 1;
            resolveRelease();
          };
        }),
      });
    });
  };

  const sandbox = { __loadShim, console };
  vm.createContext(sandbox);
  vm.runInContext(`${lifecycle}\nglobalThis.__loadLeisurePlannerModule = loadLeisurePlannerModule;\nglobalThis.__resetLeisurePlannerModuleHandle = resetLeisurePlannerModuleHandle;`, sandbox, { filename: "assets/js/app.js" });

  // 1. First load — module is held.
  const firstLoad = sandbox.__loadLeisurePlannerModule();
  await tick();
  loadResolver();
  await firstLoad;
  assert.equal(activeGraphCount, 1, "exactly one graph after initial load");

  // 2. Rapid flag toggle: reset, then immediately try to re-load.
  const resetPromise = sandbox.__resetLeisurePlannerModuleHandle();
  const reloadPromise = sandbox.__loadLeisurePlannerModule();

  // The reload MUST wait for the release before kicking off a new load.
  await tick();
  assert.equal(activeGraphCount, 1, "still one graph: release not yet resolved, so reload must be queued");
  assert.deepStrictEqual(loadOrder, ["load", "release"], "release fires before any second load");

  // 3. Resolve the release; the reload's load call should now run.
  releaseResolver();
  await resetPromise;
  await tick();
  assert.equal(activeGraphCount, 1, "release dec'd to 0, new load inc'd back to 1 — never 2");

  // 4. Finish the reload.
  loadResolver();
  await reloadPromise;

  assert.equal(maxParallelGraphs, 1, "never more than one graph allocated simultaneously across the full sequence");
  assert.deepStrictEqual(loadOrder, ["load", "release", "load"], "exact sequence: initial load, release, reload");
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

test("JS expandedLine matches Rust raw-previous geometry dedup fixture", async () => {
  const { expandedLine } = await corridorExpandedLineModule();
  const from = { id: "from", lat: 0, lon: 0 };
  const to = { id: "to", lat: 0, lon: 0.0000099 };
  const edge = {
    id: "from->to",
    from: "from",
    to: "to",
    geometry: [[0, 0.0000054]],
  };

  const result = expandedLine(edge, from, to);

  assert.equal(result.length, 1, "Should match Rust: keep only 'from'");
  assert.equal(result[0].id, "from");
});

function parityScenarios() {
  return [
    {
      name: "closed auto with seeded determinism",
      run: (api) => api.leisurePlanAuto(uiOptions({
        start: "j-andermatt",
        targetValue: 6,
        seed: "r5-closed-seeded",
        timeBudgetMs: 50,
      })),
      assert: (result) => assert.ok(result.tourStops.length >= 3),
    },
    {
      name: "selected with multiple required passes",
      run: (api) => api.leisurePlanSelected(uiOptions({
        start: "j-andermatt",
        targetValue: 7,
        seed: "r5-selected-multi",
        timeBudgetMs: 50,
      }), ["furkapass", "grimselpass", "sustenpass"]),
      assert: (result) => {
        const stopIds = new Set(result.tourStops.map((stop) => stop.id));
        for (const id of ["furkapass", "grimselpass", "sustenpass"]) assert.ok(stopIds.has(id), `missing ${id}`);
      },
    },
    {
      name: "open A-to-B with corridor POIs requested",
      run: (api) => api.leisurePlanAuto(uiOptions({
        start: "j-bellinzona",
        endNode: "j-chur",
        targetValue: 8,
        seed: "r5-open-corridor",
        timeBudgetMs: 20,
        includePois: true,
        themes: ["panoramic-view"],
        personas: ["photographer"],
        maxSuggestionsTotal: 8,
      })),
      breaksNormalized: true,
      assert: (result) => {
        assert.equal(result.tourStops[0]?.id, "j-bellinzona");
        assert.equal(result.tourStops.at(-1)?.id, "j-chur");
        assert.ok(Array.isArray(result.corridor.suggestions));
      },
    },
    {
      name: "closed with lunch zone",
      run: (api) => api.leisurePlanAuto(uiOptions({
        start: "j-bellinzona",
        targetValue: 8,
        seed: "r5-lunch-zone",
        timeBudgetMs: 50,
        personas: ["family"],
        stopsConfig: { ...defaultStopsConfig(), lunchBreak: "auto" },
      })),
      assert: (result) => assert.ok(Array.isArray(result.lunchZones)),
    },
    {
      name: "long tour with breaks",
      run: (api) => api.leisurePlanAuto(uiOptions({
        start: "j-andermatt",
        targetValue: 6,
        seed: "r5-long-breaks",
        timeBudgetMs: 100,
        personas: ["comfort"],
        stopsConfig: { ...defaultStopsConfig(), restBreakOn: true, restInterval: 2, restDuration: 20 },
      })),
      assert: (result) => assert.ok(result.breaks.length > 0, "expected break suggestions"),
    },
    {
      name: "tour with intent personas",
      run: (api) => api.leisurePlanAuto(uiOptions({
        start: "j-bellinzona",
        targetValue: 8,
        seed: "r5-intent-personas",
        timeBudgetMs: 50,
        includePois: true,
        themes: ["panoramic-view", "food-drink"],
        personas: ["photographer", "family"],
        maxSuggestionsTotal: 8,
      })),
      assert: (result) => assert.ok(Array.isArray(result.intent.primary) && Array.isArray(result.intent.serendipity)),
    },
    {
      name: "scenic stops surfaced",
      run: (api) => api.leisurePlanAuto(uiOptions({
        start: "j-andermatt",
        targetValue: 7,
        seed: "r5-scenic-stops",
        timeBudgetMs: 50,
        stopsConfig: { ...defaultStopsConfig(), passStopMin: 15, restBreakOn: true, restInterval: 2, restDuration: 15 },
      })),
      assert: (result) => assert.ok(Array.isArray(result.scenicStops)),
    },
    {
      name: "error path invalid start coordinate",
      run: (api) => api.leisurePlanAuto(uiOptions({
        start: { id: "bad-start", name: "Bad start", lat: 999, lon: 999 },
        seed: "r5-invalid-start",
      })),
      expectedWasmReasonRegex: /^missing-start$/,
      expectedJsReasonRegex: /^missing-start$/,
      assert: (result) => {
        assert.equal(result.status, "infeasible");
        assert.equal(typeof result.routeWarning, "string");
      },
    },
    {
      name: "no selected stops",
      run: (api) => api.leisurePlanSelected(uiOptions({
        start: "j-andermatt",
        seed: "r5-no-selected",
      }), []),
      assert: (result) => {
        assert.equal(result.status, "infeasible");
        assert.equal(result.reason, "no-selected-stops");
      },
    },
    {
      name: "endpoint inferred from endNode",
      run: (api) => api.leisurePlanAuto(uiOptions({
        start: "j-andermatt",
        endNode: "j-bellinzona",
        targetValue: 6,
        seed: "r5-end-node",
        timeBudgetMs: 50,
      })),
      breaksNormalized: true,
      assert: (result) => {
        assert.equal(result.endNode, "j-bellinzona");
        assert.equal(result.tourStops.at(-1)?.id, "j-bellinzona");
      },
    },
  ];
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

function assertBreakIndexBounds(wasmResult, jsResult, scenario = {}) {
  if (!scenario.breaksNormalized) return;

  const wasmIdxs = arrayFrom(wasmResult.breaks).map((item) => item?.atTourVertexIdx);
  const jsIdxs = arrayFrom(jsResult.breaks).map((item) => item?.atTourVertexIdx);
  assert.equal(wasmIdxs.length, jsIdxs.length, "break counts must match");
  // Note: atTourVertexIdx is indexed into the underlying tour.path (with
  // sentinels and full graph traversal), NOT tourStops. WASM and JS use
  // different formulas (Rust: float interpolation rounded to 3dp; JS: integer
  // .indexOf()), so the values legitimately differ on open routes. The break
  // LOCATION (lat/lon via enrichBreakPoint) is unaffected. We assert only
  // that both sides produce finite numbers and the same count; full value
  // parity is covered by normalizeBreak deep-equal (which excludes this field).
  assertBreakIndicesFinite(wasmIdxs, "wasm");
  assertBreakIndicesFinite(jsIdxs, "js");
}

function assertBreakIndicesFinite(indices, label) {
  for (const idx of indices) {
    assert.equal(typeof idx === "number" && Number.isFinite(idx), true,
      `${label} break idx ${idx} should be a finite number`);
    assert.ok(idx >= 0, `${label} break idx ${idx} should be non-negative`);
  }
}

function assertReasonParity(wasmResult, jsResult, scenario = {}) {
  if (scenario.expectedWasmReasonRegex && scenario.expectedJsReasonRegex) {
    assert.match(
      wasmResult.reason ?? "",
      scenario.expectedWasmReasonRegex,
      `wasm reason should match ${scenario.expectedWasmReasonRegex}`,
    );
    assert.match(
      jsResult.reason ?? "",
      scenario.expectedJsReasonRegex,
      `js reason should match ${scenario.expectedJsReasonRegex}`,
    );
  } else {
    assert.equal(wasmResult.reason, jsResult.reason);
  }
}

function normalizeUiPlan(result, scenario = {}) {
  return stripRuntimeFields({
    status: result.status,
    reason: scenario.expectedWasmReasonRegex || scenario.expectedJsReasonRegex ? undefined : result.reason,
    start: endpointContract(result.start),
    endNode: result.endNode,
    tourStops: arrayFrom(result.tourStops).map(stopContract),
    modes: arrayFrom(result.modes).map(modeContract),
    implicitPasses: arrayFrom(result.implicitPasses).map(stopContract),
    scenicStops: arrayFrom(result.scenicStops).map(scenicStopContract),
    km: result.km,
    driveH: result.driveH,
    dwellH: result.dwellH,
    extrasH: result.extrasH,
    extrasParts: result.extrasParts,
    totalH: result.totalH,
    inRange: result.inRange,
    advanced: result.advanced,
    routeWarning: result.routeWarning,
    statusWarning: result.statusWarning,
    tripDate: result.tripDate,
    matched: result.matched,
    poolSize: result.poolSize,
    totalOpen: result.totalOpen,
    targetMode: result.targetMode,
    targetValue: result.targetValue,
    targetTol: result.targetTol,
    openOnly: result.openOnly,
    routeAlternatives: arrayFrom(result.routeAlternatives).map(routeAlternativeContract),
    corridor: corridorContract(result.corridor),
    lunchZones: arrayFrom(result.lunchZones).map(lunchZoneContract),
    breaks: scenario.breaksNormalized
      ? arrayFrom(result.breaks).map(normalizeBreak)
      : arrayFrom(result.breaks).map(breakContract),
    intent: intentContract(result.intent),
  });
}

function stripRuntimeFields(value, key = "") {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => stripRuntimeFields(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childValue === undefined || typeof childValue === "function") continue;
      if ((key === "diagnostics" && (childKey === "runtimeMs" || childKey === "iterations"))
          || childKey === "runtimeMs"
          || childKey === "iterations"
          || childKey === "adviceMs") continue;
      out[childKey] = stripRuntimeFields(childValue, childKey);
    }
    return out;
  }
  return value;
}

function endpointContract(point) {
  if (!point) return null;
  return pick(point, ["id", "name", "displayName", "kind", "isEndpoint", "lat", "lon"]);
}

function stopContract(stop) {
  if (!stop) return null;
  return {
    ...pick(stop, [
      "id", "name", "displayName", "kind", "isEndpoint", "isPoi", "lat", "lon",
      "elev", "quality", "qScenic", "qSummit", "qApproach", "scenicScore",
      "visitDwellSec", "dwellMin", "dwellH", "poiCategory",
    ]),
    poiThemes: sortedArray(stop.poiThemes),
    themes: sortedArray(stop.themes),
    viewpoints: arrayFrom(stop.viewpoints),
    baseA: endpointContract(stop.baseA),
    baseB: endpointContract(stop.baseB),
    summitParking: endpointContract(stop.summitParking),
  };
}

function modeContract(mode) {
  return pick(mode, ["passIdx", "enterSide", "exitSide", "mode"]);
}

function scenicStopContract(stop) {
  return pick(stop, ["passId", "side", "kind", "label", "name", "atTourVertexIdx"]);
}

// routeAlternatives are summary-only in the UI (button labels + scalar stats).
// Deeper fields (alternative tour stops, modes, breaks) are not consumed; if
// future UI uses them, extend this contract.
function routeAlternativeContract(alt) {
  return pick(alt, ["index", "label", "endNode", "km", "driveH", "totalH"]);
}

function corridorContract(corridor) {
  return {
    autoInclude: arrayFrom(corridor?.autoInclude).map(corridorItemContract),
    suggestions: arrayFrom(corridor?.suggestions).map(corridorItemContract),
    drawer: arrayFrom(corridor?.drawer).map(corridorItemContract),
  };
}

function corridorItemContract(item) {
  return {
    ...pick(item, ["id", "poiId", "nodeId", "name", "poiName", "score", "detourMin", "reason", "lat", "lon"]),
    themes: sortedArray(item?.themes),
    categories: sortedArray(item?.categories),
  };
}

function lunchZoneContract(zone) {
  return pick(zone, ["id", "label", "vibeTag", "centroid", "polygon", "tArriveMin", "tArriveMax"]);
}

function breakContract(item) {
  return pick(item, ["id", "atTourVertexIdx", "type", "label", "polygon"]);
}

function normalizeBreak(item) {
  // Open-route WASM/JS break vertex indices can differ by rounding; compare the
  // UI-visible break identity and location while deliberately omitting atTourVertexIdx.
  return pick(item, ["id", "type", "kind", "label", "lat", "lon"]);
}

function intentContract(intent) {
  return {
    topPersona: intent?.topPersona ?? "",
    ambiguous: Boolean(intent?.ambiguous),
    primary: arrayFrom(intent?.primary).map(intentPoiContract),
    serendipity: arrayFrom(intent?.serendipity).map(intentPoiContract),
    topPersonas: arrayFrom(intent?.topPersonas),
  };
}

function intentPoiContract(item) {
  return pick(item, ["id", "poiId", "name", "poiName", "score", "persona", "reason", "detourMin"]);
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}

function sortedArray(value) {
  return arrayFrom(value).slice().sort();
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

async function wasmShimPhase4Module() {
  return wasmShimFromSource((source) => source
    .replace("function phase4Outputs(", "export function phase4Outputs("));
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
  const uiTranslationUrl = pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "lib", "ui-translation.js")).href;
  let source = await fs.readFile(sourcePath, "utf8");
  source = source.replace('from "./lib/ui-translation.js";', `from "${uiTranslationUrl}";`);
  source = source.replace('const GRAPH_URL = new URL("../../data/leisure-graph.v1.json", import.meta.url).href;', 'const GRAPH_URL = "about:blank";');
  source = transform(source);
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

function minimalGraph() {
  return {
    nodes: new Map([["j-test", { id: "j-test", name: "Test", kind: "junction", lat: 46.8, lon: 8.2 }]]),
    nodesByKind: new Map(),
    passTriplets: new Map(),
    passIdByNodeId: new Map(),
    passSidesFor: () => null,
  };
}

async function runPlanWithMockTimezone(offsetMinutes) {
  const original = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = () => -offsetMinutes;
  try {
    const shim = await wasmShimWithMockWasm({ wasm: mockWasm({ lunchOffsetFromOptions: true }) });
    return await shim.leisurePlanAuto(uiOptions({ start: "j-start", stopsConfig: { ...defaultStopsConfig(), lunchBreak: "auto" } }));
  } finally {
    Date.prototype.getTimezoneOffset = original;
  }
}

function mockWasm({ lunchOffsetFromOptions = false } = {}) {
  return {
    leisure_core_version: () => "test",
    wasm_load_graph: () => 1,
    wasm_decompose_ears: () => ({ handle: 2 }),
    wasm_leisure_plan_auto: () => mockPlannedTour(),
    wasm_leisure_plan_open: () => mockPlannedTour(),
    wasm_leisure_plan_selected: () => mockPlannedTour(),
    wasm_suggest_corridor: () => ({ autoInclude: [], suggestions: [], drawer: [] }),
    wasm_find_lunch_area: (_graphHandle, _tour, options = {}) => ({
      zones: [{
        id: "lunch",
        label: "Lunch",
        tArriveMin: 720 + (lunchOffsetFromOptions ? Number(options.tzOffsetMinutes) || 0 : 0),
        tArriveMax: 780 + (lunchOffsetFromOptions ? Number(options.tzOffsetMinutes) || 0 : 0),
      }],
    }),
    wasm_suggest_breaks: () => ({ breaks: [] }),
    wasm_infer_intent: () => ({ topPersona: "Balanced", ambiguous: false }),
    wasm_surface_intent_pois: () => ({ primary: [], serendipity: [], diagnostics: {} }),
  };
}

function mockPlannedTour() {
  return {
    status: "optimal",
    primary: {
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

async function corridorExpandedLineModule() {
  const sourcePath = path.join(repoRoot, "assets", "js", "leisure", "corridor.js");
  const graphUrl = pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "graph.js")).href;
  let source = await fs.readFile(sourcePath, "utf8");
  source = source.replace('from "./graph.js";', `from "${graphUrl}";`);
  source = source.replace("function expandedLine(edge, from, to)", "export function expandedLine(edge, from, to)");
  source += `\n// test-import-nonce:${Date.now()}:${Math.random()}`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
