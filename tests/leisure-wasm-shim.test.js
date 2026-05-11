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
  return wasmShimFromSource((source) => source
    .replace("async function loadWasm() {", "async function loadWasm() { throw new Error(\"mock wasm blocked\");"));
}

async function wasmShimFromSource(transform) {
  const sourcePath = path.join(repoRoot, "assets", "js", "leisure", "wasm-shim.js");
  const uiTranslationUrl = pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "lib", "ui-translation.js")).href;
  let source = await fs.readFile(sourcePath, "utf8");
  source = source.replace('from "./lib/ui-translation.js";', `from "${uiTranslationUrl}";`);
  source = source.replace('const GRAPH_URL = new URL("../../data/leisure-graph.v1.json", import.meta.url).href;', 'const GRAPH_URL = "about:blank";');
  source = transform(source);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
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
