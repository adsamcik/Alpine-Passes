const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function loadArray(relPath, constName) {
  const sandbox = {};
  vm.runInNewContext(`${read(relPath)}\nglobalThis.result = ${constName};`, sandbox, {
    filename: relPath,
  });
  return sandbox.result;
}

const ukPois = loadArray("assets/js/uk-pois.js", "UK_POIS");
const irishPois = loadArray("assets/js/irish-pois.js", "IRISH_POIS");
const passes = loadArray("assets/js/uk-ireland-passes.js", "UK_IRELAND_PASSES");
const drives = loadArray("assets/js/uk-ireland-scenic-drives.js", "UK_IRELAND_SCENIC_DRIVES");

const existingCategories = new Set([
  "mountain-summit", "alpine-lake", "waterfall-gorge", "glacier", "old-town",
  "castle-fortress", "monastery-church", "scenic-railway", "funicular",
  "bridge-engineering", "village", "national-park", "spa-wellness",
  "viewpoint-panorama", "museum-cultural", "geology-cave", "wine-region",
  "special-experience", "shinto-shrine", "buddhist-temple", "traditional-garden",
  "onsen-town", "post-town", "volcano", "observation-tower", "historic-district",
  "food-market", "pop-culture-site", "art-island",
]);

function validateLatLon(lat, lon, label) {
  assert.ok(Number.isFinite(lat) && lat >= -90 && lat <= 90, `${label} has invalid latitude`);
  assert.ok(Number.isFinite(lon) && lon >= -180 && lon <= 180, `${label} has invalid longitude`);
}

function nationCount(items, prefix) {
  return items.filter((item) => item.region.startsWith(prefix)).length;
}

test("UK and Irish POI datasets cover every home nation with routable sights", () => {
  assert.ok(ukPois.length >= 80, `expected at least 80 UK POIs, found ${ukPois.length}`);
  assert.ok(irishPois.length >= 40, `expected at least 40 Irish POIs, found ${irishPois.length}`);

  assert.ok(nationCount(ukPois, "Scotland /") >= 20);
  assert.ok(nationCount(ukPois, "England /") >= 20);
  assert.ok(nationCount(ukPois, "Wales /") >= 15);
  assert.ok(nationCount(ukPois, "Northern Ireland /") >= 12);
  assert.ok(nationCount(irishPois, "Ireland /") >= 40);

  for (const prefix of ["Scotland /", "England /", "Wales /", "Northern Ireland /", "Ireland /"]) {
    const source = prefix === "Ireland /" ? irishPois : ukPois;
    const routable = source.filter((poi) => poi.region.startsWith(prefix) && poi.access.includes("car"));
    assert.ok(routable.length >= 8, `${prefix} should have at least eight car-routable POIs`);
  }
});

test("new POIs conform to the shared schema and preserve local place vocabulary", () => {
  const all = [...ukPois, ...irishPois];
  const names = new Set();
  for (const poi of all) {
    assert.equal(typeof poi.n, "string");
    assert.ok(poi.n.length > 2);
    assert.ok(!names.has(poi.n), `duplicate POI name: ${poi.n}`);
    names.add(poi.n);
    validateLatLon(poi.la, poi.lo, poi.n);
    assert.ok(["GB", "IE"].includes(poi.co), `${poi.n} has unexpected country ${poi.co}`);
    assert.ok(existingCategories.has(poi.cat), `${poi.n} uses unknown category ${poi.cat}`);
    assert.ok(Array.isArray(poi.themes) && poi.themes.length >= 2, `${poi.n} needs themes`);
    assert.ok(Array.isArray(poi.access) && poi.access.length >= 1, `${poi.n} needs access modes`);
    assert.ok(Array.isArray(poi.season) && poi.season.length >= 1, `${poi.n} needs seasons`);
    assert.ok(Number.isFinite(poi.dur) && poi.dur > 0, `${poi.n} needs a positive dwell time`);
    assert.ok(Number.isFinite(poi.sc) && poi.sc >= 1 && poi.sc <= 10, `${poi.n} has invalid score`);
    assert.ok(poi.td && poi.rs, `${poi.n} needs description and rationale`);
  }

  const themes = new Set(all.flatMap((poi) => poi.themes));
  for (const theme of [
    "prehistoric", "archaeology", "coastal", "sea-cliff", "island", "whisky",
    "gaeltacht", "industrial-heritage", "dark-sky", "literary", "film-location",
  ]) {
    assert.ok(themes.has(theme), `missing characteristic theme ${theme}`);
  }

  for (const landmark of [
    "Skara Brae", "Stonehenge", "Eryri National Park", "Giant's Causeway",
    "Brú na Bóinne", "Skellig Michael", "The Burren National Park", "Slieve League Cliffs",
  ]) {
    assert.ok(names.has(landmark), `missing landmark ${landmark}`);
  }
});

test("UK and Ireland pass dataset spans all mountain-road regions", () => {
  assert.ok(passes.length >= 30, `expected at least 30 passes, found ${passes.length}`);
  const names = new Set();
  for (const pass of passes) {
    assert.ok(!names.has(pass.n), `duplicate pass name: ${pass.n}`);
    names.add(pass.n);
    validateLatLon(pass.la, pass.lo, pass.n);
    assert.ok(["GB", "IE"].includes(pass.co));
    assert.ok(pass.region && pass.region.includes(" / "));
    assert.ok(Array.isArray(pass.bA) && pass.bA.length === 2, `${pass.n} missing base A`);
    assert.ok(Array.isArray(pass.bB) && pass.bB.length === 2, `${pass.n} missing base B`);
    validateLatLon(pass.bA[0], pass.bA[1], `${pass.n} base A`);
    validateLatLon(pass.bB[0], pass.bB[1], `${pass.n} base B`);
    assert.ok(Number.isFinite(pass.e) && pass.e > 0);
    assert.ok(Number.isFinite(pass.sc) && pass.sc >= 0 && pass.sc <= 1);
  }

  for (const prefix of ["Scotland /", "England /", "Wales /", "Northern Ireland /", "Ireland /"]) {
    assert.ok(nationCount(passes, prefix) >= 2, `${prefix} needs pass coverage`);
  }
  for (const landmark of ["Bealach na Bà / Pass of the Cattle", "Hardknott Pass", "Llanberis Pass / Pen-y-Pass", "Conor Pass", "Healy Pass"]) {
    assert.ok(names.has(landmark), `missing pass ${landmark}`);
  }
});

test("scenic-drive overlays include national and regional touring routes", () => {
  assert.ok(drives.length >= 20, `expected at least 20 drives, found ${drives.length}`);
  assert.ok(drives.filter((drive) => drive.co === "GB").length >= 12);
  assert.ok(drives.filter((drive) => drive.co === "IE").length >= 5);

  for (const drive of drives) {
    assert.equal(drive.kind, "scenic-drive");
    assert.ok(drive.region && drive.region.includes(" / "));
    assert.ok(Number.isFinite(drive.len_km) && drive.len_km > 0);
    assert.ok(Number.isFinite(drive.drive_min) && drive.drive_min > 0);
    assert.ok(Array.isArray(drive.waypoints) && drive.waypoints.length >= 4, `${drive.n} needs route anchors`);
    for (const waypoint of drive.waypoints) validateLatLon(waypoint.la, waypoint.lo, `${drive.n}: ${waypoint.n}`);
  }

  const names = new Set(drives.map((drive) => drive.n));
  for (const landmark of ["North Coast 500", "Causeway Coastal Route", "Ring of Kerry", "Slea Head Drive", "North Wales Way & Eryri loop"]) {
    assert.ok(names.has(landmark), `missing scenic drive ${landmark}`);
  }
});

test("new datasets are registered in the bundle, app, enrichment tools, and planner starts", () => {
  const bundle = read("tools/build-bundle.mjs");
  const app = read("assets/js/app.js");
  const prices = read("tools/fetch_poi_prices.py");
  const html = read("index.html");

  for (const file of ["uk-ireland-passes.js", "uk-ireland-scenic-drives.js", "uk-pois.js", "irish-pois.js"]) {
    assert.ok(bundle.includes(file), `${file} missing from bundle sources`);
  }
  for (const globalName of ["UK_IRELAND_PASSES", "UK_IRELAND_SCENIC_DRIVES", "UK_POIS", "IRISH_POIS"]) {
    assert.ok(app.includes(globalName), `${globalName} missing from app aggregation`);
  }
  assert.ok(app.includes("function leisurePlannerSupportsRequest()"));
  assert.ok(app.includes("isLeisurePlannerEnabled() && leisurePlannerSupportsRequest()"));
  for (const sourceName of ["UK_POIS", "IRISH_POIS"]) {
    assert.ok(prices.includes(sourceName), `${sourceName} missing from price enrichment registry`);
  }
  for (const start of ["edinburgh", "inverness", "llanberis", "belfast", "dublin", "galway", "killarney", "donegal"]) {
    assert.ok(html.includes(`value="${start}"`), `${start} missing from planner start options`);
    assert.ok(new RegExp(`\\b${start}\\s*:`).test(app), `${start} missing from PRESET_STARTS`);
  }
});
