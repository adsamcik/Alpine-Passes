/* ───────────────────────── Alpine geographic filter ─────────────────────────
   Approximates the Alpine Convention extent. Tuned to exclude Apennines (IT),
   Jura (FR/CH), Vosges and Black Forest (FR/DE), Swabian and Bavarian Forest
   (DE), Mühlviertel (AT), and the Velebit/Karst (HR) — ranges that frequently
   leak into Alpine OSM `mountain_pass=yes` queries. Vertices are [lon, lat]
   to match GeoJSON convention. */
const ALPS_POLYGON = [
  [5.00, 44.05], [5.05, 44.95], [5.55, 45.50], [5.85, 46.00],
  [6.20, 46.30], [6.85, 46.85], [7.55, 47.05], [8.50, 47.40],
  [9.55, 47.55], [10.55, 47.65], [11.50, 47.85], [12.40, 47.85],
  [13.50, 48.00], [14.80, 48.20], [16.10, 48.15], [16.55, 47.65],
  [16.55, 46.70], [15.70, 46.40], [14.50, 45.55], [13.65, 45.75],
  [12.55, 45.85], [11.45, 45.65], [10.50, 45.50], [9.50, 45.40],
  [8.65, 45.05], [8.40, 44.40], [8.05, 44.05], [7.55, 43.70],
  [6.65, 43.65],
];
function pointInAlps(lon, lat) {
  let inside = false;
  const poly = ALPS_POLYGON;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > lat) !== (yj > lat) &&
        lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/* Map common Swiss alpen-paesse.ch slugs from a pass name. */
const SWISS_SLUG_RULES = [
  [/\balbulapass\b|\balbula\s*pass\b/i,                              "albulapass"],
  [/\bberninapass\b|passo\s+del\s+bernina|\bbernina\s*pass\b/i,      "berninapass"],
  [/\bbr(ü|ue)nigpass\b|br(ü|ue)nig\s*pass\b/i,                      "bruenigpass"],
  [/\bfl(ü|ue)elapass\b|fl(ü|ue)ela\s*pass\b/i,                      "flueelapass"],
  [/\bfurkapass\b|\bcol\s+de\s+la\s+furka\b/i,                       "furkapass"],
  [/\bforcola\s+di\s+livigno\b|passo\s+forcola\s+di\s+livigno/i,     "forcola-di-livigno"],
  [/\bglaubenbergpass\b/i,                                           "glaubenbergpass"],
  [/\bglaubenbielen|glaubenb(ü|ue)elen|panoramastrasse/i,            "glaubenbielenpass"],
  [/\bgotthardpass\b|passo\s+del\s+san\s+gottardo|gotthard\s*pass/i, "gotthardpass"],
  [/\bgrimselpass\b|col\s+du\s+grimsel/i,                            "grimselpass"],
  [/grand[- ]?saint[- ]?bernard|grosser\s+sankt\s+bernhard|gran\s+san\s+bernardo/i,
                                                                     "grosser-sankt-bernhard"],
  [/\bgrosse\s+scheidegg\b/i,                                        "grosse-scheidegg"],
  [/\bibergeregg\b/i,                                                "ibergereggpass"],
  [/\bjulierpass\b|pass\s+dal\s+g(ü|ue)glia/i,                       "julierpass"],
  [/\bklausenpass\b/i,                                               "klausenpass"],
  [/\blukmanierpass\b|passo\s+del\s+lucomagno/i,                     "lukmanierpass"],
  [/\bmalojapass\b|passo\s+del\s+maloja/i,                           "malojapass"],
  [/\bnufenenpass\b|passo\s+della\s+novena/i,                        "nufenenpass"],
  [/\boberalppass\b|passo\s+dell['']?\s*oberalp/i,                   "oberalppass"],
  [/\bofenpass\b|pass\s+dal\s+fuorn|passo\s+del\s+forno/i,           "ofenpass"],
  [/\bpragelpass\b/i,                                                "pragelpass"],
  [/\bsan\s+bernardinopass\b|passo\s+del\s+san\s+bernardino/i,       "san-bernardinopass"],
  [/\bsimplonpass\b|simplon\s*pass|col\s+du\s+simplon/i,             "simplonpass"],
  [/\bspl(ü|ue)genpass\b|passo\s+dello\s+spluga/i,                   "spluegenpass"],
  [/\bsustenpass\b/i,                                                "sustenpass"],
  [/\bumbrailpass\b|pass\s+umbrail|passo\s+dell['']?\s*umbrail/i,    "umbrailpass"],
];
function swissSlug(name) {
  for (const [re, slug] of SWISS_SLUG_RULES) if (re.test(name)) return slug;
  return null;
}

/* Seasonal status estimate, layered:
   1) OSM `access:conditional` / `vehicle:conditional` rules (best — actual
      crowd-curated road policy).  Eg "no @ Nov-May".
   2) `seasonal=yes` flag on the highway (some closure exists, dates unknown).
   3) Elevation + month heuristic as last resort, clearly marked "estimated". */
const MONTHS_SHORT = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isMonthInRange(m, sm, em) {
  if (sm <= em) return m >= sm && m <= em;
  return m >= sm || m <= em;       // wraps year (Nov-May)
}

function osmRuleStatus(rules, date = new Date()) {
  if (!rules || !rules.length) return null;
  const m = date.getMonth() + 1;
  const closures = rules.filter(r =>
    (r.v === "no" || r.v === "private" || r.v === "closed") && r.sm && r.em
  );
  if (!closures.length) return null;
  const active = closures.find(r => isMonthInRange(m, r.sm, r.em));
  if (active) {
    return {
      state: "closed",
      stateText: `Closed ${MONTHS_SHORT[active.sm]}–${MONTHS_SHORT[active.em]}` +
                 (active.wk ? " (approx. ISO weeks)" : ""),
      info: `Per OpenStreetMap, this road is closed ${MONTHS_SHORT[active.sm]}–${MONTHS_SHORT[active.em]} every year. ` +
            `The evaluated month is ${MONTHS_SHORT[m]} — in the closure window.`,
      source: "osm",
    };
  }
  const r0 = closures[0];
  return {
    state: "open",
    stateText: `Open (closes ${MONTHS_SHORT[r0.sm]}–${MONTHS_SHORT[r0.em]})`,
    info: `Per OpenStreetMap, the seasonal closure runs ${MONTHS_SHORT[r0.sm]}–${MONTHS_SHORT[r0.em]}. ` +
          `The evaluated month is ${MONTHS_SHORT[m]} — outside the closure window.`,
    source: "osm",
  };
}

function elevationEstimate(elev, seasonal, date = new Date()) {
  const m = date.getMonth() + 1;
  let sm, em, label;
  if (elev < 1300)      { sm = 1;  em = 12; label = "year-round"; }
  else if (elev < 1700) { sm = 4;  em = 11; label = "Apr–Nov";    }
  else if (elev < 2100) { sm = 5;  em = 10; label = "May–Oct";    }
  else                  { sm = 6;  em = 10; label = "Jun–Oct";    }
  const isOpen = isMonthInRange(m, sm, em);
  return {
    state: isOpen ? "open" : "closed",
    estimated: true,
    stateText: `Typical season: ${label}` + (seasonal ? " · road marked seasonal" : ""),
    info: `No pass-specific road policy is available. This status is estimated from elevation (${elev} m), ` +
          `the evaluated month and broad Alpine seasonal patterns — verify locally before driving.`,
    source: "estimate",
    sourceLabel: "elevation/month",
  };
}

function defaultStatus(p) {
  return osmRuleStatus(p.closureRules) || elevationEstimate(p.elev, p.seasonal);
}

/* Transform raw OSM data into our internal model. */
const ALPS_INPUT = ALPS_RAW.filter(d => pointInAlps(d.lo, d.la));
if (ALPS_INPUT.length !== ALPS_RAW.length) {
  console.info(`Filtered ${ALPS_RAW.length - ALPS_INPUT.length} non-Alpine entries (kept ${ALPS_INPUT.length}/${ALPS_RAW.length}).`);
}
const PASS_CAMS_MAP = (typeof window !== "undefined" && window.PASS_CAMS) || {};
const PASSES = ALPS_INPUT.map((d, i) => {
  const fullName = d.n;
  const parts = fullName.split(/\s*\/\s*|\s*-\s*/);
  const slug = swissSlug(fullName);
  const iconKey = `${fullName}|${d.e}`;
  const scenicIconAsset = window.PASS_ICON_ASSETS?.[iconKey] || null;
  const symbolIconAsset = window.PASS_SYMBOL_ASSETS?.[iconKey] || scenicIconAsset;
  return {
    id: "p" + i,
    rawName: fullName,
    name: parts[0].trim(),
    alt: parts.length > 1 ? parts.slice(1).join(" / ").trim() : "",
    elev: d.e,
    lat: d.la,
    lon: d.lo,
    slug,
    /* Bases: ~6 km from summit on each side, roughly where the climb begins
       (typical valley floor distance for an Alpine pass).  Fed to OSRM as
       waypoints so the route follows the actual pass road, and used by the
       planner to choose direction or out-and-back. */
    baseA: d.bA ? { lat: d.bA[0], lon: d.bA[1] } : null,
    baseB: d.bB ? { lat: d.bB[0], lon: d.bB[1] } : null,
    closureRules: d.cr || null,
    seasonal: !!d.s,
    /* Quality scores 0..1 */
    quality:    typeof d.sc  === "number" ? d.sc  : 0,   // overall (display)
    qSummit:    typeof d.qSm === "number" ? d.qSm : 0,   // summit alone
    qApproach:  typeof d.qAp === "number" ? d.qAp : 0,   // climb (one side)
    qualitySignals: d.sg || null,
    tldr:       d.td || "",
    tldrSource: d.ts || "",
    reasoning:  d.rs || "",
    bestPhoto:  d.bp || null,
    confidence: d.cf || "",
    wikiLang: d.wl || "en",
    wikiTitle: d.wt || fullName.replace(/\s+/g, "_"),
    iconAsset: scenicIconAsset,
    scenicIconAsset,
    symbolIconAsset,
  };
});

/* Attach live-cam links: curated set (passes-cams.js) + auto-added entries
   for Swiss passes (their alpen-paesse.ch detail page hosts cam embeds) +
   a generic "more nearby" Windy.com pin anchored on lat/lon. Pass with no
   curated/auto entries get no cams section. */
PASSES.forEach(p => {
  const cams = [];
  const curated = PASS_CAMS_MAP[p.rawName];
  if (Array.isArray(curated) && curated.length) cams.push(...curated);
  if (p.slug) {
    cams.push({
      l: "Live cams on alpen-paesse.ch",
      u: `https://www.alpen-paesse.ch/en/alpenpaesse/${p.slug}/#webcams`,
      s: "alpen-paesse.ch",
    });
  }
  if (cams.length) {
    cams.push({
      l: "More webcams nearby",
      u: `https://www.windy.com/-Webcams/${p.lat.toFixed(4)}/${p.lon.toFixed(4)}/12`,
      s: "windy.com",
    });
    p.cams = cams;
  } else {
    p.cams = null;
  }
});
const PASS_BY_ID = new Map(PASSES.map(p => [p.id, p]));

document.getElementById("passCount").textContent = PASSES.length.toLocaleString();
/* ─────────────────────── Switzerland POI dataset ───────────────────────
   Loaded from `swiss-pois.js` (see that file for the source schema).
   POIs are normalised into the same field shape as PASSES so the existing
   planner, popup and tour-rendering helpers can treat them uniformly.

   For routing purposes a POI is a single geographic point, so we set
   `baseA == baseB == summit`.  POIs that aren't reachable by car
   (Jungfraujoch, Mürren, …) are excluded from the planner picker — they
   still appear on the map for context but can't be added to a tour.
   `isPoi: true` is the discriminator used throughout the planner. */
const POI_RAW = (typeof SWISS_POIS !== "undefined" && Array.isArray(SWISS_POIS)) ? SWISS_POIS : [];
const POIS = POI_RAW.map((d, i) => ({
  id: "poi" + i,
  rawName: d.n,
  name: d.n,
  alt: "",
  elev: typeof d.e === "number" ? d.e : null,
  lat: d.la,
  lon: d.lo,
  slug: null,
  baseA: { lat: d.la, lon: d.lo },
  baseB: { lat: d.la, lon: d.lo },
  closureRules: null,
  seasonal: false,
  /* Quality 0..1 derived from the curated 1-10 notability score. */
  quality:   typeof d.sc === "number" ? d.sc / 10 : 0,
  qSummit:   typeof d.sc === "number" ? d.sc / 10 : 0,
  qApproach: 0,
  qualitySignals: null,
  tldr:       d.td || "",
  tldrSource: "agent",
  reasoning:  d.rs || "",
  bestPhoto:  d.bp || null,
  confidence: "h",
  wikiLang:   d.wl || "en",
  wikiTitle:  d.wt || (d.n || "").replace(/\s+/g, "_"),
  cams: null,
  /* POI-specific metadata. */
  isPoi: true,
  poiCategory: d.cat,
  poiThemes: Array.isArray(d.themes) ? d.themes.slice() : [],
  poiAccess:  Array.isArray(d.access) ? d.access.slice() : [],
  poiSeason:  Array.isArray(d.season) ? d.season.slice() : [],
  poiRegion:  d.region || "",
  /* Visit-time at destination (separate from driving time). */
  visitDwellSec: typeof d.dur === "number" ? Math.round(d.dur * 3600) : 0,
}));
const POI_BY_ID = new Map(POIS.map(p => [p.id, p]));
/* Hard-filter to POIs the OSRM road router can actually reach.  Anything
   without "car" access (cogwheel-only summits, car-free mountain villages)
   is shown on the map but not allowed in a planned tour. */
const PLANNABLE_POIS = POIS.filter(p => p.poiAccess.includes("car"));
const PLANNABLE_POI_IDS = new Set(PLANNABLE_POIS.map(p => p.id));
function isPlannablePoi(p) { return p?.isPoi && PLANNABLE_POI_IDS.has(p.id); }

/* Static taxonomy used by the POI picker filter dropdowns. */
const POI_CATEGORY_LABELS = {
  "mountain-summit":     "Mountain summit",
  "alpine-lake":         "Alpine lake",
  "waterfall-gorge":     "Waterfall / gorge",
  "glacier":             "Glacier",
  "old-town":            "Old town",
  "castle-fortress":     "Castle / fortress",
  "monastery-church":    "Monastery / church",
  "scenic-railway":      "Scenic railway",
  "bridge-engineering":  "Bridge / engineering",
  "village":             "Village",
  "national-park":       "National park",
  "spa-wellness":        "Spa / wellness",
  "viewpoint-panorama":  "Viewpoint",
  "museum-cultural":     "Museum / cultural",
  "geology-cave":        "Geology / cave",
  "wine-region":         "Wine region",
  "special-experience":  "Special experience",
};
const POI_CATEGORY_GLYPH = {
  "mountain-summit":     "⛰",
  "alpine-lake":         "🜄",
  "waterfall-gorge":     "🌊",
  "glacier":             "❄",
  "old-town":            "🏛",
  "castle-fortress":     "🏰",
  "monastery-church":    "✝",
  "scenic-railway":      "🚂",
  "bridge-engineering":  "🌉",
  "village":             "🏘",
  "national-park":       "🌲",
  "spa-wellness":        "♨",
  "viewpoint-panorama":  "👁",
  "museum-cultural":     "🏛",
  "geology-cave":        "🪨",
  "wine-region":         "🍇",
  "special-experience":  "✨",
};
function poiCategoryLabel(cat) { return POI_CATEGORY_LABELS[cat] || cat || "POI"; }
function poiCategoryGlyph(cat) { return POI_CATEGORY_GLYPH[cat] || "📍"; }

/* Header counter for POIs (mirrors `passCount`). */
{
  const el = document.getElementById("poiCount");
  if (el) el.textContent = POIS.length.toLocaleString();
}

const STATE_LABEL = { open: "Open", restricted: "Open with restrictions",
                      closed: "Closed", unknown: "Status unknown" };
const ESTIMATED_STATE_LABEL = {
  open: "Likely open",
  restricted: "Likely restricted",
  closed: "Likely closed",
  unknown: "Unknown",
};
const STATUS_SOURCE_META = {
  live:     { className: "live", label: "Live",     title: "Live road status feed" },
  osm:      { className: "osm",  label: "OSM rule", title: "OpenStreetMap seasonal access rule" },
  history:  { className: "history", label: "History", title: "Historical opening/closing records" },
  estimate: { className: "est",  label: "Estimate", title: "Elevation/month seasonal estimate" },
  unknown:  { className: "unknown", label: "Unknown", title: "No status source" },
};
const ICON_SPRITE = "assets/icons.svg";

function iconSvg(id, className = "app-icon") {
  return `<svg class="${className}" aria-hidden="true"><use href="${ICON_SPRITE}#${id}"></use></svg>`;
}

function isEstimatedStatus(status) {
  return !!status && (status.estimated || status.source === "estimate");
}

function cleanStatusDetail(status, label) {
  let detail = (status?.stateText || "").trim();
  if (!detail) return "";
  const detailLc = detail.toLowerCase();
  const labelLc = label.toLowerCase();
  if (detailLc === labelLc) return "";
  if (detailLc.startsWith(labelLc + " ") || detailLc.startsWith(labelLc + "(")) {
    detail = detail.slice(label.length).trim();
  }
  return detail;
}

function statusDisplay(status) {
  const state = status?.state || "unknown";
  const estimated = isEstimatedStatus(status);
  const label = estimated
    ? (ESTIMATED_STATE_LABEL[state] || `Likely ${STATE_LABEL[state]?.toLowerCase() || "unknown"}`)
    : (STATE_LABEL[state] || STATE_LABEL.unknown);
  const source = status?.source || "unknown";
  const sourceMeta = STATUS_SOURCE_META[source] || STATUS_SOURCE_META.unknown;
  const className = `${state}${estimated ? " estimated" : ""}`;
  const detail = cleanStatusDetail(status, label);
  return {
    state,
    estimated,
    label,
    detail,
    className,
    source,
    sourceMeta,
    sourceLabel: status?.sourceLabel || "",
  };
}

function statusSignature(status) {
  const d = statusDisplay(status);
  return `${d.className}:${d.source}:${status?.sourceLabel || ""}:${status?.stateText || ""}:${openingHintLabel(status?.openingHint)}`;
}

function sourceBadgeHtml(status) {
  const d = statusDisplay(status);
  /* Fold the descriptive source label (e.g. "elevation/month") into the
     badge title attribute instead of rendering it inline — keeps the
     status row uncluttered while still surfacing the detail on hover. */
  const fullTitle = d.sourceLabel
    ? `${d.sourceMeta.title} — ${d.sourceLabel}`
    : d.sourceMeta.title;
  return `<span class="src-badge ${d.sourceMeta.className}" title="${escapeHtml(fullTitle)}">● ${escapeHtml(d.sourceMeta.label)}</span>`;
}

function listStatusLabel(status) {
  const d = statusDisplay(status);
  if (status?.projection?.listLabel) return `${d.label} (${status.projection.listLabel})`;
  if (status?.openingHint) return `${d.label} (${openingHintListLabel(status.openingHint)})`;
  if (d.estimated && d.detail) return `${d.label} (${d.detail.replace(/^(Typical|Historical) season:\s*/, "")})`;
  if (d.source === "osm" && d.detail) return `${d.label} ${d.detail}`;
  return d.label;
}

function statusSortRank(status) {
  const d = statusDisplay(status);
  if (d.estimated) {
    if (d.state === "open") return 2;
    if (d.state === "restricted") return 3;
    if (d.state === "closed") return 5;
  }
  return ({ open: 0, restricted: 1, unknown: 4, closed: 6 })[d.state] ?? 4;
}

const PROJECTION_HORIZON_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
const planDateEl = document.getElementById("planDate");
const planDateHintEl = document.getElementById("planDateHint");

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function todayLocalDate() {
  return startOfLocalDay(new Date());
}

function toDateInputValue(date) {
  const d = startOfLocalDay(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDateInputValue(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return todayLocalDate();
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? todayLocalDate() : startOfLocalDay(date);
}

function daysBetweenDates(fromDate, toDate) {
  return Math.round((startOfLocalDay(toDate) - startOfLocalDay(fromDate)) / DAY_MS);
}

function currentTripDate() {
  return parseDateInputValue(planDateEl?.value);
}

/* Map the trip date to one of the four seasons used by the POI dataset.
   Northern-hemisphere meteorological seasons: Mar-May = spring, Jun-Aug =
   summer, Sep-Nov = autumn, Dec-Feb = winter. Used by the auto-discovery
   planner to drop POIs that aren't accessible during the trip. */
function currentTripSeason() {
  const d = currentTripDate();
  const m = (d?.getMonth?.() ?? new Date().getMonth()) + 1;
  if (m >= 3 && m <= 5)  return "spring";
  if (m >= 6 && m <= 8)  return "summer";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter";
}

function formatTripDate(date) {
  const d = startOfLocalDay(date);
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS_SHORT[d.getMonth() + 1]} ${d.getFullYear()}`;
}

function makeProjection(status, projection, overrides = {}, forceEstimated = true) {
  return {
    ...status,
    ...overrides,
    estimated: forceEstimated ? true : !!status.estimated,
    projection,
  };
}

function openingHintDateForTrip(hint, tripDate) {
  if (!hint?.date) return null;
  const year = hint.date.year || tripDate.getFullYear();
  const date = new Date(year, hint.date.month - 1, hint.date.day);
  return Number.isNaN(date.getTime()) ? null : startOfLocalDay(date);
}

function projectionFromOpeningHint(status, tripDate) {
  const hint = status?.openingHint;
  const hintDate = openingHintDateForTrip(hint, tripDate);
  if (!hintDate) return null;
  const cmp = daysBetweenDates(hintDate, tripDate);
  const openByTrip = hint.kind === "closed-until" ? cmp > 0 : cmp >= 0;
  if (openByTrip && cmp > PROJECTION_HORIZON_DAYS) return null;
  const hintLabel = openingHintLabel(hint);
  const tripLabel = formatTripDate(tripDate);
  const dateLabel = formatOpeningDate(hint.date);
  const state = openByTrip ? "open" : "closed";
  const listLabel = openByTrip
    ? `forecast from ${dateLabel}`
    : (hint.kind === "closed-until" ? `closed until ${dateLabel}` : `opens ${dateLabel}`);
  return makeProjection(status, {
    basis: "opening-hint",
    guessed: false,
    listLabel,
    label: `Trip forecast for ${tripLabel}: ${openByTrip ? "expected open" : "expected closed"} (${hintLabel}).`,
  }, {
    state,
    stateText: openByTrip
      ? `Trip forecast: expected open from ${dateLabel}`
      : `Trip forecast: expected closed until ${dateLabel}`,
  });
}

function assumeUnchangedStatus(status, tripDate, offsetDays) {
  const stateLabel = (STATE_LABEL[status.state] || status.state || "status").toLowerCase();
  const tripLabel = formatTripDate(tripDate);
  return makeProjection(status, {
    basis: "assumed-unchanged",
    guessed: true,
    listLabel: "guess: unchanged ≤1 month",
    label: `Trip guess for ${tripLabel}: assuming current ${stateLabel} state remains for ${offsetDays} days because no change date was found.`,
  }, {
    stateText: `Trip guess: assuming current state remains through ${tripLabel}`,
  });
}

function projectedOsmStatus(p, tripDate) {
  const status = osmRuleStatus(p.closureRules, tripDate);
  if (!status) return null;
  return makeProjection(status, {
    basis: "osm",
    guessed: false,
    listLabel: "OSM seasonal rule",
    label: `Trip rule for ${formatTripDate(tripDate)}: OpenStreetMap seasonal access rule.`,
  }, {}, false);
}

function projectedHistoryStatus(history, tripDate) {
  const status = historyStatus(history, tripDate);
  return makeProjection(status, {
    basis: "history",
    guessed: true,
    listLabel: `guess: history ${historySeasonLabel(history)}`,
    label: `Trip guess for ${formatTripDate(tripDate)}: historical records suggest ${status.state === "open" ? "open" : "closed"} (${historySeasonLabel(history)} typical season).`,
  });
}

function projectedElevationStatus(p, tripDate) {
  const status = elevationEstimate(p.elev, p.seasonal, tripDate);
  return makeProjection(status, {
    basis: "elevation",
    guessed: true,
    listLabel: "guess: elevation/month",
    label: `Trip guess for ${formatTripDate(tripDate)}: estimated from elevation and month because no pass-specific date data was found.`,
  });
}

function projectedStatusForPass(p, tripDate = currentTripDate()) {
  const current = p._status || defaultStatus(p);
  const offsetDays = daysBetweenDates(todayLocalDate(), tripDate);
  if (offsetDays <= 0) return current;

  const hinted = projectionFromOpeningHint(current, tripDate);
  if (hinted) return hinted;

  if (current.source === "osm") return projectedOsmStatus(p, tripDate) || current;

  if (current.source === "live" && ["open", "restricted", "closed"].includes(current.state) && offsetDays <= PROJECTION_HORIZON_DAYS) {
    return assumeUnchangedStatus(current, tripDate, offsetDays);
  }

  const osm = projectedOsmStatus(p, tripDate);
  if (osm) return osm;

  const history = p._history || current.history;
  if (history) return projectedHistoryStatus(history, tripDate);

  return projectedElevationStatus(p, tripDate);
}

function passStatus(p) {
  return p._displayStatus || p._status || defaultStatus(p);
}

let plannedLayer = null, plannedStartMarker = null, plannedTourIds = [];

function plannedBadgeNumber(p) {
  const idx = plannedTourIds.indexOf(p.id);
  return idx >= 0 ? idx + 1 : null;
}

function updatePassMarkerIcon(p) {
  if (!p?._marker) return;
  const status = passStatus(p);
  const next = `${statusSignature(status)}:${plannedBadgeNumber(p) || ""}`;
  if (p._marker._currentState !== next) {
    p._marker.setIcon(makeMarkerIcon(status, plannedBadgeNumber(p)));
    p._marker._currentState = next;
  }
  p._marker._popupBuilt = false;
}

function refreshProjectedStatuses({ updateMarkers = false } = {}) {
  const tripDate = currentTripDate();
  PASSES.forEach(p => { p._displayStatus = projectedStatusForPass(p, tripDate); });
  if (!updateMarkers) return;
  PASSES.forEach(updatePassMarkerIcon);
  if (typeof syncMarkerVisibility === "function") syncMarkerVisibility();
  if (typeof renderList === "function") renderList();
  if (typeof renderAdvancedSelection === "function") renderAdvancedSelection();
  if (typeof renderAdvancedPicker === "function") renderAdvancedPicker();
}

function updateTripDateHint() {
  if (!planDateHintEl) return;
  const tripDate = currentTripDate();
  const days = daysBetweenDates(todayLocalDate(), tripDate);
  if (days <= 0) {
    planDateHintEl.innerHTML = "Using current live/OSM/history status for today.";
  } else if (days <= PROJECTION_HORIZON_DAYS) {
    planDateHintEl.innerHTML = `Projecting <strong>${formatTripDate(tripDate)}</strong>: explicit opening dates first; otherwise current live state is guessed unchanged for up to 1 month.`;
  } else {
    planDateHintEl.innerHTML = `Projecting <strong>${formatTripDate(tripDate)}</strong>: long-range status uses OSM rules, historical seasons, then elevation/month guesses.`;
  }
}

function initTripDateControl() {
  if (!planDateEl) return;
  const today = todayLocalDate();
  planDateEl.min = toDateInputValue(today);
  if (!planDateEl.value) planDateEl.value = toDateInputValue(today);
  updateTripDateHint();
}

/* ────────────────────────── caching helpers ────────────────────────── */
const cacheGet = (k, ttlMs) => {
  try { const r = localStorage.getItem(k); if (!r) return null;
        const o = JSON.parse(r); if (Date.now() - o.t > ttlMs) return null; return o.v; }
  catch { return null; }
};
const cacheSet = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), v })); } catch {}
};
const haversine = (a, b) => {
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const fmtDuration = h => {
  const t = Math.round(h * 60), hh = Math.floor(t/60), mm = t % 60;
  return hh ? `${hh} h ${mm.toString().padStart(2,"0")} min` : `${mm} min`;
};

/* ───────────────────── live Swiss pass status ───────────────────── */
const PROXIES = [
  url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];
const STATUS_URL = "https://www.alpen-paesse.ch/en/";
const STATUS_CACHE_KEY = "alps:status:v2";
const HISTORY_CACHE_KEY = "alps:history:v1";
const ALERTS_URL = "https://www.alpenpaesse.de/verkehrsinfo";
const ALERTS_CACHE_KEY = "alps:alerts:v2";
const LIVE_SOURCE_TTL = 24 * 60 * 60 * 1000;
const HISTORY_TTL = 7 * 24 * 60 * 60 * 1000;

async function fetchViaProxies(url) {
  let lastErr;
  for (const wrap of PROXIES) {
    try {
      const res = await fetch(wrap(url), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const html = await res.text();
      if (html.length < 2000) throw new Error("response too small");
      return html;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("All proxies failed");
}

const OPENING_MONTHS = {
  january: 1, jan: 1, januar: 1, janvier: 1, gennaio: 1,
  february: 2, feb: 2, februar: 2, fevrier: 2, février: 2, febbraio: 2,
  march: 3, mar: 3, maerz: 3, märz: 3, mars: 3, marzo: 3,
  april: 4, apr: 4, avril: 4, aprile: 4,
  may: 5, mai: 5, maggio: 5,
  june: 6, jun: 6, juni: 6, juin: 6, giugno: 6,
  july: 7, jul: 7, juli: 7, juillet: 7, luglio: 7,
  august: 8, aug: 8, agosto: 8, aout: 8, août: 8,
  september: 9, sep: 9, sept: 9, septembre: 9, settembre: 9,
  october: 10, oct: 10, oktober: 10, octobre: 10, ottobre: 10,
  november: 11, nov: 11, novembre: 11,
  december: 12, dec: 12, dezember: 12, decembre: 12, décembre: 12, dicembre: 12,
};
const OPENING_MONTH_RE = Object.keys(OPENING_MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

function cleanSourceText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseOpeningDate(text) {
  const src = cleanSourceText(text);
  if (!src) return null;

  let m = src.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-]\s*(\d{4}))?(?!\d)/);
  if (m) {
    const day = Number(m[1]), month = Number(m[2]), year = m[3] ? Number(m[3]) : null;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return { day, month, year };
  }

  const monthName = new RegExp(`\\b(${OPENING_MONTH_RE})\\b\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, "i");
  m = src.match(monthName);
  if (m) {
    const month = OPENING_MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]), year = m[3] ? Number(m[3]) : null;
    if (day >= 1 && day <= 31 && month) return { day, month, year };
  }

  const dayMonthName = new RegExp(`(\\d{1,2})(?:st|nd|rd|th|\\.)?\\s+\\b(${OPENING_MONTH_RE})\\b(?:\\s*(\\d{4}))?`, "i");
  m = src.match(dayMonthName);
  if (m) {
    const day = Number(m[1]);
    const month = OPENING_MONTHS[m[2].toLowerCase()];
    const year = m[3] ? Number(m[3]) : null;
    if (day >= 1 && day <= 31 && month) return { day, month, year };
  }

  return null;
}

function formatOpeningDate(date) {
  if (!date) return "";
  const base = `${String(date.day).padStart(2, "0")} ${MONTHS_SHORT[date.month]}`;
  return date.year ? `${base} ${date.year}` : base;
}

function openingHintLabel(hint) {
  if (!hint) return "";
  const date = formatOpeningDate(hint.date);
  if (hint.kind === "closed-until") return `Closed until ${date}`;
  if (hint.kind === "open-from") return `Open from ${date}`;
  return `Predicted opening: ${date}`;
}

function openingHintListLabel(hint) {
  if (!hint) return "";
  const date = formatOpeningDate(hint.date);
  if (hint.kind === "closed-until") return `closed until ${date}`;
  if (hint.kind === "open-from") return `open from ${date}`;
  return `opens ${date}`;
}

function parseOpeningHint(text) {
  const src = cleanSourceText(text);
  if (!src) return null;
  const patterns = [
    { kind: "predicted", re: /\b(?:predicted|expected|estimated|planned|anticipated)\s+(?:pass\s+)?opening\s*:?\s*([^\n]{0,120})/i },
    { kind: "predicted", re: /(?:^|\s)(?:voraussichtliche\s+)?(?:öffnung|oeffnung|freigabe)\s*:?\s*([^\n]{0,120})/i },
    { kind: "open-from", re: /\b(?:open|opened|opens|reopen|reopens|reopening)\s+(?:again\s+)?(?:from|on|around|about|approximately|approx\.?)?\s*:?\s*([^\n]{0,120})/i },
    { kind: "open-from", re: /(?:^|\s)(?:offen|geöffnet|geoeffnet|öffnet|oeffnet)\s+(?:ab|am|voraussichtlich(?:\s+ab)?)\s*([^\n]{0,120})/i },
    { kind: "closed-until", re: /\b(?:closed|closure|blocked|shut)\s+(?:until|through|till)\s+([^\n]{0,120})/i },
    { kind: "closed-until", re: /\b(?:gesperrt|sperre|wintersperre)\s+(?:bis|voraussichtlich\s+bis)\s+([^\n]{0,120})/i },
  ];
  for (const { kind, re } of patterns) {
    const m = src.match(re);
    if (!m) continue;
    const date = parseOpeningDate(m[1]);
    if (date) return { kind, date, text: m[0].trim() };
  }
  return null;
}

function withOpeningHint(status) {
  if (!status) return status;
  const openingHint = status.openingHint || parseOpeningHint(`${status.stateText || ""}\n${status.info || ""}`);
  if (!openingHint) return status;
  return { ...status, openingHint };
}

function parseStatuses(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const cards = doc.querySelectorAll("li.passes-element-item");
  const map = {};
  cards.forEach(card => {
    const link = card.querySelector('a[href*="/alpenpaesse/"]');
    if (!link) return;
    const m = link.getAttribute("href").match(/\/alpenpaesse\/([^/]+)\//);
    if (!m) return;
    const slug = m[1];
    const iconUse = card.querySelector(".pass-card-badge .icon use");
    const iconHref = iconUse ? (iconUse.getAttribute("xlink:href") || iconUse.getAttribute("href") || "") : "";
    let state = "unknown";
    if (iconHref.includes("status-open"))             state = "open";
    else if (iconHref.includes("status-warning"))     state = "restricted";
    else if (iconHref.includes("status-restriction")) state = "restricted";
    else if (iconHref.includes("status-closed"))      state = "closed";

    const stateTextEl = card.querySelector(".pass-card-badge .pass-card-badge-text > div");
    const stateText = stateTextEl ? stateTextEl.textContent.trim() : "";
    const lcText = stateText.toLowerCase();
    const withRestriction = /\bwith\s+restriction/.test(lcText);
    if (state === "unknown") {
      if (lcText.startsWith("open"))   state = withRestriction ? "restricted" : "open";
      else if (lcText.includes("closed")) state = "closed";
    } else if (state === "open" && withRestriction) {
      state = "restricted";
    }
    const sinceEl = card.querySelector(".pass-card-badge .pass-card-badge-text-clamp-1");
    const since = sinceEl ? sinceEl.textContent.replace(/^[^:]*:+\s*/, "").trim() : "";
    let weather = "";
    card.querySelectorAll(".pass-card-badge").forEach(b => {
      const ic = b.querySelector(".icon[class*='weather']");
      if (ic && !weather) {
        const t = b.querySelector(".pass-card-badge-text");
        if (t) weather = t.textContent.trim();
      }
    });
    const body = card.querySelector(".pass-card-body");
    let info = "";
    if (body) {
      info = Array.from(body.querySelectorAll("p"))
        .map(p => p.textContent.trim()).filter(Boolean).slice(0, 4).join("\n\n");
    }
    map[slug] = withOpeningHint({
      state,
      stateText,
      since,
      weather,
      info,
      source: "live",
      sourceUrl: `https://www.alpen-paesse.ch/en/alpenpaesse/${slug}/`,
    });
  });
  return map;
}

async function loadStatuses() {
  const cached = cacheGet(STATUS_CACHE_KEY, LIVE_SOURCE_TTL);
  if (cached) return { data: cached.data, fetchedAt: cached.fetchedAt, cached: true };
  const html = await fetchViaProxies(STATUS_URL);
  const data = parseStatuses(html);
  const fetchedAt = new Date().toISOString();
  cacheSet(STATUS_CACHE_KEY, { data, fetchedAt });
  return { data, fetchedAt, cached: false };
}

function parseHistoryDate(text) {
  const m = String(text || "").match(/(\d{1,2})\.(\d{1,2})\./);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return { day, month };
}

function historyDayOfYear(date) {
  const daysBeforeMonth = [0,0,31,59,90,120,151,181,212,243,273,304,334];
  return daysBeforeMonth[date.month] + date.day;
}

function medianNumber(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function historyDateFromDayOfYear(doy) {
  const daysInMonth = [0,31,28,31,30,31,30,31,31,30,31,30,31];
  let month = 1;
  let day = Math.max(1, Math.min(365, Math.round(doy)));
  while (month < 12 && day > daysInMonth[month]) {
    day -= daysInMonth[month];
    month++;
  }
  return { day, month };
}

function formatHistoryDate(date) {
  return `${String(date.day).padStart(2, "0")} ${MONTHS_SHORT[date.month]}`;
}

function historySeasonLabel(history) {
  if (!history?.typicalOpen || !history?.typicalClose) return "";
  return `${formatHistoryDate(history.typicalOpen)}–${formatHistoryDate(history.typicalClose)}`;
}

function parseSwissHistory(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector(".yearly-overview-element table.yearly-overview-table");
  if (!table) return null;
  const years = Array.from(table.querySelectorAll("thead th")).slice(1)
    .map(th => Number((th.textContent || "").match(/\b(19|20)\d{2}\b/)?.[0] || NaN));
  const row = table.querySelector("tbody tr");
  if (!row) return null;
  const records = Array.from(row.querySelectorAll("td")).map((td, idx) => {
    const parts = Array.from(td.querySelectorAll("div"))
      .map(div => div.textContent.trim().replace(/\s+/g, " ").replace(/\s*-\s*$/, ""))
      .filter(Boolean);
    const open = parseHistoryDate(parts[0]);
    const close = parseHistoryDate(parts[1]);
    return years[idx] && (open || close) ? { year: years[idx], open, close } : null;
  }).filter(Boolean);

  const complete = records.filter(r => r.open && r.close);
  if (complete.length < 3) return null;
  const typicalOpen = historyDateFromDayOfYear(medianNumber(complete.map(r => historyDayOfYear(r.open))));
  const typicalClose = historyDateFromDayOfYear(medianNumber(complete.map(r => historyDayOfYear(r.close))));
  const yearsWithData = records.map(r => r.year).sort((a, b) => a - b);
  return {
    typicalOpen,
    typicalClose,
    recordCount: complete.length,
    firstYear: yearsWithData[0],
    lastYear: yearsWithData[yearsWithData.length - 1],
  };
}

async function mapLimit(items, limit, worker) {
  const out = [];
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return out;
}

async function loadSwissHistory(slugs) {
  const uniq = [...new Set(slugs.filter(Boolean))];
  const cached = cacheGet(HISTORY_CACHE_KEY, HISTORY_TTL);
  if (cached) return { data: cached.data, fetchedAt: cached.fetchedAt, cached: true };

  const pairs = await mapLimit(uniq, 4, async slug => {
    try {
      const html = await fetchViaProxies(`https://www.alpen-paesse.ch/en/alpenpaesse/${slug}/`);
      return [slug, parseSwissHistory(html)];
    } catch (e) {
      console.warn("History failed", slug, e);
      return [slug, null];
    }
  });
  const data = {};
  pairs.forEach(([slug, history]) => { if (history) data[slug] = history; });
  const fetchedAt = new Date().toISOString();
  cacheSet(HISTORY_CACHE_KEY, { data, fetchedAt });
  return { data, fetchedAt, cached: false };
}

function historyStatus(history, date = new Date()) {
  const openDoy = historyDayOfYear(history.typicalOpen);
  const closeDoy = historyDayOfYear(history.typicalClose);
  const today = historyDayOfYear({ day: date.getDate(), month: date.getMonth() + 1 });
  const isOpen = openDoy <= closeDoy
    ? today >= openDoy && today <= closeDoy
    : today >= openDoy || today <= closeDoy;
  const label = historySeasonLabel(history);
  return {
    state: isOpen ? "open" : "closed",
    estimated: true,
    stateText: `Historical season: ${label}`,
    info: `Historical opening/closing records from alpen-paesse.ch suggest a typical open season of ${label}. ` +
          `This is based on ${history.recordCount} complete yearly records (${history.firstYear}–${history.lastYear}) and is not a live status.`,
    source: "history",
    sourceLabel: "alpen-paesse.ch",
    history,
  };
}

/* ───────────── live cross-Alpine alerts (alpenpaesse.de) ─────────────
   This single feed covers AT/DE/IT/FR/SI passes that have active alerts —
   closures, restrictions, snow, etc. Passes not in the feed are typically
   "open without alerts" (we conservatively stay with our OSM/estimate
   baseline rather than assume open). */
function normName(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  /* strip accents */
    .replace(/ß/g, "ss")
    .replace(/\([^)]*\)/g, " ")                        /* strip parentheticals */
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/* Alias set for fuzzy name matching.  Generates the full normalized name plus
   variants split on " / " or " - " plus suffix-stripped forms (drops "pass",
   "joch", "sattel", "strasse" etc.).  Lets us match e.g. alpenpaesse.de's
   "Glaubenberg" against OSM's "Glaubenbergpass". */
const NAME_SUFFIXES = ["pass","joch","sattel","strasse","hohenstrasse",
                       "panoramastrasse","alpenstrasse","gipfelstrasse"];
function nameAliases(name) {
  const out = new Set();
  if (!name) return out;
  const base = normName(name);
  if (base) out.add(base);
  name.split(/\s*\/\s*|\s+-\s+/).forEach(part => {
    const n = normName(part);
    if (n) out.add(n);
  });
  Array.from(out).forEach(a => {
    NAME_SUFFIXES.forEach(suf => {
      if (a.length > suf.length + 2 && a.endsWith(suf)) out.add(a.slice(0, -suf.length));
    });
  });
  return out;
}

function parseAlpsAlerts(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = doc.querySelectorAll("tr[data-link]");
  const map = {};
  rows.forEach(row => {
    const link = row.getAttribute("data-link") || "";
    const name = row.querySelector(".passtable-passname")?.textContent.trim() || "";
    if (!name) return;

    let iconClass = "";
    row.querySelectorAll("[class*='ap-fa7-']").forEach(el => {
      el.classList.forEach(c => { if (c.startsWith("ap-fa7-")) iconClass = c.slice(7); });
    });

    let state = "unknown";
    if (iconClass === "road-circle-xmark" || iconClass === "road-barrier") state = "closed";
    else if (iconClass === "snowflake")            state = "restricted";
    else if (iconClass === "person-digging")       state = "restricted";
    else if (iconClass === "person-falling-burst") state = "restricted";
    else if (iconClass === "road-circle-check")    state = "open";

    const statusTextEl = row.querySelector(".passtable-status-text .is-hidden-touch");
    const statusText = statusTextEl ? statusTextEl.textContent.trim().replace(/\s+/g, " ") : "";

    let ele = null;
    const tds = row.querySelectorAll("td");
    const lastTd = tds[tds.length - 1];
    if (lastTd) {
      const m = lastTd.textContent.trim().match(/^(\d+)\s*m\b/);
      if (m) ele = parseInt(m[1]);
    }

    const flagEl = row.querySelector(".flag-icon");
    let cc = "";
    if (flagEl) {
      flagEl.classList.forEach(c => { if (c.startsWith("flag-icon-") && c.length === 12) cc = c.slice(10); });
    }

    map[normName(name)] = withOpeningHint({
      state,
      stateText: state === "closed"     ? "Currently closed" :
                 state === "restricted" ? "Currently restricted" :
                 state === "open"       ? "Currently open" :
                                          (statusText || "Alert"),
      info: statusText,
      source: "live",
      sourceUrl: link,
      sourceLabel: "alpenpaesse.de" + (cc ? ` (${cc.toUpperCase()})` : ""),
      elev: ele,
      _matchName: name,
    });
  });
  return map;
}

async function loadAlpsAlerts() {
  const cached = cacheGet(ALERTS_CACHE_KEY, LIVE_SOURCE_TTL);
  if (cached) return { data: cached.data, fetchedAt: cached.fetchedAt, cached: true };
  const html = await fetchViaProxies(ALERTS_URL);
  const data = parseAlpsAlerts(html);
  const fetchedAt = new Date().toISOString();
  cacheSet(ALERTS_CACHE_KEY, { data, fetchedAt });
  return { data, fetchedAt, cached: false };
}

/* ─────────────────────── Wikipedia thumbnails ─────────────────────── */
const WIKI_TTL = 7 * 24 * 60 * 60 * 1000;
async function fetchWiki(title, primaryLang) {
  const key = `alps:wiki:${primaryLang}:${title}`;
  const c = cacheGet(key, WIKI_TTL);
  if (c) return c;
  const langs = [primaryLang, "en", "de"].filter((v, i, a) => a.indexOf(v) === i);
  for (const lang of langs) {
    try {
      const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.type === "disambiguation") continue;
      const out = {
        thumb: j.thumbnail ? j.thumbnail.source : null,
        extract: j.extract || "",
        url: j.content_urls ? j.content_urls.desktop.page : `https://${lang}.wikipedia.org/wiki/${title}`,
      };
      cacheSet(key, out);
      return out;
    } catch {}
  }
  const out = { thumb: null, extract: "", url: `https://${primaryLang}.wikipedia.org/wiki/${encodeURIComponent(title)}` };
  cacheSet(key, out);
  return out;
}

/* ───────────────────── vector basemap (MapLibre GL) ─────────────────────
   MapLibre renders OpenFreeMap vector styles inside Leaflet so existing
   markers, clustering, popups, routes, and controls keep working unchanged. */
const VECTOR_BASEMAPS = [
  { name: "Liberty vector",  style: "https://tiles.openfreemap.org/styles/liberty" },
  { name: "Bright vector",   style: "https://tiles.openfreemap.org/styles/bright" },
  { name: "Positron vector", style: "https://tiles.openfreemap.org/styles/positron" },
];

function makeVectorBasemap(styleUrl) {
  return L.maplibreGL({
    style: styleUrl,
    interactive: false,
    pane: "tilePane",
    /* No throttle on the bridge's move handler — let every Leaflet
       move event push through to the GL transform immediately. With a
       throttle, smooth-wheel zoom firing rAF-rate move events ends up
       at ~30 Hz GL updates (alternating frames suppressed), so the
       basemap visibly lags markers/polylines during fast zoom. At 0,
       GL stays in lockstep at 60 Hz. */
    updateInterval: 0,
    /* Smaller padding = less off-screen GL work per frame. We trade a
       few extra renders during very fast pan for lower per-frame cost. */
    padding: 0.15,
  });
}

function buildVectorBaseLayers() {
  const layers = {};
  VECTOR_BASEMAPS.forEach(({ name, style }) => {
    layers[name] = makeVectorBasemap(style);
  });
  return layers;
}

function updateMapInfo(styleName) {
  const el = document.getElementById("mapInfo");
  if (!el) return;
  el.innerHTML = `Vector map: <strong>${styleName}</strong> · OpenFreeMap/OpenMapTiles · WebGL`;
}


const map = L.map("map", {
  zoomControl: true,
  minZoom: 4,
  maxZoom: 18,
  /* Smooth interactions enabled now that maplibre-gl-leaflet 0.1.3 keeps
     the WebGL basemap in sync during pan/zoom animations (the older 0.0.22
     bridge desynced and we used to force everything synchronous). */
  zoomAnimation: true,
  markerZoomAnimation: true,
  fadeAnimation: true,
  inertia: true,
  inertiaDeceleration: 2200,
  /* Fractional zoom — used by double-click and keyboard zoom. Wheel zoom
     is handled by our smooth-zoom rAF loop below. */
  zoomSnap: 0,
  zoomDelta: 0.5,
  scrollWheelZoom: false,
  /* Canvas renderer for vector layers (polylines, polygons). The planned
     tour can easily be 3000+ polyline points; SVG's per-element layout
     cost on every pan/zoom event creates visible jank during smooth-wheel
     zoom and inertia drag. A shared canvas batches all vector layers into
     one draw per frame. Markers (HTML divIcons) are unaffected. */
  preferCanvas: true,
  renderer: L.canvas({ padding: 0.5 }),
}).setView([46.7, 10.0], 7);

/* ───────────────────── Smooth wheel zoom (Google-Maps style) ─────────────────────
   Replaces Leaflet's default stepped wheel zoom with continuous, frame-by-frame
   interpolation toward an accumulated target zoom. Uses Leaflet's internal
   `_move(center, zoom)` per rAF (events on) so that:
     · The maplibre bridge's `zoom`/`move` listeners fire each frame and the
       WebGL basemap follows along seamlessly via setCenter/setZoom.
     · Per-marker `zoom` handlers reposition icons each frame (smooth visual).
     · `zoomstart`/`zoomend` are NOT spammed, so MarkerClusterGroup doesn't
       reflow 60 times/sec — only when the gesture settles.
   At the end of the gesture, `_moveEnd(true)` fires zoomend+moveend exactly
   once, letting the cluster, route polylines and bridge cleanly commit. */
const SMOOTH_WHEEL_SENSITIVITY = 0.0035;  // wheel-pixels → target zoom-levels
const SMOOTH_WHEEL_LERP = 0.30;           // 0..1 approach factor per frame
const SMOOTH_WHEEL_END_DELAY = 200;       // ms after last wheel before settling
const SMOOTH_WHEEL_STOP = 0.005;          // |goal-cur| below this is "done"

let _smoothActive = false;
let _smoothGoalZoom = 0;
let _smoothCursorPoint = null;
let _smoothCenterPoint = null;
let _smoothAnchorLatLng = null;
let _smoothRAF = 0;
let _smoothEndTimer = 0;

function _smoothBegin(e) {
  _smoothActive = true;
  map.stop();
  _smoothCenterPoint = map.getSize().divideBy(2);
  _smoothCursorPoint = map.mouseEventToContainerPoint(e);
  _smoothAnchorLatLng = map.containerPointToLatLng(_smoothCursorPoint);
  _smoothGoalZoom = map.getZoom();
  map._moveStart(true, false);
}

function _smoothFinalise() {
  if (!_smoothActive) return;
  _smoothActive = false;
  if (_smoothRAF) { cancelAnimationFrame(_smoothRAF); _smoothRAF = 0; }
  map._moveEnd(true);
}

function _smoothTick() {
  _smoothRAF = 0;
  if (!_smoothActive) return;
  const cur = map.getZoom();
  const diff = _smoothGoalZoom - cur;
  if (Math.abs(diff) < SMOOTH_WHEEL_STOP) return;

  let next = cur + diff * SMOOTH_WHEEL_LERP;
  next = Math.round(next * 1000) / 1000;

  /* Keep _smoothAnchorLatLng under _smoothCursorPoint at the new zoom by
     projecting the anchor at `next`, subtracting cursor offset from view
     centre, and unprojecting to get the new map centre. */
  const cursorOffset = _smoothCursorPoint.subtract(_smoothCenterPoint);
  const newCenter = map.unproject(
    map.project(_smoothAnchorLatLng, next).subtract(cursorOffset),
    next
  );
  map._move(newCenter, next);
  _smoothRAF = requestAnimationFrame(_smoothTick);
}

map.getContainer().addEventListener("wheel", e => {
  if (!e.deltaY) return;
  const at = map.getZoom();
  const minZ = map.getMinZoom();
  const maxZ = map.getMaxZoom();
  /* At a hard zoom limit in the wheel direction → leave default scroll
     behaviour alone so the page can scroll as expected. */
  const goalAtLimit = (at <= minZ && e.deltaY > 0) || (at >= maxZ && e.deltaY < 0);
  if (goalAtLimit) return;

  e.preventDefault();
  if (!_smoothActive) _smoothBegin(e);

  /* Refresh the cursor anchor each event — handles cursor moving between
     wheel ticks (e.g. trackpad gestures with built-in jitter). */
  _smoothCursorPoint = map.mouseEventToContainerPoint(e);
  _smoothAnchorLatLng = map.containerPointToLatLng(_smoothCursorPoint);

  const lineMul = e.deltaMode === 1 ? 16 : 1;       // Firefox line-mode
  /* Browser-pinch on trackpad arrives as wheel + ctrlKey with much larger
     deltaY values; tone it down so a pinch isn't a 3-level jump. */
  const ctrlMul = e.ctrlKey ? 0.5 : 1;
  const delta = -e.deltaY * lineMul * ctrlMul * SMOOTH_WHEEL_SENSITIVITY;

  _smoothGoalZoom = Math.max(minZ, Math.min(maxZ, _smoothGoalZoom + delta));

  if (!_smoothRAF) _smoothRAF = requestAnimationFrame(_smoothTick);
  clearTimeout(_smoothEndTimer);
  _smoothEndTimer = setTimeout(_smoothFinalise, SMOOTH_WHEEL_END_DELAY);
}, { passive: false });

const baseLayers = buildVectorBaseLayers();
const defaultBaseLayerName = VECTOR_BASEMAPS[0].name;
baseLayers[defaultBaseLayerName].addTo(map);
updateMapInfo(defaultBaseLayerName);
map.on("baselayerchange", e => updateMapInfo(e.name));

const markersBySlug = {};
const STATE_ICON_NAMES = new Set(["open", "restricted", "closed", "estimated", "unknown"]);
function stateIconId(state, estimated = false) {
  if (estimated) return "alpine-state-estimated";
  return STATE_ICON_NAMES.has(state) ? `alpine-state-${state}` : "alpine-state-unknown";
}
function makeMarkerIcon(statusOrState, badgeNumber = null, estimated = false) {
  const view = typeof statusOrState === "string"
    ? { state: statusOrState, className: `${statusOrState}${estimated ? " estimated" : ""}`, estimated }
    : statusDisplay(statusOrState);
  const cls = view.className;
  const iconId = stateIconId(view.state, view.estimated);
  const badge = badgeNumber != null ? `<div class="tour-badge">${badgeNumber}</div>` : "";
  return L.divIcon({
    className: "",
    html: `<div class="pass-marker-wrap"><div class="pass-marker ${cls}">${iconSvg(iconId, "marker-icon")}</div>${badge}</div>`,
    iconSize: [24, 24], iconAnchor: [12, 12],
  });
}

const passCluster = L.markerClusterGroup({
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
  maxClusterRadius: 50,
  /* Keep clustering one zoom level longer so dense Alpine areas don't
     dump 100+ individual divIcons on screen the moment a user zooms in. */
  disableClusteringAtZoom: 12,
  chunkedLoading: true,
});
map.addLayer(passCluster);

/* Drop expensive marker visuals (box-shadow / drop-shadow filters) and
   per-frame composited effects while the map is moving. Pure CSS toggle
   via a `map-moving` class on the map container; very cheap to apply
   on movestart/zoomstart and remove on moveend/zoomend. */
{
  const mc = map.getContainer();
  const setMoving = () => mc.classList.add("map-moving");
  const clearMoving = () => mc.classList.remove("map-moving");
  map.on("movestart zoomstart", setMoving);
  map.on("moveend zoomend", clearMoving);
}

function buildPopupHtml(p, status, wiki) {
  const statusView = statusDisplay(status);
  const wikiHref = wiki?.url || `https://${p.wikiLang}.wikipedia.org/wiki/${encodeURIComponent(p.wikiTitle)}`;
  const passDetail = p.slug ? `https://www.alpen-paesse.ch/en/alpenpaesse/${p.slug}/` : null;
  /* Prefer the agent-curated representative photo, fall back to Wikipedia
     thumbnail (which loads asynchronously after the popup opens). */
  const photoSrc = p.bestPhoto || wiki?.thumb;
  const img = photoSrc
    ? `<img class="popup-img" src="${photoSrc}" alt="${p.name}" loading="lazy">`
    : `<div class="popup-img placeholder">no photo</div>`;

  const stateLine = status
    ? `<span class="badge ${statusView.className}">${escapeHtml(statusView.label)}</span>` +
      ` <span class="popup-source">${sourceBadgeHtml(status)}</span>`
    : `<span class="badge unknown">Loading…</span>`;
  const statusDetailBlock = status && statusView.detail
    ? `<div class="popup-status-detail">${escapeHtml(statusView.detail)}</div>`
    : "";
  const meta = [
    status?.weather ? `🌡 ${status.weather}` : null,
    status?.since ? `since ${status.since}` : null,
  ].filter(Boolean).join(" · ");
  const metaBlock = meta ? `<div class="popup-meta">${meta}</div>` : "";
  const info = status?.info
    ? `<div class="popup-info">${status.info.split("\n\n").map(par => `<p>${escapeHtml(par)}</p>`).join("")}</div>` : "";
  const tldrBlock = p.tldr
    ? `<div class="popup-tldr">${escapeHtml(p.tldr)}</div>`
    : "";
  const projectionBlock = status?.projection
    ? `<div class="popup-meta projection${status.projection.guessed ? " guess" : ""}">${escapeHtml(status.projection.label)}</div>`
    : "";
  const openingBlock = status?.openingHint
    ? `<div class="popup-meta opening">${escapeHtml(openingHintLabel(status.openingHint))}</div>`
    : "";
  const historyBlock = status?.history
    ? `<div class="popup-meta history">History: typical open season ${escapeHtml(historySeasonLabel(status.history))} · ${status.history.recordCount} records (${status.history.firstYear}–${status.history.lastYear})</div>`
    : "";
  const whyLine = whyRatingLine(p);
  const whyBlock = whyLine ? `<div class="popup-why">${whyLine}</div>` : "";
  const camsBlock = p.cams && p.cams.length
    ? `<div class="popup-cams" aria-label="Live webcams">
         <div class="popup-cams-label">📹 Live cams</div>
         <ul class="popup-cams-list">
           ${p.cams.map(c => `<li><a href="${escapeHtml(c.u)}" target="_blank" rel="noopener"><span class="cam-label">${escapeHtml(c.l)}</span><span class="cam-source">${escapeHtml(c.s)}</span></a></li>`).join("")}
         </ul>
       </div>`
    : "";
  const planBtnBlock = (p.baseA && p.baseB)
    ? `<div class="popup-actions"><button class="popup-add-btn" type="button" data-pass-add="${escapeHtml(p.id)}" aria-label="Add ${escapeHtml(p.name)} to tour">＋ Add to selected route</button></div>`
    : "";
  const linkParts = [];
  if (passDetail) linkParts.push(`<a href="${passDetail}" target="_blank" rel="noopener">↗ alpen-paesse.ch</a>`);
  linkParts.push(`<a href="${wikiHref}" target="_blank" rel="noopener">↗ Wikipedia</a>`);

  return `<div class="popup">${img}
    <div class="popup-body">
      <div class="popup-title">
        <h2>${passIconHtml(p)}<span>${p.name}</span></h2>
        ${qualityStars(p.quality)}
      </div>
      ${p.alt ? `<div class="popup-alt">${escapeHtml(p.alt)}</div>` : ""}
      <div class="popup-status">
        <span class="popup-elev">${p.elev} m</span>
        ${stateLine}
      </div>
      ${statusDetailBlock}
      ${metaBlock}
      ${projectionBlock}
      ${openingBlock}
      ${historyBlock}
      ${tldrBlock}
      ${whyBlock}
      ${info}
      ${camsBlock}
      ${planBtnBlock}
      <div class="popup-links">${linkParts.join("")}</div>
    </div></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function passIconHtml(p, className = "pass-art-icon", variant = "scenic") {
  const asset = variant === "symbol"
    ? (p.symbolIconAsset || p.iconAsset)
    : (p.scenicIconAsset || p.iconAsset || p.symbolIconAsset);
  if (!asset) return "";
  const col = Math.max(0, Math.min(4, Number(asset.col) || 0));
  const row = Math.max(0, Math.min(4, Number(asset.row) || 0));
  const posX = col === 0 ? "0%" : `${col * 25}%`;
  const posY = row === 0 ? "0%" : `${row * 25}%`;
  return `<span class="${className} lazy-pass-icon" role="img" aria-label="${escapeHtml(p.name)} icon" data-pass-icon-sheet="${escapeHtml(asset.sheet)}" data-pass-icon-position="${posX} ${posY}"></span>`;
}

const passIconObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        loadPassIcon(entry.target);
        passIconObserver.unobserve(entry.target);
      });
    }, { rootMargin: "240px 0px" })
  : null;

function loadPassIcon(el) {
  const sheet = el?.dataset?.passIconSheet;
  if (!sheet || el.dataset.passIconLoaded === "true") return;
  el.style.backgroundImage = `url("${sheet}")`;
  el.style.backgroundPosition = el.dataset.passIconPosition || "center";
  el.dataset.passIconLoaded = "true";
  delete el.dataset.passIconSheet;
  delete el.dataset.passIconPosition;
}

function lazyLoadPassIcons(root = document, immediate = false) {
  const icons = root.querySelectorAll?.(".lazy-pass-icon[data-pass-icon-sheet]");
  if (!icons?.length) return;
  icons.forEach(icon => {
    if (immediate || !passIconObserver) loadPassIcon(icon);
    else passIconObserver.observe(icon);
  });
}

/* "Why this rating" line — uses the LLM reasoning sentence as the primary
   explanation, with a small sub-score breakdown.
   Sub-scores: sB scenicBeauty, sI summitInterest, dE drivingExperience, pp popularity (all 0-10). */
function whyRatingLine(p) {
  const stars = Math.round((p.quality || 0) * 5);
  const starStr = stars > 0 ? "★".repeat(stars) : "—";
  const reasoning = p.reasoning ? escapeHtml(p.reasoning) : "";
  const sg = p.qualitySignals;
  let breakdown = "";
  if (sg && typeof sg.sB === "number") {
    breakdown =
        `<span class="why-chips" title="Agent sub-scores 0-10">`
      + `<span class="score-chip">scenic <b>${sg.sB.toFixed(1)}</b></span>`
      + `<span class="score-chip">driving <b>${sg.dE.toFixed(1)}</b></span>`
      + `<span class="score-chip">summit <b>${sg.sI.toFixed(1)}</b></span>`
      + `<span class="score-chip">known <b>${sg.pp.toFixed(1)}</b></span>`
      + `</span>`;
  }
  if (!reasoning && !breakdown) return "";
  const cf = p.confidence;
  const cfTag = cf === "l" ? ' <span class="cf-tag" title="Low confidence — sparse data">·low confidence</span>' : "";
  return `<div class="why-summary"><span class="why-stars"><b>${starStr}</b></span>${breakdown}${cfTag}</div>`
       + (reasoning ? `<div class="why-reasoning">${reasoning}</div>` : "");
}

function qualityStars(q) {
  if (typeof q !== "number" || q <= 0) return "";
  const filled = Math.round(q * 5);
  const stars = "★★★★★".slice(0, filled) + "☆☆☆☆☆".slice(0, 5 - filled);
  return `<span class="quality" title="Quality score: ${q.toFixed(2)} (AI-evaluated scenic beauty, driving experience, summit interest, popularity)">${stars}</span>`;
}
function qualityStarsCompact(q) {
  if (typeof q !== "number" || q < 0.2) return "";
  const filled = Math.round(q * 5);
  if (filled === 0) return "";
  return `<span class="quality compact">${"★".repeat(filled)}</span>`;
}

/* Eagerly compute baseline status so markers render with the right colour
   immediately, instead of starting "unknown" and re-rendering after the live
   fetch resolves. */
initTripDateControl();
PASSES.forEach(p => { p._status = defaultStatus(p); });
refreshProjectedStatuses();

const passMarkers = [];
PASSES.forEach(p => {
  const m = L.marker([p.lat, p.lon], { icon: makeMarkerIcon(passStatus(p)) });
  m.bindTooltip(`${p.name} · ${p.elev} m`, { direction: "top", offset: [0, -10] });
  /* Lazy popup: build HTML the first time the popup opens (saves ~591×
     buildPopupHtml on init).  Wikipedia thumbnail loaded async in parallel. */
  m.on("popupopen", async () => {
    if (!m._popupBuilt) {
      m.setPopupContent(buildPopupHtml(p, passStatus(p), null));
      lazyLoadPassIcons(m.getPopup()?.getElement(), true);
      m._popupBuilt = true;
    }
    const wiki = await fetchWiki(p.wikiTitle, p.wikiLang);
    m.setPopupContent(buildPopupHtml(p, passStatus(p), wiki));
    lazyLoadPassIcons(m.getPopup()?.getElement(), true);
  });
  m.bindPopup("…", { maxWidth: 300, autoPan: true });
  passMarkers.push(m);
  markersBySlug[p.id] = m;
  if (p.slug) markersBySlug[p.slug] = m;
  p._marker = m;
  p._marker._currentState = `${statusSignature(passStatus(p))}:`;
});

/* Single batch insert is markedly faster than 591 individual addLayer calls
   (cluster recomputes per insert otherwise). */
passCluster.addLayers(passMarkers);

/* ───────────────────────── POI markers + popups ─────────────────────────
   Separate cluster + divIcon so POIs and passes are visually distinct.
   POIs use a violet accent and a category glyph; non-plannable POIs (no
   car access) are rendered with reduced opacity so users understand they
   can't be added to a tour. */
function makePoiIcon(poi, badgeNumber = null) {
  const glyph = poiCategoryGlyph(poi.poiCategory);
  const dim = isPlannablePoi(poi) ? "" : " dim";
  const badge = badgeNumber != null ? `<div class="tour-badge poi-tour-badge">${badgeNumber}</div>` : "";
  return L.divIcon({
    className: "",
    html: `<div class="poi-marker-wrap"><div class="poi-marker${dim}" data-cat="${poi.poiCategory}"><span class="poi-marker-glyph">${glyph}</span></div>${badge}</div>`,
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
}

function buildPoiPopupHtml(poi) {
  const wikiHref = `https://${poi.wikiLang}.wikipedia.org/wiki/${encodeURIComponent(poi.wikiTitle)}`;
  const img = poi.bestPhoto
    ? `<img class="popup-img" src="${escapeHtml(poi.bestPhoto)}" alt="${escapeHtml(poi.name)}" loading="lazy">`
    : `<div class="popup-img placeholder">no photo</div>`;
  const themeBadges = poi.poiThemes.slice(0, 6).map(t =>
    `<span class="poi-theme-chip">${escapeHtml(t)}</span>`).join("");
  const elevLine = poi.elev ? `${poi.elev} m · ` : "";
  const accessLine = poi.poiAccess.map(a => escapeHtml(a)).join(" · ");
  const seasonLine = poi.poiSeason.length === 4 ? "year-round" : poi.poiSeason.map(escapeHtml).join(" · ");
  const dwellLine = poi.visitDwellSec
    ? `${(poi.visitDwellSec / 3600).toFixed(poi.visitDwellSec >= 3600 ? 1 : 1)} h typical visit`
    : "";
  const planBtn = isPlannablePoi(poi)
    ? `<button class="popup-add-btn" type="button" data-poi-add="${escapeHtml(poi.id)}" aria-label="Add ${escapeHtml(poi.name)} to tour">＋ Add to selected route</button>`
    : `<div class="popup-meta tight" title="POI is not directly reachable by car (${escapeHtml(accessLine)})">⚠ Not car-accessible — view-only on the map</div>`;
  return `
    <article class="popup poi-popup" data-poi="${escapeHtml(poi.id)}">
      ${img}
      <header class="popup-head">
        <div class="popup-head-row">
          <h3 class="popup-title">${escapeHtml(poi.name)}</h3>
          <span class="poi-cat-badge" data-cat="${poi.poiCategory}">${poiCategoryGlyph(poi.poiCategory)} ${escapeHtml(poiCategoryLabel(poi.poiCategory))}</span>
        </div>
        <div class="popup-meta">${escapeHtml(elevLine)}${escapeHtml(poi.poiRegion)}${dwellLine ? " · " + escapeHtml(dwellLine) : ""}</div>
      </header>
      <div class="popup-body">
        <p class="popup-tldr">${escapeHtml(poi.tldr)}</p>
        ${themeBadges ? `<div class="poi-theme-chips">${themeBadges}</div>` : ""}
        <div class="popup-meta tight"><strong>Access:</strong> ${accessLine || "—"}</div>
        <div class="popup-meta tight"><strong>Season:</strong> ${seasonLine || "—"}</div>
      </div>
      <footer class="popup-foot">
        <a class="popup-link" href="${wikiHref}" target="_blank" rel="noopener">Wikipedia ↗</a>
        ${planBtn}
      </footer>
    </article>`;
}

const poiCluster = L.markerClusterGroup({
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
  maxClusterRadius: 60,
  disableClusteringAtZoom: 12,
  chunkedLoading: true,
  iconCreateFunction(cluster) {
    const n = cluster.getChildCount();
    return L.divIcon({
      html: `<div class="poi-cluster"><span>${n}</span></div>`,
      className: "",
      iconSize: [34, 34],
    });
  },
});

const poiMarkers = [];
POIS.forEach(poi => {
  const m = L.marker([poi.lat, poi.lon], { icon: makePoiIcon(poi) });
  m.bindTooltip(`${poi.name} · ${poiCategoryLabel(poi.poiCategory)}`, { direction: "top", offset: [0, -10] });
  m.bindPopup("…", { maxWidth: 360, autoPan: true });
  m.on("popupopen", () => {
    if (!m._popupBuilt) {
      m.setPopupContent(buildPoiPopupHtml(poi));
      m._popupBuilt = true;
    }
  });
  poiMarkers.push(m);
  poi._marker = m;
});
poiCluster.addLayers(poiMarkers);
/* POI layer is ON by default so users see the POI integration immediately;
   they can hide it via the layer control on the top-right. */
map.addLayer(poiCluster);

/* Popup-delegated handler: "Add to selected route" buttons on POI and
   pass popups. Both routes go through the same UX — flip into advanced
   mode if needed, then add the stop. */
document.addEventListener("click", e => {
  const poiBtn = e.target.closest("[data-poi-add]");
  if (poiBtn) {
    const id = poiBtn.dataset.poiAdd;
    if (typeof toggleSelectedPoi === "function" && PLANNABLE_POI_IDS.has(id)) {
      /* Make sure advanced mode is on so the user actually sees the change. */
      if (typeof advancedModeEl !== "undefined" && !advancedModeEl.checked) {
        advancedModeEl.checked = true;
        if (typeof syncAdvancedMode === "function") syncAdvancedMode();
      }
      toggleSelectedPoi(id, true);
    }
    return;
  }
  const passBtn = e.target.closest("[data-pass-add]");
  if (passBtn) {
    const id = passBtn.dataset.passAdd;
    const pass = PASS_BY_ID.get(id);
    if (pass && pass.baseA && pass.baseB && typeof toggleSelectedPass === "function") {
      if (typeof advancedModeEl !== "undefined" && !advancedModeEl.checked) {
        advancedModeEl.checked = true;
        if (typeof syncAdvancedMode === "function") syncAdvancedMode();
      }
      toggleSelectedPass(id, true);
    }
  }
});

/* ───────────────────────── overlays / layer control ───────────────────────── */
const overlayLayers = {};
overlayLayers[
  `<span class="poi-overlay-swatch"></span>` +
  `Sights / POIs <span class="overlay-meta">· ${POIS.length} curated</span>`
] = poiCluster;
L.control.layers(baseLayers, overlayLayers, { position: "topright", collapsed: true }).addTo(map);

/* ─────────────────────────── tour planner ─────────────────────────── */
const PRESET_STARTS = {
  lucerne:    { name: "Lucerne",                  lat: 47.0502, lon: 8.3093 },
  andermatt:  { name: "Andermatt",                lat: 46.6364, lon: 8.5942 },
  engelberg:  { name: "Engelberg",                lat: 46.8224, lon: 8.4039 },
  interlaken: { name: "Interlaken",               lat: 46.6863, lon: 7.8632 },
  stmoritz:   { name: "St. Moritz",               lat: 46.4983, lon: 9.8408 },
  chur:       { name: "Chur",                     lat: 46.8499, lon: 9.5320 },
  bellinzona: { name: "Bellinzona",               lat: 46.1947, lon: 9.0244 },
  aosta:      { name: "Aosta",                    lat: 45.7372, lon: 7.3206 },
  bolzano:    { name: "Bolzano",                  lat: 46.4983, lon: 11.3548 },
  trento:     { name: "Trento",                   lat: 46.0667, lon: 11.1167 },
  cortina:    { name: "Cortina d'Ampezzo",        lat: 46.5405, lon: 12.1357 },
  innsbruck:  { name: "Innsbruck",                lat: 47.2692, lon: 11.4041 },
  salzburg:   { name: "Salzburg",                 lat: 47.8095, lon: 13.0550 },
  klagenfurt: { name: "Klagenfurt",               lat: 46.6228, lon: 14.3056 },
  ljubljana:  { name: "Ljubljana",                lat: 46.0569, lon: 14.5058 },
  chamonix:   { name: "Chamonix",                 lat: 45.9237, lon: 6.8694 },
  grenoble:   { name: "Grenoble",                 lat: 45.1885, lon: 5.7245 },
  munich:     { name: "Munich",                   lat: 48.1374, lon: 11.5755 },
};
let customStart = null; // {name, lat, lon}

const distSlider = document.getElementById("planDist");
const distLabel  = document.getElementById("distLabel");
const startSel   = document.getElementById("planStart");
const openOnlyEl = document.getElementById("planOpenOnly");
const includePoisEl = document.getElementById("planIncludePois");
/* V3 — distance-vs-time mode + sight preferences. */
const distanceControlEl = document.getElementById("distanceControl");
const timeControlEl     = document.getElementById("timeControl");
const timeSlider        = document.getElementById("planTime");
const timeLabel         = document.getElementById("timeLabel");
const timeTolHint       = document.getElementById("timeTolHint");
const targetModeRadios  = document.querySelectorAll('input[name="planTargetMode"]');
const poiPrefsEl        = document.getElementById("poiPrefs");
const poiPrefsSubtitleEl = document.getElementById("poiPrefsSubtitle");
const poiPresetsEl      = document.getElementById("poiPresets");
const poiCatChipsEl     = document.getElementById("poiCatChips");
const poiThemeChipsEl   = document.getElementById("poiThemeChips");
const poiMinScoreEl     = document.getElementById("poiMinScore");
const poiMinScoreLabelEl = document.getElementById("poiMinScoreLabel");
const poiMaxCountEl     = document.getElementById("poiMaxCount");
const poiMaxCountLabelEl = document.getElementById("poiMaxCountLabel");

/* V3 prefs state. Sets are empty by default = "any" (no gating). */
const allowedPoiCategories = new Set();
const allowedPoiThemes     = new Set();
function planTargetMode() {
  for (const r of targetModeRadios) if (r.checked) return r.value;
  return "distance";
}
function planTargetValue() {
  return planTargetMode() === "time" ? +timeSlider.value : +distSlider.value;
}
/* Tolerance: 20% of distance, or clamp(0.5h, 15% × hours, 2h) for time mode. */
function planTargetTolerance() {
  if (planTargetMode() === "distance") return 0.20;
  const hours = +timeSlider.value;
  const half = Math.max(0.5, Math.min(2.0, hours * 0.15));
  return half / hours;
}
function poiMinScoreVal() { return +poiMinScoreEl.value; }
function poiMaxCountVal() { return +poiMaxCountEl.value; }
/* Curated theme set surfaced as chips — full list is 19 but most users
   only need these. The candidate filter still accepts any theme via the
   advanced-mode multi-region picker. */
const CURATED_PREF_THEMES = [
  "unesco", "family-friendly", "photogenic", "iconic",
  "panoramic-view", "historic", "food-drink",
  "hidden-gem", "swimmable", "winter-sport",
];
const POI_PRESETS = {
  family:   { cats: ["viewpoint-panorama","alpine-lake","scenic-railway","special-experience","museum-cultural"], themes: ["family-friendly"], minScore: 7, maxCount: 4, label: "Family day · ★7+ · max 4" },
  cultural: { cats: ["castle-fortress","monastery-church","old-town","museum-cultural"], themes: ["unesco","historic"], minScore: 7, maxCount: 4, label: "Cultural tour · ★7+ · max 4" },
  photo:    { cats: ["viewpoint-panorama","alpine-lake","mountain-summit","glacier","waterfall-gorge"], themes: ["photogenic","iconic"], minScore: 8, maxCount: 3, label: "Photo tour · ★8+ · max 3" },
  hidden:   { cats: [], themes: ["hidden-gem"], minScore: 6, maxCount: 3, label: "Hidden gems · ★6+ · max 3" },
  wine:     { cats: ["wine-region","village","old-town"], themes: ["food-drink"], minScore: 6, maxCount: 4, label: "Wine & food · ★6+ · max 4" },
  reset:    { cats: [], themes: [], minScore: 6, maxCount: 3, label: "Default · any category · any theme · ★6+ · max 3" },
};
let activePresetId = null;
const planRunBtn = document.getElementById("planRun");
const planResult = document.getElementById("planResult");
const planPickBtn= document.getElementById("planPick");
const advancedModeEl = document.getElementById("planAdvanced");
const advancedPlannerEl = document.getElementById("advancedPlanner");
const advancedPassSearchEl = document.getElementById("planPassSearch");
const advancedPassPickerEl = document.getElementById("planPassPicker");
const selectedPassesEl = document.getElementById("selectedPasses");
const selectedStopCountEl = document.getElementById("selectedStopCount");
const selectedPassMiniEl = document.getElementById("selectedPassMini");
const selectedPoiMiniEl = document.getElementById("selectedPoiMini");
const clearSelectedPassesBtn = document.getElementById("clearSelectedPasses");
const advancedPlannerNoteEl = document.getElementById("advancedPlannerNote");
/* POI picker elements (added when POI integration shipped). */
const advancedPoiSearchEl = document.getElementById("planPoiSearch");
const advancedPoiPickerEl = document.getElementById("planPoiPicker");
const selectedPoisEl = document.getElementById("selectedPois");
const advancedPoiRegionEl = document.getElementById("planPoiRegion");
const advancedPoiCategoryEl = document.getElementById("planPoiCategory");
const advancedPoiThemeEl = document.getElementById("planPoiTheme");
/* Combined cap covers passes + POIs together — Held-Karp is O(N²·2^N), and
   31 OSRM matrix nodes (1 + 3·10) keeps us well under public-server limits. */
const ADVANCED_MAX_STOPS = 10;
const ADVANCED_PICKER_LIMIT = 100;
const selectedPassIds = new Set();
const selectedPoiIds  = new Set();

function currentStart() {
  if (startSel.value === "custom" && customStart) return customStart;
  return PRESET_STARTS[startSel.value];
}

function plannerButtonLabel() {
  return advancedModeEl.checked ? "Optimize selected route" : "Plan optimal tour";
}
function resetPlanButton() {
  planRunBtn.disabled = false;
  planRunBtn.textContent = plannerButtonLabel();
}
function setPlannerBusy(label = "Planning…") {
  planRunBtn.disabled = true;
  planRunBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${escapeHtml(label)}`;
}
function selectablePlannerPasses() {
  return PASSES.filter(p => p.baseA && p.baseB);
}
function selectablePlannerPois() {
  return PLANNABLE_POIS;
}
function selectedAdvancedPasses() {
  return [...selectedPassIds].map(id => PASS_BY_ID.get(id)).filter(p => p?.baseA && p?.baseB);
}
function selectedAdvancedPois() {
  return [...selectedPoiIds].map(id => POI_BY_ID.get(id)).filter(Boolean);
}
/* Mixed pass + POI list, in stable insertion order: passes first, then POIs.
   Order doesn't affect optimization (Held-Karp permutes everything) but it
   keeps the post-result rendering deterministic. */
function selectedAdvancedStops() {
  return [...selectedAdvancedPasses(), ...selectedAdvancedPois()];
}
function selectedAdvancedTotalCount() {
  return selectedPassIds.size + selectedPoiIds.size;
}
function advancedDefaultNote() {
  const count = selectedAdvancedTotalCount();
  if (count === 0) return "Advanced mode optimizes the shortest loop through every selected pass and POI, then returns to the start.";
  const passN = selectedPassIds.size, poiN = selectedPoiIds.size;
  const parts = [];
  if (passN) parts.push(`${passN} pass${passN === 1 ? "" : "es"}`);
  if (poiN)  parts.push(`${poiN} POI${poiN === 1 ? "" : "s"}`);
  return `Selected route will visit ${parts.join(" + ")} in the shortest optimized order.`;
}
function setAdvancedNote(message = advancedDefaultNote(), warn = false) {
  advancedPlannerNoteEl.textContent = message;
  advancedPlannerNoteEl.classList.toggle("warn", warn);
}
function passPickerMatches(p, q) {
  if (!q) return true;
  return `${p.name} ${p.alt || ""}`.toLowerCase().includes(q);
}
function poiPickerMatches(p, q) {
  if (!q) return true;
  return `${p.name} ${p.poiRegion || ""} ${(p.poiThemes || []).join(" ")}`.toLowerCase().includes(q);
}
function refreshSelectedCounters() {
  if (selectedStopCountEl) selectedStopCountEl.textContent = String(selectedAdvancedTotalCount());
  if (selectedPassMiniEl)  selectedPassMiniEl.textContent  = String(selectedPassIds.size);
  if (selectedPoiMiniEl)   selectedPoiMiniEl.textContent   = String(selectedPoiIds.size);
}
function renderAdvancedSelection() {
  const selected = selectedAdvancedPasses();
  selectedPassesEl.classList.toggle("empty", selected.length === 0);
  selectedPassesEl.innerHTML = selected.length
    ? selected.map(p => `
      <span class="selected-pass-chip">
        ${passIconHtml(p, "pass-art-icon chip symbol", "symbol")}
        <span title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <button type="button" data-remove-id="${escapeHtml(p.id)}" aria-label="Remove ${escapeHtml(p.name)}">×</button>
      </span>`).join("")
    : "No passes selected.";
  lazyLoadPassIcons(selectedPassesEl);
  refreshSelectedCounters();
  setAdvancedNote();
}
function renderAdvancedPoiSelection() {
  if (!selectedPoisEl) return;
  const selected = selectedAdvancedPois();
  selectedPoisEl.classList.toggle("empty", selected.length === 0);
  selectedPoisEl.innerHTML = selected.length
    ? selected.map(p => `
      <span class="selected-pass-chip poi-chip">
        <span class="chip-glyph" aria-hidden="true">${poiCategoryGlyph(p.poiCategory)}</span>
        <span title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <button type="button" data-remove-poi-id="${escapeHtml(p.id)}" aria-label="Remove ${escapeHtml(p.name)}">×</button>
      </span>`).join("")
    : "No sights selected.";
  refreshSelectedCounters();
  setAdvancedNote();
}
function renderAdvancedPicker() {
  const q = advancedPassSearchEl.value.trim().toLowerCase();
  const items = selectablePlannerPasses()
    .filter(passesAllFilters)
    .filter(p => passPickerMatches(p, q))
    .sort((a, b) => {
      const aSel = selectedPassIds.has(a.id) ? 1 : 0;
      const bSel = selectedPassIds.has(b.id) ? 1 : 0;
      if (aSel !== bSel) return bSel - aSel;
      if (!q && (a.quality || 0) !== (b.quality || 0)) return (b.quality || 0) - (a.quality || 0);
      return a.name.localeCompare(b.name);
    });
  const shown = items.slice(0, ADVANCED_PICKER_LIMIT);
  if (shown.length === 0) {
    advancedPassPickerEl.innerHTML = `<div class="pass-picker-empty">No selectable passes match.</div>`;
    return;
  }
  advancedPassPickerEl.innerHTML = shown.map(p => {
    const selected = selectedPassIds.has(p.id);
    const disabled = !selected && selectedAdvancedTotalCount() >= ADVANCED_MAX_STOPS;
    const status = passStatus(p);
    const label = listStatusLabel(status);
    const source = statusDisplay(status).sourceMeta.label;
    return `<label class="pass-picker-row pass-picker-pass-row${selected ? " selected" : ""}">
      <input type="checkbox" value="${escapeHtml(p.id)}"${selected ? " checked" : ""}${disabled ? " disabled" : ""}>
      ${passIconHtml(p, "pass-art-icon picker symbol", "symbol")}
      <span>
        <span class="pass-picker-name">${escapeHtml(p.name)} ${qualityStarsCompact(p.quality)}</span>
        <span class="pass-picker-meta">${p.elev} m · ${escapeHtml(label)} · ${escapeHtml(source)}</span>
      </span>
    </label>`;
  }).join("") + (items.length > shown.length
    ? `<div class="pass-picker-empty">${items.length - shown.length} more match${items.length - shown.length === 1 ? "" : "es"} — keep typing to narrow.</div>`
    : "");
  lazyLoadPassIcons(advancedPassPickerEl);
}
function renderAdvancedPoiPicker() {
  if (!advancedPoiPickerEl) return;
  const q = (advancedPoiSearchEl?.value || "").trim().toLowerCase();
  const region = advancedPoiRegionEl?.value || "";
  const cat = advancedPoiCategoryEl?.value || "";
  const theme = advancedPoiThemeEl?.value || "";
  const items = selectablePlannerPois()
    .filter(p => !region || p.poiRegion === region)
    .filter(p => !cat || p.poiCategory === cat)
    .filter(p => !theme || p.poiThemes.includes(theme))
    .filter(p => poiPickerMatches(p, q))
    .sort((a, b) => {
      const aSel = selectedPoiIds.has(a.id) ? 1 : 0;
      const bSel = selectedPoiIds.has(b.id) ? 1 : 0;
      if (aSel !== bSel) return bSel - aSel;
      if (!q && (a.quality || 0) !== (b.quality || 0)) return (b.quality || 0) - (a.quality || 0);
      return a.name.localeCompare(b.name);
    });
  const shown = items.slice(0, ADVANCED_PICKER_LIMIT);
  if (shown.length === 0) {
    advancedPoiPickerEl.innerHTML = `<div class="pass-picker-empty">No selectable sights match these filters.</div>`;
    return;
  }
  advancedPoiPickerEl.innerHTML = shown.map(p => {
    const selected = selectedPoiIds.has(p.id);
    const disabled = !selected && selectedAdvancedTotalCount() >= ADVANCED_MAX_STOPS;
    const dwell = p.visitDwellSec ? `${(p.visitDwellSec / 3600).toFixed(1)} h visit` : "";
    return `<label class="pass-picker-row poi-picker-row${selected ? " selected" : ""}">
      <input type="checkbox" value="${escapeHtml(p.id)}"${selected ? " checked" : ""}${disabled ? " disabled" : ""}>
      <span>
        <span class="pass-picker-name">${poiCategoryGlyph(p.poiCategory)} ${escapeHtml(p.name)} ${qualityStarsCompact(p.quality)}</span>
        <span class="pass-picker-meta">${escapeHtml(poiCategoryLabel(p.poiCategory))} · ${escapeHtml(p.poiRegion)}${dwell ? " · " + escapeHtml(dwell) : ""}</span>
      </span>
    </label>`;
  }).join("") + (items.length > shown.length
    ? `<div class="pass-picker-empty">${items.length - shown.length} more match${items.length - shown.length === 1 ? "" : "es"} — refine filters or search.</div>`
    : "");
}
function populatePoiFilterOptions() {
  if (!advancedPoiRegionEl) return;
  const regions = [...new Set(selectablePlannerPois().map(p => p.poiRegion).filter(Boolean))].sort();
  for (const r of regions) {
    const opt = document.createElement("option");
    opt.value = r; opt.textContent = r;
    advancedPoiRegionEl.appendChild(opt);
  }
  const cats = [...new Set(selectablePlannerPois().map(p => p.poiCategory).filter(Boolean))].sort();
  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = poiCategoryLabel(c);
    advancedPoiCategoryEl.appendChild(opt);
  }
  const themes = [...new Set(selectablePlannerPois().flatMap(p => p.poiThemes))].sort();
  for (const t of themes) {
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    advancedPoiThemeEl.appendChild(opt);
  }
}
function toggleSelectedPass(id, checked = !selectedPassIds.has(id)) {
  const p = PASS_BY_ID.get(id);
  if (!p?.baseA || !p?.baseB) return;
  if (checked) {
    if (!selectedPassIds.has(id) && selectedAdvancedTotalCount() >= ADVANCED_MAX_STOPS) {
      renderAdvancedPicker();
      setAdvancedNote(`Advanced mode supports up to ${ADVANCED_MAX_STOPS} stops at once. Clear one before adding another.`, true);
      return;
    }
    selectedPassIds.add(id);
  } else {
    selectedPassIds.delete(id);
  }
  renderAdvancedSelection();
  renderAdvancedPicker();
  renderAdvancedPoiPicker();
  if (typeof renderList === "function") renderList();
}
function toggleSelectedPoi(id, checked = !selectedPoiIds.has(id)) {
  const p = POI_BY_ID.get(id);
  if (!p || !PLANNABLE_POI_IDS.has(id)) return;
  if (checked) {
    if (!selectedPoiIds.has(id) && selectedAdvancedTotalCount() >= ADVANCED_MAX_STOPS) {
      renderAdvancedPoiPicker();
      setAdvancedNote(`Advanced mode supports up to ${ADVANCED_MAX_STOPS} stops at once. Clear one before adding another.`, true);
      return;
    }
    selectedPoiIds.add(id);
  } else {
    selectedPoiIds.delete(id);
  }
  renderAdvancedPoiSelection();
  renderAdvancedPoiPicker();
  renderAdvancedPicker();
  /* The sidebar POI list highlights selected rows when in advanced mode,
     so refresh it whenever selection state changes. */
  if (typeof renderPoiList === "function") renderPoiList();
}
function syncAdvancedMode() {
  const advanced = advancedModeEl.checked;
  advancedPlannerEl.hidden = !advanced;
  distSlider.disabled = advanced;
  timeSlider.disabled = advanced;
  openOnlyEl.disabled = advanced;
  if (includePoisEl) includePoisEl.disabled = advanced;
  /* The whole sights-prefs sub-card is hidden in advanced mode (advanced
     has its own POI picker). */
  if (poiPrefsEl) {
    poiPrefsEl.hidden = advanced || !includePoisEl?.checked;
    if (advanced) poiPrefsEl.open = false;
  }
  for (const r of targetModeRadios) r.disabled = advanced;
  distSlider.closest("label")?.classList.toggle("disabled", advanced);
  timeSlider.closest("label")?.classList.toggle("disabled", advanced);
  openOnlyEl.closest("label")?.classList.toggle("disabled", advanced);
  includePoisEl?.closest("label")?.classList.toggle("disabled", advanced);
  resetPlanButton();
  renderAdvancedSelection();
  renderAdvancedPicker();
  renderAdvancedPoiSelection();
  renderAdvancedPoiPicker();
  if (typeof renderList === "function") renderList();
  if (typeof renderPoiList === "function") renderPoiList();
}

/* ─────── V3: target-mode toggle, POI prefs UI, presets ─────── */
function syncTargetMode() {
  const mode = planTargetMode();
  if (distanceControlEl) distanceControlEl.hidden = mode !== "distance";
  if (timeControlEl)     timeControlEl.hidden     = mode !== "time";
  updateTimeTolHint();
}
function updateTimeTolHint() {
  if (!timeTolHint) return;
  const hours = +timeSlider.value;
  const half = Math.max(0.5, Math.min(2.0, hours * 0.15));
  timeTolHint.textContent = `(±${half.toFixed(half >= 1 ? 1 : 1)} h)`;
}
function fmtMinScoreLabel(v) { return `★ ${v}+`; }
function poiPrefsCurrentSubtitle() {
  if (activePresetId && POI_PRESETS[activePresetId]) {
    return POI_PRESETS[activePresetId].label;
  }
  const catCount = allowedPoiCategories.size;
  const themeCount = allowedPoiThemes.size;
  const cats = catCount === 0 ? "any category" : catCount === 1 ? "1 category" : `${catCount} categories`;
  const themes = themeCount === 0 ? "any theme" : themeCount === 1 ? "1 theme" : `${themeCount} themes`;
  return `Custom · ${cats} · ${themes} · ★ ${poiMinScoreVal()}+ · up to ${poiMaxCountVal()} sights`;
}
function refreshPoiPrefsSubtitle() {
  if (poiPrefsSubtitleEl) poiPrefsSubtitleEl.textContent = poiPrefsCurrentSubtitle();
}
function setActivePreset(id) {
  activePresetId = id;
  poiPresetsEl?.querySelectorAll("[data-preset]").forEach(b => {
    b.classList.toggle("active", b.dataset.preset === id);
  });
  refreshPoiPrefsSubtitle();
}
function clearActivePreset() {
  activePresetId = null;
  poiPresetsEl?.querySelectorAll("[data-preset]").forEach(b => b.classList.remove("active"));
  refreshPoiPrefsSubtitle();
}
function applyPoiPreset(id) {
  const p = POI_PRESETS[id];
  if (!p) return;
  allowedPoiCategories.clear();
  for (const c of p.cats) allowedPoiCategories.add(c);
  allowedPoiThemes.clear();
  for (const t of p.themes) allowedPoiThemes.add(t);
  poiMinScoreEl.value = String(p.minScore);
  poiMaxCountEl.value = String(p.maxCount);
  poiMinScoreLabelEl.textContent = fmtMinScoreLabel(p.minScore);
  poiMaxCountLabelEl.textContent = String(p.maxCount);
  renderPoiPrefsChips();
  setActivePreset(id);
}
function renderPoiPrefsChips() {
  if (!poiCatChipsEl) return;
  /* Categories — all 17, ordered by the dataset's natural frequency. */
  const catCounts = {};
  POIS.forEach(p => { catCounts[p.poiCategory] = (catCounts[p.poiCategory] || 0) + 1; });
  const cats = Object.keys(catCounts).sort((a, b) => catCounts[b] - catCounts[a]);
  poiCatChipsEl.innerHTML = cats.map(c => {
    const active = allowedPoiCategories.has(c);
    return `<button type="button" class="pref-chip${active ? " active" : ""}" data-cat="${escapeHtml(c)}" aria-pressed="${active}" title="${escapeHtml(poiCategoryLabel(c))}">${poiCategoryGlyph(c)} ${escapeHtml(poiCategoryLabel(c))}</button>`;
  }).join("");
  /* Themes — curated subset only. */
  poiThemeChipsEl.innerHTML = CURATED_PREF_THEMES.map(t => {
    const active = allowedPoiThemes.has(t);
    return `<button type="button" class="pref-chip${active ? " active" : ""}" data-theme="${escapeHtml(t)}" aria-pressed="${active}">${escapeHtml(t)}</button>`;
  }).join("");
}
renderPoiPrefsChips();
poiCatChipsEl?.addEventListener("click", e => {
  const btn = e.target.closest("[data-cat]");
  if (!btn) return;
  const cat = btn.dataset.cat;
  if (allowedPoiCategories.has(cat)) allowedPoiCategories.delete(cat);
  else allowedPoiCategories.add(cat);
  clearActivePreset();
  renderPoiPrefsChips();
});
poiThemeChipsEl?.addEventListener("click", e => {
  const btn = e.target.closest("[data-theme]");
  if (!btn) return;
  const t = btn.dataset.theme;
  if (allowedPoiThemes.has(t)) allowedPoiThemes.delete(t);
  else allowedPoiThemes.add(t);
  clearActivePreset();
  renderPoiPrefsChips();
});
poiPresetsEl?.addEventListener("click", e => {
  const btn = e.target.closest("[data-preset]");
  if (!btn) return;
  applyPoiPreset(btn.dataset.preset);
});
poiMinScoreEl?.addEventListener("input", () => {
  poiMinScoreLabelEl.textContent = fmtMinScoreLabel(poiMinScoreVal());
  clearActivePreset();
});
poiMaxCountEl?.addEventListener("input", () => {
  poiMaxCountLabelEl.textContent = String(poiMaxCountVal());
  clearActivePreset();
});

distSlider.addEventListener("input", () => { distLabel.textContent = `${distSlider.value} km`; });
timeSlider?.addEventListener("input", () => {
  const v = +timeSlider.value;
  if (timeLabel) timeLabel.textContent = v % 1 === 0 ? `${v} h` : `${v.toFixed(1)} h`;
  updateTimeTolHint();
});
for (const r of targetModeRadios) r.addEventListener("change", syncTargetMode);
includePoisEl?.addEventListener("change", () => {
  if (poiPrefsEl) poiPrefsEl.hidden = !includePoisEl.checked || advancedModeEl.checked;
});
syncTargetMode();
updateTimeTolHint();
planDateEl?.addEventListener("change", () => {
  updateTripDateHint();
  refreshProjectedStatuses({ updateMarkers: true });
  if (!planResult.classList.contains("empty")) {
    clearPlannedTour();
    planResult.innerHTML = `<div class="warn">Trip date changed to ${escapeHtml(formatTripDate(currentTripDate()))}. Run the planner again to optimize against the updated pass expectations.</div>`;
  }
});
planRunBtn.addEventListener("click", () => planTour());
advancedModeEl.addEventListener("change", syncAdvancedMode);
advancedPassSearchEl.addEventListener("input", renderAdvancedPicker);
advancedPassPickerEl.addEventListener("change", e => {
  if (e.target.matches('input[type="checkbox"]')) toggleSelectedPass(e.target.value, e.target.checked);
});
selectedPassesEl.addEventListener("click", e => {
  const btn = e.target.closest("button[data-remove-id]");
  if (btn) toggleSelectedPass(btn.dataset.removeId, false);
});
/* POI picker wiring (mirrors the pass picker). */
advancedPoiSearchEl?.addEventListener("input", renderAdvancedPoiPicker);
advancedPoiRegionEl?.addEventListener("change", renderAdvancedPoiPicker);
advancedPoiCategoryEl?.addEventListener("change", renderAdvancedPoiPicker);
advancedPoiThemeEl?.addEventListener("change", renderAdvancedPoiPicker);
advancedPoiPickerEl?.addEventListener("change", e => {
  if (e.target.matches('input[type="checkbox"]')) toggleSelectedPoi(e.target.value, e.target.checked);
});
selectedPoisEl?.addEventListener("click", e => {
  const btn = e.target.closest("button[data-remove-poi-id]");
  if (btn) toggleSelectedPoi(btn.dataset.removePoiId, false);
});
clearSelectedPassesBtn.addEventListener("click", () => {
  selectedPassIds.clear();
  selectedPoiIds.clear();
  renderAdvancedSelection();
  renderAdvancedPicker();
  renderAdvancedPoiSelection();
  renderAdvancedPoiPicker();
  renderList();
});
populatePoiFilterOptions();

let pickingStart = false;
function syncPickButtonState() {
  document.body.classList.toggle("picking", pickingStart);
  planPickBtn.classList.toggle("active", pickingStart);
  planPickBtn.setAttribute("aria-pressed", String(pickingStart));
}

planPickBtn.addEventListener("click", () => {
  pickingStart = !pickingStart;
  syncPickButtonState();
});
map.on("click", (e) => {
  if (!pickingStart) return;
  customStart = { name: `Custom (${e.latlng.lat.toFixed(3)}, ${e.latlng.lng.toFixed(3)})`,
                  lat: e.latlng.lat, lon: e.latlng.lng };
  let opt = startSel.querySelector('option[value="custom"]');
  opt.disabled = false;
  opt.textContent = "📍 " + customStart.name;
  startSel.value = "custom";
  pickingStart = false;
  syncPickButtonState();
});

function clearPlannedTour() {
  if (plannedLayer) { map.removeLayer(plannedLayer); plannedLayer = null; }
  if (plannedStartMarker) { map.removeLayer(plannedStartMarker); plannedStartMarker = null; }
  const oldTourIds = plannedTourIds;
  plannedTourIds = [];
  oldTourIds.forEach(id => {
    /* IDs may be either a pass ("p<i>") or a POI ("poi<i>"); reset whichever
       this id maps to. */
    const pass = PASS_BY_ID.get(id);
    if (pass && pass._marker) {
      updatePassMarkerIcon(pass);
      pass._marker.setZIndexOffset(0);
      return;
    }
    const poi = POI_BY_ID.get(id);
    if (poi && poi._marker) {
      poi._marker.setIcon(makePoiIcon(poi));
      poi._marker.setZIndexOffset(0);
    }
  });
}

async function fetchTable(points) {
  const coords = points.map(p => `${p.lon},${p.lat}`).join(";");
  return osrmTable(coords);
}

/* ───────────────────── OSRM caching helpers ─────────────────────
   Repeat tour-plans with the same start + candidates hit OSRM
   unnecessarily.  Cache table + route results in localStorage keyed by
   a short hash of the coordinate string.  TTLs are long because road
   networks rarely change. */
const OSRM_TABLE_TTL = 7  * 24 * 60 * 60 * 1000;   // 7 days
const OSRM_ROUTE_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days

/* Lightweight 32-bit FNV-1a hash → base36 string. */
function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/* In-flight request deduplication: if user clicks Plan twice quickly, share
   one outstanding fetch instead of firing two. */
const inFlight = new Map();
function dedupe(key, factory) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = factory().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function osrmTable(coordsStr) {
  const key = `alps:osrm:t:${shortHash(coordsStr)}`;
  const cached = cacheGet(key, OSRM_TABLE_TTL);
  if (cached) { console.log("osrm table: cache hit"); return cached; }
  return dedupe(key, async () => {
    const url = `https://router.project-osrm.org/table/v1/driving/${coordsStr}?annotations=distance,duration`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.code !== "Ok") throw new Error("OSRM table " + j.code);
    const out = { dist: j.distances, dur: j.durations };
    cacheSet(key, out);
    return out;
  });
}

async function osrmRoute(coordsStr) {
  const key = `alps:osrm:r:${shortHash(coordsStr)}`;
  const cached = cacheGet(key, OSRM_ROUTE_TTL);
  if (cached) { console.log("osrm route: cache hit"); return cached; }
  return dedupe(key, async () => {
    const url = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`;
    const r = await fetch(url);
    const j = await r.json();
    if (!j.routes || j.code !== "Ok") throw new Error("OSRM route " + j.code);
    const out = {
      geom: j.routes[0].geometry.coordinates,
      distanceKm: Math.round(j.routes[0].distance / 1000),
      durationH: +(j.routes[0].duration / 3600).toFixed(1),
    };
    cacheSet(key, out);
    return out;
  });
}

/* Asymmetric Held-Karp DP for tours where each pass can be:
     • traversed A→B  (enter side A, exit side B)
     • traversed B→A
     • visited out-and-back from A  (enter A, exit A, summit between)
     • visited out-and-back from B
   The DP state's "exit side" tells us which side we leave from, but the
   cost/quality of the visit depends on entry-and-exit pair.

   Matrix layout: 1 + 3N nodes
     index 0           = start
     index 1 + 3*i     = pass i, base A (valley start of climb on side A)
     index 2 + 3*i     = pass i, summit
     index 3 + 3*i     = pass i, base B

   `passQ[i] = { qSummit, qApproach }` for candidate i.
   Quality earned per visit:
     traverse A→B or B→A:  2 * qApproach + qSummit
     out-and-back A or B:  qApproach + qSummit

   Cost per visit (read from matrix):
     traverse A→B:  d(prev, baseA) + d(baseA, summit) + d(summit, baseB)
     out-back A:    d(prev, baseA) + d(baseA, summit) + d(summit, baseA)

   Returns: { perm: [{passIdx, enterSide, exitSide, mode}], km, h, k,
              totalQuality, inRange, modes } */

/* Quality scoring knobs for bestTourGated. Without these, traceQuality
   is a raw sum and the planner stuffs the route with mediocre filler.
     PASS_QUALITY_POWER         exponent on per-visit raw quality. >1
                                emphasises individual pass quality over
                                headcount.
     PASS_PER_VISIT_COST        flat cost subtracted per pass. Sub-median
                                passes contribute negatively, so they
                                only get added when they meaningfully
                                fill out a tour.
     OUT_AND_BACK_RETRACE_PENALTY
                                extra hit for visiting a pass as out-and-
                                back: the car drives the same approach
                                road up and down. Pushes the planner to
                                prefer traversals (different roads in /
                                out) wherever a through-pass exists.
     SHARED_GATEWAY_KM /
     SHARED_GATEWAY_PENALTY     each pair of passes in a tour whose closest
                                approach gateways sit within this km
                                threshold gets penalised. Catches "drove
                                the same valley twice" cases (passes that
                                share a connector road) without needing
                                actual route-segment matching. */
const PASS_QUALITY_POWER = 4;
const PASS_PER_VISIT_COST = 1.5;
const OUT_AND_BACK_RETRACE_PENALTY = 2.5;
const SHARED_GATEWAY_KM = 5;
const SHARED_GATEWAY_PENALTY = 2.0;

/* Pre-compute an N×N flag matrix marking which candidate passes have
   approach gateways close enough that any tour visiting both would
   likely retrace the same connector valley. Uses haversine on the
   four base-pair distances (bA-bA, bA-bB, bB-bA, bB-bB) — true
   road-distance overlap detection would need actual route geometry,
   but proximity of the bases is a strong proxy for "shares a valley". */
function computeSharedGatewayFlags(candidates) {
  const N = candidates.length;
  const flags = Array.from({ length: N }, () => new Uint8Array(N));
  for (let i = 0; i < N; i++) {
    const A = candidates[i];
    /* POIs are single-point stops — no baseA/baseB pair, no shared-valley
       concept. Treat them as "no shared gateway" with anything. */
    if (A.isPoi) continue;
    if (!A.baseA || !A.baseB) continue;
    for (let j = i + 1; j < N; j++) {
      const B = candidates[j];
      if (B.isPoi) continue;
      if (!B.baseA || !B.baseB) continue;
      const dMin = Math.min(
        haversine(A.baseA, B.baseA),
        haversine(A.baseA, B.baseB),
        haversine(A.baseB, B.baseA),
        haversine(A.baseB, B.baseB),
      );
      if (dMin < SHARED_GATEWAY_KM) {
        flags[i][j] = flags[j][i] = 1;
      }
    }
  }
  return flags;
}

function bestTourGated(matrix, N, targetKm, tolerance, maxPasses, passQ, sharedFlags, stops) {
  const cap = Math.min(maxPasses, N);
  if (N === 0) return null;
  const lo = targetKm * (1 - tolerance) * 1000;
  const hi = targetKm * (1 + tolerance) * 1000;
  const SIZE = 1 << N;
  const dist = matrix.dist;
  const Q = passQ || new Array(N).fill({ qSummit: 0.5, qApproach: 0.5 });
  /* Matrix index helper: pass i, point p ∈ {0=A, 1=summit, 2=B}. */
  const mi = (i, p) => 1 + 3 * i + p;
  const baseA = (i) => mi(i, 0), summit = (i) => mi(i, 1), baseB = (i) => mi(i, 2);
  /* Per-stop POI flag — used to branch the quality formula and skip the
     out-and-back retrace penalty for POIs (a POI is one point; there's no
     "back" to trace). */
  const isPoi = (i) => !!stops?.[i]?.isPoi;

  /* Per-visit cost: enterSide∈{0,1}=A/B, exitSide∈{0,1}=A/B.
     Internal traversal: enterBase → summit → exitBase. */
  function visitCost(i, enterSide, exitSide) {
    const enterIdx = enterSide === 0 ? baseA(i) : baseB(i);
    const exitIdx  = exitSide  === 0 ? baseA(i) : baseB(i);
    return dist[enterIdx][summit(i)] + dist[summit(i)][exitIdx];
  }
  function visitDur(i, enterSide, exitSide) {
    const enterIdx = enterSide === 0 ? baseA(i) : baseB(i);
    const exitIdx  = exitSide  === 0 ? baseA(i) : baseB(i);
    return matrix.dur[enterIdx][summit(i)] + matrix.dur[summit(i)][exitIdx];
  }
  function visitQuality(i, enterSide, exitSide) {
    const q = Q[i];
    if (isPoi(i)) {
      /* POI quality: sc/10 ∈ [0.5, 1.0]; q.qApproach is always 0.
         Add a 0.5 baseline so a sc=10 POI clears the per-visit cost (the
         offset represents the journey-to-the-POI being worth ~0.5 quality
         units even before the "summit" itself). Subtract a per-hour dwell
         penalty so 5-hour POIs are pricier than 1-hour ones — without
         this, the optimizer would always pick the highest-score POI
         regardless of how long it takes to visit. Calibrated against the
         current pass formula (POWER=4, COST=1.5):
           sc=10, dwell 1.5h → (1.5)^4 - 1.5 - 0.9 = 2.66
           sc=10, dwell 4h   → (1.5)^4 - 1.5 - 2.4 = 1.16
           sc=8,  dwell 1.5h → (1.3)^4 - 1.5 - 0.9 = 0.46
           sc=5,  dwell 1h   → (1.0)^4 - 1.5 - 0.6 = -1.10  (skipped)
         Median pass (qSm=qAp=0.7 traversed) gives ~17.95, so passes still
         dominate ~5–10× per slot — POIs only win on cost, never quality. */
      const dwellHours = (stops[i].visitDwellSec || 0) / 3600;
      return Math.pow(q.qSummit + 0.5, PASS_QUALITY_POWER) - PASS_PER_VISIT_COST - dwellHours * 0.6;
    }
    const outAndBack = enterSide === exitSide;
    const raw = outAndBack
      ? q.qApproach + q.qSummit       // out-and-back: one approach + summit
      : 2 * q.qApproach + q.qSummit;  // traversal: both approaches + summit
    /* Cube transform + per-pass cost so the planner stops stuffing the
       route with low-quality filler. Without this, traceQuality is a
       pure sum of raw quality and an extra mediocre pass *always* lifts
       the score, leading to e.g. five Pre-Alps cols beating one Klausen.
       The cube emphasises individual pass quality (a 0.9-quality pass is
       ~3× more valuable than a 0.6-quality pass instead of 1.5×); the
       constant cost makes a sub-median pass hurt the tour score.
       The retrace penalty discourages out-and-back even further: the
       quality already drops (1× approach instead of 2×) but driving the
       same road twice deserves an explicit hit on top of that. */
    let v = Math.pow(raw, PASS_QUALITY_POWER) - PASS_PER_VISIT_COST;
    if (outAndBack) v -= OUT_AND_BACK_RETRACE_PENALTY;
    return v;
  }

  /* g[mask*N*2 + i*2 + s] = min metres tour-segment cost reaching exit-side
     `s` of pass `i`, having visited exactly `mask`.  We pick the visit-mode
     greedily: for each (predecessor, enterSide), minimise total cost. */
  const g = new Float64Array(SIZE * N * 2);
  g.fill(Infinity);
  /* Track chosen enterSide for reconstruction. */
  const enterSideChosen = new Int8Array(SIZE * N * 2);

  /* Base case: start → pass i, exit side `s` via either entry side. */
  for (let i = 0; i < N; i++) {
    for (let s = 0; s < 2; s++) {
      let best = Infinity, bestEnter = -1;
      for (let e = 0; e < 2; e++) {
        const enterIdx = e === 0 ? baseA(i) : baseB(i);
        const cost = dist[0][enterIdx] + visitCost(i, e, s);
        if (cost < best) { best = cost; bestEnter = e; }
      }
      const k = (1 << i) * N * 2 + i * 2 + s;
      g[k] = best;
      enterSideChosen[k] = bestEnter;
    }
  }

  /* Fill in by popcount(mask) ascending. */
  for (let mask = 1; mask < SIZE; mask++) {
    const pc = popcount(mask);
    if (pc > cap || pc >= cap) continue;     // can still extend?  pc<cap
    for (let i = 0; i < N; i++) {
      if (!(mask & (1 << i))) continue;
      for (let s = 0; s < 2; s++) {
        const cur = g[mask * N * 2 + i * 2 + s];
        if (!isFinite(cur)) continue;
        const fromIdx = s === 0 ? baseA(i) : baseB(i);
        for (let j = 0; j < N; j++) {
          if (mask & (1 << j)) continue;
          for (let s2 = 0; s2 < 2; s2++) {
            const newMask = mask | (1 << j);
            let best = Infinity, bestEnter = -1;
            for (let e = 0; e < 2; e++) {
              const enterIdx = e === 0 ? baseA(j) : baseB(j);
              const cost = cur + dist[fromIdx][enterIdx] + visitCost(j, e, s2);
              if (cost < best) { best = cost; bestEnter = e; }
            }
            const idx = newMask * N * 2 + j * 2 + s2;
            if (best < g[idx]) { g[idx] = best; enterSideChosen[idx] = bestEnter; }
          }
        }
      }
    }
  }

  /* Mask quality cache — depends on enterSide==exitSide for each pass.
     We can't precompute this on the mask alone since visit modes are
     per-state. So we compute total quality during reconstruction. */

  /* Find best closing tour.
     Two distinct selection rules:
       - bestSol  (in budget):  maximise quality + small closeness tiebreak
       - fallback (out of bud): minimise distance from target — quality
                                does NOT compensate for blowing the budget. */
  /* Cache the shared-gateway penalty per mask. Each mask's penalty is
     intrinsic to its set of passes; (lastI, lastS) doesn't change it. */
  const sharedPenaltyByMask = sharedFlags ? new Float32Array(SIZE) : null;
  function maskSharedPenalty(mask) {
    if (!sharedFlags) return 0;
    if (sharedPenaltyByMask[mask] !== 0) return sharedPenaltyByMask[mask];
    let count = 0;
    for (let i = 0; i < N; i++) {
      if (!(mask & (1 << i))) continue;
      for (let j = i + 1; j < N; j++) {
        if ((mask & (1 << j)) && sharedFlags[i][j]) count++;
      }
    }
    const p = count * SHARED_GATEWAY_PENALTY;
    sharedPenaltyByMask[mask] = p || -1e-9;  /* sentinel "computed=zero" */
    return p;
  }

  let bestSol = null, fallback = null;
  for (let mask = 1; mask < SIZE; mask++) {
    const k = popcount(mask);
    if (k > cap) continue;
    for (let i = 0; i < N; i++) {
      if (!(mask & (1 << i))) continue;
      for (let s = 0; s < 2; s++) {
        const v = g[mask * N * 2 + i * 2 + s];
        if (!isFinite(v)) continue;
        const exitIdx = s === 0 ? baseA(i) : baseB(i);
        const total = v + dist[exitIdx][0];
        if (!isFinite(total)) continue;

        const inRange = total >= lo && total <= hi;
        if (inRange) {
          const traceQ = traceQuality(mask, i, s);
          const sharedPenalty = maskSharedPenalty(mask);
          const closeness = -Math.abs(total - targetKm * 1000) / 1000;
          const score = (traceQ - sharedPenalty) * 1e6 + closeness;
          if (!bestSol || score > bestSol.score) {
            bestSol = { mask, total, lastI: i, lastS: s, k, quality: traceQ, score, inRange: true };
          }
        } else {
          /* Fallback: pick by distance closeness only.  Skip computing
             quality (slow walk-back) unless this becomes the chosen one. */
          const closeness = -Math.abs(total - targetKm * 1000) / 1000;
          if (!fallback || closeness > fallback.score) {
            fallback = { mask, total, lastI: i, lastS: s, k, quality: 0, score: closeness, inRange: false };
          }
        }
      }
    }
  }
  let sol = bestSol;
  if (!sol) {
    sol = fallback;
    if (sol) sol.quality = traceQuality(sol.mask, sol.lastI, sol.lastS);
  }
  if (!sol) return null;

  /* Reconstruct tour with visit modes. */
  function traceQuality(mask, i, s) {
    let q = 0;
    let curMask = mask, curI = i, curS = s;
    while (true) {
      const e = enterSideChosen[curMask * N * 2 + curI * 2 + curS];
      q += visitQuality(curI, e, curS);
      const subMask = curMask ^ (1 << curI);
      if (subMask === 0) return q;
      const pred = findPredecessor(curMask, curI, curS, e);
      if (!pred) return q;
      curMask = subMask; curI = pred.j; curS = pred.sp;
    }
  }
  function findPredecessor(curMask, curI, curS, enterSide) {
    /* Find (j, sp) such that g[subMask][j][sp] + d(exit_j_sp, enter_curI)
       + visitCost(curI, enterSide, curS) == g[curMask][curI][curS] */
    const subMask = curMask ^ (1 << curI);
    if (subMask === 0) return null;
    const enterIdx = enterSide === 0 ? baseA(curI) : baseB(curI);
    const targetVal = g[curMask * N * 2 + curI * 2 + curS];
    const internal = visitCost(curI, enterSide, curS);
    for (let j = 0; j < N; j++) {
      if (!(subMask & (1 << j))) continue;
      for (let sp = 0; sp < 2; sp++) {
        const v = g[subMask * N * 2 + j * 2 + sp];
        if (!isFinite(v)) continue;
        const fromIdx = sp === 0 ? baseA(j) : baseB(j);
        const recon = v + dist[fromIdx][enterIdx] + internal;
        if (Math.abs(recon - targetVal) < 1e-3) return { j, sp };
      }
    }
    return null;
  }

  /* Re-walk for the actual tour list. */
  const tour = [];
  let curMask = sol.mask, curI = sol.lastI, curS = sol.lastS;
  while (true) {
    const enterSide = enterSideChosen[curMask * N * 2 + curI * 2 + curS];
    const mode = (enterSide === curS) ? "out-and-back" : "traverse";
    tour.unshift({ passIdx: curI, enterSide, exitSide: curS, mode });
    const subMask = curMask ^ (1 << curI);
    if (subMask === 0) break;
    const pred = findPredecessor(curMask, curI, curS, enterSide);
    if (!pred) break;
    curMask = subMask; curI = pred.j; curS = pred.sp;
  }

  /* Canonicalise POI mode: enterSide/exitSide are arbitrary tie-breaks for
     a single-point stop, and `mode="out-and-back"|"traverse"` is meaningless
     for a POI. Force a single canonical form so renderers and validators
     don't see nonsense. (Same fix as bestExactSelectedTour for advanced
     mode — rubber-duck blocking #1.) */
  if (stops) {
    for (const t of tour) {
      if (stops[t.passIdx]?.isPoi) {
        t.enterSide = 0;
        t.exitSide = 0;
        t.mode = "poi";
      }
    }
  }

  /* Total duration along the chosen tour, split into driving (matrix) vs.
     dwell (POI visit time). Never collapse them — auto-discovery's UI
     surfaces the breakdown when dwellH > 0 (rubber-duck blocking #2). */
  const dur = matrix.dur;
  let totalDriveS = 0, totalDwellS = 0, prevIdx = 0;
  for (const t of tour) {
    const enterIdx = t.enterSide === 0 ? baseA(t.passIdx) : baseB(t.passIdx);
    const exitIdx  = t.exitSide  === 0 ? baseA(t.passIdx) : baseB(t.passIdx);
    totalDriveS += dur[prevIdx][enterIdx];
    totalDriveS += visitDur(t.passIdx, t.enterSide, t.exitSide);
    if (stops?.[t.passIdx]?.isPoi) {
      totalDwellS += stops[t.passIdx].visitDwellSec || 0;
    }
    prevIdx = exitIdx;
  }
  totalDriveS += dur[prevIdx][0];

  return {
    perm: tour,
    km: sol.total / 1000,
    h: totalDriveS / 3600,
    driveH: totalDriveS / 3600,
    dwellH: totalDwellS / 3600,
    totalH: (totalDriveS + totalDwellS) / 3600,
    k: sol.k,
    totalQuality: sol.quality,
    score: sol.score,
    inRange: sol.inRange,
  };
}

function matrixValue(table, from, to) {
  const v = table?.[from]?.[to];
  return Number.isFinite(v) ? v : Infinity;
}

/* Exact advanced-mode optimizer: visit every selected pass once, choose each
   pass direction/out-and-back mode, and minimize the closed-loop distance. */
function bestExactSelectedTour(matrix, N, passQ, stops) {
  if (N === 0) return null;
  const SIZE = 1 << N;
  const fullMask = SIZE - 1;
  const dist = matrix.dist;
  const dur = matrix.dur;
  const Q = passQ || new Array(N).fill({ qSummit: 0.5, qApproach: 0.5 });

  const mi = (i, p) => 1 + 3 * i + p;
  const baseA = (i) => mi(i, 0), summit = (i) => mi(i, 1), baseB = (i) => mi(i, 2);
  const stateIdx = (mask, i, side) => mask * N * 2 + i * 2 + side;
  const sideIdx = (i, side) => side === 0 ? baseA(i) : baseB(i);

  function visitCost(i, enterSide, exitSide) {
    return matrixValue(dist, sideIdx(i, enterSide), summit(i)) +
           matrixValue(dist, summit(i), sideIdx(i, exitSide));
  }
  function visitDur(i, enterSide, exitSide) {
    return matrixValue(dur, sideIdx(i, enterSide), summit(i)) +
           matrixValue(dur, summit(i), sideIdx(i, exitSide));
  }
  function visitQuality(i, enterSide, exitSide) {
    const q = Q[i];
    const outAndBack = enterSide === exitSide;
    const raw = outAndBack
      ? q.qApproach + q.qSummit
      : 2 * q.qApproach + q.qSummit;
    let v = Math.pow(raw, PASS_QUALITY_POWER) - PASS_PER_VISIT_COST;
    if (outAndBack) v -= OUT_AND_BACK_RETRACE_PENALTY;
    return v;
  }

  const g = new Float64Array(SIZE * N * 2);
  g.fill(Infinity);
  const prevPass = new Int16Array(SIZE * N * 2);
  const prevSide = new Int8Array(SIZE * N * 2);
  const enterSideChosen = new Int8Array(SIZE * N * 2);
  prevPass.fill(-1);
  prevSide.fill(-1);
  enterSideChosen.fill(-1);

  for (let i = 0; i < N; i++) {
    for (let exitSide = 0; exitSide < 2; exitSide++) {
      let best = Infinity, bestEnter = -1;
      for (let enterSide = 0; enterSide < 2; enterSide++) {
        const cost = matrixValue(dist, 0, sideIdx(i, enterSide)) + visitCost(i, enterSide, exitSide);
        if (cost < best) { best = cost; bestEnter = enterSide; }
      }
      const idx = stateIdx(1 << i, i, exitSide);
      g[idx] = best;
      enterSideChosen[idx] = bestEnter;
    }
  }

  for (let mask = 1; mask < SIZE; mask++) {
    for (let i = 0; i < N; i++) {
      if (!(mask & (1 << i))) continue;
      for (let exitSide = 0; exitSide < 2; exitSide++) {
        const curIdx = stateIdx(mask, i, exitSide);
        const cur = g[curIdx];
        if (!isFinite(cur)) continue;
        const fromIdx = sideIdx(i, exitSide);
        for (let j = 0; j < N; j++) {
          if (mask & (1 << j)) continue;
          const newMask = mask | (1 << j);
          for (let nextExitSide = 0; nextExitSide < 2; nextExitSide++) {
            for (let nextEnterSide = 0; nextEnterSide < 2; nextEnterSide++) {
              const cost = cur +
                matrixValue(dist, fromIdx, sideIdx(j, nextEnterSide)) +
                visitCost(j, nextEnterSide, nextExitSide);
              const nextIdx = stateIdx(newMask, j, nextExitSide);
              if (cost < g[nextIdx]) {
                g[nextIdx] = cost;
                prevPass[nextIdx] = i;
                prevSide[nextIdx] = exitSide;
                enterSideChosen[nextIdx] = nextEnterSide;
              }
            }
          }
        }
      }
    }
  }

  let bestTotal = Infinity, lastI = -1, lastSide = -1;
  for (let i = 0; i < N; i++) {
    for (let exitSide = 0; exitSide < 2; exitSide++) {
      const idx = stateIdx(fullMask, i, exitSide);
      const total = g[idx] + matrixValue(dist, sideIdx(i, exitSide), 0);
      if (total < bestTotal) {
        bestTotal = total;
        lastI = i;
        lastSide = exitSide;
      }
    }
  }
  if (!isFinite(bestTotal)) return null;

  const tour = [];
  let mask = fullMask, curI = lastI, curSide = lastSide;
  while (curI >= 0) {
    const idx = stateIdx(mask, curI, curSide);
    const enterSide = enterSideChosen[idx];
    tour.unshift({
      passIdx: curI,
      enterSide,
      exitSide: curSide,
      mode: enterSide === curSide ? "out-and-back" : "traverse",
    });
    const prevI = prevPass[idx];
    const prevS = prevSide[idx];
    mask ^= (1 << curI);
    curI = prevI;
    curSide = prevS;
  }

  /* CANONICALIZE POI MODE — rubber-duck blocking #1.
     For a POI we have baseA == baseB == summit, so all four (enterSide,
     exitSide) combinations have identical cost and the DP picks one
     arbitrarily based on tie-break order. The reconstructed mode label
     ("traverse" / "out-and-back") would therefore be meaningless. Force
     a single canonical representation so downstream code can rely on it. */
  if (stops) {
    for (const t of tour) {
      if (stops[t.passIdx]?.isPoi) {
        t.enterSide = 0;
        t.exitSide = 0;
        t.mode = "poi";
      }
    }
  }

  let totalDriveS = 0, totalDwellS = 0, totalQuality = 0, prevIdx = 0;
  for (const t of tour) {
    const enterIdx = sideIdx(t.passIdx, t.enterSide);
    const exitIdx = sideIdx(t.passIdx, t.exitSide);
    totalDriveS += matrixValue(dur, prevIdx, enterIdx);
    totalDriveS += visitDur(t.passIdx, t.enterSide, t.exitSide);
    totalQuality += visitQuality(t.passIdx, t.enterSide, t.exitSide);
    if (stops?.[t.passIdx]?.isPoi) {
      totalDwellS += stops[t.passIdx].visitDwellSec || 0;
    }
    prevIdx = exitIdx;
  }
  totalDriveS += matrixValue(dur, prevIdx, 0);

  return {
    perm: tour,
    km: bestTotal / 1000,
    h: totalDriveS / 3600,
    driveH: totalDriveS / 3600,
    dwellH: totalDwellS / 3600,
    totalH: (totalDriveS + totalDwellS) / 3600,
    k: N,
    totalQuality,
    inRange: true,
    exact: true,
  };
}

function popcount(n) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/* Legacy brute-force, kept only for reference / fallback at very large N. */
function bestTour(matrix, N, targetKm, tolerance, maxPasses) {
  const cap = Math.min(maxPasses, N);
  const lo = targetKm * (1 - tolerance), hi = targetKm * (1 + tolerance);
  let best = null, fallback = null;
  const consider = (perm, km, h) => {
    const k = perm.length, closeness = -Math.abs(km - targetKm);
    if (km >= lo && km <= hi) {
      const score = k * 1e6 + closeness;
      if (!best || score > best.score) best = { perm: perm.slice(), km, h, k, score, inRange: true };
    }
    if (!fallback || closeness > fallback.score)
      fallback = { perm: perm.slice(), km, h, k, score: closeness, inRange: false };
  };
  function permsOf(items, remaining, prefix) {
    if (remaining === 0) {
      let totalM = 0, totalS = 0, prev = 0;
      for (const i of prefix) {
        totalM += matrix.dist[prev][i+1]; totalS += matrix.dur[prev][i+1]; prev = i+1;
      }
      totalM += matrix.dist[prev][0]; totalS += matrix.dur[prev][0];
      consider(prefix, totalM/1000, totalS/3600);
      return;
    }
    for (let i = 0; i < items.length; i++) {
      prefix.push(items[i]);
      permsOf(items.slice(0,i).concat(items.slice(i+1)), remaining - 1, prefix);
      prefix.pop();
    }
  }
  const all = Array.from({length: N}, (_, i) => i);
  for (let k = cap; k >= 1; k--) {
    permsOf(all, k, []);
    if (best && best.k === k) break;
  }
  return best || fallback;
}

const PLANNER_MAX_CANDIDATES = 15;
const PLANNER_MAX_PASSES = 6;

function plannerPointsForPasses(start, stops) {
  /* Stops can be passes (3 distinct points: baseA, summit, baseB) or POIs
     (3 identical copies of lat/lon since baseA == baseB == summit). The
     duplication wastes 2 OSRM matrix entries per POI but lets the existing
     1+3N matrix layout work unchanged. */
  const points = [start];
  stops.forEach(p => {
    points.push({ lat: p.baseA.lat, lon: p.baseA.lon });
    points.push({ lat: p.lat,        lon: p.lon       });
    points.push({ lat: p.baseB.lat, lon: p.baseB.lon });
  });
  return points;
}

function waypointsForTour(start, stops, perm) {
  /* For OSRM route geometry we send one point per POI (not three duplicates)
     so the rendered polyline doesn't wiggle. Passes still send all three
     points so OSRM is forced to climb the actual pass road.

     Use `tourWaypointPlan` instead if you also need the matching matrix
     indices — keeping these in lock-step is critical for the close-pass
     validate-repair loop. */
  return tourWaypointPlan(start, stops, perm).waypoints;
}

/* Build the canonical (waypoints, wpMatrixIdx) pair for a planned tour.
   `wpMatrixIdx[i]` is the matrix-row that corresponds to `waypoints[i]`,
   so callers can map a polyline leg back to a matrix edge without
   duplicating expansion logic (rubber-duck blocking #1). */
function tourWaypointPlan(start, stops, perm) {
  const waypoints = [[start.lat, start.lon]];
  const wpMatrixIdx = [0];
  perm.forEach(t => {
    const p = stops[t.passIdx];
    if (p.isPoi) {
      /* POI: one point. Matrix row 1 + 3*i + 1 (the "summit" slot — all
         three slots have identical coordinates so any works, but the
         summit slot is the canonical one. */
      waypoints.push([p.lat, p.lon]);
      wpMatrixIdx.push(1 + 3 * t.passIdx + 1);
      return;
    }
    const enter = t.enterSide === 0 ? p.baseA : p.baseB;
    const exit  = t.exitSide  === 0 ? p.baseA : p.baseB;
    waypoints.push([enter.lat, enter.lon]);
    wpMatrixIdx.push(1 + 3 * t.passIdx + t.enterSide * 2);
    waypoints.push([p.lat, p.lon]);
    wpMatrixIdx.push(1 + 3 * t.passIdx + 1);
    waypoints.push([exit.lat, exit.lon]);
    wpMatrixIdx.push(1 + 3 * t.passIdx + t.exitSide  * 2);
  });
  waypoints.push([start.lat, start.lon]);
  wpMatrixIdx.push(0);
  return { waypoints, wpMatrixIdx };
}

function coordsFromWaypoints(waypoints) {
  return waypoints.map(([la, lo]) => `${lo},${la}`).join(";");
}

function advancedStatusWarning(tourStops) {
  /* POIs don't have a road-status concept — only filter passes. */
  const flagged = tourStops.filter(p => !p.isPoi).filter(p => {
    const d = statusDisplay(passStatus(p));
    if (d.estimated || d.source === "unknown") return true;
    return d.state !== "open" && d.state !== "restricted";
  });
  if (!flagged.length) return "";
  const names = flagged.slice(0, 5)
    .map(p => `${p.name} (${listStatusLabel(passStatus(p))})`)
    .join(", ");
  const extra = flagged.length > 5 ? ` and ${flagged.length - 5} more` : "";
  return `Selected route includes passes that are closed, unknown, or guessed for the trip date: ${names}${extra}. Verify locally before driving.`;
}

async function planSelectedTour() {
  clearPlannedTour();
  const start = currentStart();
  if (!start) { showPlanResult({ error: "Pick a start point." }); return; }

  const selected = selectedAdvancedStops();
  if (selected.length === 0) {
    showPlanResult({ error: "Select at least one pass or sight for advanced planning." });
    return;
  }
  if (selected.length > ADVANCED_MAX_STOPS) {
    showPlanResult({ error: `Select no more than ${ADVANCED_MAX_STOPS} stops at once.` });
    return;
  }

  setPlannerBusy("Optimizing…");
  showPlanResult({ loading: true, advanced: true });

  let matrix;
  try {
    matrix = await fetchTable(plannerPointsForPasses(start, selected));
  } catch (e) {
    resetPlanButton();
    showPlanResult({ error: "Routing service unavailable. Please try again." });
    return;
  }

  const passQ = selected.map(p => ({
    qSummit: p.qSummit || 0,
    qApproach: p.qApproach || 0,
  }));
  const result = bestExactSelectedTour(matrix, selected.length, passQ, selected);
  if (!result) {
    resetPlanButton();
    showPlanResult({ error: "No route found through the selected stops." });
    return;
  }

  const tourStops = result.perm.map(t => selected[t.passIdx]);
  const waypoints = waypointsForTour(start, selected, result.perm);
  /* Driving time/distance from the planner matrix as a baseline; OSRM full
     route below replaces them with road-accurate values. Dwell time stays
     separate so it's never lost or mis-labelled (rubber-duck blocking #2). */
  let driveH = result.h;
  let driveKm = result.km;
  const dwellH = result.dwellH || 0;
  let latlngs = null;
  let routeWarning = "";
  try {
    const routeOut = await osrmRoute(coordsFromWaypoints(waypoints));
    latlngs = routeOut.geom.map(([lo, la]) => [la, lo]);
    driveKm = routeOut.distanceKm;
    driveH  = routeOut.durationH;
  } catch (e) {
    routeWarning = "Could not fetch detailed route geometry; map line is approximate.";
  }
  const totalH = driveH + dwellH;

  resetPlanButton();
  showPlanResult({
    start,
    tourStops,
    km: driveKm,
    driveH, dwellH, totalH,
    matched: selected.length,
    poolSize: selected.length,
    inRange: true,
    advanced: true,
    routeWarning,
    statusWarning: advancedStatusWarning(tourStops),
    tripDate: currentTripDate(),
    modes: result.perm,
  });
  drawPlannedTour(start, tourStops, latlngs);
}

async function planTour() {
  if (advancedModeEl.checked) {
    await planSelectedTour();
    return;
  }
  clearPlannedTour();
  const start = currentStart();
  if (!start) { showPlanResult({ error: "Pick a start point." }); return; }
  /* V3 — read target mode + value. Distance mode = km, time mode = hours.
     The DP runs on `matrix.dur` (seconds) in time mode so it picks the
     time-optimal tour, not just shortest-distance with a time budget. */
  const targetMode  = planTargetMode();
  const targetValue = planTargetValue();
  const targetTol   = planTargetTolerance();
  const AVG_SPEED_KMH = 55; /* Alpine driving average — used only for
                               candidate haversine pre-filter and km-equiv
                               composite ranking in time mode. */
  const budgetKmEquiv = targetMode === "time"
    ? targetValue * AVG_SPEED_KMH
    : targetValue;
  const targetSpec = { mode: targetMode, value: targetValue, tolerance: targetTol, avgSpeedKmH: AVG_SPEED_KMH };

  const openOnly = openOnlyEl.checked;
  const includePois = includePoisEl?.checked || false;
  const allCands = PASSES.filter(p => {
    if (!p.baseA || !p.baseB) return false;            /* need traversal data */
    if (!openOnly) return true;
    const s = passStatus(p);
    if (!s) return false;
    return s.state === "open" || s.state === "restricted";
  });

  /* Pre-filter candidates by haversine distance.  Cap firmly at
     budgetKmEquiv × 0.55 so the planner can't reach for famous-but-distant
     passes and produce a wildly out-of-budget tour.  No silent fallback
     that broadens to all-of-Alps. */
  const upperHaversine = budgetKmEquiv * 0.55;
  let passCands = allCands
    .map(p => ({ p, d: haversine(start, p) }))
    .filter(x => x.d <= upperHaversine);

  /* Sort by composite (distance, quality) — closer & higher-quality first. */
  passCands.sort((a, b) => {
    return (a.d - 0.4 * a.p.quality * budgetKmEquiv) -
           (b.d - 0.4 * b.p.quality * budgetKmEquiv);
  });

  /* When "Include sights" is on, build a POI candidate pool with V3
     prefs applied: season match + min-score gate + category/theme filters
     (empty = any). The dwell penalty in the composite still ranks short
     visits ahead of equivalent-quality long ones. */
  let poiCands = [];
  let poiPrefsSnapshot = null;
  if (includePois) {
    const tripSeason = currentTripSeason();
    const minScore = poiMinScoreVal() / 10;  /* score is sc/10 in [0.5, 1.0] */
    const cats = allowedPoiCategories;
    const themes = allowedPoiThemes;
    poiPrefsSnapshot = {
      minScore: poiMinScoreVal(),
      maxCount: poiMaxCountVal(),
      cats: [...cats],
      themes: [...themes],
      preset: activePresetId,
    };
    poiCands = PLANNABLE_POIS
      .filter(p => !tripSeason || (p.poiSeason || []).includes(tripSeason))
      .filter(p => (p.quality || 0) >= minScore)
      .filter(p => cats.size === 0 || cats.has(p.poiCategory))
      .filter(p => themes.size === 0 || (p.poiThemes || []).some(t => themes.has(t)))
      .map(p => ({ p, d: haversine(start, p) }))
      .filter(x => x.d <= upperHaversine);
    /* Composite for POIs: closer + higher quality - dwell-aware soft cost
       (so a 5-hour POI is ranked behind an equally-quality 1-hour POI). */
    poiCands.sort((a, b) => {
      const dwellPenA = (a.p.visitDwellSec || 0) / 3600 * 5; /* km-equivalent */
      const dwellPenB = (b.p.visitDwellSec || 0) / 3600 * 5;
      return (a.d + dwellPenA - 0.4 * a.p.quality * budgetKmEquiv) -
             (b.d + dwellPenB - 0.4 * b.p.quality * budgetKmEquiv);
    });
  }

  /* maxSights from the slider replaces the V2 hardcoded POI_QUOTA = 3.
     We oversample by 1 so the DP has a fallback if the top-ranked POI
     happens to be much further than rank-2 (rubber-duck recommendation
     against pure top-N pre-filter). */
  const POI_QUOTA = poiPrefsSnapshot ? poiPrefsSnapshot.maxCount : 3;
  const POI_OVERSAMPLE = Math.min(POI_QUOTA + 1, poiCands.length);
  const passSlots = Math.max(PLANNER_MAX_CANDIDATES - POI_OVERSAMPLE, PLANNER_MAX_CANDIDATES - POI_QUOTA - 1);
  const passShare = passCands.slice(0, passSlots).map(x => x.p);
  const poiShare  = poiCands.slice(0, POI_OVERSAMPLE).map(x => x.p);
  /* Keep PLANNER_MAX_CANDIDATES-bounded total. Passes go first so the
     bitmask in Held-Karp keeps lower indices for "important" stops. */
  let candidates = passShare.concat(poiShare).slice(0, PLANNER_MAX_CANDIDATES);

  if (candidates.length === 0) {
    const targetCopy = targetMode === "time"
      ? `${targetValue} h day from ${start.name}`
      : `${targetValue} km loop from ${start.name}`;
    showPlanResult({ error: openOnly
      ? `No projected open/restricted passes within reach for a ${targetCopy} on ${formatTripDate(currentTripDate())}. ` +
        `Try a longer ${targetMode === "time" ? "day" : "distance"}, change start point, or uncheck open-only.`
      : `No passes within reach for a ${targetCopy}. Try a longer ${targetMode === "time" ? "day" : "distance"}.` });
    return;
  }
  /* Friendly warning if user asked for sights but none survived filters/range. */
  let candidatePoolNote = "";
  if (includePois && poiCands.length === 0) {
    candidatePoolNote = `No sights match your preferences in season ${currentTripSeason() || "(unset)"}. Tour shows passes only — relax filters or pick a different preset.`;
  } else if (includePois && poiShare.length === 0) {
    candidatePoolNote = `Sights matched filters but were displaced from the candidate pool by stronger passes. Tour shows passes only.`;
  }

  setPlannerBusy("Planning…");
  showPlanResult({ loading: true });

  let matrix;
  try {
    matrix = await fetchTable(plannerPointsForPasses(start, candidates));
  } catch (e) {
    resetPlanButton();
    showPlanResult({ error: "Routing service unavailable. Please try again." });
    return;
  }

  /* Plan-validate-repair: brute-force tour search uses driving distances
     between gateways, but the *fastest road* between two open passes can
     itself run over a third pass that's currently closed.  After picking a
     tour we fetch its actual road geometry, see if it crosses any known-
     closed pass NOT in the tour, mark those edges as Infinity, and re-plan.
     We additionally do segment-level retrace detection on the geometry —
     when two distinct connector legs of the tour drive the same valley
     road, we soft-penalise both edges and re-plan to push the optimiser
     toward exploring new ground. */
  const closedKnown = (openOnly ? PASSES.filter(p => passStatus(p).state === "closed") : []);
  const MAX_ITER = 5;

  let chosen = null;
  let chosenLatLngs = null;
  let chosenWaypoints = null;
  let chosenTourStops = null;
  const blockedNames = new Set();
  const retraceLog = [];
  let plannerMs = 0;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const t0 = performance.now();
    const passQ = candidates.map(p => ({
      qSummit: p.qSummit || 0,
      qApproach: p.qApproach || 0,
    }));
    const sharedFlags = computeSharedGatewayFlags(candidates);
    const result = bestTourGated(matrix, candidates.length, targetSpec, PLANNER_MAX_PASSES, passQ, sharedFlags, candidates);
    plannerMs += performance.now() - t0;
    if (!result) break;

    const tourStops = result.perm.map(t => candidates[t.passIdx]);
    const plan = tourWaypointPlan(start, candidates, result.perm);
    const waypoints = plan.waypoints;
    const wpMatrixIdx = plan.wpMatrixIdx;

    const coordsStr = coordsFromWaypoints(waypoints);
    let routeOut;
    try { routeOut = await osrmRoute(coordsStr); }
    catch { break; }
    const latlngs = routeOut.geom.map(([lo, la]) => [la, lo]);

    /* Slice polyline per leg by snapping waypoints to nearest polyline pt.
       Each pass contributes 3 legs: connect-in (prev→enter), climb (enter→summit),
       descent (summit→exit). The climb+descent legs are intentional; we only
       check connect-in (and the final exit→next or exit→start) for closures.
       POIs contribute one waypoint each so they participate in connect-in
       checks just like a pass-summit-without-climb. */
    const wpIdx = waypoints.map(wp => closestPolylineIdx(wp, latlngs));
    const tourIds = new Set(tourStops.map(p => p.id));

    const blockedThisIter = [];
    if (closedKnown.length) {
      for (let leg = 0; leg < waypoints.length - 1; leg++) {
        const a = wpIdx[leg], b = wpIdx[leg + 1];
        const slice = latlngs.slice(Math.min(a, b), Math.max(a, b) + 1);
        const fromM = wpMatrixIdx[leg], toM = wpMatrixIdx[leg + 1];
        /* Skip legs internal to the same stop (pass enter→summit→exit, or a
           degenerate POI's three-equal-points slots). */
        const sameP = (fromM > 0 && toM > 0)
                       && Math.floor((fromM - 1) / 3) === Math.floor((toM - 1) / 3);
        if (sameP) continue;
        for (const cp of closedKnown) {
          if (tourIds.has(cp.id)) continue;
          if (closeToPolyline(cp, slice, 1.5)) {
            blockedThisIter.push({ fromM, toM, name: cp.name });
          }
        }
      }
    }

    /* Retrace detection: only meaningful when there's no closed-pass to
       resolve first (closed-pass blocking changes the tour anyway), and
       only on iterations where we still have a re-plan budget left. */
    const retraceLegs = (blockedThisIter.length === 0 && iter < MAX_ITER - 1)
      ? detectRetracedConnectorLegs(latlngs, wpIdx)
      : [];

    /* Always record this iteration's tour as our current best — closed-
       pass blocking will overwrite on the next loop, retrace blocking
       might too. If we exhaust MAX_ITER, the most-recently-recorded
       tour is what the user sees. We override `km` with the actual route
       distance so penalised matrix sums don't leak into the displayed
       numbers; drive/dwell time stays separate (V2 fix: never collapse
       OSRM driving time into total time). */
    if (blockedThisIter.length === 0) {
      chosen = result;
      chosen.km = routeOut.distanceKm;
      chosen.driveH = routeOut.durationH;
      chosen.totalH = chosen.driveH + (chosen.dwellH || 0);
      chosen.h = chosen.driveH;  /* legacy field, used by older readers */
      chosenLatLngs = latlngs;
      chosenWaypoints = waypoints;
      chosenTourStops = tourStops;
    }

    if (blockedThisIter.length === 0 && retraceLegs.length === 0) break;

    /* Apply hard infinitisation for closed-pass crossings. */
    for (const b of blockedThisIter) {
      matrix.dist[b.fromM][b.toM] = Infinity;
      matrix.dur [b.fromM][b.toM] = Infinity;
      matrix.dist[b.toM][b.fromM] = Infinity;
      matrix.dur [b.toM][b.fromM] = Infinity;
      blockedNames.add(b.name);
    }

    /* Apply soft-multiplicative penalty for retraced connector legs.
       Both edges of an overlapping pair get penalised so the DP steers
       away from ANY tour reusing either of those two valleys; if the
       only valid tour still uses them, the penalty stacks but never
       infinitises, so we never lose feasibility. */
    if (retraceLegs.length) {
      console.log(`planner iter ${iter}: retrace pairs detected:`,
        retraceLegs.map(r => `legs ${r.legA}↔${r.legB} share ${r.overlapM}m`).join("; "));
    }
    for (const r of retraceLegs) {
      const fromMA = wpMatrixIdx[r.legA];
      const toMA   = wpMatrixIdx[r.legA + 1];
      const fromMB = wpMatrixIdx[r.legB];
      const toMB   = wpMatrixIdx[r.legB + 1];
      matrix.dist[fromMA][toMA] *= RETRACE_PENALTY_MULT;
      matrix.dist[toMA][fromMA] *= RETRACE_PENALTY_MULT;
      matrix.dist[fromMB][toMB] *= RETRACE_PENALTY_MULT;
      matrix.dist[toMB][fromMB] *= RETRACE_PENALTY_MULT;
      retraceLog.push(r.overlapM);
    }
  }

  console.log(`planner: ${candidates.length} candidates (${passShare.length} passes + ${poiShare.length} POIs) · ${Math.round(plannerMs)} ms total · avoided=[${[...blockedNames].join(",")}] · retraceFixes=${retraceLog.length}`);
  resetPlanButton();

  if (!chosen) {
    if (blockedNames.size > 0) {
      showPlanResult({ error:
        `Couldn't find a tour avoiding closed pass${blockedNames.size > 1 ? "es" : ""} ` +
        `(${[...blockedNames].join(", ")}). Try a longer distance or a different start.` });
    } else {
      showPlanResult({ error: "No tour found." });
    }
    return;
  }

  /* Reject fallbacks that overshoot the budget catastrophically — much
     better UX to say "couldn't fit" than to dump a 1300 km tour on a user
     who asked for 200 km. Threshold scales with the active target unit. */
  const overshoot = targetMode === "time"
    ? (chosen.totalH || chosen.driveH) > targetValue * 1.5
    : chosen.km > targetValue * 1.5;
  if (!chosen.inRange && overshoot) {
    const tolPct = Math.round(targetTol * 100);
    const targetCopy = targetMode === "time"
      ? `${targetValue} h day from ${start.name}`
      : `${targetValue} km loop from ${start.name}`;
    const closestCopy = targetMode === "time"
      ? `${(chosen.totalH || chosen.driveH).toFixed(1)} h`
      : `${Math.round(chosen.km)} km`;
    showPlanResult({ error:
      `No tour fits within ±${tolPct}% of a ${targetCopy}. ` +
      `Closest possible is ${closestCopy}. Try a longer ${targetMode === "time" ? "day length" : "distance"} ` +
      `or a different start point.` });
    clearPlannedTour();
    return;
  }

  showPlanResult({
    start, tourStops: chosenTourStops,
    km: chosen.km,
    driveH: chosen.driveH,
    dwellH: chosen.dwellH || 0,
    totalH: chosen.totalH || chosen.driveH,
    matched: chosen.k,
    poolSize: candidates.length,
    totalOpen: allCands.length,
    inRange: chosen.inRange,
    targetMode, targetValue, targetTol, openOnly,
    poiPrefs: poiPrefsSnapshot,
    tripDate: currentTripDate(),
    avoided: blockedNames.size > 0 ? [...blockedNames] : null,
    candidatePoolNote: candidatePoolNote || null,
    modes: chosen.perm,   // [{passIdx, enterSide, exitSide, mode}, ...]
  });
  drawPlannedTour(start, chosenTourStops, chosenLatLngs);
}

/* Index in `polyline` of the point closest to lat/lng `wp` (planar approx). */
function closestPolylineIdx(wp, polyline) {
  const lat0 = wp[0], lon0 = wp[1];
  const cos = Math.cos(lat0 * Math.PI / 180);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < polyline.length; i++) {
    const dy = (polyline[i][0] - lat0) * 111;
    const dx = (polyline[i][1] - lon0) * 111 * cos;
    const d = dx*dx + dy*dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/* Segment-level retrace detection on the chosen tour's actual route
   geometry. Densifies the polyline at fixed metre spacing, drops samples
   into a coarse spatial grid, then for every pair of points in nearby
   cells with index distance >1 leg checks whether they're geographically
   on top of each other. Accumulated "shared metres" per connector-leg
   pair tells us when two distinct connector drives use the same valley
   road. Only connector legs (leg-index `mod 3 === 0`) are considered —
   the climb+descent legs of a single pass are intra-pass and intentional.

   Returns [{ legA, legB, overlapM }] for connector pairs whose shared
   road length exceeds RETRACE_MIN_OVERLAP_M. */
const RETRACE_THRESH_M = 100;      // points within this distance count as "same valley road"
const RETRACE_MIN_OVERLAP_M = 800; // must share at least this many metres to count
const RETRACE_SAMPLE_M = 200;      // densification spacing
const RETRACE_PENALTY_MULT = 2.0;  // multiply both shared edges' cost per iter
function detectRetracedConnectorLegs(latlngs, wpIdx) {
  if (!latlngs.length || wpIdx.length < 2) return [];
  const numLegs = wpIdx.length - 1;

  /* Step 1: assign each polyline point to its leg. */
  const legByIdx = new Int16Array(latlngs.length);
  for (let leg = 0; leg < numLegs; leg++) {
    const lo = Math.min(wpIdx[leg], wpIdx[leg+1]);
    const hi = Math.max(wpIdx[leg], wpIdx[leg+1]);
    for (let k = lo; k <= hi; k++) legByIdx[k] = leg;
  }

  /* Step 2: sample at ~RETRACE_SAMPLE_M spacing on connector legs only. */
  const samples = [];
  let acc = 0;
  for (let i = 0; i < latlngs.length; i++) {
    const leg = legByIdx[i];
    const isConnector = (leg % 3) === 0;
    if (i === 0) {
      if (isConnector) samples.push({ idx: 0, lat: latlngs[0][0], lon: latlngs[0][1], leg });
      continue;
    }
    const d = haversine(
      { lat: latlngs[i-1][0], lon: latlngs[i-1][1] },
      { lat: latlngs[i][0],   lon: latlngs[i][1]   }
    ) * 1000;
    acc += d;
    if (acc >= RETRACE_SAMPLE_M) {
      acc = 0;
      if (isConnector) samples.push({ idx: i, lat: latlngs[i][0], lon: latlngs[i][1], leg });
    }
  }

  /* Step 3: spatial grid for collision detection (~111 m at the equator,
     ~75 m at 46° latitude — keeps neighbour cells inexpensive). */
  const GRID = 0.001;
  const grid = new Map();
  for (const p of samples) {
    const key = Math.floor(p.lat / GRID) + "," + Math.floor(p.lon / GRID);
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    bucket.push(p);
  }

  /* Step 4: accumulate overlap (metres) per leg-pair. */
  const overlapByPair = new Map();
  for (const p of samples) {
    const lk = Math.floor(p.lat / GRID);
    const ok = Math.floor(p.lon / GRID);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get((lk + dx) + "," + (ok + dy));
        if (!cell) continue;
        for (const q of cell) {
          if (q.idx <= p.idx) continue;
          if (Math.abs(q.leg - p.leg) <= 1) continue;     // skip same / adjacent legs
          const dM = haversine(p, q) * 1000;
          if (dM > RETRACE_THRESH_M) continue;
          const key = Math.min(p.leg, q.leg) + "," + Math.max(p.leg, q.leg);
          overlapByPair.set(key, (overlapByPair.get(key) || 0) + RETRACE_SAMPLE_M);
        }
      }
    }
  }

  /* Step 5: filter pairs with significant overlap. */
  const result = [];
  for (const [pairKey, overlap] of overlapByPair) {
    if (overlap < RETRACE_MIN_OVERLAP_M) continue;
    const [a, b] = pairKey.split(",").map(Number);
    result.push({ legA: a, legB: b, overlapM: Math.round(overlap) });
  }
  return result;
}

function showPlanResult(r) {
  planResult.classList.remove("empty");
  planResult.removeAttribute("aria-busy");
  if (r.loading) {
    planResult.setAttribute("aria-busy", "true");
    const title = r.advanced ? "Optimizing selected route…" : "Planning best tour…";
    const detail = r.advanced ? "Checking selected stops and route order." : "Scoring candidates, routing, and avoiding projected closures.";
    planResult.innerHTML = `<div class="loading-row"><span class="spinner" aria-hidden="true"></span><span><strong>${title}</strong><span>${detail}</span></span></div>`;
    return;
  }
  if (r.error)   { planResult.innerHTML = `<div class="warn">${r.error}</div>`; return; }
  /* Auto-discovery flow still uses `tourPasses`; advanced flow now uses
     `tourStops`. Accept either for backwards compatibility. */
  const stops = r.tourStops || r.tourPasses || [];
  const arrow = ' <span class="arrow">→</span> ';
  const stopList = stops.map((p, i) => {
    const t = r.modes[i];
    if (p.isPoi) {
      const dwell = p.visitDwellSec ? ` <span class="dwell-badge" title="Typical visit time">${(p.visitDwellSec / 3600).toFixed(1)}h</span>` : "";
      return `<span class="tour-stop poi-stop"><span class="poi-stop-glyph" title="${escapeHtml(poiCategoryLabel(p.poiCategory))}">${poiCategoryGlyph(p.poiCategory)}</span> ${escapeHtml(p.name)}${dwell}</span>`;
    }
    const modeBadge = t?.mode === "out-and-back"
      ? ` <span class="mode-badge" title="Visit summit and return same way">↻</span>`
      : ``;
    return `<span class="tour-stop pass-stop">${escapeHtml(p.name)}${modeBadge}${qualityStarsCompact(p.quality)}</span>`;
  }).join(arrow);
  const passOnly = stops.filter(p => !p.isPoi);
  const avgQ = passOnly.length
    ? passOnly.reduce((s, p) => s + (p.quality || 0), 0) / passOnly.length
    : 0;
  const obCount = (r.modes || []).filter(m => m.mode === "out-and-back").length;
  const modeNote = obCount > 0
    ? `<div class="popup-meta tight"><span class="mode-badge">↻</span> ${obCount} of ${passOnly.length} pass${passOnly.length === 1 ? "" : "es"} visited summit-and-back</div>`
    : "";
  const qualityLine = avgQ > 0
    ? `<div class="popup-meta tight">Pass quality: <strong class="tour-quality">${"★".repeat(Math.round(avgQ * 5))}</strong> <span>(avg ${avgQ.toFixed(2)})</span></div>`
    : "";
  const warn = !r.inRange
    ? `<div class="warn">No tour within ±20% of ${r.targetKm} km. Showing closest fit.</div>` : "";
  const routeWarning = r.routeWarning
    ? `<div class="warn">${escapeHtml(r.routeWarning)}</div>` : "";
  const statusWarning = r.statusWarning
    ? `<div class="warn">${escapeHtml(r.statusWarning)}</div>` : "";
  const avoided = r.avoided
    ? `<div class="popup-meta tight success">↻ Re-planned to avoid closed pass${r.avoided.length > 1 ? "es" : ""}: ${r.avoided.join(", ")}</div>` : "";
  const title = r.advanced ? "Optimized selected route" : "Best tour";
  /* Time accounting — drive vs dwell vs total. Auto-discovery mode has no
     POIs and so dwellH = 0 / totalH = driveH; only show the breakdown when
     dwell time is nonzero to keep the line concise. */
  const driveH = r.driveH ?? r.h ?? 0;
  const dwellH = r.dwellH ?? 0;
  const totalH = r.totalH ?? driveH;
  const timeBlock = dwellH > 0
    ? `~<strong>${fmtDuration(totalH)}</strong> total <span class="time-breakdown">(${fmtDuration(driveH)} driving + ${fmtDuration(dwellH)} on site)</span>`
    : `~<strong>${fmtDuration(driveH)}</strong> driving`;
  const passN = passOnly.length;
  const poiN  = stops.length - passN;
  const stopSummary = poiN > 0
    ? `<strong>${passN}</strong> pass${passN === 1 ? "" : "es"} + <strong>${poiN}</strong> POI${poiN === 1 ? "" : "s"}`
    : `<strong>${r.matched}</strong> selected pass${r.matched === 1 ? "" : "es"}`;
  const statsLine = r.advanced
    ? `${stopSummary} ·
       <strong>${Math.round(r.km)} km</strong> · ${timeBlock}`
    : poiN > 0
      ? `${stopSummary} of ${r.poolSize} candidates
         ${r.openOnly ? `(${r.totalOpen} passes shortlisted)` : ""} ·
         <strong>${Math.round(r.km)} km</strong> · ${timeBlock}`
      : `<strong>${r.matched}</strong> of ${r.poolSize} candidates
         ${r.openOnly ? `(out of ${r.totalOpen} projected open/restricted passes)` : ""} ·
         <strong>${Math.round(r.km)} km</strong> · ${timeBlock}`;
  const candidatePoolBlock = r.candidatePoolNote
    ? `<div class="popup-meta tight">${escapeHtml(r.candidatePoolNote)}</div>`
    : "";
  const tripDateLine = r.tripDate
    ? `<div class="popup-meta tight projection${daysBetweenDates(todayLocalDate(), r.tripDate) > 0 ? " guess" : ""}">Trip date: ${escapeHtml(formatTripDate(r.tripDate))} · projected pass states; guesses are marked “Likely” / “guess”.</div>`
    : "";
  planResult.innerHTML = `
    <h3>${title} from ${r.start.name}</h3>
    <div class="tour-passes">${stopList}</div>
    <div class="stats">${statsLine}</div>
    ${candidatePoolBlock}
    ${tripDateLine}
    ${qualityLine}
    ${modeNote}
    ${avoided}
    ${warn}
    ${routeWarning}
    ${statusWarning}
    <div class="plan-result-actions"><button id="planClear">Clear</button></div>`;
  document.getElementById("planClear").onclick = () => {
    clearPlannedTour();
    planResult.classList.add("empty"); planResult.innerHTML = "";
  };
}

function drawPlannedTour(start, tourStops, latlngs) {
  plannedTourIds = tourStops.map(p => p.id);
  plannedLayer = L.layerGroup().addTo(map);
  plannedStartMarker = L.marker([start.lat, start.lon], {
    icon: L.divIcon({
      className: "",
      html: `<div class="start-marker"><span>${start.name[0]}</span></div>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    }), zIndexOffset: 500,
  }).addTo(map).bindTooltip(`Start: ${start.name}`, { direction: "top", offset: [0, -12] });

  /* Auto-add the POI cluster if any POIs are in this tour, so user sees them
     even if they hadn't enabled the POI layer. */
  if (tourStops.some(p => p.isPoi) && !map.hasLayer(poiCluster)) {
    map.addLayer(poiCluster);
  }

  tourStops.forEach((p, idx) => {
    if (!p._marker) return;
    if (p.isPoi) {
      p._marker.setIcon(makePoiIcon(p, idx + 1));
    } else {
      p._marker.setIcon(makeMarkerIcon(passStatus(p), idx + 1));
      p._marker._currentState = `${statusSignature(passStatus(p))}:${idx + 1}`;
    }
    p._marker.setZIndexOffset(400);
  });

  /* Geometry was already fetched by the planner.  Just draw it. The
     three-layer stack (dark casing + white halo + colored core) is
     decimated with smoothFactor so canvas redraws stay cheap during
     smooth wheel zoom + inertia. interactive:false + bubblingMouseEvents
     :false take the casing/halo out of Leaflet's hit-testing chain;
     they're decorative, only the core layer needs interaction. */
  if (latlngs && latlngs.length > 1) {
    plannedLayer.addLayer(L.polyline(latlngs, { color:"#000",    weight:11, opacity:0.45, lineCap:"round", lineJoin:"round", smoothFactor:1.5, interactive:false, bubblingMouseEvents:false }));
    plannedLayer.addLayer(L.polyline(latlngs, { color:"#fff",    weight:7,  opacity:0.90, lineCap:"round", lineJoin:"round", smoothFactor:1.5, interactive:false, bubblingMouseEvents:false }));
    plannedLayer.addLayer(L.polyline(latlngs, { color:"#ffd166", weight:5,  opacity:1,    lineCap:"round", lineJoin:"round", smoothFactor:1.5, interactive:false, bubblingMouseEvents:false }));
    map.fitBounds(L.latLngBounds(latlngs).pad(0.10));
  } else {
    /* Fallback to straight lines if router was unavailable. */
    const wp = [[start.lat, start.lon], ...tourStops.map(p => [p.lat, p.lon]), [start.lat, start.lon]];
    plannedLayer.addLayer(L.polyline(wp, { color:"#000",    weight:6,   opacity:0.40, lineCap:"round", lineJoin:"round", interactive:false, bubblingMouseEvents:false }));
    plannedLayer.addLayer(L.polyline(wp, { color:"#ffd166", weight:3.5, opacity:0.85, dashArray:"4 6", lineCap:"round", lineJoin:"round", interactive:false, bubblingMouseEvents:false }));
    map.fitBounds(L.latLngBounds(wp).pad(0.15));
  }
}

function closeToPolyline(pt, latlngs, thresholdKm) {
  const t2 = thresholdKm * thresholdKm;
  const cos = Math.cos(pt.lat * Math.PI / 180);
  for (let i = 0; i < latlngs.length; i++) {
    const [la, lo] = latlngs[i];
    const dy = (la - pt.lat) * 111;
    const dx = (lo - pt.lon) * 111 * cos;
    if (dx*dx + dy*dy < t2) return true;
  }
  return false;
}

/* ─────────────────────────── side panel ─────────────────────────── */
const listEl   = document.getElementById("passList");
const noteEl   = document.getElementById("listNote");
const searchEl = document.getElementById("search");
const sortEl   = document.getElementById("sort");
const sortOpenFirstEl = document.getElementById("sortOpenFirst");
const showOpenOnlyEl = document.getElementById("showOpenOnly");
const showNotableOnlyEl = document.getElementById("showNotableOnly");
const VIEW_LIMIT = 80;

/* "Notable" gates out low-confidence entries plus everything below this
   quality cutoff. Keep this aligned with the generated pass icon set so
   every notable pass has both scenic and compact sprite artwork. */
const NOTABLE_MIN_QUALITY = 0.7;

function inViewport(p) {
  return map.getBounds().contains([p.lat, p.lon]);
}
function isOpenForDisplay(p) {
  return statusDisplay(passStatus(p)).state === "open";
}
function isNotablePass(p) {
  return p.confidence !== "l" && (p.quality || 0) >= NOTABLE_MIN_QUALITY;
}
function passesOpenFilter(p) {
  return !showOpenOnlyEl.checked || isOpenForDisplay(p);
}
function passesNotableFilter(p) {
  return !showNotableOnlyEl.checked || isNotablePass(p);
}
function passesAllFilters(p) {
  return passesOpenFilter(p) && passesNotableFilter(p);
}
function compareBySelectedSort(a, b, sort, start) {
  if (sort === "name") return a.name.localeCompare(b.name);
  if (sort === "elevation") return b.elev - a.elev;
  if (sort === "quality") return (b.quality || 0) - (a.quality || 0);
  if (sort === "distance") {
    const da = start ? haversine(start, a) : a.elev;
    const db = start ? haversine(start, b) : b.elev;
    return da - db;
  }
  const sa = statusSortRank(passStatus(a));
  const sb = statusSortRank(passStatus(b));
  if (sa !== sb) return sa - sb;
  return (b.quality || 0) - (a.quality || 0);
}
function syncMarkerVisibility() {
  const visibleMarkers = PASSES
    .filter(passesAllFilters)
    .map(p => p._marker)
    .filter(Boolean);
  /* Diff the cluster's contents against the new visible set instead of
     clearLayers + addLayers — full reclusters can take 30-100 ms on
     445 markers; a diffed update touches only the markers that changed
     filter state. */
  const visibleSet = new Set(visibleMarkers);
  const current = passCluster.__visibleMarkers || new Set();
  const toAdd = visibleMarkers.filter(m => !current.has(m));
  const toRemove = [];
  current.forEach(m => { if (!visibleSet.has(m)) toRemove.push(m); });
  if (toRemove.length) passCluster.removeLayers(toRemove);
  if (toAdd.length) passCluster.addLayers(toAdd);
  passCluster.__visibleMarkers = visibleSet;
}
/* Mirror for POIs: when sidebar filters change (category, region, drivable,
   top-notable, search), hide non-matching markers from the on-map cluster
   so the map and the list stay in sync. The full POI population is still
   reachable by clearing the filters or toggling the layer overlay off/on. */
function syncPoiMarkerVisibility() {
  if (typeof poiPassesAllFilters !== "function") return;
  const q = (poiSearchEl?.value || "").trim().toLowerCase();
  const visibleMarkers = POIS
    .filter(p => poiPassesAllFilters(p))
    .filter(p => !q || poiSearchMatches(p, q))
    .map(p => p._marker)
    .filter(Boolean);
  poiCluster.clearLayers();
  poiCluster.addLayers(visibleMarkers);
}
function syncOpenOnlyFilter() {
  syncMarkerVisibility();
  renderList();
  renderAdvancedPicker();
}

function renderList() {
  const q = searchEl.value.trim().toLowerCase();
  const sort = sortEl.value;
  const start = currentStart();
  const useSearch = q.length > 0;

  let items = useSearch
    ? PASSES.filter(p => p.name.toLowerCase().includes(q) || (p.alt && p.alt.toLowerCase().includes(q)))
    : PASSES.filter(inViewport);
  items = items.filter(passesAllFilters);

  items = items.slice().sort((a, b) => {
    if (sortOpenFirstEl.checked) {
      const ao = isOpenForDisplay(a) ? 0 : 1;
      const bo = isOpenForDisplay(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
    }
    return compareBySelectedSort(a, b, sort, start);
  });

  const total = items.length;
  const shown = items.slice(0, VIEW_LIMIT);
  const openOnly = showOpenOnlyEl.checked;
  const notableOnly = showNotableOnlyEl.checked;
  const filterTag = openOnly && notableOnly ? "open notable "
                  : openOnly                 ? "open "
                  : notableOnly              ? "notable "
                  : "";

  if (shown.length === 0) {
    listEl.innerHTML = `<li class="empty">No ${filterTag}passes ${useSearch ? "match" : "in view"}.</li>`;
  } else {
    listEl.innerHTML = shown.map(p => {
      const status = passStatus(p);
      const statusView = statusDisplay(status);
      const label = listStatusLabel(status);
      const sourceLabel = statusView.sourceMeta.label;
      const dist  = start ? `· ${Math.round(haversine(start, p))} km from ${start.name}` : "";
      const selected = advancedModeEl.checked && selectedPassIds.has(p.id);
      const listIconId = stateIconId(statusView.state, statusView.estimated);
      const listIcon = p.symbolIconAsset
        ? `<span class="pass-list-icon-wrap">${passIconHtml(p, "pass-art-icon list symbol", "symbol")} ${iconSvg(listIconId, `status-icon ${statusView.className}`)}</span>`
        : iconSvg(listIconId, `status-icon ${statusView.className}`);
      return `<li data-id="${p.id}" class="${selected ? "selected" : ""}" title="${advancedModeEl.checked ? "Select this pass for the route" : "Zoom to this pass"}">
        ${listIcon}
        <span>
          <div class="name">${p.name} ${qualityStarsCompact(p.quality)}</div>
          <div class="meta">${p.elev} m · ${label} · ${sourceLabel} ${dist}</div>
        </span>
        <span class="alt" title="${escapeHtml(p.alt || "")}">${p.alt || ""}</span>
      </li>`;
    }).join("");

    listEl.querySelectorAll("li[data-id]").forEach(li => {
      li.addEventListener("click", () => {
        const p = PASSES.find(x => x.id === li.dataset.id);
        if (advancedModeEl.checked) {
          toggleSelectedPass(p.id);
          return;
        }
        li.setAttribute("aria-busy", "true");
        map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 11), { duration: 0.45 });
        setTimeout(() => {
          li.removeAttribute("aria-busy");
          p._marker.openPopup();
        }, 480);
      });
    });
    lazyLoadPassIcons(listEl);
  }

  noteEl.textContent = useSearch
    ? `${total} ${filterTag}match${total === 1 ? "" : "es"}${total > VIEW_LIMIT ? ` (showing first ${VIEW_LIMIT})` : ""}`
    : `${total} ${filterTag}in view${total > VIEW_LIMIT ? ` (showing first ${VIEW_LIMIT})` : ""} · ${PASSES.filter(passesAllFilters).length} ${filterTag}total`;
}

/* ─────────────────────── POI side-panel rendering ─────────────────────── */
const poiListEl = document.getElementById("poiList");
const poiSearchEl = document.getElementById("poiSearch");
const poiSortEl = document.getElementById("poiSort");
const poiCatFilterEl = document.getElementById("poiCatFilter");
const poiRegionFilterEl = document.getElementById("poiRegionFilter");
const poiPlannableOnlyEl = document.getElementById("poiPlannableOnly");
const poiTopOnlyEl = document.getElementById("poiTopOnly");
const tabPasses = document.getElementById("tabPasses");
const tabPois   = document.getElementById("tabPois");
const tabPanePasses = document.getElementById("tabPanePasses");
const tabPanePois   = document.getElementById("tabPanePois");
const tabCountPasses = document.getElementById("tabCountPasses");
const tabCountPois   = document.getElementById("tabCountPois");

let activeExplorerTab = "passes";

function populatePoiSidebarFilters() {
  if (!poiCatFilterEl) return;
  /* Categories ordered by frequency for natural UX (most common first). */
  const counts = {};
  POIS.forEach(p => { counts[p.poiCategory] = (counts[p.poiCategory] || 0) + 1; });
  const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = `${poiCategoryGlyph(c)} ${poiCategoryLabel(c)} (${counts[c]})`;
    poiCatFilterEl.appendChild(opt);
  }
  /* Regions in canonical Alpine-Passes order (matches swiss-pois.js header). */
  const regionCounts = {};
  POIS.forEach(p => { regionCounts[p.poiRegion] = (regionCounts[p.poiRegion] || 0) + 1; });
  const regions = Object.keys(regionCounts).sort((a, b) => regionCounts[b] - regionCounts[a]);
  for (const r of regions) {
    if (!r) continue;
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = `${r} (${regionCounts[r]})`;
    poiRegionFilterEl.appendChild(opt);
  }
}
populatePoiSidebarFilters();

function poiInViewport(p) {
  return map.getBounds().contains([p.lat, p.lon]);
}
function poiPassesAllFilters(p) {
  if (poiPlannableOnlyEl?.checked && !isPlannablePoi(p)) return false;
  if (poiTopOnlyEl?.checked && (p.quality || 0) < 0.8) return false;
  const cat = poiCatFilterEl?.value || "";
  if (cat && p.poiCategory !== cat) return false;
  const region = poiRegionFilterEl?.value || "";
  if (region && p.poiRegion !== region) return false;
  return true;
}
function poiSearchMatches(p, q) {
  if (!q) return true;
  const hay = `${p.name} ${p.poiRegion} ${poiCategoryLabel(p.poiCategory)} ${(p.poiThemes || []).join(" ")}`.toLowerCase();
  return hay.includes(q);
}
function comparePoiBySort(a, b, sort, start) {
  if (sort === "name") return a.name.localeCompare(b.name);
  if (sort === "category") {
    const ca = poiCategoryLabel(a.poiCategory).localeCompare(poiCategoryLabel(b.poiCategory));
    if (ca !== 0) return ca;
    return (b.quality || 0) - (a.quality || 0);
  }
  if (sort === "region") {
    const ra = (a.poiRegion || "").localeCompare(b.poiRegion || "");
    if (ra !== 0) return ra;
    return (b.quality || 0) - (a.quality || 0);
  }
  if (sort === "distance") {
    const da = start ? haversine(start, a) : -(a.quality || 0);
    const db = start ? haversine(start, b) : -(b.quality || 0);
    return da - db;
  }
  /* default: notability score (high → low). */
  return (b.quality || 0) - (a.quality || 0);
}

function renderPoiList() {
  if (!poiListEl) return;
  const q = (poiSearchEl?.value || "").trim().toLowerCase();
  const sort = poiSortEl?.value || "score";
  const start = currentStart();
  const useSearch = q.length > 0;

  let items = useSearch
    ? POIS.filter(p => poiSearchMatches(p, q))
    : POIS.filter(poiInViewport);
  items = items.filter(poiPassesAllFilters);
  items = items.slice().sort((a, b) => comparePoiBySort(a, b, sort, start));

  const total = items.length;
  const shown = items.slice(0, VIEW_LIMIT);

  if (shown.length === 0) {
    poiListEl.innerHTML = `<li class="empty">No sights ${useSearch ? "match" : "in view"}.</li>`;
  } else {
    poiListEl.innerHTML = shown.map(p => {
      const dist = start ? `· ${Math.round(haversine(start, p))} km from ${start.name}` : "";
      const dwell = p.visitDwellSec ? `· ${(p.visitDwellSec / 3600).toFixed(1)} h visit` : "";
      const elev = p.elev ? `${p.elev} m · ` : "";
      const advanced = advancedModeEl.checked && isPlannablePoi(p);
      const selected = advanced && selectedPoiIds.has(p.id);
      const notDrivable = !isPlannablePoi(p);
      const titleAttr = advanced
        ? "Add this sight to the route"
        : notDrivable
          ? `Not directly reachable by car (${p.poiAccess.join(", ")})`
          : "Zoom to this sight";
      return `<li data-poi-id="${escapeHtml(p.id)}" class="poi-row${selected ? " selected" : ""}${notDrivable ? " not-drivable" : ""}" title="${escapeHtml(titleAttr)}">
        <span class="poi-row-glyph" data-cat="${escapeHtml(p.poiCategory)}" aria-hidden="true">${poiCategoryGlyph(p.poiCategory)}</span>
        <span>
          <div class="name">${escapeHtml(p.name)} ${qualityStarsCompact(p.quality)}</div>
          <div class="meta">${escapeHtml(elev)}${escapeHtml(poiCategoryLabel(p.poiCategory))} · ${escapeHtml(p.poiRegion)} ${escapeHtml(dwell)} ${escapeHtml(dist)}</div>
        </span>
        ${notDrivable ? '<span class="poi-row-badge" title="Not car-accessible">⚠</span>' : ""}
      </li>`;
    }).join("");

    poiListEl.querySelectorAll("li[data-poi-id]").forEach(li => {
      li.addEventListener("click", () => {
        const p = POI_BY_ID.get(li.dataset.poiId);
        if (!p) return;
        if (advancedModeEl.checked && isPlannablePoi(p)) {
          toggleSelectedPoi(p.id);
          return;
        }
        li.setAttribute("aria-busy", "true");
        if (!map.hasLayer(poiCluster)) map.addLayer(poiCluster);
        map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 11), { duration: 0.45 });
        setTimeout(() => {
          li.removeAttribute("aria-busy");
          p._marker?.openPopup?.();
        }, 480);
      });
    });
  }

  /* Update tab counters: passes total reflects passes-in-view count;
     POI total reflects the POI list. */
  if (tabCountPois) {
    tabCountPois.textContent = `· ${total}${total > VIEW_LIMIT ? `+` : ""}`;
  }

  /* When the POI tab is active, mirror noteEl text to the POI footnote. */
  if (activeExplorerTab === "pois") {
    noteEl.textContent = useSearch
      ? `${total} match${total === 1 ? "" : "es"}${total > VIEW_LIMIT ? ` (showing first ${VIEW_LIMIT})` : ""}`
      : `${total} in view${total > VIEW_LIMIT ? ` (showing first ${VIEW_LIMIT})` : ""} · ${POIS.length} total`;
  }
}

/* Tab counter for passes is the in-view count (matches the existing footnote
   style). Updated whenever the pass list re-renders by piggy-backing on
   renderList — patch that here rather than weaving it into the pass code. */
const _origRenderList = renderList;
renderList = function () {
  _origRenderList.apply(this, arguments);
  if (tabCountPasses) {
    /* Read the count from the existing footnote text (it's authoritative)
       to avoid duplicating the filter logic. */
    const m = noteEl.textContent.match(/^(\d+)/);
    tabCountPasses.textContent = m ? `· ${m[1]}` : "";
  }
};

function showExplorerTab(tab) {
  activeExplorerTab = tab;
  const passesActive = tab === "passes";
  tabPasses?.classList.toggle("active", passesActive);
  tabPois?.classList.toggle("active", !passesActive);
  tabPasses?.setAttribute("aria-selected", String(passesActive));
  tabPois?.setAttribute("aria-selected", String(!passesActive));
  /* Roving tabindex: only the active tab is keyboard-tabbable; the inactive
     one is reachable via arrow keys (WCAG ARIA tab pattern). */
  tabPasses?.setAttribute("tabindex", passesActive ? "0" : "-1");
  tabPois?.setAttribute("tabindex", passesActive ? "-1" : "0");
  if (tabPanePasses) tabPanePasses.hidden = !passesActive;
  if (tabPanePois)   tabPanePois.hidden   = passesActive;
  /* Re-render the now-active tab so it picks up any viewport changes that
     happened while it was hidden. */
  if (passesActive) renderList(); else renderPoiList();
}

tabPasses?.addEventListener("click", () => showExplorerTab("passes"));
tabPois?.addEventListener("click",   () => showExplorerTab("pois"));

/* WCAG ARIA tab pattern: Left/Right (and Home/End) move focus and activate
   the next tab. Up/Down are intentionally not bound — vertical tabs use
   those, but our tabs are horizontal. Listener is on the tablist parent. */
function handleTabKeydown(e) {
  const key = e.key;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
  e.preventDefault();
  const next = (key === "ArrowRight" || key === "End")
    ? (activeExplorerTab === "passes" ? "pois" : "pois")  /* End → last */
    : (key === "ArrowLeft"  || key === "Home")
    ? "passes"  /* Home / Left → first */
    : null;
  if (key === "ArrowRight") {
    showExplorerTab(activeExplorerTab === "passes" ? "pois" : "passes");
  } else if (key === "ArrowLeft") {
    showExplorerTab(activeExplorerTab === "pois" ? "passes" : "pois");
  } else if (key === "Home") {
    showExplorerTab("passes");
  } else if (key === "End") {
    showExplorerTab("pois");
  }
  /* Move focus to whichever tab is now active. */
  (activeExplorerTab === "passes" ? tabPasses : tabPois)?.focus();
}
tabPasses?.addEventListener("keydown", handleTabKeydown);
tabPois?.addEventListener("keydown", handleTabKeydown);
/* Initialise tabindex state. */
tabPasses?.setAttribute("tabindex", "0");
tabPois?.setAttribute("tabindex", "-1");

poiSearchEl?.addEventListener("input", () => { renderPoiList(); syncPoiMarkerVisibility(); });
poiSortEl?.addEventListener("change", renderPoiList);
poiCatFilterEl?.addEventListener("change", () => { renderPoiList(); syncPoiMarkerVisibility(); });
poiRegionFilterEl?.addEventListener("change", () => { renderPoiList(); syncPoiMarkerVisibility(); });
poiPlannableOnlyEl?.addEventListener("change", () => { renderPoiList(); syncPoiMarkerVisibility(); });
poiTopOnlyEl?.addEventListener("change", () => { renderPoiList(); syncPoiMarkerVisibility(); });

searchEl.addEventListener("input", renderList);
sortEl  .addEventListener("change", renderList);
sortOpenFirstEl.addEventListener("change", renderList);
startSel.addEventListener("change", renderList);
showOpenOnlyEl.addEventListener("change", syncOpenOnlyFilter);
showNotableOnlyEl.addEventListener("change", syncOpenOnlyFilter);

/* Debounce viewport-driven re-renders: panning fires moveend many times
   per second; renderList() / renderPoiList() are each cheap (~5 ms) but
   rebuilding 80 li's is visible jank on slow devices. We re-render both
   lists so the off-screen tab's count stays accurate; the tab badge in
   the header reads "X" / "Y" regardless of which tab is foregrounded. */
let moveTimer = null;
map.on("moveend", () => {
  /* Pass list: skip when its search is active (search results aren't viewport-bound). */
  const passSearchActive = searchEl.value;
  const poiSearchActive  = poiSearchEl?.value;
  if (passSearchActive && poiSearchActive) return;
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (!passSearchActive) renderList();
    if (!poiSearchActive)  renderPoiList();
  }, 120);
});
renderList();
renderPoiList();
syncAdvancedMode();

/* ─────── kick off live status load ─────── */
const banner   = document.getElementById("banner");
const updatedText = document.getElementById("updatedText");

(async () => {
  /* Baseline: every pass gets OSM-rule-or-elevation status. */
  PASSES.forEach(p => { p._status = defaultStatus(p); });

  let chMatched = 0, alpsMatched = 0, swissTotal = 0;
  PASSES.forEach(p => { if (p.slug) swissTotal++; });

  /* Build alias index for alpenpaesse.de fuzzy name matching. */
  const passByAlias = new Map();   /* alias -> [pass, pass, ...] */
  PASSES.forEach(p => {
    const aliases = new Set([
      ...nameAliases(p.name),
      ...nameAliases(p.alt),
      ...nameAliases(`${p.name}${p.alt ? " / " + p.alt : ""}`),
    ]);
    aliases.forEach(a => {
      if (!passByAlias.has(a)) passByAlias.set(a, []);
      passByAlias.get(a).push(p);
    });
  });

  const swissSlugs = PASSES.map(p => p.slug).filter(Boolean);
  const [chR, alpsR, histR] = await Promise.all([
    loadStatuses().catch(e => { console.warn("CH live failed", e); return null; }),
    loadAlpsAlerts().catch(e => { console.warn("Alps alerts failed", e); return null; }),
    loadSwissHistory(swissSlugs).catch(e => { console.warn("CH history failed", e); return null; }),
  ]);

  const failures = [];
  if (chR) {
    PASSES.forEach(p => {
      if (p.slug && chR.data[p.slug]) {
        chR.data[p.slug].sourceLabel = "alpen-paesse.ch";
        p._status = chR.data[p.slug];
        chMatched++;
      }
    });
  } else { failures.push("alpen-paesse.ch (CH)"); }

  if (alpsR) {
    Object.values(alpsR.data).forEach(alert => {
      const candidates = new Set();
      nameAliases(alert._matchName).forEach(a => {
        const list = passByAlias.get(a);
        if (list) list.forEach(p => candidates.add(p));
      });
      if (candidates.size === 0) return;
      /* Pick best by elevation similarity. */
      let best = null, bestDelta = Infinity;
      candidates.forEach(p => {
        const d = alert.elev != null ? Math.abs(alert.elev - p.elev) : 0;
        if (d < bestDelta) { bestDelta = d; best = p; }
      });
      if (!best) return;
      if (alert.elev != null && bestDelta > 200) return;  /* probably wrong match */
      /* don't overwrite higher-priority CH live source */
      if (best._status?.source === "live" && best._status.sourceLabel?.includes("alpen-paesse.ch")) return;
      best._status = alert;
      alpsMatched++;
    });
  } else { failures.push("alpenpaesse.de (alerts)"); }

  if (histR) {
    PASSES.forEach(p => {
      const history = p.slug ? histR.data[p.slug] : null;
      if (!history) return;
      p._history = history;
      if (!p._status || p._status.source === "estimate") {
        p._status = historyStatus(history);
      } else {
        p._status.history = history;
      }
    });
  } else { failures.push("alpen-paesse.ch (history)"); }

  /* Tally final source counts; split estimates by likely state so the footer
     does not flatten "likely open" and "likely closed" into one bucket. */
  const counts = {
    live: 0, osm: 0, historyDerived: 0, historyRecords: 0,
    estimateOpen: 0, estimateRestricted: 0, estimateClosed: 0, unknown: 0,
  };
  PASSES.forEach(p => {
    const d = statusDisplay(p._status);
    if (p._history) counts.historyRecords++;
    if (d.source === "live") counts.live++;
    else if (d.source === "osm") counts.osm++;
    else if (d.source === "history") counts.historyDerived++;
    else if (!d.estimated) counts.unknown++;

    if (d.estimated && d.state === "open") counts.estimateOpen++;
    else if (d.estimated && d.state === "restricted") counts.estimateRestricted++;
    else if (d.estimated && d.state === "closed") counts.estimateClosed++;
  });
  const estimateParts = [
    counts.estimateOpen ? `${counts.estimateOpen} likely open` : null,
    counts.estimateRestricted ? `${counts.estimateRestricted} likely restricted` : null,
    counts.estimateClosed ? `${counts.estimateClosed} likely closed` : null,
  ].filter(Boolean);

  const ts = new Date(chR?.fetchedAt || alpsR?.fetchedAt || Date.now()).toLocaleString();
  updatedText.textContent =
    `Status: ${counts.live} live · ${counts.osm} OSM rule` +
    (counts.historyDerived ? ` · ${counts.historyDerived} history-derived` : "") +
    (estimateParts.length ? ` · ${estimateParts.join(" · ")}` : "") +
    (counts.historyRecords ? ` · ${counts.historyRecords} history records` : "") +
    (counts.unknown ? ` · ${counts.unknown} unknown` : "") +
    ` · fetched ${ts}` +
    (chR?.cached || alpsR?.cached || histR?.cached ? " (cached)" : "");

  if (failures.length) {
    banner.classList.remove("hidden");
    banner.textContent = `⚠ Some live sources unavailable (${failures.join(", ")}). Falling back to OSM rules / estimates where needed.`;
  }

  refreshProjectedStatuses({ updateMarkers: true });
})();

document.getElementById("refreshBtn").addEventListener("click", () => {
  /* Reload the page without bypassing the daily live-source cache. */
  location.reload();
});
