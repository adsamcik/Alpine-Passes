const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appPath = path.resolve(__dirname, "..", "assets", "js", "app.js");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadOverlayLayoutHooks() {
  const source = fs.readFileSync(appPath, "utf8");
  const snippets = [
    sourceBetween(source, "function hashStringToUint", "function packedGlyphForUiIcon"),
    sourceBetween(source, "function clusterPebbleLayoutSize", "function textureRefForPassSymbol"),
    sourceBetween(source, "const OVERLAY_TILE_SIZE =", "function overlayPassItems"),
    sourceBetween(source, "function clusterRadiusFor", "/* Re-cluster on settled map state"),
    sourceBetween(source, "function deconflictClusterOverlap", "function scheduleAlpineOverlayLayout"),
  ].join("\n\n");
  const sandbox = {};
  vm.runInNewContext(`
function clampNumber(value, min, max) { return Math.max(min, Math.min(max, value)); }
function textureRefForUiIcon(id, scale) { return { id, scale }; }
function packedGlyphForUiIcon() { return 1; }
function poiClusterPebbleModel() { return { count: 0, pebbles: [{ categoryIcon: "poi-generic", share: 1 }] }; }
function plannedBadgeNumber(item) { return item.planned ? 1 : null; }
${snippets}
globalThis.__overlayLayoutExports = {
  buildOverlayGroupsAtZoom,
  clusterCountLabelOffset,
  clusterRadiusFor,
  deconflictClusterOverlap,
  layoutClusterPebbles,
  lngLatToWorldPx,
  worldPxToLngLat,
};`, sandbox, { filename: appPath });
  return sandbox.__overlayLayoutExports;
}

const layout = loadOverlayLayoutHooks();

function itemAtWorld(id, x, y, zoom = 8, overrides = {}) {
  const point = layout.worldPxToLngLat(x, y, zoom);
  return { id, lon: point.lng, lat: point.lat, ...overrides };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function worldDistance(a, b, zoom = 8) {
  const aw = layout.lngLatToWorldPx(a.lng ?? a.lon, a.lat, zoom);
  const bw = layout.lngLatToWorldPx(b.lng ?? b.lon, b.lat, zoom);
  return Math.hypot(aw.x - bw.x, aw.y - bw.y);
}

test("overlay grouping merges compact neighbors across a grid-cell boundary", () => {
  const items = [itemAtWorld("left", 499.5, 500), itemAtWorld("right", 500.5, 500)];
  const groups = layout.buildOverlayGroupsAtZoom(items, "poi", 8);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, "cluster");
  assert.deepEqual(plain(groups[0].items.map(item => item.id)), ["left", "right"]);
});

test("overlay grouping is input-order independent and uses a world-pixel centroid", () => {
  const items = [
    itemAtWorld("c", 507, 492),
    itemAtWorld("a", 493, 498),
    itemAtWorld("b", 501, 510),
  ];
  const forward = layout.buildOverlayGroupsAtZoom(items, "pass", 8);
  const reverse = layout.buildOverlayGroupsAtZoom(items.slice().reverse(), "pass", 8);
  assert.deepEqual(plain(forward), plain(reverse));
  const center = layout.lngLatToWorldPx(forward[0].lng, forward[0].lat, 8);
  assert.ok(Math.abs(center.x - (507 + 493 + 501) / 3) < 1e-8);
  assert.ok(Math.abs(center.y - (492 + 498 + 510) / 3) < 1e-8);
});

test("compact merging does not create an unbounded chain cluster", () => {
  const items = [479, 481, 575, 671].map((x, index) => itemAtWorld(String(index), x, 500));
  const groups = layout.buildOverlayGroupsAtZoom(items, "pass", 8);
  assert.equal(groups.length, 2);
  assert.deepEqual(plain(groups.map(group => group.type).sort()), ["cluster", "marker"]);
  assert.equal(groups.find(group => group.type === "cluster").items.length, 3);
});

test("planned stops stay exact standalone markers", () => {
  const items = [
    itemAtWorld("planned", 500, 500, 8, { planned: true }),
    itemAtWorld("near-a", 501, 500),
    itemAtWorld("near-b", 502, 500),
  ];
  const groups = layout.buildOverlayGroupsAtZoom(items, "poi", 8);
  const planned = groups.find(group => group.id === "poi:planned");
  assert.equal(planned.type, "marker");
  assert.equal(planned.lng, items[0].lon);
  assert.equal(planned.lat, items[0].lat);
  assert.equal(groups.find(group => group.type === "cluster").items.length, 2);
});

test("pebble geometry is canonical and places the count away from the dominant glyph", () => {
  const model = {
    count: 18,
    pebbles: [
      { categoryIcon: "a", share: 0.55 },
      { categoryIcon: "b", share: 0.25 },
      { categoryIcon: "c", share: 0.15 },
      { categoryIcon: "d", share: 0.05 },
    ],
  };
  const alpha = layout.layoutClusterPebbles(model, "alpha");
  const beta = layout.layoutClusterPebbles(model, "beta");
  assert.deepEqual(plain(alpha), plain(beta));
  const badge = layout.clusterCountLabelOffset(alpha);
  const dominant = alpha.pebbles[0];
  const dominantCenter = {
    x: dominant.cx * alpha.width,
    y: dominant.cy * alpha.height,
  };
  assert.ok(Math.hypot(badge.offsetX - dominantCenter.x, badge.offsetY - dominantCenter.y) > 30);
  for (const pebble of alpha.pebbles) {
    assert.ok(pebble.cx - pebble.r >= -0.5 && pebble.cx + pebble.r <= 0.5);
    assert.ok(pebble.cy - pebble.r >= -0.5 && pebble.cy + pebble.r <= 0.5);
  }
});

test("deconfliction is input-order independent and separates coincident clusters", () => {
  const center = itemAtWorld("center", 500, 500);
  const makeGroups = () => [
    { id: "poi:cluster:a", kind: "poi", type: "cluster", lng: center.lon, lat: center.lat },
    { id: "pass:cluster:b", kind: "pass", type: "cluster", lng: center.lon, lat: center.lat },
  ];
  const forward = makeGroups();
  const reverse = makeGroups().reverse();
  layout.deconflictClusterOverlap(forward, 8);
  layout.deconflictClusterOverlap(reverse, 8);
  assert.ok(worldDistance(forward[0], forward[1]) >= 95.9);
  const forwardById = Object.fromEntries(forward.map(group => [group.id, [group.lng, group.lat]]));
  const reverseById = Object.fromEntries(reverse.map(group => [group.id, [group.lng, group.lat]]));
  assert.deepEqual(plain(forwardById), plain(reverseById));
});

test("deconfliction pins exact markers and caps cluster drift", () => {
  const center = itemAtWorld("center", 500, 500);
  const marker = { id: "poi:exact", kind: "poi", type: "marker", lng: center.lon, lat: center.lat };
  const cluster = { id: "pass:cluster:a", kind: "pass", type: "cluster", lng: center.lon, lat: center.lat };
  layout.deconflictClusterOverlap([marker, cluster], 8);
  assert.equal(marker.lng, center.lon);
  assert.equal(marker.lat, center.lat);
  const drift = worldDistance(cluster, center);
  assert.ok(drift <= 48.01);
});
