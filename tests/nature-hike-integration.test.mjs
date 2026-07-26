import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, appSource, detailSource, exportSource, detailStyles] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../assets/js/nature/app.mjs", import.meta.url), "utf8"),
  readFile(new URL("../assets/js/nature/hike-detail.mjs", import.meta.url), "utf8"),
  readFile(new URL("../assets/js/nature/route-export.mjs", import.meta.url), "utf8"),
  readFile(new URL("../assets/css/nature-hike-detail.css", import.meta.url), "utf8"),
]);

test("the document loads isolated hike-detail styles after the legacy site stylesheet", () => {
  const legacy = html.indexOf('href="assets/css/site.css?v=itinera-1"');
  const hike = html.indexOf('href="assets/css/nature-hike-detail.css?v=1"');
  assert.ok(legacy >= 0, "legacy site stylesheet must remain present");
  assert.ok(hike > legacy, "isolated hike-detail styles must load after legacy styles");
});

test("nature app delegates route details and downloads to the isolated modules", () => {
  assert.match(appSource, /from "\.\/hike-detail\.mjs"/);
  assert.match(appSource, /from "\.\/route-export\.mjs"/);
  assert.match(appSource, /renderHikeDetail\(/);
  assert.match(appSource, /serializeTrailRouteGeoJson/);
  assert.match(appSource, /serializeTrailRouteGpx/);
  assert.match(appSource, /downloadRouteFile\(/);
  assert.doesNotMatch(appSource, /function appendRouteDetails\(/);
  assert.doesNotMatch(appSource, /function downloadGpx\(/);
  assert.doesNotMatch(appSource, /<gpx version=/);
});

test("route enrichment resolves every safety and route-character reference used by the detail view", () => {
  for (const property of [
    "trailSegments",
    "hazards",
    "conditions",
    "restrictions",
    "permitRequirements",
  ]) {
    assert.match(
      appSource,
      new RegExp(`${property}: \\[\\.\\.\\.`),
      `${property} must be resolved into attached route data`,
    );
  }
  for (const reference of [
    "segmentIds",
    "hazardRefs",
    "conditionRefs",
    "restrictionRefs",
    "permitRequirementIds",
  ]) {
    assert.match(appSource, new RegExp(reference));
  }
});

test("hike detail keeps its five information sections and both export formats explicit", () => {
  for (const title of [
    "At a glance",
    "Route character",
    "Getting there",
    "Safety & conditions",
    "Data confidence",
  ]) {
    assert.match(detailSource, new RegExp(title));
  }
  assert.match(detailSource, /Download GPX/);
  assert.match(detailSource, /Download GeoJSON/);
  assert.match(detailSource, /aria-disabled/);
  assert.match(detailSource, /aria-live/);
  assert.match(exportSource, /overview_geometry_only/);
  assert.match(exportSource, /safetyDisclaimer/);
  assert.match(exportSource, /provenance/);
  assert.match(detailStyles, /min-height:\s*44px/);
  assert.match(detailStyles, /@media \(forced-colors: active\)/);
});
