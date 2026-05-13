const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const wasmShimModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "wasm-shim.js")).href);

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

