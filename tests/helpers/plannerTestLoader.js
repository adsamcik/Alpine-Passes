const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..", "..");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start) : source.length;
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadPlannerHooks({ passes = [] } = {}) {
  const appPath = path.join(repoRoot, "assets", "js", "app.js");
  const source = fs.readFileSync(appPath, "utf8");
  const snippets = [
    sourceBetween(source, "const STATE_LABEL =", "function statusSortRank"),
    sourceBetween(source, "const haversine = (a, b) => {", "/* ───────────────────── live Swiss pass status"),
    sourceBetween(source, "function formatOpeningDate", "function parseOpeningHint"),
    sourceBetween(source, "/* Stops & breaks — pass photo stops", "/* Curated theme set surfaced as chips"),
    sourceBetween(source, "/* Quality scoring knobs for bestTourGated.", "const PLANNER_MAX_CANDIDATES ="),
    sourceBetween(source, "function plannerPointsForPasses", "const ROUTE_PASS_CROSSING_KM ="),
    sourceBetween(source, "const ROUTE_PASS_CROSSING_KM =", "const VIEWPOINT_MODE_MIN_Q ="),
    sourceBetween(source, "const VIEWPOINT_MODE_MIN_Q =", "function routeAlternativeSummaries()"),
    sourceBetween(source, "/* Index in `polyline` of the point closest", "function renderScenicStopsBlock"),
  ].join("\n\n");

  const sandbox = {
    console,
    document: { getElementById: () => null },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    __PASSES: passes,
  };

  vm.runInNewContext(`const MONTHS_SHORT = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;
const PASSES = globalThis.__PASSES || [];
function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function todayLocalDate() {
  return startOfLocalDay(new Date());
}
function daysBetweenDates(fromDate, toDate) {
  return Math.round((startOfLocalDay(toDate) - startOfLocalDay(fromDate)) / DAY_MS);
}
function openingHintDateForTrip(hint, tripDate) {
  if (!hint?.date) return null;
  const year = hint.date.year || tripDate.getFullYear();
  const date = new Date(year, hint.date.month - 1, hint.date.day);
  return Number.isNaN(date.getTime()) ? null : startOfLocalDay(date);
}
function openingHintOpenFromDatePassed(hint, today = todayLocalDate()) {
  if (hint?.kind !== "open-from") return false;
  const hintDate = openingHintDateForTrip(hint, today);
  return !!hintDate && daysBetweenDates(hintDate, today) > 0;
}
${snippets}
globalThis.__plannerTestExports = {
  STOPS_DEFAULTS,
  applyRetracePenalties,
  bestExactSelectedTour,
  bestTourGated,
  closestPolylineIdx,
  computeExtras,
  coordsFromWaypoints,
  detectRetracedConnectorLegs,
  formatOpeningDate,
  haversine,
  listStatusLabel,
  nearestPolylineHit,
  orderedPolylineWaypointIndices,
  passTraversalHitForRange,
  planScenicStops,
  plannerPointsForPasses,
  rankedRouteEntriesFromOsrm,
  routeListFromOsrm,
  routePassCrossingsForPlan,
  statusDisplay,
  tourWaypointPlan,
};`, sandbox, { filename: appPath });

  return sandbox.__plannerTestExports;
}

function loadRawPasses() {
  const dataPath = path.join(repoRoot, "assets", "js", "passes-data.js");
  const source = fs.readFileSync(dataPath, "utf8");
  const match = source.match(/const ALPS_RAW = (.*);\s*$/s);
  if (!match) throw new Error("Could not parse ALPS_RAW from passes-data.js");
  return JSON.parse(match[1]);
}

module.exports = {
  loadPlannerHooks,
  loadRawPasses,
};
