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
  /* Starting price (filled in async by loadPoiPrices()). */
  priceKind:         null,
  priceFromAdultChf: null,
  priceAsOf:         null,
  priceSourceUrl:    null,
  priceNotes:        null,
}));
const POI_BY_ID = new Map(POIS.map(p => [p.id, p]));
/* Hard-filter to POIs the OSRM road router can actually reach.  Anything
   without "car" access (cogwheel-only summits, car-free mountain villages)
   is shown on the map but not allowed in a planned tour. */
const PLANNABLE_POIS = POIS.filter(p => p.poiAccess.includes("car"));
const PLANNABLE_POI_IDS = new Set(PLANNABLE_POIS.map(p => p.id));
function isPlannablePoi(p) { return p?.isPoi && PLANNABLE_POI_IDS.has(p.id); }

/* ─────────────────────── POI starting-prices ───────────────────────
   Loaded from `assets/data/poi-prices.json` (committed cache refreshed
   on deploy via tools/fetch_poi_prices.py + the refresh-poi-prices
   GitHub Actions workflow). The committed JSON is the persistent
   fallback so we always have *some* price data even if the live fetch
   fails. Each entry is keyed by the POI's raw `n` field (kept on
   `poi.rawName` after normalisation). The fetch is best-effort: a
   missing or unreachable cache simply leaves POIs without prices.

   Schema of each entry:
     kind            "paid" | "free" | "varies" | "donation"
     from_adult_chf  number — only when kind === "paid"
     as_of           year string for context (e.g. "2024")
     source_url      official source URL
     source_kind     "manual" | "wikidata"  (refresher only updates wikidata)
     verified_at     YYYY-MM-DD
     notes           optional free-text
*/
async function loadPoiPrices() {
  try {
    const res = await fetch("assets/data/poi-prices.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const cache = await res.json();
    if (!cache || typeof cache !== "object") return;
    const entries = cache.entries || {};
    let matched = 0;
    POIS.forEach(p => {
      const e = entries[p.rawName];
      if (!e) return;
      p.priceKind        = e.kind || null;
      p.priceFromAdultChf = typeof e.from_adult_chf === "number" ? e.from_adult_chf : null;
      p.priceAsOf        = e.as_of || null;
      p.priceSourceUrl   = e.source_url || null;
      p.priceNotes       = e.notes || null;
      matched++;
    });
    if (matched > 0 && typeof renderPoiList === "function") {
      renderPoiList();
    }
  } catch (e) {
    /* Silent fallback — POI rows simply render without price chips. */
    console.warn("[poi-prices] cache load failed:", e);
  }
}

function poiPriceShort(poi) {
  switch (poi.priceKind) {
    case "free":     return "Free";
    case "varies":   return "Varies";
    case "donation": return "Donation";
    case "paid":
      return poi.priceFromAdultChf
        ? `CHF ${Math.round(poi.priceFromAdultChf)}+`
        : null;
    default: return null;
  }
}

function poiPriceLong(poi) {
  switch (poi.priceKind) {
    case "free":     return "Free";
    case "varies":   return "Varies";
    case "donation": return "Donation";
    case "paid":
      return poi.priceFromAdultChf
        ? `From CHF ${Number.isInteger(poi.priceFromAdultChf)
            ? poi.priceFromAdultChf
            : poi.priceFromAdultChf.toFixed(2)} · adult`
        : null;
    default: return null;
  }
}

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
const POI_CATEGORY_ICON = {
  "mountain-summit":     "poi-mountain-summit",
  "alpine-lake":         "poi-alpine-lake",
  "waterfall-gorge":     "poi-waterfall-gorge",
  "glacier":             "poi-glacier",
  "old-town":            "poi-old-town",
  "castle-fortress":     "poi-castle-fortress",
  "monastery-church":    "poi-monastery-church",
  "scenic-railway":      "poi-scenic-railway",
  "bridge-engineering":  "poi-bridge-engineering",
  "village":             "poi-village",
  "national-park":       "poi-national-park",
  "spa-wellness":        "poi-spa-wellness",
  "viewpoint-panorama":  "poi-viewpoint-panorama",
  "museum-cultural":     "poi-museum-cultural",
  "geology-cave":        "poi-geology-cave",
  "wine-region":         "poi-wine-region",
  "special-experience":  "poi-special-experience",
};
function poiCategoryLabel(cat) { return POI_CATEGORY_LABELS[cat] || cat || "POI"; }
function poiCategoryIconId(cat) { return POI_CATEGORY_ICON[cat] || "poi-generic"; }

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
const UI_ICON_IDS = new Set([
  "status-open", "status-restricted", "status-closed", "status-estimated", "status-unknown",
  "poi-generic", "not-by-car", "poi-mountain-summit", "poi-alpine-lake", "poi-waterfall-gorge",
  "poi-glacier", "poi-old-town", "poi-castle-fortress", "poi-monastery-church", "poi-scenic-railway",
  "poi-bridge-engineering", "poi-village", "poi-national-park", "poi-spa-wellness", "poi-viewpoint-panorama",
  "poi-museum-cultural", "poi-geology-cave", "poi-wine-region", "poi-special-experience", "pass-generic",
]);

function iconSvg(id, className = "app-icon") {
  return `<svg class="${className}" aria-hidden="true"><use href="${ICON_SPRITE}#${id}"></use></svg>`;
}

function uiIconHtml(id, className = "app-icon", label = "") {
  const safeId = UI_ICON_IDS.has(id) ? id : "poi-generic";
  const aria = label
    ? ` role="img" aria-label="${escapeHtml(label)}"`
    : ` aria-hidden="true"`;
  return `<span class="ui-art-icon ui-icon-${safeId} ${className}"${aria}></span>`;
}

function poiCategoryIcon(cat, className = "poi-icon") {
  return uiIconHtml(poiCategoryIconId(cat), className, poiCategoryLabel(cat));
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

let plannedTourIds = [];
let plannedBadgeMap = new Map();
let plannedStart = null;
let plannedRouteActive = false;
let plannedRouteCoords = null;
let plannedRouteFallback = false;

function setPlannedTourIds(ids) {
  plannedTourIds = Array.isArray(ids) ? ids.slice() : [];
  plannedBadgeMap = new Map(plannedTourIds.map((id, i) => [id, i + 1]));
}

function plannedBadgeNumber(p) {
  return plannedBadgeMap.get(p?.id) || null;
}

function updatePassMarkerIcon(p) {
  if (!p) return;
  updateMapSources();
}

function refreshProjectedStatuses({ updateMarkers = false } = {}) {
  const tripDate = currentTripDate();
  PASSES.forEach(p => { p._displayStatus = projectedStatusForPass(p, tripDate); });
  if (!updateMarkers) return;
  updateMapSources();
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

/* ───────────────────── native vector map (MapLibre GL) ─────────────────────
   MapLibre owns the vector basemap and route line layers. A custom Alpine DOM
   overlay owns the rich pass/POI markers, clusters, tour badges and start pin,
   so we keep the fast basemap without giving up the app's visual identity. */
const VECTOR_BASEMAPS = [
  { name: "Liberty vector",  style: "https://tiles.openfreemap.org/styles/liberty" },
  { name: "Bright vector",   style: "https://tiles.openfreemap.org/styles/bright" },
  { name: "Positron vector", style: "https://tiles.openfreemap.org/styles/positron" },
];

function updateMapInfo(styleName) {
  const el = document.getElementById("mapInfo");
  if (!el) return;
  el.innerHTML = `Vector map: <strong>${styleName}</strong> · OpenFreeMap/OpenMapTiles · WebGL`;
}

const defaultBaseLayerName = VECTOR_BASEMAPS[0].name;
let currentBaseLayerName = defaultBaseLayerName;

const map = new maplibregl.Map({
  container: "map",
  style: VECTOR_BASEMAPS[0].style,
  center: [10.0, 46.7],
  zoom: 7,
  minZoom: 4,
  maxZoom: 18,
  attributionControl: true,
});
window.alpineMap = map;

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
updateMapInfo(defaultBaseLayerName);

const STATE_ICON_NAMES = new Set(["open", "restricted", "closed", "estimated", "unknown"]);
function stateIconId(state, estimated = false) {
  if (estimated) return "status-estimated";
  return STATE_ICON_NAMES.has(state) ? `status-${state}` : "status-unknown";
}

const PASS_SOURCE_ID = "alpine-passes";
const POI_SOURCE_ID = "swiss-pois";
const ROUTE_SOURCE_ID = "planned-route";
const START_SOURCE_ID = "planned-start";
const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] };
let mapLayersReady = false;
let poiLayerVisible = true;
let activePopup = null;
let passUiReady = false;
let poiUiReady = false;
let mapLayerRestoreQueued = false;

function statusColorExpression() {
  return [
    "match", ["get", "state"],
    "open", "#3ddc84",
    "restricted", "#ffb020",
    "closed", "#ef4444",
    "#8a96a0",
  ];
}

function passFeature(p) {
  const status = passStatus(p);
  const view = statusDisplay(status);
  const badge = plannedBadgeNumber(p) || 0;
  return {
    type: "Feature",
    id: p.id,
    geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    properties: {
      id: p.id,
      kind: "pass",
      name: p.name,
      alt: p.alt || "",
      elev: p.elev,
      state: view.state,
      estimated: !!view.estimated,
      quality: p.quality || 0,
      tourIndex: badge,
      tourLabel: badge ? String(badge) : "",
    },
  };
}

function poiFeature(p) {
  const badge = plannedBadgeNumber(p) || 0;
  return {
    type: "Feature",
    id: p.id,
    geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    properties: {
      id: p.id,
      kind: "poi",
      name: p.name,
      category: p.poiCategory || "",
      plannable: isPlannablePoi(p),
      quality: p.quality || 0,
      tourIndex: badge,
      tourLabel: badge ? String(badge) : "",
    },
  };
}

function featureCollection(items, mapper) {
  return { type: "FeatureCollection", features: items.map(mapper) };
}

function currentPassMapFeatures() {
  const items = passUiReady ? PASSES.filter(passesAllFilters) : PASSES;
  return featureCollection(items, passFeature);
}

function currentPoiMapFeatures() {
  if (!poiLayerVisible) return EMPTY_FEATURE_COLLECTION;
  if (!poiUiReady) return featureCollection(POIS, poiFeature);
  const q = (poiSearchEl?.value || "").trim().toLowerCase();
  return featureCollection(
    POIS.filter(p => poiPassesAllFilters(p)).filter(p => !q || poiSearchMatches(p, q)),
    poiFeature
  );
}

function setSourceData(sourceId, data) {
  const source = map.getSource(sourceId);
  if (source) source.setData(data);
}

function hasRequiredMapLayers() {
  return !!(
    map.getSource(PASS_SOURCE_ID) &&
    map.getSource(POI_SOURCE_ID) &&
    map.getSource(ROUTE_SOURCE_ID) &&
    map.getLayer("planned-route-core") &&
    map.getLayer(ALPINE_GL_LAYER_ID)
  );
}

function requestMapLayerRestore(attempt = 0) {
  if (mapLayerRestoreQueued) return;
  mapLayerRestoreQueued = true;
  const run = () => {
    mapLayerRestoreQueued = false;
    try {
      mapLayersReady = false;
      setupMapLayers();
      updateMapInfo(currentBaseLayerName);
    } catch (error) {
      if (attempt < 20) {
        setTimeout(() => requestMapLayerRestore(attempt + 1), 100);
        return;
      }
      console.error("Unable to restore Alpine map layers after style change", error);
    }
  };
  requestAnimationFrame(run);
}

function updateMapSources() {
  scheduleAlpineOverlayRender();
  if (!mapLayersReady || !hasRequiredMapLayers()) {
    requestMapLayerRestore();
    return;
  }
  setSourceData(PASS_SOURCE_ID, currentPassMapFeatures());
  setSourceData(POI_SOURCE_ID, currentPoiMapFeatures());
  updatePlannedTourLayers();
  scheduleAlpineOverlayRender();
}

function addCircleLayer(layer) {
  if (!map.getLayer(layer.id)) map.addLayer(layer);
}

const ALPINE_GL_LAYER_ID = "alpine-overlay";
const ALPINE_GL_STRIDE = 20;
const ALPINE_GL_KIND = { pass: 0, poi: 1, passCluster: 2, poiCluster: 3, label: 4, preview: 5 };
const ALPINE_GL_LABEL_COLS = 16;
const ALPINE_GL_LABEL_ROWS = 16;
const ALPINE_GL_LABEL_CELL = 64;
const ALPINE_GL_FLAG_ESTIMATED = 1;
const ALPINE_GL_FLAG_DIM = 2;
const ALPINE_GL_FLAG_SIMPLE_CIRCLE = 4;
const ALPINE_GL_COLORS = {
  markerPurple:[0.545, 0.424, 0.925, 1],
  open:       [0.239, 0.863, 0.518, 1],
  restricted: [1.000, 0.690, 0.125, 1],
  closed:     [0.937, 0.267, 0.267, 1],
  unknown:    [0.541, 0.588, 0.627, 1],
  passCluster:[0.075, 0.590, 0.660, 1],
  poi:        [0.655, 0.545, 0.980, 1],
  poiDim:     [0.580, 0.639, 0.722, 0.86],
  poiCluster: [0.075, 0.590, 0.660, 1],
  white:      [1.000, 1.000, 1.000, 0.95],
  dark:       [0.043, 0.055, 0.063, 0.96],
  preview:    [0.360, 0.400, 0.420, 0.96],
};
const UI_ATLAS_CELLS = {
  "status-open": [0, 0],
  "status-restricted": [1, 0],
  "status-closed": [2, 0],
  "status-estimated": [3, 0],
  "status-unknown": [4, 0],
  "poi-generic": [0, 1],
  "not-by-car": [1, 1],
  "poi-mountain-summit": [2, 1],
  "poi-alpine-lake": [3, 1],
  "poi-waterfall-gorge": [4, 1],
  "poi-glacier": [0, 2],
  "poi-old-town": [1, 2],
  "poi-castle-fortress": [2, 2],
  "poi-monastery-church": [3, 2],
  "poi-scenic-railway": [4, 2],
  "poi-bridge-engineering": [0, 3],
  "poi-village": [1, 3],
  "poi-national-park": [2, 3],
  "poi-spa-wellness": [3, 3],
  "poi-viewpoint-panorama": [4, 3],
  "poi-museum-cultural": [0, 4],
  "poi-geology-cave": [1, 4],
  "poi-wine-region": [2, 4],
  "poi-special-experience": [3, 4],
  "pass-generic": [4, 4],
};

function lngLatToMercatorNorm(lng, lat) {
  const sinLat = Math.sin(lat * Math.PI / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI),
  };
}

function atlasCellUv(cell) {
  const col = Math.max(0, Math.min(4, Number(cell?.[0]) || 0));
  const row = Math.max(0, Math.min(4, Number(cell?.[1]) || 0));
  return [col * 0.2, (4 - row) * 0.2];
}

function textureRefForUiIcon(id, scale = 0.85) {
  const [u, v] = atlasCellUv(UI_ATLAS_CELLS[id] || UI_ATLAS_CELLS["poi-generic"]);
  return { sheet: 0, u, v, scale };
}

function textureRefForPassSymbol(asset, scale = 1.0) {
  if (!asset) return null;
  const sheet = String(asset.sheet || "").includes("sprite-02") ? 2 : 1;
  const [u, v] = atlasCellUv([asset.col, asset.row]);
  return { sheet, u, v, scale };
}

class AlpineWebGLLayer {
  constructor() {
    this.id = ALPINE_GL_LAYER_ID;
    this.type = "custom";
    this.renderingMode = "2d";
    this._map = null;
    this._gl = null;
    this._program = null;
    this._quadBuffer = null;
    this._instanceBuffer = null;
    this._textures = [];
    this._locations = null;
    this._instancingExt = null;
    this._instanceData = new Float32Array(0);
    this._instanceCount = 0;
    this._pickItems = [];
    this._dirty = true;
    this._labelDirty = true;
    this._warnedMissingMatrix = false;
    this._groups = [];
    this._transientGroups = [];
    this._animations = new Map();
    this._animationMs = 280;
    this._start = null;
    this._labelCanvas = document.createElement("canvas");
    this._labelCanvas.width = ALPINE_GL_LABEL_COLS * ALPINE_GL_LABEL_CELL;
    this._labelCanvas.height = ALPINE_GL_LABEL_ROWS * ALPINE_GL_LABEL_CELL;
    this._labelEntries = [];
    this._labelKeys = new Map();
    this._reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;
    this._startedAt = performance.now();
  }

  setGroups(groups, start = null) {
    const nextGroups = Array.isArray(groups) ? groups.slice() : [];
    this._prepareGroupAnimations(this._groups, nextGroups);
    this._groups = nextGroups;
    this._start = start;
    this._rebuildInstances(performance.now());
    this._dirty = true;
    this._labelDirty = true;
    this._map?.triggerRepaint();
  }

  _prepareGroupAnimations(oldGroups, newGroups) {
    if (this._reducedMotion) {
      this._animations.clear();
      this._transientGroups = [];
      return;
    }
    const now = performance.now();
    const oldPositions = this._itemPositionsForGroups(oldGroups, now);
    const newPositions = this._itemPositionsForGroups(newGroups, now);
    const animations = new Map();
    const transients = [];
    const distanceEpsilon = 0.000001;
    for (const [key, dst] of newPositions) {
      const src = oldPositions.get(key);
      if (!src) continue;
      const moved = Math.abs(src.lng - dst.lng) + Math.abs(src.lat - dst.lat);
      if (moved <= distanceEpsilon) continue;
      animations.set(key, { srcLngLat: [src.lng, src.lat], dstLngLat: [dst.lng, dst.lat], startMs: now });
    }
    for (const group of newGroups) {
      if (group.type !== "cluster") continue;
      for (const item of group.items || []) {
        const key = this._itemAnimationKey(group.kind, item);
        if (!animations.has(key)) continue;
        transients.push({
          id: `${group.kind}:transient:${item.id}`,
          kind: group.kind,
          type: "marker",
          item,
          lng: item.lon,
          lat: item.lat,
          _animKey: key,
        });
      }
    }
    this._animations = animations;
    this._transientGroups = transients;
  }

  _itemPositionsForGroups(groups, now) {
    const positions = new Map();
    for (const group of groups || []) {
      if (group.type === "cluster") {
        for (const item of group.items || []) {
          const key = this._itemAnimationKey(group.kind, item);
          positions.set(key, this._animatedLngLat(key, group.lng, group.lat, now, false));
        }
      } else if (group.item) {
        const key = this._itemAnimationKey(group.kind, group.item);
        positions.set(key, this._animatedLngLat(key, group.lng, group.lat, now, false));
      }
    }
    return positions;
  }

  _itemAnimationKey(kind, item) {
    return `${kind}:${item?.id}`;
  }

  _animationEase(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  _animatedLngLat(key, lng, lat, now = performance.now(), prune = true) {
    const anim = this._animations.get(key);
    if (!anim) return { lng, lat };
    const t = Math.min(1, Math.max(0, (now - anim.startMs) / this._animationMs));
    if (t >= 1) {
      if (prune) this._animations.delete(key);
      return { lng: anim.dstLngLat[0], lat: anim.dstLngLat[1] };
    }
    const eased = this._animationEase(t);
    return {
      lng: anim.srcLngLat[0] + (anim.dstLngLat[0] - anim.srcLngLat[0]) * eased,
      lat: anim.srcLngLat[1] + (anim.dstLngLat[1] - anim.srcLngLat[1]) * eased,
    };
  }

  pickAt(point) {
    if (!this._map || !point) return null;
    for (let i = this._pickItems.length - 1; i >= 0; i--) {
      const pick = this._pickItems[i];
      const screen = this._map.project([pick.lng, pick.lat]);
      const dx = point.x - screen.x;
      const dy = point.y - screen.y;
      if ((dx * dx + dy * dy) <= pick.radius * pick.radius) return pick;
    }
    return null;
  }

  onAdd(mapInstance, gl) {
    this._map = mapInstance;
    this._gl = gl;
    this._instancingExt = this._supportsWebGL2(gl) ? null : gl.getExtension("ANGLE_instanced_arrays");
    if (!this._supportsWebGL2(gl) && !this._instancingExt) {
      throw new Error("ANGLE_instanced_arrays is unavailable");
    }
    this._program = this._createProgram(gl);
    this._locations = this._lookupLocations(gl, this._program);
    this._quadBuffer = this._createQuadBuffer(gl);
    this._instanceBuffer = gl.createBuffer();
    this._textures = [
      this._loadTexture(gl, "assets/ui-icons/alpine-ui-icons.png"),
      this._loadTexture(gl, "assets/pass-icon-sheets/top-50-icon-sprite-01.png"),
      this._loadTexture(gl, "assets/pass-icon-sheets/top-50-icon-sprite-02.png"),
      this._createLabelTexture(gl),
    ];
    this._dirty = true;
    this._labelDirty = true;
    mapInstance.triggerRepaint();
  }

  onRemove(_mapInstance, gl) {
    if (this._quadBuffer) gl.deleteBuffer(this._quadBuffer);
    if (this._instanceBuffer) gl.deleteBuffer(this._instanceBuffer);
    if (this._program) gl.deleteProgram(this._program);
    this._textures.forEach(tex => { if (tex) gl.deleteTexture(tex); });
    this._quadBuffer = null;
    this._instanceBuffer = null;
    this._program = null;
    this._textures = [];
    this._locations = null;
    this._gl = null;
  }

  render(arg0, arg1) {
    if (!this._program || !this._locations) return;
    const gl = arg0?.gl || arg0;
    const matrix = this._matrixFromRenderArgs(arg0, arg1);
    if (!gl || !matrix) {
      if (!this._warnedMissingMatrix) {
        this._warnedMissingMatrix = true;
        console.error("Alpine WebGL overlay render missing a 4x4 projection matrix");
      }
      return;
    }
    if (this._animations.size) {
      this._rebuildInstances(performance.now());
      this._dirty = true;
      this._map?.triggerRepaint();
    } else if (this._transientGroups.length) {
      this._transientGroups = [];
      this._rebuildInstances(performance.now());
      this._dirty = true;
    }
    if (this._dirty) this._uploadInstances(gl);
    if (this._labelDirty) this._uploadLabelTexture(gl);
    if (!this._instanceCount) return;
    const loc = this._locations;
    gl.useProgram(this._program);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.uniformMatrix4fv(loc.uMatrix, false, matrix);
    gl.uniform2f(loc.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(loc.uDpr, window.devicePixelRatio || 1);
    gl.uniform1f(loc.uTime, this._reducedMotion ? 0 : (performance.now() - this._startedAt) / 1000);
    this._bindTextures(gl, loc);
    this._bindAttributes(gl, loc);
    this._drawInstanced(gl);
  }

  _matrixFromRenderArgs(arg0, arg1) {
    /* MapLibre 5 ships these in the second arg of render():
       - defaultProjectionData.mainMatrix: works with raw MercatorCoordinate
         (x,y in [0,1]) — what we want.
       - modelViewProjectionMatrix: works with mercator * worldSize.
       Older MapLibre versions pass the matrix as the second argument.
       Prefer mainMatrix so our [0,1] mercator vertex positions project
       directly to clip space at every zoom. */
    const candidates = [
      arg0?.defaultProjectionData?.mainMatrix,
      arg1?.defaultProjectionData?.mainMatrix,
      arg0?.modelViewProjectionMatrix,
      arg1?.modelViewProjectionMatrix,
      arg0?.projectionMatrix,
      arg1?.projectionMatrix,
      arg1,
    ];
    for (const candidate of candidates) {
      const matrix = this._matrixCandidate(candidate);
      if (matrix) return matrix;
    }
    return null;
  }

  _matrixCandidate(candidate) {
    if (!candidate) return null;
    if (candidate instanceof Float32Array && candidate.length >= 16) return candidate;
    if (ArrayBuffer.isView(candidate) && candidate.length >= 16) {
      /* Element-wise conversion (e.g. MapLibre 5 ships a Float64Array).
         Do NOT use the (buffer, byteOffset, length) form — that reinterprets
         8-byte doubles as 4-byte floats and produces a garbage matrix. */
      return new Float32Array(candidate);
    }
    if (typeof candidate.length === "number" && candidate.length >= 16) {
      return new Float32Array(Array.prototype.slice.call(candidate, 0, 16));
    }
    return null;
  }

  _supportsWebGL2(gl) {
    return typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  }

  _createProgram(gl) {
    const vertexSource = `
      precision mediump float;
      attribute vec2 a_quad;
      attribute vec2 a_pos;
      attribute vec4 a_meta;
      attribute vec4 a_fill;
      attribute vec4 a_stroke;
      attribute vec4 a_icon;
      attribute vec2 a_offset;
      uniform mat4 u_matrix;
      uniform vec2 u_viewport;
      uniform float u_dpr;
      uniform float u_time;
      varying vec2 v_uv;
      varying vec2 v_local;
      varying vec4 v_meta;
      varying vec4 v_fill;
      varying vec4 v_stroke;
      varying vec4 v_icon;
      varying float v_time;
      void main() {
        vec4 clip = u_matrix * vec4(a_pos, 0.0, 1.0);
        vec2 ndc = clip.xy / clip.w;
        vec2 pxOffset = a_quad * vec2(a_meta.x, a_meta.y) + a_offset;
        vec2 ndcOffset = (pxOffset * u_dpr) / (u_viewport * 0.5);
        gl_Position = vec4((ndc + ndcOffset) * clip.w, clip.z, clip.w);
        v_uv = a_quad + 0.5;
        v_local = a_quad;
        v_meta = a_meta;
        v_fill = a_fill;
        v_stroke = a_stroke;
        v_icon = a_icon;
        v_time = u_time;
      }`;
    const fragmentSource = `
      precision mediump float;
      uniform sampler2D u_uiTex;
      uniform sampler2D u_passTex1;
      uniform sampler2D u_passTex2;
      uniform sampler2D u_labelTex;
      varying vec2 v_uv;
      varying vec2 v_local;
      varying vec4 v_meta;
      varying vec4 v_fill;
      varying vec4 v_stroke;
      varying vec4 v_icon;
      varying float v_time;
      const float PI = 3.14159265359;
      bool flagSet(float flags, float bit) {
        return mod(floor(flags / bit), 2.0) >= 1.0;
      }
      vec4 sampleIcon(vec2 iconUv) {
        if (v_icon.x < -0.5) return vec4(0.0);
        if (v_icon.x < 0.5) return texture2D(u_uiTex, iconUv);
        if (v_icon.x < 1.5) return texture2D(u_passTex1, iconUv);
        if (v_icon.x < 2.5) return texture2D(u_passTex2, iconUv);
        return texture2D(u_labelTex, iconUv);
      }
      vec4 fetchIconAt(vec2 uv, float scale) {
        if (v_icon.x < -0.5 || v_icon.w <= 0.0) return vec4(0.0);
        vec2 iconLocal = (uv - vec2(0.5)) / max(0.001, scale) + vec2(0.5);
        if (iconLocal.x < 0.0 || iconLocal.x > 1.0 || iconLocal.y < 0.0 || iconLocal.y > 1.0) return vec4(0.0);
        vec2 iconUv = vec2(v_icon.y + iconLocal.x * 0.2, v_icon.z + iconLocal.y * 0.2);
        return sampleIcon(iconUv);
      }
      vec4 fetchIcon() {
        return fetchIconAt(v_uv, v_icon.w);
      }
      float roundedBox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + vec2(r);
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }
      vec4 simpleCircleMarker() {
        float d = length(v_local);
        float aa = 0.012;
        float alpha = 1.0 - smoothstep(0.50 - aa, 0.50 + aa, d);
        if (alpha <= 0.0) discard;
        float edge = smoothstep(0.43, 0.50, d);
        vec3 color = mix(v_fill.rgb, min(v_fill.rgb * 1.10, vec3(1.0)), 1.0 - v_uv.y);
        color = mix(color, vec3(1.0), edge * 0.10);
        vec4 icon = fetchIconAt(v_uv, v_icon.w);
        float iconMask = icon.a;
        if (v_icon.x >= 0.5) iconMask *= 1.0 - smoothstep(0.50, 0.86, length(icon.rgb));
        color = mix(color, vec3(1.0), iconMask * (1.0 - edge * 0.6));
        return vec4(color, alpha);
      }
      vec4 pinMarker() {
        if (flagSet(v_meta.w, 4.0)) return simpleCircleMarker();
        float aa = 0.014;
        float headOuter = roundedBox(v_local - vec2(0.0, 0.08), vec2(0.39, 0.31), 0.12);
        float headInner = roundedBox(v_local - vec2(0.0, 0.08), vec2(0.35, 0.27), 0.10);
        float tailT = clamp((v_local.y + 0.48) / 0.34, 0.0, 1.0);
        float tailOuter = step(-0.48, v_local.y) * step(v_local.y, -0.12) * step(abs(v_local.x), mix(0.035, 0.22, tailT));
        float tailInner = step(-0.43, v_local.y) * step(v_local.y, -0.11) * step(abs(v_local.x), mix(0.020, 0.17, tailT));
        float outer = max(1.0 - smoothstep(0.0, aa, headOuter), tailOuter);
        float inner = max(1.0 - smoothstep(0.0, aa, headInner), tailInner);
        if (outer <= 0.0) discard;
        vec3 color = mix(v_stroke.rgb, v_fill.rgb, inner);
        color = mix(color, v_fill.rgb, tailInner * 0.45);
        vec4 icon = fetchIconAt(v_uv - vec2(0.0, 0.12), v_icon.w);
        bool glyphIcon = v_icon.x < 0.5;
        vec3 iconColor = (glyphIcon || v_meta.z < 0.5 || v_meta.z > 4.5) ? vec3(1.0) : mix(icon.rgb, vec3(1.0), 0.18);
        color = mix(color, iconColor, icon.a * inner);
        if (flagSet(v_meta.w, 1.0)) {
          float a = atan(v_local.y, v_local.x) + PI;
          float dash = step(0.45, fract(a / (2.0 * PI) * 14.0));
          float rim = (1.0 - inner) * outer;
          color = mix(color, vec3(1.0, 0.82, 0.30), rim * dash);
        }
        return vec4(color, outer);
      }
      vec4 clusterMarker() {
        float aa = 0.012;
        float body = roundedBox(v_local, vec2(0.47, 0.34), 0.17);
        float alpha = 1.0 - smoothstep(0.0, aa, body);
        if (alpha <= 0.0) discard;
        float rim = smoothstep(-0.035, 0.018, body);
        vec3 color = mix(v_fill.rgb * 0.94, min(v_fill.rgb * 1.08, vec3(1.0)), 1.0 - v_uv.y);
        color = mix(color, vec3(0.76, 0.97, 0.91), rim * 0.16);
        return vec4(color, alpha);
      }
      vec4 previewChip() {
        float d = length(v_local);
        float aa = 0.014;
        float alpha = 1.0 - smoothstep(0.50 - aa, 0.50 + aa, d);
        if (alpha <= 0.0) discard;
        float ring = smoothstep(0.39, 0.50, d);
        vec3 color = mix(v_fill.rgb, vec3(0.92, 1.0, 0.98), ring * 0.25);
        vec4 icon = fetchIcon();
        vec3 mutedIcon = v_icon.x < 0.5 ? icon.rgb : vec3(1.0);
        color = mix(color, mutedIcon, icon.a * (1.0 - ring * 0.35));
        return vec4(color, alpha);
      }
      vec4 labelMarker() {
        vec2 iconUv = vec2(
          v_icon.y + v_uv.x / ${ALPINE_GL_LABEL_COLS}.0,
          v_icon.z + v_uv.y / ${ALPINE_GL_LABEL_ROWS}.0
        );
        vec4 label = texture2D(u_labelTex, iconUv);
        if (label.a <= 0.01) discard;
        return label;
      }
      void main() {
        float kind = v_meta.z;
        if (kind < 1.5) gl_FragColor = pinMarker();
        else if (kind < 3.5) gl_FragColor = clusterMarker();
        else if (kind < 4.5) gl_FragColor = labelMarker();
        else gl_FragColor = previewChip();
      }`;
    const vertex = this._compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = this._compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const msg = gl.getProgramInfoLog(program) || "unknown link error";
      gl.deleteProgram(program);
      throw new Error(msg);
    }
    return program;
  }

  _compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const msg = gl.getShaderInfoLog(shader) || "unknown shader error";
      gl.deleteShader(shader);
      throw new Error(msg);
    }
    return shader;
  }

  _lookupLocations(gl, program) {
    return {
      aQuad: gl.getAttribLocation(program, "a_quad"),
      aPos: gl.getAttribLocation(program, "a_pos"),
      aMeta: gl.getAttribLocation(program, "a_meta"),
      aFill: gl.getAttribLocation(program, "a_fill"),
      aStroke: gl.getAttribLocation(program, "a_stroke"),
      aIcon: gl.getAttribLocation(program, "a_icon"),
      aOffset: gl.getAttribLocation(program, "a_offset"),
      uMatrix: gl.getUniformLocation(program, "u_matrix"),
      uViewport: gl.getUniformLocation(program, "u_viewport"),
      uDpr: gl.getUniformLocation(program, "u_dpr"),
      uTime: gl.getUniformLocation(program, "u_time"),
      uUiTex: gl.getUniformLocation(program, "u_uiTex"),
      uPassTex1: gl.getUniformLocation(program, "u_passTex1"),
      uPassTex2: gl.getUniformLocation(program, "u_passTex2"),
      uLabelTex: gl.getUniformLocation(program, "u_labelTex"),
    };
  }

  _createQuadBuffer(gl) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, -0.5,  0.5, -0.5, -0.5,  0.5,
      -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
    ]), gl.STATIC_DRAW);
    return buffer;
  }

  _loadTexture(gl, url) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (!this._gl || !tex) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      this._map?.triggerRepaint();
    };
    image.onerror = () => console.warn("Alpine WebGL overlay texture failed to load", url);
    image.src = url;
    return tex;
  }

  _createLabelTexture(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._labelCanvas);
    return tex;
  }

  _bindTextures(gl, loc) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._textures[0]);
    gl.uniform1i(loc.uUiTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._textures[1]);
    gl.uniform1i(loc.uPassTex1, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._textures[2]);
    gl.uniform1i(loc.uPassTex2, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this._textures[3]);
    gl.uniform1i(loc.uLabelTex, 3);
  }

  _bindAttributes(gl, loc) {
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.enableVertexAttribArray(loc.aQuad);
    gl.vertexAttribPointer(loc.aQuad, 2, gl.FLOAT, false, 0, 0);
    this._vertexAttribDivisor(gl, loc.aQuad, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);
    const stride = ALPINE_GL_STRIDE * 4;
    this._instanceAttrib(gl, loc.aPos, 2, stride, 0);
    this._instanceAttrib(gl, loc.aMeta, 4, stride, 2);
    this._instanceAttrib(gl, loc.aFill, 4, stride, 6);
    this._instanceAttrib(gl, loc.aStroke, 4, stride, 10);
    this._instanceAttrib(gl, loc.aIcon, 4, stride, 14);
    this._instanceAttrib(gl, loc.aOffset, 2, stride, 18);
  }

  _instanceAttrib(gl, location, size, strideBytes, floatOffset) {
    if (location < 0) return;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, strideBytes, floatOffset * 4);
    this._vertexAttribDivisor(gl, location, 1);
  }

  _vertexAttribDivisor(gl, location, divisor) {
    if (location < 0) return;
    if (this._supportsWebGL2(gl)) gl.vertexAttribDivisor(location, divisor);
    else this._instancingExt.vertexAttribDivisorANGLE(location, divisor);
  }

  _drawInstanced(gl) {
    if (this._supportsWebGL2(gl)) gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this._instanceCount);
    else this._instancingExt.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, this._instanceCount);
  }

  _uploadInstances(gl) {
    gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this._instanceData, gl.DYNAMIC_DRAW);
    this._dirty = false;
  }

  _uploadLabelTexture(gl) {
    gl.bindTexture(gl.TEXTURE_2D, this._textures[3]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._labelCanvas);
    this._labelDirty = false;
  }

  _rebuildInstances(now = performance.now()) {
    const out = [];
    this._pickItems = [];
    this._labelEntries = [];
    this._labelKeys = new Map();
    for (const group of this._groups) this._pushGroupInstances(out, group, now);
    for (const group of this._transientGroups) this._pushGroupInstances(out, group, now);
    if (this._start) this._pushStartInstance(out, this._start);
    this._drawLabelAtlas();
    this._instanceCount = out.length / ALPINE_GL_STRIDE;
    this._instanceData = new Float32Array(out);
  }

  _pushGroupInstances(out, group, now = performance.now()) {
    const isCluster = group.type === "cluster";
    const isPoi = group.kind === "poi";
    let kind, width, height, flags = 0, fill, stroke = ALPINE_GL_COLORS.white, icon = { sheet: -1, u: 0, v: 0, scale: 0 };
    let lng = group.lng;
    let lat = group.lat;
    if (!isCluster && group.item) {
      const key = group._animKey || this._itemAnimationKey(group.kind, group.item);
      const pos = this._animatedLngLat(key, group.lng, group.lat, now);
      lng = pos.lng;
      lat = pos.lat;
    }
    if (isCluster) {
      kind = isPoi ? ALPINE_GL_KIND.poiCluster : ALPINE_GL_KIND.passCluster;
      width = group.items.length >= 80 ? 54 : group.items.length >= 25 ? 50 : 46;
      height = group.items.length >= 80 ? 38 : 34;
      fill = ALPINE_GL_COLORS.passCluster;
      this._pushInstance(out, lng, lat, width, height, kind, flags, fill, fill, icon);
      this._pushClusterPreviews(out, group, width, height, lng, lat);
      const countLabel = this._labelRef(String(group.items.length), isPoi ? "cluster-poi" : "cluster-pass");
      if (countLabel) {
        const labelWidth = group.items.length >= 100 ? 34 : group.items.length >= 10 ? 30 : 24;
        this._pushInstance(out, lng, lat, labelWidth, 16, ALPINE_GL_KIND.label, 0,
          ALPINE_GL_COLORS.dark, ALPINE_GL_COLORS.dark, countLabel, 0, -height * 0.36);
      }
      this._pickItems.push({ type: "cluster", kind: group.kind, id: group.id, group, lng, lat, radius: width * 0.58 });
      return;
    } else if (isPoi) {
      const plannable = isPlannablePoi(group.item);
      kind = ALPINE_GL_KIND.poi;
      width = 28;
      height = 34;
      flags = plannable ? 0 : ALPINE_GL_FLAG_DIM;
      fill = plannable ? ALPINE_GL_COLORS.markerPurple : ALPINE_GL_COLORS.poiDim;
      icon = textureRefForUiIcon(poiCategoryIconId(group.item.poiCategory), 0.44);
      this._pushInstance(out, lng, lat, width, height, kind, flags, fill, ALPINE_GL_COLORS.dark, icon, 0, height * 0.42);
      if (!plannable) {
        this._pushInstance(out, lng, lat, 18, 18, ALPINE_GL_KIND.preview, 0,
          [0.055, 0.078, 0.118, 0.92], stroke, textureRefForUiIcon("not-by-car", 0.78), 12, height * 0.42 + 10);
      }
    } else {
      kind = ALPINE_GL_KIND.pass;
      const view = statusDisplay(passStatus(group.item));
      width = 34;
      height = 34;
      flags = ALPINE_GL_FLAG_SIMPLE_CIRCLE | (view.estimated ? ALPINE_GL_FLAG_ESTIMATED : 0);
      fill = ALPINE_GL_COLORS.markerPurple;
      icon = textureRefForPassSymbol(group.item.symbolIconAsset, 0.62) ||
             textureRefForUiIcon("pass-generic", 0.48);
      this._pushInstance(out, lng, lat, width, height, kind, flags,
        fill, ALPINE_GL_COLORS.dark, icon, 0, 0);
    }
    const badge = plannedBadgeNumber(group.item);
    if (badge) {
      const badgeIcon = this._labelRef(String(badge), isPoi ? "badge-poi" : "badge-pass");
      if (badgeIcon) this._pushInstance(out, lng, lat, 22, 22, ALPINE_GL_KIND.label, 0,
        fill, stroke, badgeIcon, 13, height * 0.42 + 9);
    }
    this._pickItems.push({
      type: "marker",
      kind: group.kind,
      id: group.item.id,
      item: group.item,
      lng,
      lat,
      radius: Math.max(width, height) * 0.65,
    });
  }

  _pushClusterPreviews(out, group, clusterSize, clusterHeight, lng, lat) {
    const previewSize = clusterSize >= 54 ? 17 : 16;
    const count = Math.min(3, group.items.length);
    const startX = -((count - 1) * previewSize * 0.58) / 2;
    const previewFill = [0.090, 0.170, 0.170, 0.96];
    const previewY = -clusterHeight * 0.03;
    group.items.slice(0, 3).forEach((item, index) => {
      const isPoi = group.kind === "poi";
      let icon;
      if (isPoi) {
        icon = textureRefForUiIcon(poiCategoryIconId(item.poiCategory), 0.72);
      } else {
        const view = statusDisplay(passStatus(item));
        icon = textureRefForPassSymbol(item.symbolIconAsset, 0.82) ||
          textureRefForUiIcon(stateIconId(view.state, view.estimated), 0.72);
      }
      this._pushInstance(out, lng, lat, previewSize, previewSize, ALPINE_GL_KIND.preview, 0,
        previewFill, ALPINE_GL_COLORS.dark, icon, startX + index * (previewSize * 0.58), previewY);
    });
  }

  _pushStartInstance(out, start) {
    const label = this._labelRef((start.name?.[0] || "S").toUpperCase(), "start");
    if (label) this._pushInstance(out, start.lon, start.lat, 38, 38, ALPINE_GL_KIND.label, 0, ALPINE_GL_COLORS.white, ALPINE_GL_COLORS.white, label, 0, -15);
  }

  _pushInstance(out, lng, lat, width, height, kind, flags, fill, stroke, icon, offsetX = 0, offsetY = 0) {
    const merc = lngLatToMercatorNorm(lng, lat);
    out.push(
      merc.x, merc.y, width, height, kind, flags,
      fill[0], fill[1], fill[2], fill[3],
      stroke[0], stroke[1], stroke[2], stroke[3],
      icon.sheet, icon.u, icon.v, icon.scale,
      offsetX, offsetY
    );
  }

  _labelRef(text, type) {
    const safeText = String(text || "").slice(0, 4);
    const key = `${type}:${safeText}`;
    const existing = this._labelKeys.get(key);
    if (existing) return existing;
    const slot = this._labelEntries.length;
    if (slot >= ALPINE_GL_LABEL_COLS * ALPINE_GL_LABEL_ROWS) return null;
    const col = slot % ALPINE_GL_LABEL_COLS;
    const row = Math.floor(slot / ALPINE_GL_LABEL_COLS);
    const ref = {
      sheet: 3,
      u: col / ALPINE_GL_LABEL_COLS,
      v: row / ALPINE_GL_LABEL_ROWS,
      scale: 1,
    };
    this._labelEntries.push({ text: safeText, type, col, row });
    this._labelKeys.set(key, ref);
    return ref;
  }

  _drawLabelAtlas() {
    const ctx = this._labelCanvas.getContext("2d");
    ctx.clearRect(0, 0, this._labelCanvas.width, this._labelCanvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const entry of this._labelEntries) this._drawLabelCell(ctx, entry);
  }

  _drawLabelCell(ctx, entry) {
    const x = entry.col * ALPINE_GL_LABEL_CELL;
    const y = entry.row * ALPINE_GL_LABEL_CELL;
    const cx = x + ALPINE_GL_LABEL_CELL / 2;
    const cy = y + ALPINE_GL_LABEL_CELL / 2;
    ctx.save();
    if (entry.type === "start") {
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      this._roundedRect(ctx, -20, -20, 40, 40, 9);
      ctx.fillStyle = "#ffd166";
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.stroke();
      ctx.rotate(-Math.PI / 4);
      ctx.font = "700 24px system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.fillStyle = "#111827";
      ctx.fillText(entry.text, 0, 1);
      ctx.restore();
      return;
    }
    const isCluster = entry.type.startsWith("cluster");
    const isPoi = entry.type.endsWith("poi");
    const fill = isCluster
      ? "#111827"
      : (isPoi ? "#a78bfa" : "#ffd166");
    const textColor = isCluster ? "#ffffff" : "#111827";
    if (isCluster) {
      this._roundedRect(ctx, x + 5, y + 14, 54, 36, 18);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.font = entry.text.length >= 3
        ? "800 27px system-ui, -apple-system, Segoe UI, sans-serif"
        : "800 31px system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.fillStyle = textColor;
      ctx.fillText(entry.text, cx, cy + 1);
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.stroke();
      ctx.font = "800 23px system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.fillStyle = textColor;
      ctx.fillText(entry.text, cx, cy + 1);
    }
    ctx.restore();
  }

  _roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

const alpineOverlayLayer = new AlpineWebGLLayer();
window.alpineOverlayLayer = alpineOverlayLayer;
const alpineOverlayClusters = new Map();
let overlayLayoutScheduled = false;

const OVERLAY_TILE_SIZE = 256;

/* Web Mercator world-pixel coords at the given zoom — pan-independent so
   cluster cells stay anchored to geography, not to the current screen offset. */
function lngLatToWorldPx(lng, lat, zoom) {
  const sinLat = Math.sin(lat * Math.PI / 180);
  const scale = OVERLAY_TILE_SIZE * Math.pow(2, zoom);
  const x = scale * (lng + 180) / 360;
  const y = scale * (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI));
  return { x, y };
}

function overlayPassItems() {
  return passUiReady ? PASSES.filter(passesAllFilters) : PASSES;
}

function overlayPoiItems() {
  if (!poiLayerVisible) return [];
  if (!poiUiReady) return POIS;
  const q = (poiSearchEl?.value || "").trim().toLowerCase();
  return POIS
    .filter(p => poiPassesAllFilters(p))
    .filter(p => !q || poiSearchMatches(p, q));
}

function clusterRadiusFor(kind, zoom) {
  if (kind === "pass") return zoom < 7 ? 82 : zoom < 9 ? 70 : 58;
  return zoom < 7 ? 90 : zoom < 9 ? 74 : 62;
}

function shouldClusterOverlay(kind, zoom) {
  return zoom < (kind === "pass" ? 11.7 : 11.4);
}

/* Snap to half-zoom steps so small wheel deltas don't reflow clusters. */
function clusterZoomFor(zoom) {
  return Math.round(zoom * 2) / 2;
}

function buildOverlayGroups(items, kind) {
  const zoom = map.getZoom();
  const cZoom = clusterZoomFor(zoom);
  if (!shouldClusterOverlay(kind, zoom)) {
    return items.map(item => ({
      id: `${kind}:${item.id}`,
      kind,
      type: "marker",
      item,
      lng: item.lon,
      lat: item.lat,
    }));
  }
  const radius = clusterRadiusFor(kind, cZoom);
  const cells = new Map();
  const forced = [];
  for (const item of items) {
    if (plannedBadgeNumber(item)) {
      /* Planned-tour stops always render as their own marker so the user
         can see the route order without expanding a cluster. */
      forced.push({
        id: `${kind}:${item.id}`,
        kind,
        type: "marker",
        item,
        lng: item.lon,
        lat: item.lat,
      });
      continue;
    }
    const wp = lngLatToWorldPx(item.lon, item.lat, cZoom);
    const cellKey = `${Math.floor(wp.x / radius)},${Math.floor(wp.y / radius)}`;
    let cell = cells.get(cellKey);
    if (!cell) {
      cell = { cellKey, items: [], sumLng: 0, sumLat: 0 };
      cells.set(cellKey, cell);
    }
    cell.items.push(item);
    cell.sumLng += item.lon;
    cell.sumLat += item.lat;
  }
  const groups = [];
  for (const cell of cells.values()) {
    if (cell.items.length === 1) {
      const item = cell.items[0];
      groups.push({
        id: `${kind}:${item.id}`,
        kind,
        type: "marker",
        item,
        lng: item.lon,
        lat: item.lat,
      });
    } else {
      /* Cluster ID is anchored to (kind, zoom step, world cell). It does NOT
         depend on item ordering or count, so the same cluster element
         persists through pans and small zoom drifts. */
      groups.push({
        id: `${kind}:cluster:${cZoom}:${cell.cellKey}`,
        kind,
        type: "cluster",
        items: cell.items,
        lng: cell.sumLng / cell.items.length,
        lat: cell.sumLat / cell.items.length,
      });
    }
  }
  return groups.concat(forced);
}

/* Re-cluster on settled map state and push the complete overlay model to WebGL. */
function layoutAlpineOverlay() {
  overlayLayoutScheduled = false;
  alpineOverlayClusters.clear();
  const groups = [
    ...buildOverlayGroups(overlayPassItems(), "pass"),
    ...buildOverlayGroups(overlayPoiItems(), "poi"),
  ];
  for (const group of groups) {
    if (group.type === "cluster") alpineOverlayClusters.set(group.id, group);
  }
  alpineOverlayLayer.setGroups(groups, plannedStart);
}

function scheduleAlpineOverlayLayout() {
  if (overlayLayoutScheduled) return;
  overlayLayoutScheduled = true;
  requestAnimationFrame(layoutAlpineOverlay);
}

/* Back-compat alias for callers like updateMapSources(). */
function scheduleAlpineOverlayRender() {
  scheduleAlpineOverlayLayout();
}

function zoomToOverlayCluster(group) {
  if (!group?.items?.length) return;
  if (group.items.length === 1) {
    map.easeTo({ center: [group.items[0].lon, group.items[0].lat], zoom: Math.min(map.getZoom() + 2, 13), duration: 350 });
    return;
  }
  const bounds = new maplibregl.LngLatBounds(
    [group.items[0].lon, group.items[0].lat],
    [group.items[0].lon, group.items[0].lat]
  );
  group.items.slice(1).forEach(item => bounds.extend([item.lon, item.lat]));
  map.fitBounds(bounds, { padding: 90, duration: 450, maxZoom: Math.min(map.getZoom() + 3, 13) });
}

map.on("click", event => {
  if (pickingStart || document.body.classList.contains("picking")) return;
  const pick = alpineOverlayLayer.pickAt(event.point);
  if (!pick) return;
  event.originalEvent?.preventDefault?.();
  if (pick.type === "cluster") {
    zoomToOverlayCluster(pick.group || alpineOverlayClusters.get(pick.id));
    return;
  }
  if (pick.kind === "pass") openPassPopup(pick.item || PASS_BY_ID.get(pick.id));
  else if (pick.kind === "poi") openPoiPopup(pick.item || POI_BY_ID.get(pick.id));
});

map.on("mousemove", event => {
  const canvas = map.getCanvas();
  if (pickingStart || document.body.classList.contains("picking")) {
    canvas.style.cursor = "crosshair";
    return;
  }
  canvas.style.cursor = alpineOverlayLayer.pickAt(event.point) ? "pointer" : "";
});
map.on("moveend", scheduleAlpineOverlayLayout);
/* Re-cluster only when the user has settled — cluster radius depends on the
   final zoom step, not on transient values during a wheel/easeTo flight. */
map.on("zoomend", scheduleAlpineOverlayLayout);
map.on("resize", scheduleAlpineOverlayLayout);

function setupMapLayers() {
  if (!map.getSource(PASS_SOURCE_ID)) {
    map.addSource(PASS_SOURCE_ID, {
      type: "geojson",
      data: currentPassMapFeatures(),
    });
  }
  if (!map.getSource(POI_SOURCE_ID)) {
    map.addSource(POI_SOURCE_ID, {
      type: "geojson",
      data: currentPoiMapFeatures(),
    });
  }
  if (!map.getSource(ROUTE_SOURCE_ID)) {
    map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  }
  if (!map.getSource(START_SOURCE_ID)) {
    map.addSource(START_SOURCE_ID, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  }

  addCircleLayer({
    id: "planned-route-shadow",
    type: "line",
    source: ROUTE_SOURCE_ID,
    paint: { "line-color": "#000", "line-width": 11, "line-opacity": 0.45, "line-blur": 1 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  addCircleLayer({
    id: "planned-route-halo",
    type: "line",
    source: ROUTE_SOURCE_ID,
    paint: { "line-color": "#fff", "line-width": 7, "line-opacity": 0.9 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  addCircleLayer({
    id: "planned-route-core",
    type: "line",
    source: ROUTE_SOURCE_ID,
    paint: {
      "line-color": "#ffd166",
      "line-width": ["case", ["get", "fallback"], 3.5, 5],
      "line-opacity": ["case", ["get", "fallback"], 0.85, 1],
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });

  if (!map.getLayer(ALPINE_GL_LAYER_ID)) {
    map.addLayer(alpineOverlayLayer);
  }

  mapLayersReady = true;
  bindMapInteractions();
  updateMapSources();
}

function bindMapLayerCursor(layerId) {
  map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = pickingStart ? "crosshair" : ""; });
}

function expandCluster(sourceId, feature) {
  const source = map.getSource(sourceId);
  if (!source) return;
  source.getClusterExpansionZoom(feature.properties.cluster_id, (err, zoom) => {
    if (err) return;
    map.easeTo({ center: feature.geometry.coordinates, zoom, duration: 350 });
  });
}

function bindMapInteractions() {
  if (map._alpineInteractionsBound) return;
  map._alpineInteractionsBound = true;
}

function mapBoundsContainsPoint(p) {
  return map.getBounds().contains([p.lon, p.lat]);
}

function flyToItem(p, zoom = 11) {
  map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), zoom), duration: 450 });
}

function fitLngLatPairs(points, pad = 0.10) {
  if (!points.length) return;
  const bounds = new maplibregl.LngLatBounds(points[0], points[0]);
  points.slice(1).forEach(point => bounds.extend(point));
  const size = map.getContainer().getBoundingClientRect();
  const padding = Math.round(Math.min(size.width, size.height) * pad);
  map.fitBounds(bounds, { padding, duration: 500, maxZoom: 13 });
}

function openMapPopup(lngLat, html, maxWidth = "360px") {
  if (activePopup) activePopup.remove();
  activePopup = new maplibregl.Popup({ maxWidth, closeButton: true, closeOnClick: true })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
  return activePopup;
}

async function openPassPopup(p, lngLat = [p.lon, p.lat]) {
  const popup = openMapPopup(lngLat, buildPopupHtml(p, passStatus(p), null), "480px");
  lazyLoadPassIcons(popup.getElement(), true);
  const wiki = await fetchWiki(p.wikiTitle, p.wikiLang);
  if (activePopup === popup) {
    popup.setHTML(buildPopupHtml(p, passStatus(p), wiki));
    lazyLoadPassIcons(popup.getElement(), true);
  }
}

function openPoiPopup(poi, lngLat = [poi.lon, poi.lat]) {
  openMapPopup(lngLat, buildPoiPopupHtml(poi), "480px");
}

function setPoiLayerVisible(visible) {
  poiLayerVisible = visible;
  updateMapSources();
  layoutAlpineOverlay();
  renderPoiList();
}

class AlpineLayerControl {
  onAdd() {
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl maplibregl-ctrl-group alpine-layer-control";
    const styleOptions = VECTOR_BASEMAPS.map(({ name }) =>
      `<option value="${escapeHtml(name)}"${name === currentBaseLayerName ? " selected" : ""}>${escapeHtml(name)}</option>`
    ).join("");
    el.innerHTML = `
      <label><span>Map style</span><select aria-label="Map style">${styleOptions}</select></label>
      <label class="check"><input type="checkbox" checked><span>Sights / POIs</span></label>`;
    const select = el.querySelector("select");
    const poiToggle = el.querySelector('input[type="checkbox"]');
    poiToggle.id = "mapPoiToggle";
    window.mapPoiToggle = poiToggle;
    select.addEventListener("change", () => {
      const next = VECTOR_BASEMAPS.find(b => b.name === select.value);
      if (!next) return;
      currentBaseLayerName = next.name;
      updateMapInfo(currentBaseLayerName);
      map.setStyle(next.style);
      map.once("idle", restoreMapLayers);
    });
    poiToggle.addEventListener("change", () => setPoiLayerVisible(poiToggle.checked));
    return el;
  }
  onRemove() {}
}

map.addControl(new AlpineLayerControl(), "top-right");
function restoreMapLayers() {
  requestMapLayerRestore();
}
map.on("style.load", restoreMapLayers);
map.on("idle", () => {
  if (!map.getSource(ROUTE_SOURCE_ID)) restoreMapLayers();
});

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
  const priceLong = poiPriceLong(poi);
  let priceHtml = "";
  if (priceLong) {
    const sourceLink = poi.priceSourceUrl
      ? ` <a class="poi-price-source" href="${escapeHtml(poi.priceSourceUrl)}" target="_blank" rel="noopener">source ↗</a>`
      : "";
    const asOf = poi.priceAsOf ? ` <span class="poi-price-asof">(${escapeHtml(poi.priceAsOf)})</span>` : "";
    const note = poi.priceNotes
      ? `<div class="poi-price-note">${escapeHtml(poi.priceNotes)}</div>`
      : "";
    priceHtml = `<div class="popup-meta tight poi-price-line">
        <strong>Price:</strong> ${escapeHtml(priceLong)}${asOf}${sourceLink}
        ${note}
      </div>`;
  }
  const planBtn = isPlannablePoi(poi)
    ? `<button class="popup-add-btn" type="button" data-poi-add="${escapeHtml(poi.id)}" aria-label="Add ${escapeHtml(poi.name)} to tour">＋ Add to selected route</button>`
    : `<div class="popup-meta tight" title="POI is not directly reachable by car (${escapeHtml(accessLine)})">${uiIconHtml("not-by-car", "inline-ui-icon", "Not car-accessible")} Not car-accessible — view-only on the map</div>`;
  return `
    <article class="popup poi-popup" data-poi="${escapeHtml(poi.id)}">
      ${img}
      <header class="popup-head">
        <div class="popup-head-row">
          <h3 class="popup-title">${escapeHtml(poi.name)}</h3>
          <span class="poi-cat-badge" data-cat="${poi.poiCategory}">${poiCategoryIcon(poi.poiCategory, "poi-cat-icon")} ${escapeHtml(poiCategoryLabel(poi.poiCategory))}</span>
        </div>
        <div class="popup-meta">${escapeHtml(elevLine)}${escapeHtml(poi.poiRegion)}${dwellLine ? " · " + escapeHtml(dwellLine) : ""}</div>
      </header>
      <div class="popup-body">
        <p class="popup-tldr">${escapeHtml(poi.tldr)}</p>
        ${themeBadges ? `<div class="poi-theme-chips">${themeBadges}</div>` : ""}
        <div class="popup-meta tight"><strong>Access:</strong> ${accessLine || "—"}</div>
        <div class="popup-meta tight"><strong>Season:</strong> ${seasonLine || "—"}</div>
        ${priceHtml}
      </div>
      <footer class="popup-foot">
        <a class="popup-link" href="${wikiHref}" target="_blank" rel="noopener">Wikipedia ↗</a>
        ${planBtn}
      </footer>
    </article>`;
}

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
        ${poiCategoryIcon(p.poiCategory, "chip-glyph")}
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
      ${poiCategoryIcon(p.poiCategory, "poi-picker-art")}
      <span>
        <span class="pass-picker-name">${escapeHtml(p.name)} ${qualityStarsCompact(p.quality)}</span>
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
    return `<button type="button" class="pref-chip${active ? " active" : ""}" data-cat="${escapeHtml(c)}" aria-pressed="${active}" title="${escapeHtml(poiCategoryLabel(c))}">${poiCategoryIcon(c, "pref-chip-icon")} ${escapeHtml(poiCategoryLabel(c))}</button>`;
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
  if (pickingStart && activePopup) { activePopup.remove(); activePopup = null; }
  syncPickButtonState();
});
map.on("click", (e) => {
  if (!pickingStart) return;
  customStart = { name: `Custom (${e.lngLat.lat.toFixed(3)}, ${e.lngLat.lng.toFixed(3)})`,
                  lat: e.lngLat.lat, lon: e.lngLat.lng };
  let opt = startSel.querySelector('option[value="custom"]');
  opt.disabled = false;
  opt.textContent = "📍 " + customStart.name;
  startSel.value = "custom";
  pickingStart = false;
  syncPickButtonState();
});

function clearPlannedTour() {
  setPlannedTourIds([]);
  plannedStart = null;
  plannedRouteActive = false;
  plannedRouteCoords = null;
  plannedRouteFallback = false;
  if (activePopup) { activePopup.remove(); activePopup = null; }
  updatePlannedTourLayers();
  updateMapSources();
}

window.setPlannedStart = function(start) {
  plannedStart = start && Number.isFinite(start.lat) && Number.isFinite(start.lon)
    ? { name: start.name || "Start", lat: start.lat, lon: start.lon }
    : null;
  updatePlannedTourLayers();
  layoutAlpineOverlay();
};

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

/* Backwards-compatible signature wrapper: callers passing the old
   (matrix, N, targetKm, tolerance, …) still work. New callers pass
   targetSpec = { mode, value, tolerance, avgSpeedKmH? } as the third
   argument and `tolerance` is omitted. */
function bestTourGated(matrix, N, targetSpecOrKm, toleranceOrMaxPasses, maxPassesOrPassQ, passQOrSharedFlags, sharedFlagsOrStops, stopsOrUndef) {
  let targetSpec, tolerance, maxPasses, passQ, sharedFlags, stops;
  if (typeof targetSpecOrKm === "object" && targetSpecOrKm !== null) {
    /* New signature: bestTourGated(matrix, N, targetSpec, maxPasses, passQ, sharedFlags, stops) */
    targetSpec = targetSpecOrKm;
    tolerance  = targetSpec.tolerance ?? 0.20;
    maxPasses  = toleranceOrMaxPasses;
    passQ      = maxPassesOrPassQ;
    sharedFlags = passQOrSharedFlags;
    stops      = sharedFlagsOrStops;
  } else {
    /* Legacy signature: bestTourGated(matrix, N, targetKm, tolerance, maxPasses, passQ, sharedFlags, stops) */
    targetSpec = { mode: "distance", value: targetSpecOrKm, tolerance: toleranceOrMaxPasses };
    tolerance  = toleranceOrMaxPasses;
    maxPasses  = maxPassesOrPassQ;
    passQ      = passQOrSharedFlags;
    sharedFlags = sharedFlagsOrStops;
    stops      = stopsOrUndef;
  }
  return _bestTourGatedImpl(matrix, N, targetSpec, tolerance, maxPasses, passQ, sharedFlags, stops);
}

function _bestTourGatedImpl(matrix, N, targetSpec, tolerance, maxPasses, passQ, sharedFlags, stops) {
  const cap = Math.min(maxPasses, N);
  if (N === 0) return null;
  /* Cost matrix selection. In time mode the DP optimises directly on
     `matrix.dur` (seconds) so we get the time-optimal tour, not just the
     time-optimal-given-a-distance-shortest-permutation. POI dwell time is
     added inside visitCost so the DP correctly trades long-dwell sights
     against extra driving (rubber-duck V3 blocking #1). */
  const isTimeMode = targetSpec.mode === "time";
  const costMatrix = isTimeMode ? matrix.dur : matrix.dist;
  /* Targets are kept in cost units (m for distance, s for time) so that
     `g[mask][i][s]` and `lo`/`hi` use consistent magnitudes. */
  const target = isTimeMode ? targetSpec.value * 3600 : targetSpec.value * 1000;
  const lo = target * (1 - tolerance);
  const hi = target * (1 + tolerance);
  const SIZE = 1 << N;
  const Q = passQ || new Array(N).fill({ qSummit: 0.5, qApproach: 0.5 });
  /* Matrix index helper: pass i, point p ∈ {0=A, 1=summit, 2=B}. */
  const mi = (i, p) => 1 + 3 * i + p;
  const baseA = (i) => mi(i, 0), summit = (i) => mi(i, 1), baseB = (i) => mi(i, 2);
  /* Per-stop POI flag — used to branch the quality formula and skip the
     out-and-back retrace penalty for POIs (a POI is one point; there's no
     "back" to trace). */
  const isPoi = (i) => !!stops?.[i]?.isPoi;

  /* Per-visit cost: enterSide∈{0,1}=A/B, exitSide∈{0,1}=A/B.
     Internal traversal: enterBase → summit → exitBase. In time mode and
     for a POI, the per-stop dwell is added so the DP "spends" wall-clock
     time on each sight. */
  function visitCost(i, enterSide, exitSide) {
    const enterIdx = enterSide === 0 ? baseA(i) : baseB(i);
    const exitIdx  = exitSide  === 0 ? baseA(i) : baseB(i);
    let c = costMatrix[enterIdx][summit(i)] + costMatrix[summit(i)][exitIdx];
    if (isTimeMode && isPoi(i)) c += stops[i].visitDwellSec || 0;
    return c;
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
        const cost = costMatrix[0][enterIdx] + visitCost(i, e, s);
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
              const cost = cur + costMatrix[fromIdx][enterIdx] + visitCost(j, e, s2);
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
        const total = v + costMatrix[exitIdx][0];
        if (!isFinite(total)) continue;

        const inRange = total >= lo && total <= hi;
        if (inRange) {
          const traceQ = traceQuality(mask, i, s);
          const sharedPenalty = maskSharedPenalty(mask);
          /* Closeness in cost units: 1/1000 m for distance mode (so it's
             ~km offset), 1/3600 s for time mode (~h offset). Either way
             traceQuality (5–30 units per pass) dominates the score so
             closeness is purely a tiebreaker. */
          const closenessDivisor = isTimeMode ? 3600 : 1000;
          const closeness = -Math.abs(total - target) / closenessDivisor;
          const score = (traceQ - sharedPenalty) * 1e6 + closeness;
          if (!bestSol || score > bestSol.score) {
            bestSol = { mask, total, lastI: i, lastS: s, k, quality: traceQ, score, inRange: true };
          }
        } else {
          /* Fallback: pick by closeness only.  Skip computing
             quality (slow walk-back) unless this becomes the chosen one. */
          const closenessDivisor = isTimeMode ? 3600 : 1000;
          const closeness = -Math.abs(total - target) / closenessDivisor;
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
        const recon = v + costMatrix[fromIdx][enterIdx] + internal;
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

  /* Total duration AND distance along the chosen tour, split into driving
     vs. dwell. Recomputed from BOTH matrices regardless of which one the
     DP optimised on so the result line shows correct km even in time mode
     and correct h even in distance mode. */
  const dur = matrix.dur;
  const dist = matrix.dist;
  let totalDriveS = 0, totalDriveM = 0, totalDwellS = 0, prevIdx = 0;
  for (const t of tour) {
    const enterIdx = t.enterSide === 0 ? baseA(t.passIdx) : baseB(t.passIdx);
    const exitIdx  = t.exitSide  === 0 ? baseA(t.passIdx) : baseB(t.passIdx);
    totalDriveS += dur[prevIdx][enterIdx];
    totalDriveM += dist[prevIdx][enterIdx];
    totalDriveS += visitDur(t.passIdx, t.enterSide, t.exitSide);
    totalDriveM += dist[enterIdx][summit(t.passIdx)] + dist[summit(t.passIdx)][exitIdx];
    if (stops?.[t.passIdx]?.isPoi) {
      totalDwellS += stops[t.passIdx].visitDwellSec || 0;
    }
    prevIdx = exitIdx;
  }
  totalDriveS += dur[prevIdx][0];
  totalDriveM += dist[prevIdx][0];

  return {
    perm: tour,
    km: totalDriveM / 1000,
    h: totalDriveS / 3600,
    driveH: totalDriveS / 3600,
    dwellH: totalDwellS / 3600,
    totalH: (totalDriveS + totalDwellS) / 3600,
    k: sol.k,
    totalQuality: sol.quality,
    score: sol.score,
    inRange: sol.inRange,
    targetMode: targetSpec.mode,
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
      return `<span class="tour-stop poi-stop">${poiCategoryIcon(p.poiCategory, "poi-stop-glyph")} ${escapeHtml(p.name)}${dwell}</span>`;
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
    ? (() => {
        const tolPct = Math.round((r.targetTol ?? 0.20) * 100);
        if (r.targetMode === "time") {
          return `<div class="warn">No tour within ±${tolPct}% of ${r.targetValue} h. Showing closest fit.</div>`;
        }
        return `<div class="warn">No tour within ±${tolPct}% of ${r.targetValue ?? r.targetKm} km. Showing closest fit.</div>`;
      })()
    : "";
  const routeWarning = r.routeWarning
    ? `<div class="warn">${escapeHtml(r.routeWarning)}</div>` : "";
  const statusWarning = r.statusWarning
    ? `<div class="warn">${escapeHtml(r.statusWarning)}</div>` : "";
  const avoided = r.avoided
    ? `<div class="popup-meta tight success">↻ Re-planned to avoid closed pass${r.avoided.length > 1 ? "es" : ""}: ${r.avoided.join(", ")}</div>` : "";
  const title = r.advanced ? "Optimized selected route" : "Best tour";
  /* Time accounting — drive vs dwell vs total. Auto-discovery mode has no
     POIs and so dwellH = 0 / totalH = driveH; only show the breakdown when
     dwell time is nonzero to keep the line concise. In time-mode we always
     surface total time prominently because that's what the user asked for. */
  const driveH = r.driveH ?? r.h ?? 0;
  const dwellH = r.dwellH ?? 0;
  const totalH = r.totalH ?? driveH;
  const timeBlock = (r.targetMode === "time" || dwellH > 0)
    ? `~<strong>${fmtDuration(totalH)}</strong> total <span class="time-breakdown">(${fmtDuration(driveH)} driving${dwellH > 0 ? ` + ${fmtDuration(dwellH)} on site` : ""})</span>`
    : `~<strong>${fmtDuration(driveH)}</strong> driving`;
  const passN = passOnly.length;
  const poiN  = stops.length - passN;
  const stopSummary = poiN > 0
    ? `<strong>${passN}</strong> pass${passN === 1 ? "" : "es"} + <strong>${poiN}</strong> POI${poiN === 1 ? "" : "s"}`
    : `<strong>${r.matched}</strong> selected pass${r.matched === 1 ? "" : "es"}`;
  const distanceBlock = r.targetMode === "time"
    ? `<strong>${Math.round(r.km)} km</strong>`
    : `<strong>${Math.round(r.km)} km</strong>`;
  const targetBadge = r.targetMode === "time"
    ? ` <span class="target-badge">target ${r.targetValue} h</span>`
    : ``;
  const statsLine = r.advanced
    ? `${stopSummary} · ${distanceBlock} · ${timeBlock}`
    : poiN > 0
      ? `${stopSummary} of ${r.poolSize} candidates
         ${r.openOnly ? `(${r.totalOpen} passes shortlisted)` : ""} ·
         ${distanceBlock} · ${timeBlock}${targetBadge}`
      : `<strong>${r.matched}</strong> of ${r.poolSize} candidates
         ${r.openOnly ? `(out of ${r.totalOpen} projected open/restricted passes)` : ""} ·
         ${distanceBlock} · ${timeBlock}${targetBadge}`;
  /* Active POI prefs hint, when any deviates from defaults. */
  const prefsBlock = (r.poiPrefs && (r.poiPrefs.preset || r.poiPrefs.cats.length || r.poiPrefs.themes.length || r.poiPrefs.minScore !== 6 || r.poiPrefs.maxCount !== 3))
    ? (() => {
        if (r.poiPrefs.preset) {
          const lab = POI_PRESETS[r.poiPrefs.preset]?.label || r.poiPrefs.preset;
          return `<div class="popup-meta tight">Sights: ${escapeHtml(lab)}</div>`;
        }
        const bits = [];
        if (r.poiPrefs.cats.length) bits.push(`${r.poiPrefs.cats.length} cat${r.poiPrefs.cats.length === 1 ? "" : "s"}`);
        if (r.poiPrefs.themes.length) bits.push(`themes: ${r.poiPrefs.themes.join(", ")}`);
        bits.push(`★${r.poiPrefs.minScore}+`);
        bits.push(`max ${r.poiPrefs.maxCount}`);
        return `<div class="popup-meta tight">Sights filter: ${escapeHtml(bits.join(" · "))}</div>`;
      })()
    : "";
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
    ${prefsBlock}
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

function updatePlannedTourLayers(routeCoords = plannedRouteCoords, fallback = plannedRouteFallback) {
  if (!mapLayersReady) return;
  setSourceData(ROUTE_SOURCE_ID, routeCoords && routeCoords.length > 1
    ? {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          geometry: { type: "LineString", coordinates: routeCoords },
          properties: { fallback },
        }],
      }
    : EMPTY_FEATURE_COLLECTION);
  setSourceData(START_SOURCE_ID, plannedStart
    ? {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          geometry: { type: "Point", coordinates: [plannedStart.lon, plannedStart.lat] },
          properties: { label: plannedStart.name[0] || "S" },
        }],
      }
    : EMPTY_FEATURE_COLLECTION);
}

function drawPlannedTour(start, tourStops, latlngs) {
  setPlannedTourIds(tourStops.map(p => p.id));
  plannedStart = start;
  plannedRouteActive = true;

  if (tourStops.some(p => p.isPoi) && !poiLayerVisible) {
    setPoiLayerVisible(true);
  }

  let routeCoords;
  let fallback = false;
  if (latlngs && latlngs.length > 1) {
    routeCoords = latlngs.map(([lat, lon]) => [lon, lat]);
  } else {
    fallback = true;
    const wp = [[start.lat, start.lon], ...tourStops.map(p => [p.lat, p.lon]), [start.lat, start.lon]];
    routeCoords = wp.map(([lat, lon]) => [lon, lat]);
  }

  plannedRouteCoords = routeCoords;
  plannedRouteFallback = fallback;
  updateMapSources();
  updatePlannedTourLayers(routeCoords, fallback);
  fitLngLatPairs(routeCoords, fallback ? 0.15 : 0.10);
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
passUiReady = true;

/* "Notable" gates out low-confidence entries plus everything below this
   quality cutoff. Keep this aligned with the generated pass icon set so
   every notable pass has both scenic and compact sprite artwork. */
const NOTABLE_MIN_QUALITY = 0.7;

function inViewport(p) {
  return mapBoundsContainsPoint(p);
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
  updateMapSources();
}
/* Mirror for POIs: when sidebar filters change (category, region, drivable,
   top-notable, search), hide non-matching markers from the on-map cluster
   so the map and the list stay in sync. The full POI population is still
   reachable by clearing the filters or toggling the layer overlay off/on. */
function syncPoiMarkerVisibility() {
  updateMapSources();
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
      const statusIcon = uiIconHtml(listIconId, `status-icon ${statusView.className}`, statusView.label);
      const listIcon = p.symbolIconAsset
        ? `<span class="pass-list-icon-wrap">${passIconHtml(p, "pass-art-icon list symbol", "symbol")} ${statusIcon}</span>`
        : statusIcon;
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
        flyToItem(p, 11);
        setTimeout(() => {
          li.removeAttribute("aria-busy");
          openPassPopup(p);
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
poiUiReady = true;

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
    opt.textContent = `${poiCategoryLabel(c)} (${counts[c]})`;
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
  return mapBoundsContainsPoint(p);
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
      const priceShort = poiPriceShort(p);
      const priceTitle = p.priceNotes ? p.priceNotes
        : (p.priceAsOf ? `As of ${p.priceAsOf}` : "");
      const priceChip = priceShort
        ? `<span class="poi-row-price ${escapeHtml(p.priceKind)}"${priceTitle ? ` title="${escapeHtml(priceTitle)}"` : ""}>${escapeHtml(priceShort)}</span>`
        : "";
      const titleAttr = advanced
        ? "Add this sight to the route"
        : notDrivable
          ? `Not directly reachable by car (${p.poiAccess.join(", ")})`
          : "Zoom to this sight";
      return `<li data-poi-id="${escapeHtml(p.id)}" class="poi-row${selected ? " selected" : ""}${notDrivable ? " not-drivable" : ""}" title="${escapeHtml(titleAttr)}">
        <span class="poi-row-glyph" data-cat="${escapeHtml(p.poiCategory)}" aria-hidden="true">${poiCategoryIcon(p.poiCategory, "poi-row-art")}</span>
        <span>
          <div class="name">${escapeHtml(p.name)} ${qualityStarsCompact(p.quality)}</div>
          <div class="meta">${escapeHtml(elev)}${escapeHtml(poiCategoryLabel(p.poiCategory))} · ${escapeHtml(p.poiRegion)} ${escapeHtml(dwell)} ${escapeHtml(dist)}</div>
        </span>
        ${priceChip}
        ${notDrivable ? `<span class="poi-row-badge" title="Not car-accessible">${uiIconHtml("not-by-car", "poi-row-badge-icon", "Not car-accessible")}</span>` : ""}
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
        if (!poiLayerVisible) setPoiLayerVisible(true);
        flyToItem(p, 11);
        setTimeout(() => {
          li.removeAttribute("aria-busy");
          openPoiPopup(p);
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
updateMapSources();
/* Best-effort cache load — does not block initial render; re-renders the
   POI list once price data arrives. */
loadPoiPrices();

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
