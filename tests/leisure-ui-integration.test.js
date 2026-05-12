const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const apiModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "index.js")).href);

test("leisurePlanAuto surfaces Phase 4 UI fields on a real tour", { timeout: 10_000 }, async () => {
  const { leisurePlanAuto } = await apiModule;
  const result = await leisurePlanAuto({
    start: "j-andermatt",
    targetMode: "time",
    targetValue: 7,
    targetTol: 0.2,
    tripDate: new Date(2026, 5, 15),
    startTime: new Date(2026, 5, 15, 8, 0, 0),
    themes: ["panoramic-view", "food-drink"],
    personas: ["photo", "family"],
    openOnly: false,
    kAlternatives: 1,
    timeBudgetMs: 100,
    osrmRoute: straightLineOsrmRoute,
  });

  assert.ok(["ok", "degraded"].includes(result.status), `unexpected status ${result.status}`);
  assertPhase4Shape(result);
  assert.ok(result._routeAlternatives?.[0]?.draw?.meta?.leisureOverlays, "draw meta should carry leisure overlays");
});

test("showPlanResult renders leisure sections without throwing", () => {
  const source = fs.readFileSync(path.join(repoRoot, "assets", "js", "app.js"), "utf8");
  const snippet = sourceBetween(source, "function renderLeisureIntentBlock", "function clearLeisureOverlays()");
  const sandbox = showPlanSandbox();
  sandbox.__result = {
    start: { id: "j-bellinzona", name: "Bellinzona", displayName: "Bellinzona" },
    endNode: "j-chur",
    tourStops: [{ id: "grimselpass", name: "Grimsel Pass", quality: 0.9 }],
    modes: [{ mode: "traverse" }],
    implicitPasses: [],
    scenicStops: [],
    km: 180,
    driveH: 4,
    dwellH: 0.5,
    extrasH: 0.25,
    extrasParts: { restH: 0.25, restCount: 1 },
    totalH: 4.75,
    inRange: true,
    advanced: false,
    routeWarning: "",
    statusWarning: "",
    tripDate: null,
    matched: 1,
    poolSize: 3,
    totalOpen: 3,
    targetMode: "time",
    targetValue: 7,
    corridor: { autoInclude: [], suggestions: [{ poiId: "poi1", poiName: "Lake view", detourMin: 8, reason: "close", lat: 46.1, lon: 8.1 }], drawer: [] },
    lunchZones: [{ id: "lunch-1", vibeTag: "valley", centroid: [46.2, 8.2], polygon: [[46.2, 8.2], [46.21, 8.2], [46.2, 8.21]], tArriveMin: new Date(2026, 5, 15, 12), tArriveMax: new Date(2026, 5, 15, 13) }],
    breaks: [{ id: "break-1", type: "coffee", tStart: new Date(2026, 5, 15, 10), reason: "load", lat: 46.3, lon: 8.3 }],
    intent: { topPersona: "Photographer", ambiguous: true, primary: [], serendipity: [], topPersonas: ["Photographer", "Family"] },
  };

  vm.runInNewContext(`${snippet}\nshowPlanResult(__result);`, sandbox, { filename: "assets/js/app.js" });

  assert.match(sandbox.planResult.innerHTML, /Bellinzona → Chur · 1 stop/);
  assert.match(sandbox.planResult.innerHTML, /Optional sights along the way/);
  assert.match(sandbox.planResult.innerHTML, /Lunch zones/);
  assert.match(sandbox.planResult.innerHTML, /Suggested breaks/);
  assert.match(sandbox.planResult.innerHTML, /Day type: Photographer/);
});


test("showWasmUnavailableBanner renders accessible dismiss and help controls", () => {
  const source = fs.readFileSync(path.join(repoRoot, "assets", "js", "app.js"), "utf8");
  const snippet = sourceBetween(source, "function showWasmUnavailableBanner", "async function runLeisurePlanner");
  const sandbox = showPlanSandbox();
  sandbox.setPlannedRouteAlternatives = () => {};
  sandbox.clearPlannedTour = () => {};

  vm.runInNewContext(`${snippet}
showWasmUnavailableBanner("mock detail");`, sandbox, { filename: "assets/js/app.js" });

  assert.match(sandbox.planResult.innerHTML, /aria-label="Dismiss WebAssembly required banner"/);
  assert.match(sandbox.planResult.innerHTML, /data-action="dismiss-wasm-banner"/);
  assert.match(sandbox.planResult.innerHTML, /href="https:\/\/webassembly\.org\/"/);
  assert.doesNotMatch(sandbox.planResult.innerHTML, /href="#"/);
});

test("showWasmUnavailableBanner dismiss button removes the banner from DOM", () => {
  const source = fs.readFileSync(path.join(repoRoot, "assets", "js", "app.js"), "utf8");
  const snippet = sourceBetween(source, "function showWasmUnavailableBanner", "async function runLeisurePlanner");
  const sandbox = showPlanSandbox();
  sandbox.setPlannedRouteAlternatives = () => {};
  sandbox.clearPlannedTour = () => {};

  vm.runInNewContext(`${snippet}
showWasmUnavailableBanner("mock detail");`, sandbox, { filename: "assets/js/app.js" });

  assert.match(sandbox.planResult.innerHTML, /aria-label="Dismiss WebAssembly required banner"/);

  const dismissBtn = sandbox.planResult.querySelector('[data-action="dismiss-wasm-banner"]');
  dismissBtn.click();

  assert.doesNotMatch(
    sandbox.planResult.innerHTML,
    /Dismiss WebAssembly required banner/,
    "banner should be removed after dismiss click",
  );
});

test("leisure flag false path remains gated before legacy planner", async () => {
  const [{ isLeisurePlannerEnabled }, source] = await Promise.all([
    apiModule,
    fs.promises.readFile(path.join(repoRoot, "assets", "js", "app.js"), "utf8"),
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  try {
    assert.equal(isLeisurePlannerEnabled(), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }

  const body = source.slice(source.indexOf("async function planTour()"));
  assert.match(body, /if\s*\(\s*isLeisurePlannerEnabled\(\)\s*\)/);
  assert.ok(body.indexOf("bestTourGated(") > body.indexOf("if (isLeisurePlannerEnabled())"));
});

function assertPhase4Shape(result) {
  assert.ok(result.corridor && typeof result.corridor === "object", "corridor object");
  assert.ok(Array.isArray(result.corridor.autoInclude), "corridor.autoInclude");
  assert.ok(Array.isArray(result.corridor.suggestions), "corridor.suggestions");
  assert.ok(Array.isArray(result.corridor.drawer), "corridor.drawer");
  assert.ok(Array.isArray(result.lunchZones), "lunchZones");
  assert.ok(result.lunchZones.length <= 2, "lunchZones capped");
  assert.ok(Array.isArray(result.breaks), "breaks");
  assert.ok(result.intent && typeof result.intent === "object", "intent object");
  assert.equal(typeof result.intent.topPersona, "string");
  assert.equal(typeof result.intent.ambiguous, "boolean");
  assert.ok(Array.isArray(result.intent.primary), "intent.primary");
  assert.ok(Array.isArray(result.intent.serendipity), "intent.serendipity");
}

function showPlanSandbox() {
  const classList = { add() {}, remove() {} };
  const planResult = {
    classList,
    children: [],
    innerHTML: "",
    removeAttribute() {},
    setAttribute() {},
    contains(node) { return node?.owner === this; },
    querySelector(selector) {
      if (selector !== '[data-action="dismiss-wasm-banner"]' || !this.innerHTML.includes('data-action="dismiss-wasm-banner"')) return null;
      return {
        owner: this,
        click: () => {
          this.innerHTML = this.innerHTML.replace(/\s*<div id="leisureWasmUnavailableBanner"[\s\S]*?<\/div>/, "");
        },
      };
    },
  };
  return {
    planResult,
    PRESET_STARTS: { chur: { name: "Chur" } },
    POI_BY_ID: new Map(),
    PASS_BY_ID: new Map(),
    requestAnimationFrame: (fn) => fn(),
    document: { querySelector: () => null },
    escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    fmtDuration: (hours) => `${Number(hours).toFixed(1)}h`,
    poiCategoryIcon: () => "",
    qualityStarsCompact: () => "",
    fmtExtrasSummary: () => "15 min rest",
    renderTourStatChips: () => "",
    renderScenicStopsBlock: () => "",
    renderRouteAlternativesBlock: () => "",
    renderPlanResultActions: () => "",
    scrollPlanResultIntoView: () => {},
    cleanStartName: (name) => String(name || ""),
    todayLocalDate: () => new Date(2026, 5, 15),
    daysBetweenDates: () => 0,
    formatTripDate: () => "15 Jun 2026",
  };
}

async function straightLineOsrmRoute(coords) {
  const points = String(coords).split(";").map((token) => {
    const [lon, lat] = token.split(",").map(Number);
    return { lat, lon };
  }).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  const geom = points.map((point) => [point.lon, point.lat]);
  return { geom, distanceKm: points.length * 12, durationH: points.length * 0.2 };
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

class MemoryStorage {
  getItem() { return null; }
}
