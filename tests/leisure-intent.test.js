const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const intentModule = import(pathToFileURL(path.join(repoRoot, "assets", "js", "leisure", "intent.js")).href);
const PERSONAS = ["Photographer", "ThrillRider", "Family", "Gourmet", "CultureSeeker", "NatureHiker", "Speedrunner", "SlowTourer"];

test("intent module exposes the requested public API only", async () => {
  const module = await intentModule;

  assert.deepEqual(Object.keys(module).sort(), ["inferIntent", "surfaceIntentPois", "updateIntent"]);
});

test("empty state infers uniform high-entropy intent without overrides", async () => {
  const { inferIntent } = await intentModule;
  const intent = inferIntent({});

  for (const persona of PERSONAS) assert.ok(Math.abs(intent[persona] - 1 / 8) < 1e-12, `${persona} was ${intent[persona]}`);
  assert.ok(Math.abs(intent.entropy - Math.log(8)) < 1e-12);
  assert.equal(intent.ambiguous, true);
});

test("pinning Stelvio and Maloja leans ThrillRider ahead of Photographer and others", async () => {
  const { inferIntent } = await intentModule;
  const intent = inferIntent({ pinnedStops: [stelvioPass(), malojaPass()] });

  assert.ok(intent.ThrillRider > intent.Photographer, `${intent.ThrillRider} <= ${intent.Photographer}`);
  for (const persona of PERSONAS.filter((item) => !["ThrillRider", "Photographer"].includes(item))) {
    assert.ok(intent.Photographer > intent[persona], `${persona} beat Photographer`);
  }
});

test("generic drivers-road pass leans ThrillRider without famous-pass names", async () => {
  const { inferIntent } = await intentModule;
  const intent = inferIntent({
    pinnedStops: [
      pass("anonymous-high-road", "Anonymous High Road", ["high-alpine", "panoramic-view", "drivers-road", "viewpoints"]),
    ],
  });

  assert.equal(intent.topPersona, "ThrillRider");
  assert.ok(intent.ThrillRider > intent.Photographer, `${intent.ThrillRider} <= ${intent.Photographer}`);
});

test("food-drink theme chip boosts Gourmet", async () => {
  const { inferIntent } = await intentModule;
  const baseline = inferIntent({});
  const intent = inferIntent({ themeChips: ["food-drink"] });

  assert.equal(intent.topPersona, "Gourmet");
  assert.ok(intent.Gourmet > baseline.Gourmet);
});

test("withChild floor lifts Family to at least 0.3", async () => {
  const { inferIntent } = await intentModule;
  const intent = inferIntent({ withChild: true });

  assert.ok(intent.Family >= 0.3);
});

test("shoestring budget damps a foodie signal and redistributes probability", async () => {
  const { inferIntent } = await intentModule;
  const pinnedStops = [poi("bistro", ["food-drink", "year-round"], ["village"], 9)];
  const normal = inferIntent({ pinnedStops, budgetTier: "normal" });
  const shoestring = inferIntent({ pinnedStops, budgetTier: "shoestring" });

  assert.ok(shoestring.Gourmet < normal.Gourmet);
  assert.ok(PERSONAS.some((persona) => persona !== "Gourmet" && shoestring[persona] > normal[persona]));
  assert.ok(Math.abs(sumPersonas(shoestring) - 1) < 1e-12);
});

test("conflicting pass and museum pins stay ambiguous and report top personas", async () => {
  const { inferIntent, surfaceIntentPois } = await intentModule;
  const intent = inferIntent({ pinnedStops: [stelvioPass(), museumPin()] });
  const surface = surfaceIntentPois(graphWithPois(samplePois()), null, intent);

  assert.ok(intent.entropy > 1.5, `entropy ${intent.entropy}`);
  assert.equal(intent.ambiguous, true);
  assert.ok(surface.diagnostics.topPersonas.length >= 2);
  assert.ok(surface.diagnostics.topPersonas.includes("ThrillRider"));
});

test("pin feedback for panoramic-view increases Photographer probability", async () => {
  const { inferIntent, updateIntent } = await intentModule;
  const baseline = inferIntent({});
  const updated = updateIntent(baseline, { kind: "pin", target: { themes: ["panoramic-view"] } });

  assert.ok(updated.Photographer > baseline.Photographer);
});

test("dismiss feedback for museum decreases CultureSeeker probability and records tag", async () => {
  const { inferIntent, updateIntent } = await intentModule;
  const baseline = inferIntent({});
  const updated = updateIntent(baseline, { kind: "dismiss", target: { themes: ["museum"] } });

  assert.ok(updated.CultureSeeker < baseline.CultureSeeker);
  assert.equal(updated.pastDismissedTags.museum, 1);
});

test("photographer-leaning surfacing puts a panoramic or viewpoint POI first", async () => {
  const { inferIntent, surfaceIntentPois } = await intentModule;
  const intent = inferIntent({ themeChips: ["panoramic-view"] });
  const surface = surfaceIntentPois(graphWithPois(samplePois()), null, intent, { topK: 5, serendipityFraction: 0 });
  const firstTags = new Set([...surface.primary[0].themes, ...surface.primary[0].categories]);

  assert.ok(firstTags.has("panoramic-view") || firstTags.has("viewpoint") || firstTags.has("viewpoints"));
});

test("serendipityFraction 0.5 returns exactly six off-intent items for topK 12", async () => {
  const { inferIntent, surfaceIntentPois } = await intentModule;
  const intent = inferIntent({ themeChips: ["panoramic-view"] });
  const surface = surfaceIntentPois(graphWithPois(manyPois(20)), null, intent, { topK: 12, serendipityFraction: 0.5 });

  assert.equal(surface.primary.length, 6);
  assert.equal(surface.serendipity.length, 6);
  assert.ok(surface.serendipity.every((item) => item.offIntent === true));
});

test("dismissed museum tags decay museum POI ranking", async () => {
  const { inferIntent, surfaceIntentPois, updateIntent } = await intentModule;
  const pois = [
    poi("museum-poi", ["historic", "architecture"], ["museum-cultural"], 10),
    poi("castle-poi", ["historic", "architecture", "photogenic"], ["castle-fortress"], 6),
    poi("view-poi", ["panoramic-view", "photogenic"], ["viewpoint"], 6),
  ];
  const baselineIntent = inferIntent({ themeChips: ["museum", "museum-cultural", "historic", "architecture"] });
  let dismissedIntent = baselineIntent;
  for (let i = 0; i < 5; i += 1) dismissedIntent = updateIntent(dismissedIntent, { kind: "dismiss", target: { themes: ["museum"] } });

  const baseline = surfaceIntentPois(graphWithPois(pois), null, baselineIntent, { topK: 3, serendipityFraction: 0 });
  const dismissed = surfaceIntentPois(graphWithPois(pois), null, dismissedIntent, { topK: 3, serendipityFraction: 0 });

  assert.ok(rankOf(dismissed, "museum-poi") > rankOf(baseline, "museum-poi"));
});

test("same input state and candidates produce deterministic SurfaceResult", async () => {
  const { inferIntent, surfaceIntentPois } = await intentModule;
  const intent = inferIntent({ pinnedStops: [stelvioPass(), museumPin()], themeChips: ["food-drink"] });
  const graph = graphWithPois(manyPois(18));

  assert.deepEqual(
    surfaceIntentPois(graph, null, intent, { topK: 12 }),
    surfaceIntentPois(graph, null, intent, { topK: 12 }),
  );
});

test("surfaceIntentPois handles 500 candidates under 30ms", async () => {
  const { inferIntent, surfaceIntentPois } = await intentModule;
  const intent = inferIntent({ themeChips: ["panoramic-view", "food-drink"] });
  const corridorPois = manyPois(500);
  const graph = graphWithPois([]);
  surfaceIntentPois(graph, null, intent, { corridorPois, topK: 12 });

  let surface;
  let elapsed = Infinity;
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    surface = surfaceIntentPois(graph, null, intent, { corridorPois, topK: 12 });
    elapsed = Math.min(elapsed, performance.now() - started);
  }

  assert.equal(surface.primary.length + surface.serendipity.length, 12);
  assert.ok(elapsed < 30, `expected <30ms, got ${elapsed.toFixed(3)}ms`);
});

function stelvioPass() {
  return pass("passo-dello-stelvio-stilfser-joch", "Passo dello Stelvio", [
    "iconic", "high-alpine", "panoramic-view", "glacier", "alpine-lake", "drivers-road", "viewpoints",
  ]);
}

function malojaPass() {
  return pass("malojapass", "Maloja Pass", [
    "high-alpine", "panoramic-view", "alpine-lake", "drivers-road", "viewpoints",
  ]);
}

function museumPin() {
  return poi("mona-lisa-style-museum", ["museum", "historic", "architecture", "year-round"], ["museum-cultural"], 10);
}

function pass(id, name, themes) {
  return { id, kind: "pass", name, themes, categories: [] };
}

function poi(id, themes, categories, score = 8) {
  return { id, kind: "poi", name: id, score, themes, categories };
}

function samplePois() {
  return [
    poi("panorama", ["panoramic-view", "photogenic"], ["viewpoint"], 9),
    poi("museum", ["museum", "historic", "architecture"], ["museum-cultural"], 10),
    poi("castle", ["historic", "architecture", "photogenic"], ["castle-fortress"], 9),
    poi("food", ["food-drink", "year-round"], ["village"], 9),
    poi("hike", ["hike-required", "panoramic-view", "nature-reserve"], ["national-park"], 8),
    poi("rail", ["scenic-railway", "panoramic-view"], ["special-experience"], 8),
  ];
}

function manyPois(count) {
  const profiles = [
    [["panoramic-view", "photogenic"], ["viewpoint"], 9],
    [["museum", "historic", "architecture"], ["museum-cultural"], 10],
    [["food-drink", "year-round"], ["village"], 8.5],
    [["drivers-road", "high-alpine"], ["special-experience"], 8],
    [["hike-required", "nature-reserve"], ["national-park"], 9.5],
    [["family-friendly", "playground"], ["alpine-lake"], 7.5],
    [["historic", "architecture"], ["castle-fortress"], 9],
    [["scenic-railway", "slow-travel"], ["special-experience"], 8],
  ];
  return Array.from({ length: count }, (_, index) => {
    const [themes, categories, score] = profiles[index % profiles.length];
    return poi(`poi-${String(index).padStart(3, "0")}`, themes, categories, score);
  });
}

function graphWithPois(pois) {
  return { nodesByKind: new Map([["poi", pois]]) };
}

function rankOf(surface, poiId) {
  return surface.primary.findIndex((item) => item.poiId === poiId);
}

function sumPersonas(intent) {
  return PERSONAS.reduce((sum, persona) => sum + intent[persona], 0);
}
