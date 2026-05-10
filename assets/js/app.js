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
function scenicPointFromRaw(raw, fallbackName = "Scenic stop", fallbackKind = "viewpoint") {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const [lat, lon, name, sideOrDwell, qOrKind, dwellOrKind, kindMaybe] = raw;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const side = typeof sideOrDwell === "string" ? sideOrDwell : "summit";
    const dwellMin = typeof sideOrDwell === "number" ? sideOrDwell
      : typeof dwellOrKind === "number" ? dwellOrKind
      : null;
    const q = typeof qOrKind === "number" ? qOrKind : null;
    const kind = typeof qOrKind === "string" ? qOrKind
      : typeof dwellOrKind === "string" ? dwellOrKind
      : typeof kindMaybe === "string" ? kindMaybe
      : fallbackKind;
    return { lat, lon, name: name || fallbackName, side, q, dwellMin, kind };
  }

  const lat = Number.isFinite(raw.lat) ? raw.lat : raw.la;
  const lon = Number.isFinite(raw.lon) ? raw.lon : raw.lo;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    name: raw.name || raw.n || fallbackName,
    side: raw.side || raw.s || "summit",
    q: typeof raw.q === "number" ? raw.q : null,
    dwellMin: typeof raw.dwellMin === "number" ? raw.dwellMin
      : typeof raw.m === "number" ? raw.m
      : null,
    kind: raw.kind || raw.k || fallbackKind,
  };
}

const PASSES = ALPS_INPUT.map((d, i) => {
  const fullName = d.n;
  const parts = fullName.split(/\s*\/\s*|\s*-\s*/);
  const slug = swissSlug(fullName);
  const iconKey = `${fullName}|${d.e}`;
  const scenicIconAsset = window.PASS_ICON_ASSETS?.[iconKey] || null;
  const symbolIconAsset = window.PASS_SYMBOL_ASSETS?.[iconKey] || scenicIconAsset;
  const summitParking = scenicPointFromRaw(d.pk, "Summit parking", "summit-parking");
  const viewpoints = Array.isArray(d.vp)
    ? d.vp.map(v => scenicPointFromRaw(v, "Viewpoint", "viewpoint")).filter(Boolean)
    : [];
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
    /* Optional curated roadside micro-stops. Raw fields are intentionally
       compact for generated data: `pk` = summit parking, `vp` = viewpoints.
       When absent, the planner falls back to the pass summit as a scenic stop. */
    summitParking,
    viewpoints,
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
/* ─────────────────────── Alpine POI datasets ───────────────────────
   Loaded from per-country POI files (`swiss-pois.js`, `french-pois.js`,
   …). All files share the schema described in `swiss-pois.js`.
   POIs are normalised into the same field shape as PASSES so the
   existing planner, popup and tour-rendering helpers can treat them
   uniformly.

   For routing purposes a POI is a single geographic point, so we set
   `baseA == baseB == summit`.  POIs that aren't reachable by car
   (Jungfraujoch, Mürren, Mont Blanc summit, …) are excluded from the
   planner picker — they still appear on the map for context but can't
   be added to a tour. `isPoi: true` is the discriminator used
   throughout the planner. */
const POI_RAW = [
  ...((typeof SWISS_POIS    !== "undefined" && Array.isArray(SWISS_POIS))    ? SWISS_POIS    : []),
  ...((typeof FRENCH_POIS   !== "undefined" && Array.isArray(FRENCH_POIS))   ? FRENCH_POIS   : []),
  ...((typeof ITALY_POIS    !== "undefined" && Array.isArray(ITALY_POIS))    ? ITALY_POIS    : []),
  ...((typeof AUSTRIAN_POIS !== "undefined" && Array.isArray(AUSTRIAN_POIS)) ? AUSTRIAN_POIS : []),
];
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
  poiCountry: d.co || "",
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
  "funicular":           "Funicular",
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
  "funicular":           "poi-funicular",
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
const POI_FAMILY_OF_CATEGORY = {
  "mountain-summit": "nature",
  "alpine-lake": "nature",
  "waterfall-gorge": "nature",
  "glacier": "nature",
  "national-park": "nature",
  "viewpoint-panorama": "nature",
  "geology-cave": "nature",
  "old-town": "heritage",
  "castle-fortress": "heritage",
  "monastery-church": "heritage",
  "village": "heritage",
  "scenic-railway": "engineered",
  "bridge-engineering": "engineered",
  "funicular": "engineered",
  "spa-wellness": "indulgence",
  "museum-cultural": "indulgence",
  "wine-region": "indulgence",
  "special-experience": "indulgence",
};
const POI_FAMILY_LABELS = {
  nature: "Nature",
  heritage: "Heritage",
  engineered: "Engineered",
  indulgence: "Indulgence",
};
const POI_FAMILY_KEYS = Object.keys(POI_FAMILY_LABELS);
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
  "poi-funicular",
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

function openingHintProjectionLabel(status, state) {
  const projection = status?.projection;
  if (projection?.basis !== "opening-hint" || projection.guessed !== false) return "";
  const hint = status?.openingHint;
  if (openingHintOpenFromDatePassed(hint)) return "";
  const hintDate = hint?.date;
  const day = Number(hintDate?.day);
  const month = Number(hintDate?.month);
  if (!Number.isInteger(day) || !Number.isInteger(month) || day < 1 || day > 31 || month < 1 || month > 12) return "";
  const dateLabel = formatOpeningDate(hintDate);
  if (!dateLabel) return "";
  if (state === "closed") return `Closed until ${dateLabel}`;
  if (state === "open") return `Open from ${dateLabel}`;
  return "";
}

function statusDisplay(status) {
  const state = status?.state || "unknown";
  const estimated = isEstimatedStatus(status);
  const exactProjectionLabel = openingHintProjectionLabel(status, state);
  const label = exactProjectionLabel || (estimated
    ? (ESTIMATED_STATE_LABEL[state] || `Likely ${STATE_LABEL[state]?.toLowerCase() || "unknown"}`)
    : (STATE_LABEL[state] || STATE_LABEL.unknown));
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
  const exactProjectionLabel = openingHintProjectionLabel(status, d.state);
  if (status?.projection?.listLabel) return exactProjectionLabel ? d.label : `${d.label} (${status.projection.listLabel})`;
  if (status?.openingHint) {
    const hintListLabel = openingHintListLabel(status.openingHint);
    if (hintListLabel) return exactProjectionLabel ? d.label : `${d.label} (${hintListLabel})`;
  }
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
const planStartTimeEl = document.getElementById("planStartTime");
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

function currentTripStartTime() {
  const value = String(planStartTimeEl?.value || "08:00");
  return /^\d{2}:\d{2}$/.test(value) ? value : "08:00";
}

function currentTripDateTime() {
  const date = currentTripDate();
  const [hours, minutes] = currentTripStartTime().split(":").map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours || 0, minutes || 0);
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

function openingHintOpenFromDatePassed(hint, today = todayLocalDate()) {
  if (hint?.kind !== "open-from") return false;
  const hintDate = openingHintDateForTrip(hint, today);
  return !!hintDate && daysBetweenDates(hintDate, today) > 0;
}

function projectionFromOpeningHint(status, tripDate) {
  const hint = status?.openingHint;
  const hintDate = openingHintDateForTrip(hint, tripDate);
  if (!hintDate) return null;
  const cmp = daysBetweenDates(hintDate, tripDate);
  const openByTrip = hint.kind === "closed-until" ? cmp > 0 : cmp >= 0;
  if (openByTrip && cmp > PROJECTION_HORIZON_DAYS) return null;
  const hintLabel = openingHintLabel(hint);
  if (!hintLabel) return null;
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

function clusterStatusTieRank(state) {
  if (!state || state === "unknown") return -1;
  return statusSortRank({ state });
}

function dominantClusterStatus(items) {
  const tally = {};
  for (const it of items || []) {
    const state = statusDisplay(passStatus(it)).state || "unknown";
    tally[state] = (tally[state] || 0) + 1;
  }
  let best = null;
  let bestCount = -1;
  for (const [state, count] of Object.entries(tally)) {
    if (count > bestCount || (count === bestCount && clusterStatusTieRank(state) > clusterStatusTieRank(best))) {
      best = state;
      bestCount = count;
    }
  }
  return best || "unknown";
}

const PEBBLE_GLYPH_STYLE_SCALE = 100;
const PASS_CLUSTER_PEBBLE_STYLE = {
  open: 1,
  restricted: 2,
  closed: 3,
  unknown: 4,
};

function clusterPebbleTargetCount(count, distinctCount) {
  if (count >= 40) return 3;
  if (count >= 10) return 4;
  if (distinctCount <= 1) return 2;
  return Math.min(3, distinctCount);
}

function poiClusterPebbleTargetCount(count, distinctCount) {
  return clusterPebbleTargetCount(count, distinctCount);
}

function poiClusterPebbleModel(items) {
  const list = Array.isArray(items) ? items : [];
  const tally = new Map();
  for (const item of list) {
    const categoryIcon = poiCategoryIconId(item?.poiCategory);
    tally.set(categoryIcon, (tally.get(categoryIcon) || 0) + 1);
  }
  if (!tally.size) tally.set("poi-generic", Math.max(1, list.length));

  const ranked = Array.from(tally, ([categoryIcon, categoryCount]) => ({ categoryIcon, categoryCount }))
    .sort((a, b) => (b.categoryCount - a.categoryCount) || a.categoryIcon.localeCompare(b.categoryIcon));
  const count = list.length;
  const total = Math.max(1, count);
  const targetCount = poiClusterPebbleTargetCount(count, ranked.length);
  const pebbles = ranked.slice(0, targetCount).map(entry => {
    const share = Math.max(0.01, entry.categoryCount / total);
    return {
      categoryIcon: entry.categoryIcon,
      categoryCount: entry.categoryCount,
      share,
      share2: Math.sqrt(share),
    };
  });

  const dominant = pebbles[0] || {
    categoryIcon: "poi-generic",
    categoryCount: Math.max(1, count),
    share: 1,
    share2: 1,
  };
  let duplicateIndex = 0;
  while (pebbles.length < targetCount) {
    const rawShare = dominant.share * Math.max(0.28, 0.58 - duplicateIndex * 0.10);
    const maxDuplicateShare = pebbles.length > 1 ? pebbles[pebbles.length - 1].share * 0.92 : rawShare;
    const share = Math.max(0.08, Math.min(rawShare, maxDuplicateShare));
    pebbles.push({
      categoryIcon: dominant.categoryIcon,
      categoryCount: Math.max(1, Math.round(share * total)),
      share,
      share2: Math.sqrt(share),
      duplicate: true,
    });
    duplicateIndex++;
  }

  return { count, pebbles };
}

function normalizedPassClusterStatus(state) {
  return PASS_CLUSTER_PEBBLE_STYLE[state] ? state : "unknown";
}

function pebbleStyleForPassStatus(state) {
  return PASS_CLUSTER_PEBBLE_STYLE[normalizedPassClusterStatus(state)];
}

function passClusterPebbleModel(items) {
  const list = Array.isArray(items) ? items : [];
  const buckets = new Map();
  for (const item of list) {
    const state = normalizedPassClusterStatus(statusDisplay(passStatus(item)).state || "unknown");
    if (!buckets.has(state)) buckets.set(state, []);
    buckets.get(state).push(item);
  }
  if (!buckets.size) buckets.set("unknown", []);

  const ranked = Array.from(buckets, ([state, bucketItems]) => {
    const status = bucketItems.length ? dominantClusterStatus(bucketItems) : state;
    return {
      status: normalizedPassClusterStatus(status),
      bucketItems,
      bucketCount: bucketItems.length,
    };
  }).sort((a, b) => (b.bucketCount - a.bucketCount) ||
    (clusterStatusTieRank(b.status) - clusterStatusTieRank(a.status)) ||
    a.status.localeCompare(b.status));

  const count = list.length;
  const total = Math.max(1, count);
  const targetCount = clusterPebbleTargetCount(count, ranked.length);
  const pebbles = ranked.slice(0, targetCount).map(entry => {
    const share = Math.max(0.01, entry.bucketCount / total);
    return {
      iconId: "pass-generic",
      status: entry.status,
      style: pebbleStyleForPassStatus(entry.status),
      bucketCount: entry.bucketCount,
      share,
      share2: Math.sqrt(share),
    };
  });

  const dominant = pebbles[0] || {
    iconId: "pass-generic",
    status: "unknown",
    style: pebbleStyleForPassStatus("unknown"),
    bucketCount: Math.max(1, count),
    share: 1,
    share2: 1,
  };
  let duplicateIndex = 0;
  while (pebbles.length < targetCount) {
    const rawShare = dominant.share * Math.max(0.28, 0.58 - duplicateIndex * 0.10);
    const maxDuplicateShare = pebbles.length > 1 ? pebbles[pebbles.length - 1].share * 0.92 : rawShare;
    const share = Math.max(0.08, Math.min(rawShare, maxDuplicateShare));
    pebbles.push({
      iconId: dominant.iconId,
      status: dominant.status,
      style: dominant.style,
      bucketCount: Math.max(1, Math.round(share * total)),
      share,
      share2: Math.sqrt(share),
      duplicate: true,
    });
    duplicateIndex++;
  }

  return { count, pebbles };
}

let plannedTourIds = [];
let plannedBadgeMap = new Map();
let plannedStart = null;
let plannedRouteActive = false;
let plannedRouteCoords = null;
let plannedRouteGeometry = null;
let plannedRouteFallback = false;
let plannedRouteAlternatives = [];
let activeRouteAlternativeIndex = 0;

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
  const today = todayLocalDate();
  if (planDateEl) {
    planDateEl.min = toDateInputValue(today);
    if (!planDateEl.value) planDateEl.value = toDateInputValue(today);
  }
  if (planStartTimeEl) {
    try {
      const saved = localStorage.getItem("alpine.planner.startTime");
      if (saved && /^\d{2}:\d{2}$/.test(saved)) planStartTimeEl.value = saved;
    } catch {}
    if (!planStartTimeEl.value) planStartTimeEl.value = "08:00";
  }
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
/* CORS-bypassing public proxies for fetching status pages from third-party
   feeds (alpen-paesse.ch, alpenpaesse.de, etc). Order matters: tries each
   in sequence until one succeeds. Reliability tested 2026-05 with 3-proxy
   sweep against both Swiss and German feeds:
   - corsproxy.io   — 117KB on German feed, 163KB on Swiss feed (good)
   - cors.lol       — 117KB on German feed, 162KB on Swiss feed (good)
   - codetabs       — 162KB on Swiss feed, 1.4KB stub on German feed (works
                      partially — kept as last resort because it's fastest
                      when it does work)
   - allorigins.win — fully CORS-blocked at present (removed — was always
                      failing with no Access-Control-Allow-Origin header) */
const PROXIES = [
  url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  url => `https://api.cors.lol/?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
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
  if (openingHintOpenFromDatePassed(hint)) return "";
  const date = formatOpeningDate(hint.date);
  if (hint.kind === "closed-until") return `Closed until ${date}`;
  if (hint.kind === "open-from") return `Open from ${date}`;
  return `Predicted opening: ${date}`;
}

function openingHintListLabel(hint) {
  if (!hint) return "";
  if (openingHintOpenFromDatePassed(hint)) return "";
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
  maxZoom: 14,
  attributionControl: true,
  preserveDrawingBuffer: true,
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
let popupSourceEl = null;
let popupSourceKey = null;
let lastFocusedRow = null;
let _popupTitleSeq = 0;
let passUiReady = false;
let poiUiReady = false;
let mapLayerRestoreQueued = false;

const PASS_LAYER_STATUS_KEYS = ["open", "restricted", "closed", "unknown"];
const PASS_LAYER_STATUS_LABELS = {
  open: "Open",
  restricted: "Restricted",
  closed: "Closed",
  unknown: "Unknown",
  estimated: "Estimated",
};
const POI_LAYER_PRESET_IDS = ["photo", "family", "cultural", "hidden", "wine"];
const POI_LAYER_PRESET_LABELS = {
  photo: "Photo",
  family: "Family",
  cultural: "Cultural",
  hidden: "Hidden",
  wine: "Wine",
};
const layerControlState = {
  passOverlayVisible: true,
  passStatuses: new Set([...PASS_LAYER_STATUS_KEYS, "estimated"]),
  passQualityMin: 0,
  poiFamilies: new Set(POI_FAMILY_KEYS),
  poiThemePreset: "",
  poiQualityMin: 0.6,
  poiPlannableOnly: false,
  soloFocus: false,
};
let layerControlInstance = null;

function passLayerControlQualityLabel() {
  const stars = Math.round(layerControlState.passQualityMin * 5);
  return stars <= 0 ? "All passes" : `★ ${stars}+`;
}

function poiLayerControlQualityLabel() {
  const stars = Math.round(layerControlState.poiQualityMin * 5);
  return stars <= 0 ? "All sights" : `★ ${stars}+`;
}

function layerPoiPresetDefinition(id) {
  if (!id) return null;
  try {
    return POI_PRESETS?.[id] || null;
  } catch (_) {
    return null;
  }
}

function passesLayerControlFilter(p) {
  const view = statusDisplay(passStatus(p));
  if (!layerControlState.passStatuses.has(view.state || "unknown")) return false;
  if (view.estimated && !layerControlState.passStatuses.has("estimated")) return false;
  const threshold = Number(layerControlState.passQualityMin) || 0;
  if (threshold > 0 && (p.quality || 0) < threshold) return false;
  return true;
}

function poiLayerControlFilter(p) {
  const family = POI_FAMILY_OF_CATEGORY[p.poiCategory] || "";
  if (family && !layerControlState.poiFamilies.has(family)) return false;
  if (layerControlState.poiPlannableOnly && !isPlannablePoi(p)) return false;

  const preset = layerPoiPresetDefinition(layerControlState.poiThemePreset);
  const presetCats = Array.isArray(preset?.cats) ? preset.cats : [];
  const presetThemes = Array.isArray(preset?.themes) ? preset.themes : [];
  if (presetCats.length && !presetCats.includes(p.poiCategory)) return false;
  if (presetThemes.length && !(p.poiThemes || []).some(t => presetThemes.includes(t))) return false;

  const sliderMin = Number(layerControlState.poiQualityMin) || 0;
  const presetMin = Number.isFinite(preset?.minScore) ? preset.minScore / 10 : 0;
  const threshold = Math.max(sliderMin, presetMin);
  if (threshold > 0 && (p.quality || 0) < threshold) return false;
  return true;
}

function refreshLayerControlUI() {
  layerControlInstance?.refresh?.();
}

function notifyLayerFiltersChanged({ passes = false, pois = false } = {}) {
  updateMapSources();
  scheduleAlpineOverlayLayout();
  if (passes) {
    renderList();
    renderAdvancedPicker();
  }
  if (pois) {
    renderPoiList();
    renderAdvancedPoiPicker?.();
  }
  refreshLayerControlUI();
}

function setPassOverlayVisible(visible) {
  const next = !!visible;
  if (layerControlState.passOverlayVisible === next) {
    refreshLayerControlUI();
    return;
  }
  layerControlState.passOverlayVisible = next;
  notifyLayerFiltersChanged({ passes: true });
}

function setLayerSoloFocus(visible) {
  const next = !!visible && plannedRouteActive;
  if (layerControlState.soloFocus === next) {
    refreshLayerControlUI();
    return;
  }
  layerControlState.soloFocus = next;
  alpineOverlayLayer.setSoloFocus(next);
  map.getContainer().classList.toggle("pass-stack-solo-focus", next);
  refreshLayerControlUI();
}

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
  if (!layerControlState.passOverlayVisible) return EMPTY_FEATURE_COLLECTION;
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
const ALPINE_GL_STRIDE = 39;
const ALPINE_GL_KIND = { pass: 0, poi: 1, passCluster: 2, poiCluster: 3, label: 4, preview: 5 };
const ALPINE_GL_ENTRANCE_SECONDS = 0.32;
const ALPINE_GL_PEBBLE_POP_SECONDS = 0.20;
const ALPINE_GL_PEBBLE_STAGGER_SECONDS = 0.12;
const ALPINE_GL_PEBBLE_ENTRANCE_SECONDS = 0.65;
const ALPINE_GL_LABEL_COLS = 16;
const ALPINE_GL_LABEL_ROWS = 16;
const ALPINE_GL_LABEL_CELL = 64;
const ALPINE_GL_UI_ATLAS_COLS = 5;
const ALPINE_GL_UI_ATLAS_ROWS = 6;
const ALPINE_GL_PASS_ATLAS_COLS = 5;
const ALPINE_GL_PASS_ATLAS_ROWS = 5;
const ALPINE_GL_FLAG_ESTIMATED = 1;
const ALPINE_GL_FLAG_DIM = 2;
const ALPINE_GL_FLAG_SIMPLE_CIRCLE = 4;
const ALPINE_GL_FLAG_SOLO_DIM = 8;
const ALPINE_GL_PASS_ART_SCALE = 1.1;
const ALPINE_GL_COLORS = {
  markerPurple:[0.545, 0.424, 0.925, 1],
  open:       [0.239, 0.863, 0.518, 1],
  restricted: [1.000, 0.690, 0.125, 1],
  closed:     [0.937, 0.267, 0.267, 1],
  unknown:    [0.541, 0.588, 0.627, 1],
  passCluster:[0.075, 0.590, 0.660, 1],
  poi:        [0.655, 0.545, 0.980, 1],
  poiDim:     [0.580, 0.639, 0.722, 0.86],
  poiCluster: [0.180, 0.440, 0.780, 1],
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
  "poi-funicular": [0, 5],
};

function lngLatToMercatorNorm(lng, lat) {
  const sinLat = Math.sin(lat * Math.PI / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI),
  };
}

function atlasCellUv(cell, cols, rows) {
  const maxCol = Math.max(0, cols - 1);
  const maxRow = Math.max(0, rows - 1);
  const col = Math.max(0, Math.min(maxCol, Number(cell?.[0]) || 0));
  const row = Math.max(0, Math.min(maxRow, Number(cell?.[1]) || 0));
  return [col / cols, (rows - row - 1) / rows];
}

function textureRefForUiIcon(id, scale = 0.85) {
  const [u, v] = atlasCellUv(
    UI_ATLAS_CELLS[id] || UI_ATLAS_CELLS["poi-generic"],
    ALPINE_GL_UI_ATLAS_COLS,
    ALPINE_GL_UI_ATLAS_ROWS
  );
  return { sheet: 0, u, v, scale };
}

function hashStringToUint(str) {
  let hash = 2166136261;
  const text = String(str || "");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function prngFromHash(hash) {
  let state = hash >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function packedGlyphForUiIcon(id, style = 0) {
  const cell = UI_ATLAS_CELLS[id] || UI_ATLAS_CELLS["poi-generic"];
  const col = Math.max(0, Math.min(ALPINE_GL_UI_ATLAS_COLS - 1, Number(cell[0]) || 0));
  const row = Math.max(0, Math.min(ALPINE_GL_UI_ATLAS_ROWS - 1, Number(cell[1]) || 0));
  const styleCode = Math.max(0, Math.min(4, Number(style) || 0));
  return styleCode * PEBBLE_GLYPH_STYLE_SCALE + col * 10 + row + 1;
}

function clusterPebbleLayoutSize(model) {
  if (model.count >= 40 || model.pebbles.length >= 4) return 64;
  if (model.pebbles.length >= 3) return 60;
  return 56;
}

function pebbleLayoutBounds(pebbles) {
  const bounds = { minX: 0.5, maxX: -0.5, minY: 0.5, maxY: -0.5 };
  for (const p of pebbles) {
    bounds.minX = Math.min(bounds.minX, p.cx - p.r);
    bounds.maxX = Math.max(bounds.maxX, p.cx + p.r);
    bounds.minY = Math.min(bounds.minY, p.cy - p.r);
    bounds.maxY = Math.max(bounds.maxY, p.cy + p.r);
  }
  return bounds;
}

function fitPebbleLayout(pebbles) {
  let bounds = pebbleLayoutBounds(pebbles);
  const maxSpan = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  if (maxSpan > 0.98) {
    const scale = 0.98 / maxSpan;
    for (const p of pebbles) {
      p.cx *= scale;
      p.cy *= scale;
      p.r *= scale;
    }
    bounds = pebbleLayoutBounds(pebbles);
  }

  let dx = 0;
  let dy = 0;
  if (bounds.minX < -0.49) dx = -0.49 - bounds.minX;
  if (bounds.maxX + dx > 0.49) dx = 0.49 - bounds.maxX;
  if (bounds.minY < -0.49) dy = -0.49 - bounds.minY;
  if (bounds.maxY + dy > 0.49) dy = 0.49 - bounds.maxY;
  if (dx || dy) {
    for (const p of pebbles) {
      p.cx += dx;
      p.cy += dy;
    }
  }
}

function layoutClusterPebbles(model, seed) {
  const pebblesIn = (model?.pebbles?.length ? model.pebbles : poiClusterPebbleModel([]).pebbles).slice(0, 4);
  const count = Number(model?.count) || 0;
  const n = Math.max(1, pebblesIn.length);
  const rand = prngFromHash(hashStringToUint(seed));
  const dominantShare = Math.max(0.01, pebblesIn[0]?.share || 1);
  const baseRadius = count >= 40 ? 0.33 : (n >= 4 ? 0.30 : 0.32);
  const minRadius = n >= 4 ? 0.18 : 0.21;
  const secondaryMax = baseRadius * (n >= 4 ? 0.78 : (n >= 3 ? 0.80 : 0.88));
  const pebbles = pebblesIn.map((p, i) => {
    const ratio = Math.sqrt(Math.max(0.01, p.share || 0.01) / dominantShare);
    const r = i === 0
      ? baseRadius
      : clampNumber(baseRadius * ratio, minRadius, secondaryMax);
    const iconId = p.iconId || p.categoryIcon || "poi-generic";
    const style = Math.max(0, Math.min(4, Number(p.style) || 0));
    return {
      categoryIcon: iconId,
      iconId,
      status: p.status,
      style,
      share: p.share,
      share2: p.share2,
      cx: 0,
      cy: 0,
      r,
      glyphAtlasRef: textureRefForUiIcon(iconId, 0.62),
      packedGlyph: packedGlyphForUiIcon(iconId, style),
    };
  });

  pebbles[0].cx = 0.06 + (rand() - 0.5) * 0.04;
  pebbles[0].cy = 0.05 + (rand() - 0.5) * 0.04;
  const angleSets = {
    2: [225],
    3: [225, 315],
    4: [205, 315, 150],
  };
  const angles = angleSets[Math.min(4, n)] || angleSets[2];
  for (let i = 1; i < pebbles.length; i++) {
    const angle = ((angles[i - 1] || (205 + i * 73)) + (rand() - 0.5) * 22) * Math.PI / 180;
    const overlap = Math.min(pebbles[0].r, pebbles[i].r) * (0.34 + rand() * 0.16);
    const dist = pebbles[0].r + pebbles[i].r - overlap;
    pebbles[i].cx = pebbles[0].cx + Math.cos(angle) * dist;
    pebbles[i].cy = pebbles[0].cy + Math.sin(angle) * dist;
  }
  fitPebbleLayout(pebbles);
  const size = clusterPebbleLayoutSize({ count, pebbles });

  return {
    dominantIndex: 0,
    width: size,
    height: size,
    pebbles,
  };
}

function layoutPoiClusterPebbles(model, seed) {
  return layoutClusterPebbles(model, seed);
}

function textureRefForPassSymbol(asset, scale = 1.0) {
  if (!asset) return null;
  const sheet = String(asset.sheet || "").includes("sprite-02") ? 2 : 1;
  const [u, v] = atlasCellUv([asset.col, asset.row], ALPINE_GL_PASS_ATLAS_COLS, ALPINE_GL_PASS_ATLAS_ROWS);
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
    this._hoverId = null;
    this._hoverTargetId = null;
    this._hoverAnim = 0;
    this._lastFrameTs = 0;
    this._featureState = new Map();   // featureId -> { bornAt (sec), lastSeenAt (ms), selectedAt (sec), lastGen (int) }
    this._featureGen = 0;             // monotonically increments per _rebuildInstances call
    this._selectedId = null;
    this._hasLoadedOnce = false;
    this._soloFocusOn = false;
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

  setHover(id) {
    if (this._hoverTargetId === id) return;
    this._hoverTargetId = id;
    this._map && this._map.triggerRepaint();
  }

  setSelected(id) {
    if (this._selectedId === id) return;
    this._selectedId = id;
    if (id) {
      const s = this._featureState.get(id) || { bornAt: performance.now() / 1000, lastSeenAt: performance.now(), lastGen: this._featureGen };
      s.selectedAt = performance.now() / 1000;
      this._featureState.set(id, s);
    }
    this._dirty = true;
    this._map?.triggerRepaint();
  }

  setSoloFocus(on) {
    const next = !!on;
    if (this._soloFocusOn === next) return;
    this._soloFocusOn = next;
    this._rebuildInstances(performance.now());
    this._dirty = true;
    this._labelDirty = true;
    this._map?.triggerRepaint();
  }

  _soloFocusDimFlags(group) {
    if (!this._soloFocusOn || !plannedRouteActive) return 0;
    const hasRouteItem = group?.type === "cluster"
      ? (group.items || []).some(item => plannedBadgeNumber(item))
      : !!plannedBadgeNumber(group?.item);
    return hasRouteItem ? 0 : ALPINE_GL_FLAG_SOLO_DIM;
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

  // Returns transition/unfuse progress for rendered child clusters during cluster split/merge movement animations; full old-cluster pebble flyout is intentionally deferred.
  _clusterSplitProgress(group, now = performance.now()) {
    if (!group || group.type !== "cluster" || !this._animations.size) return 0;
    let progress = 0;
    for (const item of group.items || []) {
      const anim = this._animations.get(this._itemAnimationKey(group.kind, item));
      if (!anim) continue;
      const t = Math.min(1, Math.max(0, (now - anim.startMs) / this._animationMs));
      if (t < 1) progress = Math.max(progress, 1 - t);
    }
    return progress;
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
    /* Hover animation — advance per-frame tween and rebuild if needed.
       Uses dirty-flag rebuild strategy: no partial buffer updates needed
       given typical marker counts (<500 instances). */
    {
      const now = performance.now();
      const dt = this._lastFrameTs ? Math.min(64, now - this._lastFrameTs) : 16;
      this._lastFrameTs = now;
      const hoverTarget = this._hoverTargetId !== null ? 1 : 0;
      const hoverStep = this._reducedMotion ? 1 : dt / 140;
      this._hoverAnim += (hoverTarget - this._hoverAnim) * Math.min(1, hoverStep);
      if (Math.abs(hoverTarget - this._hoverAnim) < 0.01) this._hoverAnim = hoverTarget;
      const hoverAnimating = Math.abs(hoverTarget - this._hoverAnim) > 0.001;
      if (hoverAnimating || this._hoverTargetId !== this._hoverId) {
        this._hoverId = this._hoverTargetId;
        this._rebuildInstances(now);
        this._dirty = true;
      }
      if (hoverAnimating) this._map?.triggerRepaint();
    }
    // Keep RAF alive while any entrance animation is still running
    if (!this._reducedMotion && this._featureState.size > 0) {
      const _nowSec = performance.now() / 1000;
      for (const s of this._featureState.values()) {
        if (_nowSec - s.bornAt >= 0 && _nowSec - s.bornAt < ALPINE_GL_PEBBLE_ENTRANCE_SECONDS) {
          this._map?.triggerRepaint();
          break;
        }
      }
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
    const _nowMs = performance.now();
    gl.uniform1f(loc.uNow, _nowMs / 1000);
    gl.uniform1f(loc.uReducedMotion, this._reducedMotion ? 1.0 : 0.0);
    const _selState = this._selectedId ? this._featureState.get(this._selectedId) : null;
    const _pulseSec = _selState?.selectedAt ? (_nowMs / 1000 - _selState.selectedAt) : 999.0;
    gl.uniform1f(loc.uPulseClock, this._reducedMotion ? 999.0 : _pulseSec);
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
      precision highp float;
      attribute vec2 a_quad;
      attribute vec2 a_pos;
      attribute vec4 a_meta;
      attribute vec4 a_fill;
      attribute vec4 a_stroke;
      attribute vec4 a_icon;
      attribute vec2 a_offset;
      attribute float a_hover;
      attribute float a_entrance;
      attribute float a_selected;
      attribute vec4 a_pebble0;
      attribute vec4 a_pebble1;
      attribute vec4 a_pebble2;
      attribute vec4 a_pebble3;
      uniform mat4 u_matrix;
      uniform vec2 u_viewport;
      uniform float u_dpr;
      uniform float u_time;
      uniform float u_now;
      uniform float u_reduced_motion;
      varying vec4 v_quad;
      varying vec4 v_meta;
      varying vec4 v_fill;
      varying vec4 v_stroke;
      varying vec4 v_icon;
      varying vec4 v_state;
      varying vec4 v_pebble3;
      void main() {
        vec4 clip = u_matrix * vec4(a_pos, 0.0, 1.0);
        vec2 ndc = clip.xy / clip.w;
        float elapsed = max(0.0, u_now - a_entrance);
        float t_entrance = clamp(elapsed / ${ALPINE_GL_ENTRANCE_SECONDS}, 0.0, 1.0);
        float t_smooth = smoothstep(0.0, 1.0, t_entrance);
        float overshoot = 1.0 + 0.06 * (1.0 - abs(2.0 * t_smooth - 1.0));
        float isPebbleCluster = step(1.5, a_meta.z) * (1.0 - step(3.5, a_meta.z));
        float entranceScale = u_reduced_motion > 0.5 ? 1.0 : mix(t_smooth * overshoot, 1.0, isPebbleCluster);
        float hoverScale = mix(1.12, 1.06, isPebbleCluster);
        vec2 size = vec2(a_meta.x, a_meta.y) * mix(1.0, hoverScale, a_hover) * entranceScale;
        vec2 pxOffset = a_quad * size + a_offset;
        vec2 ndcOffset = (pxOffset * u_dpr) / (u_viewport * 0.5);
        gl_Position = vec4((ndc + ndcOffset) * clip.w, clip.z, clip.w);
        v_quad = vec4(a_quad + 0.5, a_quad);
        v_meta = a_meta;
        v_state = vec4(u_time, a_hover, u_reduced_motion > 0.5 ? ${ALPINE_GL_PEBBLE_ENTRANCE_SECONDS} : elapsed, a_selected);
        if (a_meta.z > 1.5 && a_meta.z < 3.5) {
          v_fill = a_pebble0;
          v_stroke = a_pebble1;
          v_icon = a_pebble2;
          v_pebble3 = a_pebble3;
        } else {
          v_fill = a_fill;
          v_stroke = a_stroke;
          v_icon = a_icon;
          v_pebble3 = vec4(0.0);
        }
      }`;
    const fragmentSource = `
      precision mediump float;
      uniform sampler2D u_uiTex;
      uniform sampler2D u_passTex1;
      uniform sampler2D u_passTex2;
      uniform sampler2D u_labelTex;
      varying vec4 v_quad;
      varying vec4 v_meta;
      varying vec4 v_fill;
      varying vec4 v_stroke;
      varying vec4 v_icon;
      varying vec4 v_state;
      varying vec4 v_pebble3;
      #define v_uv v_quad.xy
      #define v_local v_quad.zw
      #define v_time v_state.x
      #define v_hover v_state.y
      #define v_entrance_elapsed v_state.z
      #define v_selected v_state.w
      uniform float u_pulse_clock;
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
        vec2 atlasStep = vec2(0.2, 0.2);
        if (v_icon.x < 0.5) atlasStep = vec2(1.0 / ${ALPINE_GL_UI_ATLAS_COLS}.0, 1.0 / ${ALPINE_GL_UI_ATLAS_ROWS}.0);
        else if (v_icon.x > 2.5) atlasStep = vec2(1.0 / ${ALPINE_GL_LABEL_COLS}.0, 1.0 / ${ALPINE_GL_LABEL_ROWS}.0);
        vec2 iconUv = vec2(v_icon.y + iconLocal.x * atlasStep.x, v_icon.z + iconLocal.y * atlasStep.y);
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
        float iconMask = icon.a * (1.0 - edge * 0.25);
        if (v_icon.x < 0.5) {
          color = mix(color, vec3(1.0), iconMask * 0.92);
        } else {
          color = mix(color, icon.rgb, icon.a);
          color = mix(color, vec3(1.0), edge * 0.14 * icon.a);
        }
        return vec4(color, alpha);
      }
      vec4 pinMarker() {
        if (flagSet(v_meta.w, 4.0)) return simpleCircleMarker();
        float aa = 0.014;
        float headOuter = roundedBox(v_local - vec2(0.0, 0.08), vec2(0.40, 0.34), 0.13);
        float headInner = roundedBox(v_local - vec2(0.0, 0.08), vec2(0.355, 0.295), 0.11);
        float tailT = smoothstep(-0.50, -0.12, v_local.y);
        float tailOuter = step(-0.50, v_local.y) * step(v_local.y, -0.10) * step(abs(v_local.x), mix(0.045, 0.235, tailT));
        float tailInner = step(-0.45, v_local.y) * step(v_local.y, -0.11) * step(abs(v_local.x), mix(0.025, 0.175, tailT));
        float outer = max(1.0 - smoothstep(0.0, aa, headOuter), tailOuter);
        float inner = max(1.0 - smoothstep(0.0, aa, headInner), tailInner);
        if (outer <= 0.0) discard;
        vec3 color = mix(v_stroke.rgb, v_fill.rgb, inner);
        color = mix(color, v_fill.rgb, tailInner * 0.45);
        vec4 icon = fetchIconAt(v_uv - vec2(0.0, 0.12), v_icon.w);
        bool glyphIcon = v_icon.x < 0.5;
        /* Sheet 0 (UI atlas) holds two kinds of icons stacked into one
           texture: the status icons in the top row (open/restricted/etc.)
           which must render as a clean white mask on the pin's status
           color, and the POI category icons in the lower rows (mountain,
           lake, castle, …) which carry their own designed colors and
           should render with that color preserved. v_icon.z is the
           cell's V coord; the top row sits high (>0.78) in a 5x6 grid
           while POI rows are at 0.667 and below, so the threshold
           cleanly separates the two. Pass-symbol sheets (sheet 1/2)
           keep their existing colored treatment via the same branch. */
        bool isStatusGlyph = glyphIcon && v_icon.z > 0.78;
        vec3 iconColor = (isStatusGlyph || v_meta.z < 0.5 || v_meta.z > 4.5)
          ? vec3(1.0)
          : mix(icon.rgb, vec3(1.0), 0.18);
        color = mix(color, iconColor, icon.a * inner);
        if (flagSet(v_meta.w, 1.0)) {
          float a = atan(v_local.y, v_local.x) + PI;
          float dash = step(0.45, fract(a / (2.0 * PI) * 14.0));
          float rim = (1.0 - inner) * outer;
          color = mix(color, vec3(1.0, 0.82, 0.30), rim * dash);
        }
        return vec4(color, outer);
      }
      float smoothMin(float a, float b, float k) {
        float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
        return mix(b, a, h) - k * h * (1.0 - h);
      }
      float entranceAlphaFromElapsed(float elapsed) {
        return smoothstep(0.0, 1.0, clamp(elapsed / ${ALPINE_GL_ENTRANCE_SECONDS}, 0.0, 1.0));
      }
      float easeOutBack(float t) {
        float x = t - 1.0;
        float c1 = 1.15;
        float c3 = c1 + 1.0;
        return 1.0 + c3 * x * x * x + c1 * x * x;
      }
      float pebblePopProgress(float order) {
        float t = clamp((v_entrance_elapsed - order * ${ALPINE_GL_PEBBLE_STAGGER_SECONDS}) / ${ALPINE_GL_PEBBLE_POP_SECONDS}, 0.0, 1.0);
        return clamp(easeOutBack(t), 0.0, 1.06);
      }
      vec4 animatedPebble(vec4 pebble, float order) {
        if (pebble.z <= 0.001) return pebble;
        pebble.z *= pebblePopProgress(order);
        return pebble;
      }
      float pebbleFusionK() {
        float clusterEntranceT = clamp(v_entrance_elapsed / ${ALPINE_GL_PEBBLE_ENTRANCE_SECONDS}, 0.0, 1.0);
        float entranceK = mix(0.024, 0.060, smoothstep(0.0, 0.4, clusterEntranceT));
        return mix(entranceK, 0.006, clamp(v_selected, 0.0, 1.0));
      }
      float pebbleDistance(vec4 pebble) {
        if (pebble.z <= 0.001) return 1.0;
        return length(v_local - pebble.xy) - pebble.z;
      }
      float packedPebbleGlyph(vec4 pebble) {
        return floor(pebble.w + 0.5);
      }
      float pebbleStyle(vec4 pebble) {
        if (pebble.z <= 0.001 || pebble.w <= 0.001) return 0.0;
        return floor(packedPebbleGlyph(pebble) / ${PEBBLE_GLYPH_STYLE_SCALE}.0);
      }
      vec3 pebbleStyleColor(float style) {
        if (style > 3.5) return vec3(0.847, 0.835, 0.812);
        if (style > 2.5) return vec3(0.753, 0.345, 0.290);
        if (style > 1.5) return vec3(0.910, 0.710, 0.278);
        return vec3(0.957, 0.929, 0.878);
      }
      float pebbleFillWeight(vec4 pebble, float aa) {
        if (pebble.z <= 0.001) return 0.0;
        return (1.0 - smoothstep(-aa * 2.0, aa * 3.0, pebbleDistance(pebble))) * pebble.z;
      }
      vec3 pebblePileFillColor(vec4 pebble0, vec4 pebble1, vec4 pebble2, vec4 pebble3, float aa) {
        float w0 = pebbleFillWeight(pebble0, aa);
        float w1 = pebbleFillWeight(pebble1, aa);
        float w2 = pebbleFillWeight(pebble2, aa);
        float w3 = pebbleFillWeight(pebble3, aa);
        float total = w0 + w1 + w2 + w3;
        if (total <= 0.001) return pebbleStyleColor(0.0);
        return (
          pebbleStyleColor(pebbleStyle(pebble0)) * w0 +
          pebbleStyleColor(pebbleStyle(pebble1)) * w1 +
          pebbleStyleColor(pebbleStyle(pebble2)) * w2 +
          pebbleStyleColor(pebbleStyle(pebble3)) * w3
        ) / total;
      }
      float pebbleGlyphMask(vec4 pebble) {
        if (pebble.z <= 0.001 || pebble.w <= 0.001) return 0.0;
        vec2 glyphLocal = (v_local - pebble.xy) / max(0.001, pebble.z * 1.46) + vec2(0.5);
        if (glyphLocal.x < 0.0 || glyphLocal.x > 1.0 || glyphLocal.y < 0.0 || glyphLocal.y > 1.0) return 0.0;
        float glyphCode = mod(packedPebbleGlyph(pebble), ${PEBBLE_GLYPH_STYLE_SCALE}.0) - 1.0;
        if (glyphCode < 0.0) return 0.0;
        float sheet = floor(glyphCode / 100.0);
        if (sheet > 0.5) return 0.0;
        float col = floor(mod(glyphCode, 100.0) / 10.0);
        float row = mod(glyphCode, 10.0);
        vec2 iconUv = vec2(
          (col + glyphLocal.x) / ${ALPINE_GL_UI_ATLAS_COLS}.0,
          (${ALPINE_GL_UI_ATLAS_ROWS}.0 - 1.0 - row + glyphLocal.y) / ${ALPINE_GL_UI_ATLAS_ROWS}.0
        );
        float chamber = 1.0 - smoothstep(pebble.z * 0.70, pebble.z * 0.86, length(v_local - pebble.xy));
        return texture2D(u_uiTex, iconUv).a * chamber;
      }
      vec4 pebblePileMarker() {
        vec4 pebble0 = animatedPebble(v_fill, 0.0);
        vec4 pebble1 = animatedPebble(v_stroke, 1.0);
        vec4 pebble2 = animatedPebble(v_icon, 2.0);
        vec4 pebble3 = animatedPebble(v_pebble3, 3.0);
        float fusionK = pebbleFusionK();
        float d = pebbleDistance(pebble0);
        d = smoothMin(d, pebbleDistance(pebble1), fusionK);
        d = smoothMin(d, pebbleDistance(pebble2), fusionK);
        d = smoothMin(d, pebbleDistance(pebble3), fusionK);

        float minDim = max(1.0, min(v_meta.x, v_meta.y));
        float aa = max(1.0 / minDim, 0.010);
        float alpha = 1.0 - smoothstep(0.0, aa * 1.45, d);
        if (alpha <= 0.0) discard;

        vec3 slate = vec3(0.133);
        float strokeWidth = 1.5 / minDim;
        float strokeMix = smoothstep(-strokeWidth - aa, -strokeWidth + aa, d);
        float topLight = smoothstep(-0.42, 0.46, v_local.y);
        vec3 color = pebblePileFillColor(pebble0, pebble1, pebble2, pebble3, aa) * mix(0.965, 1.035, topLight);
        color = mix(color, slate, strokeMix * 0.92);

        float iconMask = max(
          max(pebbleGlyphMask(pebble0), pebbleGlyphMask(pebble1)),
          max(pebbleGlyphMask(pebble2), pebbleGlyphMask(pebble3))
        );
        color = mix(color, slate, iconMask * 0.92);
        return vec4(color, alpha);
      }
      vec4 previewChip() {
        /* Compact white chip with a teal ring — used for the not-by-car
           corner badge on POI pins and any other small accent we add
           in future. Drops the previous "icon-on-teal" look so glyphs
           stay legible. */
        float d = length(v_local);
        float aa = 0.014;
        float alpha = 1.0 - smoothstep(0.50 - aa, 0.50 + aa, d);
        if (alpha <= 0.0) discard;
        float ring = smoothstep(0.42, 0.50, d);
        vec3 base = vec3(0.98, 0.99, 1.0);
        vec3 ringColor = v_fill.rgb;
        vec3 color = mix(base, ringColor, ring * 0.72);
        vec4 icon = fetchIcon();
        vec3 glyphColor = vec3(0.04, 0.06, 0.07);
        vec3 iconColor = v_icon.x < 0.5 ? glyphColor : icon.rgb;
        color = mix(color, iconColor, icon.a * (1.0 - ring * 0.5));
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
        vec4 c;
        if (kind < 1.5) c = pinMarker();
        else if (kind < 3.5) c = pebblePileMarker();
        else if (kind < 4.5) c = labelMarker();
        else c = previewChip();
        /* Hover brightness boost — leaf markers get the stronger lift;
           pebble clusters get a subtler lift, labels/previews stay neutral. */
        float leafHover = v_hover * (1.0 - step(2.0, kind));
        float clusterKind = step(2.0, kind) * (1.0 - step(3.5, kind));
        float clusterHover = v_hover * clusterKind;
        c.rgb = clamp(c.rgb + 0.20 * leafHover + 0.12 * clusterHover, 0.0, 1.0);
        // Clusters skip whole-instance fade because individual pebble radius pops are their entrance.
        c.a *= mix(entranceAlphaFromElapsed(v_entrance_elapsed), 1.0, clusterKind);
        // Keep this literal in sync with ALPINE_GL_FLAG_SOLO_DIM.
        if (flagSet(v_meta.w, 8.0)) c.a *= 0.60;
        // Selected marker pulse — brightness/alpha boost for leaf markers only
        if (kind < 2.0 && v_selected > 0.5 && u_pulse_clock < 1.6) {
          float cycles = u_pulse_clock / 0.55;
          float fr = fract(cycles);
          float ringAlpha = cycles < 2.5 ? (1.0 - fr) * 0.55 : 0.20;
          c.rgb += vec3(0.15) * ringAlpha;
          c.a = max(c.a, ringAlpha * 0.8);
        }
        gl_FragColor = c;
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
      aHover: gl.getAttribLocation(program, "a_hover"),
      aEntrance: gl.getAttribLocation(program, "a_entrance"),
      aSelected: gl.getAttribLocation(program, "a_selected"),
      aPebble0: gl.getAttribLocation(program, "a_pebble0"),
      aPebble1: gl.getAttribLocation(program, "a_pebble1"),
      aPebble2: gl.getAttribLocation(program, "a_pebble2"),
      aPebble3: gl.getAttribLocation(program, "a_pebble3"),
      uMatrix: gl.getUniformLocation(program, "u_matrix"),
      uViewport: gl.getUniformLocation(program, "u_viewport"),
      uDpr: gl.getUniformLocation(program, "u_dpr"),
      uTime: gl.getUniformLocation(program, "u_time"),
      uNow: gl.getUniformLocation(program, "u_now"),
      uReducedMotion: gl.getUniformLocation(program, "u_reduced_motion"),
      uPulseClock: gl.getUniformLocation(program, "u_pulse_clock"),
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
    /* Upload with Y flipped so canvas top-left == texture top-left, matching
       the same convention used by atlasCellUv() / _labelRef(). */
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
    this._instanceAttrib(gl, loc.aHover, 1, stride, 20);
    this._instanceAttrib(gl, loc.aEntrance, 1, stride, 21);
    this._instanceAttrib(gl, loc.aSelected, 1, stride, 22);
    this._instanceAttrib(gl, loc.aPebble0, 4, stride, 23);
    this._instanceAttrib(gl, loc.aPebble1, 4, stride, 27);
    this._instanceAttrib(gl, loc.aPebble2, 4, stride, 31);
    this._instanceAttrib(gl, loc.aPebble3, 4, stride, 35);
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
    /* Generation bump — each rebuild is one generation. Features whose
       state has lastGen === currentGen - 1 were visible in the previous
       rebuild, so we keep their bornAt instead of re-staggering them.
       This prevents markers from "blinking out and re-animating" when a
       moveend/zoomend/resize fires long after the entrance settled. */
    this._featureGen++;
    const _allGroups = [...this._groups, ...this._transientGroups];
    const _totalGroups = Math.max(1, _allGroups.length);
    let _rank = 0;
    for (const group of this._groups) this._pushGroupInstances(out, group, now, _rank++, _totalGroups);
    for (const group of this._transientGroups) this._pushGroupInstances(out, group, now, _rank++, _totalGroups);
    if (this._start) this._pushStartInstance(out, this._start);
    /* Prune feature state that hasn't been touched in the last few
       generations — bounds memory growth as clusters churn over time. */
    if (this._featureState.size > 4096) {
      const cutoff = this._featureGen - 8;
      for (const [id, s] of this._featureState) {
        if (s.lastGen < cutoff) this._featureState.delete(id);
      }
    }
    this._drawLabelAtlas();
    this._labelDirty = true;
    this._instanceCount = out.length / ALPINE_GL_STRIDE;
    this._instanceData = new Float32Array(out);
    this._hasLoadedOnce = true;
  }

  _pushGroupInstances(out, group, now = performance.now(), rank = 0, totalGroups = 1) {
    const isCluster = group.type === "cluster";
    const isPoi = group.kind === "poi";
    const soloDimFlags = this._soloFocusDimFlags(group);
    let kind, width, height, flags = soloDimFlags, fill, stroke = ALPINE_GL_COLORS.white, icon = { sheet: -1, u: 0, v: 0, scale: 0 };
    let lng = group.lng;
    let lat = group.lat;
    if (!isCluster && group.item) {
      const key = group._animKey || this._itemAnimationKey(group.kind, group.item);
      const pos = this._animatedLngLat(key, group.lng, group.lat, now);
      lng = pos.lng;
      lat = pos.lat;
    }
    // Entrance stagger tracking for animated fade-in
    const featureId = group.id;
    const stagWindowMs = this._hasLoadedOnce ? 120 : 240;
    const prevState = this._featureState.get(featureId);
    /* "Still here" if the feature was rendered in the immediately-
       previous rebuild generation. Uses a generation counter rather than
       a wall-clock window because rebuilds are bursty: continuous during
       animations, then quiescent for arbitrarily long stretches. A time
       window incorrectly treated long quiet periods as "feature dropped
       out" and re-staggered the entrance. */
    const stillHere = prevState && prevState.lastGen === this._featureGen - 1;
    const bornAtSec = stillHere
      ? prevState.bornAt
      : (now + (rank / totalGroups) * stagWindowMs) / 1000;
    const selectedAt = prevState?.selectedAt || 0;
    this._featureState.set(featureId, { bornAt: bornAtSec, lastSeenAt: now, selectedAt, lastGen: this._featureGen });
    const isSelected = featureId === this._selectedId ? 1 : 0;
    if (isCluster) {
      kind = isPoi ? ALPINE_GL_KIND.poiCluster : ALPINE_GL_KIND.passCluster;
      const clusterHover = (group.id === this._hoverTargetId) ? this._hoverAnim : 0;

      const pebbleModel = isPoi ? poiClusterPebbleModel(group.items) : passClusterPebbleModel(group.items);
      const pebbleLayout = isPoi ? layoutPoiClusterPebbles(pebbleModel, group.id) : layoutClusterPebbles(pebbleModel, group.id);
      width = pebbleLayout.width;
      height = pebbleLayout.height;
      fill = isPoi ? ALPINE_GL_COLORS.poiCluster : ALPINE_GL_COLORS.passCluster;
      const splitProgress = this._clusterSplitProgress(group, now);
      this._pushInstance(out, lng, lat, width, height, kind, flags, fill, fill, icon, 0, 0, clusterHover, bornAtSec, splitProgress, pebbleLayout.pebbles);

      const countText = pebbleModel.count <= 99 ? String(pebbleModel.count) : "99+";
      const countLabel = this._labelRef(countText, "cluster-pill");
      if (countLabel) {
        const dominantPebble = pebbleLayout.pebbles[pebbleLayout.dominantIndex] || pebbleLayout.pebbles[0];
        const labelSize = 36;
        const baseOffsetX = dominantPebble.cx * width + dominantPebble.r * width * 0.66;
        const baseOffsetY = dominantPebble.cy * height + dominantPebble.r * height * 0.66;
        const offsetLen = Math.hypot(baseOffsetX, baseOffsetY) || 1;
        const offsetX = baseOffsetX + (baseOffsetX / offsetLen) * 2 * clusterHover;
        const offsetY = baseOffsetY + (baseOffsetY / offsetLen) * 2 * clusterHover;
        this._pushInstance(out, lng, lat, labelSize, labelSize, ALPINE_GL_KIND.label, soloDimFlags,
          ALPINE_GL_COLORS.dark, ALPINE_GL_COLORS.dark, countLabel, offsetX, offsetY, 0, bornAtSec, 0);
      }
      this._pickItems.push({ type: "cluster", kind: group.kind, id: group.id, group, lng, lat, radius: Math.max(width, height) * 0.62 });
      return;
    } else if (isPoi) {
      const plannable = isPlannablePoi(group.item);
      kind = ALPINE_GL_KIND.poi;
      width = 36;
      height = 44;
      flags = (plannable ? 0 : ALPINE_GL_FLAG_DIM) | soloDimFlags;
      fill = plannable ? ALPINE_GL_COLORS.markerPurple : ALPINE_GL_COLORS.poiDim;
      icon = textureRefForUiIcon(poiCategoryIconId(group.item.poiCategory), 0.62);
      const poiHover = (group.item?.id === this._hoverTargetId) ? this._hoverAnim : 0;
      this._pushInstance(out, lng, lat, width, height, kind, flags, fill, ALPINE_GL_COLORS.dark, icon, 0, height * 0.42, poiHover, bornAtSec, isSelected);
      if (!plannable) {
        /* Smaller corner badge tucked into the bottom-right of the pin head
           (positive offsetY = up; head sits in the upper portion of the
           quad with vertical center at offsetY = height * 0.42 + ~head/2)
           so the category glyph stays the dominant visual. */
        this._pushInstance(out, lng, lat, 14, 14, ALPINE_GL_KIND.preview, soloDimFlags,
          [0.055, 0.078, 0.118, 0.94], stroke, textureRefForUiIcon("not-by-car", 0.82),
          width * 0.42, height * 0.42 - height * 0.18, 0, bornAtSec, 0);
      }
    } else {
      kind = ALPINE_GL_KIND.pass;
      const view = statusDisplay(passStatus(group.item));
      width = 36;
      height = 36;
      flags = ALPINE_GL_FLAG_SIMPLE_CIRCLE | (view.estimated ? ALPINE_GL_FLAG_ESTIMATED : 0) | soloDimFlags;
      fill = ALPINE_GL_COLORS.markerPurple;
      icon = textureRefForPassSymbol(group.item.symbolIconAsset, ALPINE_GL_PASS_ART_SCALE) ||
             textureRefForUiIcon("pass-generic", 0.62);
      const passHover = (group.item?.id === this._hoverTargetId) ? this._hoverAnim : 0;
      this._pushInstance(out, lng, lat, width, height, kind, flags,
        fill, ALPINE_GL_COLORS.dark, icon, 0, 0, passHover, bornAtSec, isSelected);
    }
    const badge = plannedBadgeNumber(group.item);
    if (badge) {
      const badgeIcon = this._labelRef(String(badge), isPoi ? "badge-poi" : "badge-pass");
      if (badgeIcon) this._pushInstance(out, lng, lat, 22, 22, ALPINE_GL_KIND.label, 0,
        fill, stroke, badgeIcon, 13, height * 0.42 + 9, 0, bornAtSec, 0);
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

  _pushStartInstance(out, start) {
    const label = this._labelRef((start.name?.[0] || "S").toUpperCase(), "start");
    if (label) this._pushInstance(out, start.lon, start.lat, 38, 38, ALPINE_GL_KIND.label, 0, ALPINE_GL_COLORS.white, ALPINE_GL_COLORS.white, label, 0, -15);
  }

  _pushInstance(out, lng, lat, width, height, kind, flags, fill, stroke, icon, offsetX = 0, offsetY = 0, hover = 0, entrance = 0, selected = 0, pebbles = null) {
    const merc = lngLatToMercatorNorm(lng, lat);
    const p0 = pebbles?.[0];
    const p1 = pebbles?.[1];
    const p2 = pebbles?.[2];
    const p3 = pebbles?.[3];
    out.push(
      merc.x, merc.y, width, height, kind, flags,
      fill[0], fill[1], fill[2], fill[3],
      stroke[0], stroke[1], stroke[2], stroke[3],
      icon.sheet, icon.u, icon.v, icon.scale,
      offsetX, offsetY, hover, entrance, selected,
      p0 ? p0.cx : 0, p0 ? p0.cy : 0, p0 ? p0.r : 0, p0 ? p0.packedGlyph : 0,
      p1 ? p1.cx : 0, p1 ? p1.cy : 0, p1 ? p1.r : 0, p1 ? p1.packedGlyph : 0,
      p2 ? p2.cx : 0, p2 ? p2.cy : 0, p2 ? p2.r : 0, p2 ? p2.packedGlyph : 0,
      p3 ? p3.cx : 0, p3 ? p3.cy : 0, p3 ? p3.r : 0, p3 ? p3.packedGlyph : 0
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
      /* Match the same flip applied to UI atlas in atlasCellUv() so labels
         render upright after UNPACK_FLIP_Y_WEBGL=true. */
      v: (ALPINE_GL_LABEL_ROWS - row - 1) / ALPINE_GL_LABEL_ROWS,
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
    if (entry.type === "cluster-pill") {
      ctx.translate(cx, cy);
      this._roundedRect(ctx, -29, -17, 58, 34, 17);
      ctx.fillStyle = "#222222";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.stroke();
      ctx.font = entry.text.length >= 3
        ? "600 25px system-ui, -apple-system, Segoe UI, sans-serif"
        : "600 26px system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.fillStyle = "#ffffff";
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
      ctx.font = entry.text.length >= 3
        ? "900 34px system-ui, -apple-system, Segoe UI, sans-serif"
        : "900 40px system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = entry.text.length >= 3 ? 6 : 7;
      ctx.strokeStyle = "rgba(15, 23, 42, 0.48)";
      ctx.strokeText(entry.text, cx, cy + 1);
      ctx.lineWidth = entry.text.length >= 3 ? 2 : 2.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.34)";
      ctx.strokeText(entry.text, cx, cy + 1);
      ctx.font = entry.text.length >= 3
        ? "900 34px system-ui, -apple-system, Segoe UI, sans-serif"
        : "900 40px system-ui, -apple-system, Segoe UI, sans-serif";
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

function worldPxToLngLat(x, y, zoom) {
  /* Inverse of lngLatToWorldPx — used by deconflictClusterOverlap to
     convert pixel-space nudges back to map coordinates. */
  const scale = OVERLAY_TILE_SIZE * Math.pow(2, zoom);
  const lng = (x / scale) * 360 - 180;
  const sinLat = Math.tanh((0.5 - y / scale) * 4 * Math.PI / 2);
  const lat = Math.asin(sinLat) * 180 / Math.PI;
  return { lng, lat };
}

function overlayPassItems() {
  if (!layerControlState.passOverlayVisible) return [];
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
  /* Pebble-pile clusters are 56-64px wide (Phase 1/2 pebble layout).
     Grid radius must exceed that and add ~18-22px breathing room so
     adjacent piles don't visually collide. The previous values
     (58-90px) predated the pebble redesign — too tight at zoom >=9. */
  if (kind === "pass") return zoom < 7 ? 110 : zoom < 9 ? 96 : 84;
  return zoom < 7 ? 116 : zoom < 9 ? 100 : 88;
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
  /* Pass and POI groups are clustered independently so they can spatially
     overlap (same valley → both a pass cluster and a POI cluster). Even
     within one kind, adjacent grid cells with items near the cell boundary
     can produce centroids closer than the grid radius. Nudge any
     overlapping pile pair apart in pixel space so they visually clear
     each other. */
  deconflictClusterOverlap(groups, clusterZoomFor(map.getZoom()));
  for (const group of groups) {
    if (group.type === "cluster") alpineOverlayClusters.set(group.id, group);
  }
  alpineOverlayLayer.setGroups(groups, plannedStart);
}

function deconflictClusterOverlap(groups, zoom) {
  /* Pixel-space spring repulsion between any cluster/marker pair whose
     visual circles overlap (same-kind OR cross-kind). Same-kind clusters
     come from independent grid cells but their centroids — averaged from
     actual item positions, not cell centers — can land close to each
     other when items cluster near a cell boundary. Cross-kind pairs are
     never grid-coordinated at all. Either way: if visuals overlap, nudge.
     Buffer is small (3px) so semantic position drift stays subtle. */
  if (groups.length < 2) return;
  const visualRadius = (g) => {
    if (g.type === "cluster") return 32;       // pebble pile half-width
    if (g.kind === "pass") return 18;          // pass disc
    return 22;                                 // POI pin (a bit taller)
  };
  const buffer = 3;
  const items = groups.map(g => ({
    g,
    wp: lngLatToWorldPx(g.lng, g.lat, zoom),
    r: visualRadius(g),
    /* Lock single-item markers in place — they point to a real coordinate
       and shifting them would lie about the location. Only clusters
       (averaged centroids already) are free to move. */
    locked: g.type !== "cluster",
  }));
  const ITERATIONS = 4;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (a.locked && b.locked) continue;
        const dx = a.wp.x - b.wp.x;
        const dy = a.wp.y - b.wp.y;
        const dist = Math.hypot(dx, dy);
        const want = a.r + b.r + buffer;
        if (dist >= want) continue;
        const overlap = want - dist;
        let dirX, dirY;
        if (dist > 0.001) {
          dirX = dx / dist;
          dirY = dy / dist;
        } else {
          /* Coincident centers — pick a deterministic direction so the
             nudge is stable across rebuilds. Hash from cluster ids. */
          const seed = (a.g.id.length * 7 + b.g.id.length * 13) % 360;
          const ang = seed * Math.PI / 180;
          dirX = Math.cos(ang);
          dirY = Math.sin(ang);
        }
        if (a.locked) {
          /* a fixed → push b the full overlap */
          b.wp.x -= dirX * overlap;
          b.wp.y -= dirY * overlap;
        } else if (b.locked) {
          a.wp.x += dirX * overlap;
          a.wp.y += dirY * overlap;
        } else {
          /* Both free → split the push 50/50 */
          const half = overlap / 2;
          a.wp.x += dirX * half;
          a.wp.y += dirY * half;
          b.wp.x -= dirX * half;
          b.wp.y -= dirY * half;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const it of items) {
    if (it.locked) continue;
    const ll = worldPxToLngLat(it.wp.x, it.wp.y, zoom);
    it.g.lng = ll.lng;
    it.g.lat = ll.lat;
  }
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

const overlayClickPickCache = new WeakMap();

function overlayPickFromMapEvent(event) {
  if (!event?.point || typeof alpineOverlayLayer?.pickAt !== "function") return null;
  const cacheKey = event.originalEvent && typeof event.originalEvent === "object" ? event.originalEvent : null;
  if (cacheKey && overlayClickPickCache.has(cacheKey)) return overlayClickPickCache.get(cacheKey);
  const pick = alpineOverlayLayer.pickAt(event.point);
  if (cacheKey) overlayClickPickCache.set(cacheKey, pick || null);
  return pick;
}

function routeClickHitsOverlay(event) {
  const pick = overlayPickFromMapEvent(event);
  return pick?.type === "marker" || pick?.type === "cluster";
}

map.on("click", event => {
  if (pickingStart || document.body.classList.contains("picking")) return;
  const pick = overlayPickFromMapEvent(event);
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
    alpineOverlayLayer.setHover(null);
    return;
  }
  const pick = alpineOverlayLayer.pickAt(event.point);
  canvas.style.cursor = pick ? "pointer" : "";
  const hoverable = pick && (pick.type === "marker" || pick.type === "cluster");
  alpineOverlayLayer.setHover(hoverable ? pick.id : null);
});
map.on("mouseout", () => alpineOverlayLayer.setHover(null));
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
      /* Explicit boolean coercion: ["get", "fallback"] returns null when
         the property is missing on a feature, which makes MapLibre's
         spec validator warn ("expected number, found null") even though
         null evaluates falsy in case-condition position. ["==", ..., true]
         always returns a boolean and silences the warning. */
      "line-width": ["case", ["==", ["get", "fallback"], true], 3.5, 5],
      "line-opacity": ["case", ["==", ["get", "fallback"], true], 0.85, 1],
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
  bindRouteInteractions();
}

function bindRouteInteractions() {
  for (const layerId of ["planned-route-core", "planned-route-halo", "planned-route-shadow"]) {
    map.on("click", layerId, onRouteClick);
    map.on("mouseenter", layerId, () => {
      if (!pickingStart && !document.body.classList.contains("picking")) map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      if (!pickingStart) map.getCanvas().style.cursor = "";
    });
  }
}

function routeStopSummary(stops, stopsTakenMin, lunchMin, restMin) {
  const bits = [];
  const passCount = stops.filter(s => !s.isPoi && s.stopMin > 0).length;
  const poiCount = stops.filter(s => s.isPoi && s.dwellMin > 0).length;
  if (passCount) bits.push(`${passCount} pass stop${passCount === 1 ? "" : "s"}`);
  if (poiCount) bits.push(`${poiCount} sight visit${poiCount === 1 ? "" : "s"}`);
  if (restMin > 0.4) bits.push(`${Math.round(restMin)} min rest`);
  if (lunchMin > 0) bits.push(`${Math.round(lunchMin)} min lunch`);
  const names = stops.slice(0, 3).map(s => escapeHtml(s.name)).join(", ");
  const more = stops.length > 3 ? ` +${stops.length - 3} more` : "";
  const prefix = bits.length ? bits.join(" · ") : "No planned stops before this point";
  return `${prefix} · ${Math.round(stopsTakenMin)} min added${names ? ` (${names}${more})` : ""}`;
}

function onRouteClick(e) {
  if (!plannedRouteGeometry || pickingStart || document.body.classList.contains("picking")) return;
  if (routeClickHitsOverlay(e)) return;
  const geom = plannedRouteGeometry;
  if (!geom.coords?.length || !geom.cumKm?.length) return;
  e.preventDefault?.();
  e.originalEvent?.preventDefault?.();
  e.originalEvent?.stopPropagation?.();

  const idx = closestPolylineIdxLngLat(e.lngLat.lng, e.lngLat.lat, geom.coords);
  const distKm = geom.cumKm[idx] || 0;
  const driveRatio = geom.totalKm > 0 ? clampNumber(distKm / geom.totalKm, 0, 1) : 0;
  const driveHAtPoint = (geom.driveH || 0) * driveRatio;
  const totalDriveH = geom.driveH || 0;
  const passedStops = geom.stops.filter(s => s.idx <= idx);
  const routeStopMin = passedStops.reduce((sum, s) => sum + (s.stopMin || 0) + (s.dwellMin || 0), 0);
  const restMin = (geom.totalRestMin || 0) * (totalDriveH > 0 ? Math.min(1, driveHAtPoint / totalDriveH) : 0);
  const lunchMin = totalDriveH > 0 && driveHAtPoint >= totalDriveH / 2 ? (geom.totalLunchMin || 0) : 0;
  const stopsTakenMin = routeStopMin + restMin + lunchMin;
  const totalHAtPoint = driveHAtPoint + stopsTakenMin / 60;

  const html = `
    <div class="route-popup">
      <h4>At this point</h4>
      <div class="route-popup-grid">
        <span>Distance from start</span><strong>${distKm.toFixed(1)} km</strong>
        <span>Driving time</span><strong>${fmtDuration(driveHAtPoint)}</strong>
        <span>With stops &amp; breaks</span><strong>${fmtDuration(totalHAtPoint)}</strong>
      </div>
      <div class="route-popup-meta">${routeStopSummary(passedStops, stopsTakenMin, lunchMin, restMin)}</div>
    </div>`;
  openMapPopup(e.lngLat, html, "320px");
}

function mapBoundsContainsPoint(p) {
  return map.getBounds().contains([p.lon, p.lat]);
}

function alpineFlyTo({ center, zoom, offset, padding }) {
  const baseOpts = {
    center,
    ...(zoom != null && { zoom }),
    ...(offset !== undefined && { offset }),
    ...(padding !== undefined && { padding }),
  };
  const rm = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (rm?.matches) {
    map.jumpTo(baseOpts);
    return;
  }
  const cur = map.getCenter();
  const curZoom = map.getZoom();
  const targetZoom = zoom != null ? zoom : curZoom;
  const pCur = map.project(cur);
  const pTar = map.project(center);
  const pixelDist = Math.hypot(pCur.x - pTar.x, pCur.y - pTar.y);
  const zoomDelta = Math.abs(targetZoom - curZoom);
  if (pixelDist < 80 && zoomDelta < 0.75) {
    map.easeTo({ ...baseOpts, zoom: targetZoom, duration: 220 });
    return;
  }
  let dur = Math.max(350, Math.min(900, 550 * (zoomDelta / 3)));
  if (zoomDelta < 0.5) dur = 350;
  if (map.isMoving()) {
    map.stop();
    dur = Math.min(dur, 400);
  }
  map.flyTo({ ...baseOpts, zoom: targetZoom, duration: dur, curve: 1.42, essential: true });
}

function flyToItem(p, zoom = 11) {
  alpineFlyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), zoom) });
}

function fitLngLatPairs(points, pad = 0.10) {
  if (!points.length) return;
  const bounds = new maplibregl.LngLatBounds(points[0], points[0]);
  points.slice(1).forEach(point => bounds.extend(point));
  const size = map.getContainer().getBoundingClientRect();
  const padding = Math.round(Math.min(size.width, size.height) * pad);
  map.fitBounds(bounds, { padding, duration: 500, maxZoom: 13 });
}

function createMarkerRing(lngLat, popup) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return null;
  const container = map.getContainer();
  const ring = document.createElement('div');
  ring.className = 'ap-marker-ring';
  const updatePos = () => {
    const p = map.project(lngLat);
    ring.style.left = p.x + 'px';
    ring.style.top = p.y + 'px';
  };
  updatePos();
  container.appendChild(ring);
  map.on('move', updatePos);
  setTimeout(() => ring.classList.add('settled'), 1650);
  popup.on('close', () => {
    ring.remove();
    map.off('move', updatePos);
  });
  return ring;
}

function applyPopupDialogAria(contentEl) {
  if (!contentEl) return;
  contentEl.setAttribute('role', 'dialog');
  contentEl.setAttribute('aria-modal', 'true');
  if (!contentEl.hasAttribute('tabindex')) contentEl.setAttribute('tabindex', '-1');
  const heading = contentEl.querySelector('h1, h2, h3, .popup-title, [data-popup-title]');
  if (heading) {
    if (!heading.id) heading.id = `popup-title-${++_popupTitleSeq}`;
    contentEl.setAttribute('aria-labelledby', heading.id);
    contentEl.removeAttribute('aria-label');
  } else {
    contentEl.setAttribute('aria-label', 'Details');
    contentEl.removeAttribute('aria-labelledby');
  }
}

/* Unconditionally apply image binding + wiki-in stagger after any setHTML.
   Called after the initial render AND after any post-wiki setHTML so that
   the pre-existing MapLibre TypeError (which prevents activePopup assignment)
   can no longer block these effects. */
function applyPopupBindings(popup) {
  const root = popup.getElement();
  if (!root) return;
  const imgWrap = root.querySelector('.popup-img-wrap');
  if (imgWrap) bindPopupImage(imgWrap);
  const body = root.querySelector('.popup-body');
  if (body) {
    body.classList.remove('wiki-in');
    [...body.children].forEach((el, i) => el.style.setProperty('--i', i));
    void body.offsetWidth; // force reflow so re-add triggers transition
    body.classList.add('wiki-in');
    setTimeout(() => body.classList.remove('wiki-in'), 240 + body.children.length * 60 + 80);
  }
  requestAnimationFrame(() => applyBodyStagger(root));
  const contentEl = root.querySelector('.maplibregl-popup-content');
  applyPopupDialogAria(contentEl);
}

function openMapPopup(lngLat, html, maxWidth = "360px") {
  if (activePopup) activePopup.remove();
  const isMobile = window.innerWidth <= 640;
  const markerPx = map.project(lngLat);
  const ch = map.getContainer().clientHeight;
  const mobileAnchor = isMobile ? (markerPx.y < ch * 0.4 ? 'top' : 'bottom') : 'auto';
  const popup = new maplibregl.Popup({
    offset: {
      'top':          [0,   10],
      'top-left':     [10,  10],
      'top-right':    [-10, 10],
      'bottom':       [0,  -10],
      'bottom-left':  [10, -10],
      'bottom-right': [-10,-10],
      'left':         [10,   0],
      'right':        [-10,  0],
      'center':       [0,    0],
    },
    anchor: mobileAnchor,
    maxWidth: '320px',
    closeButton: true,
    closeOnClick: false,
    className: 'ap-popup',
  })
    .setLngLat(lngLat)
    .setHTML(html);
  try {
    popup.addTo(map);
  } catch (e) {
    // MapLibre 5.6.1 internal positioning bug — popup still mounts visually.
    // Log once for diagnostics; suppress to avoid spamming console.
    if (!window.__mlPopupAddBugLogged) {
      console.warn('[alpine] suppressing MapLibre popup.addTo internal positioning error (cosmetic);', e?.message);
      window.__mlPopupAddBugLogged = true;
    }
  }
  const contentEl = popup.getElement().querySelector('.maplibregl-popup-content');
  if (contentEl) {
    const initialSource = lastFocusedRow || (document.activeElement !== document.body ? document.activeElement : null);
    popupSourceEl = initialSource;
    popupSourceKey = initialSource?.dataset?.id || initialSource?.dataset?.poiId || null;
    contentEl.setAttribute('tabindex', '-1');
    contentEl.focus({ preventScroll: true });
    applyPopupDialogAria(contentEl);
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const nodes = Array.from(contentEl.querySelectorAll(FOCUSABLE))
        .filter(n => n.offsetParent !== null || n === contentEl);
      if (!nodes.length) { e.preventDefault(); contentEl.focus(); return; }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === contentEl)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    contentEl.addEventListener('keydown', onKey);
    popup.on('close', () => { contentEl.removeEventListener('keydown', onKey); });
  }
  activePopup = popup;
  wrapPopupClose(popup);
  const _mapEl = map.getContainer();
  const _gen = ++_popupOpenGen;
  _mapEl.setAttribute('data-popup-open', 'true');
  popup.on('close', () => {
    if (_popupOpenGen === _gen) _mapEl.removeAttribute('data-popup-open');
    const src = popupSourceEl;
    const key = popupSourceKey;
    popupSourceEl = null;
    popupSourceKey = null;
    let target = null;
    if (src && document.contains(src)) {
      target = src;
    } else if (key) {
      target = document.querySelector(`#passList li[data-id="${CSS.escape(key)}"]`)
        || document.querySelector(`#poiList li[data-poi-id="${CSS.escape(key)}"]`);
    }
    if (target) {
      try { target.focus({ preventScroll: true }); } catch (_) {}
    }
  });
  /* After the popup mounts, ease the map so the popup fully fits in view.
     MapLibre auto-anchors the popup top/bottom of the marker but a tall
     popup can still spill off-screen near viewport edges; nudging the
     marker toward the upper-third gives the popup room to grow downward. */
  requestAnimationFrame(() => {
    if (activePopup !== popup) return;
    panMapForPopup(lngLat, popup);
  });
  return popup;
}

function panMapForPopup(lngLat, popup) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (window.innerWidth > 720) {
    /* ── Desktop: original iter-3 behaviour ─────────────────────────── */
    const container = map.getContainer();
    if (!container) return;
    const popupEl = popup?.getElement();
    if (!popupEl) return;
    const popupContent = popupEl.querySelector(".maplibregl-popup-content");
    if (!popupContent) return;
    const ch = container.offsetHeight;
    const popupHeight = Math.min(popupContent.offsetHeight, ch - 80);
    const desiredMarkerY = Math.max(64, Math.min(ch - popupHeight - 32, ch * 0.28));
    const markerScreen = map.project(lngLat);
    const dy = markerScreen.y - desiredMarkerY;
    const popupWidth = popupContent.offsetWidth;
    const dxLeft = Math.max(0, popupWidth / 2 + 24 - markerScreen.x);
    const dxRight = Math.max(0, markerScreen.x + popupWidth / 2 + 24 - container.offsetWidth);
    const dx = dxLeft - dxRight;
    if (Math.abs(dy) > 24 || Math.abs(dx) > 12) {
      if (reduce) map.jumpTo({ center: map.unproject([markerScreen.x - dx, markerScreen.y - dy]) });
      else map.easeTo({ center: map.unproject([markerScreen.x - dx, markerScreen.y - dy]), duration: 320 });
    }
    return;
  }
  /* ── Mobile: rAF-deferred measurement + anchor + max-height clamping ── */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = popup.getElement(); if (!el) return;
    const content = el.querySelector('.maplibregl-popup-content');
    if (!content) return;
    const mapRect = map.getContainer().getBoundingClientRect();
    const safe = 12;
    const pt = map.project(lngLat); // marker in container px
    const spaceAbove = pt.y - safe;
    const spaceBelow = mapRect.height - pt.y - safe - 40; // marker stem
    const desired = content.scrollHeight + 24;
    let anchor, maxH;
    if (spaceAbove >= desired) { anchor = 'bottom'; maxH = spaceAbove; }
    else if (spaceBelow >= desired) { anchor = 'top'; maxH = spaceBelow; }
    else if (spaceBelow >= spaceAbove) { anchor = 'top'; maxH = spaceBelow; }
    else { anchor = 'bottom'; maxH = spaceAbove; }
    el.style.setProperty('--popup-max-h', Math.max(180, maxH) + 'px');
    el.classList.remove('maplibregl-popup-anchor-top', 'maplibregl-popup-anchor-bottom');
    el.classList.add('maplibregl-popup-anchor-' + anchor);
    const popupH = Math.min(desired, maxH);
    const targetMarkerY = anchor === 'bottom'
      ? Math.max(popupH + safe, mapRect.height * 0.55)
      : Math.min(mapRect.height - popupH - safe - 40, mapRect.height * 0.45);
    const dy = pt.y - targetMarkerY;
    const center = map.project(map.getCenter());
    const newCenter = map.unproject([center.x, center.y + dy]);
    if (reduce) map.jumpTo({ center: newCenter });
    else map.easeTo({ center: newCenter, duration: 280, easing: t => 1 - Math.pow(1 - t, 3) });
  }));
}

async function openPassPopup(p, lngLat = [p.lon, p.lat]) {
  const popup = openMapPopup(lngLat, buildPopupHtml(p, passStatus(p), null), "480px");
  alpineOverlayLayer.setSelected(`pass:${p.id}`);
  createMarkerRing(lngLat, popup);
  popup.on('close', () => alpineOverlayLayer.setSelected(null));
  lazyLoadPassIcons(popup.getElement(), true);
  applyPopupBindings(popup); // INITIAL bindings — image, body stagger, etc. before wiki fetch
  try {
    const wiki = await fetchWiki(p.wikiTitle, p.wikiLang);
    if (activePopup === popup) {
      try {
        popup.setHTML(buildPopupHtml(p, passStatus(p), wiki));
      } finally {
        if (activePopup === popup) {
          lazyLoadPassIcons(popup.getElement(), true);
          const el2 = popup.getElement().querySelector('.maplibregl-popup-content');
          if (el2) { el2.setAttribute('tabindex', '-1'); }
          applyPopupBindings(popup); // RE-BIND after wiki content replaces HTML
        }
      }
    }
  } catch (e) {
    console.debug('[alpine] wiki fetch failed', e);
  }
}

function openPoiPopup(poi, lngLat = [poi.lon, poi.lat]) {
  const popup = openMapPopup(lngLat, buildPoiPopupHtml(poi), "480px");
  alpineOverlayLayer.setSelected(`poi:${poi.id}`);
  createMarkerRing(lngLat, popup);
  popup.on('close', () => alpineOverlayLayer.setSelected(null));
  applyPopupBindings(popup);
}

function setPoiLayerVisible(visible) {
  poiLayerVisible = !!visible;
  updateMapSources();
  layoutAlpineOverlay();
  renderPoiList();
  refreshLayerControlUI();
}

let _styleSwapOverlay = null;
function performMapStyleSwap(nextStyle) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (reduce) {
    map.setStyle(nextStyle);
    map.once('idle', restoreMapLayers);
    return;
  }
  if (_styleSwapOverlay) {
    _styleSwapOverlay.remove();
    _styleSwapOverlay = null;
  }
  let dataUrl = null;
  try {
    map.triggerRepaint();
    dataUrl = map.getCanvas().toDataURL('image/png');
  } catch (_) {
    map.setStyle(nextStyle);
    map.once('idle', restoreMapLayers);
    return;
  }
  if (!dataUrl || dataUrl.length < 200) {
    map.setStyle(nextStyle);
    map.once('idle', restoreMapLayers);
    return;
  }
  const overlay = document.createElement('img');
  overlay.src = dataUrl;
  overlay.className = 'alpine-style-swap-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  map.getContainer().appendChild(overlay);
  _styleSwapOverlay = overlay;
  map.setStyle(nextStyle);
  map.once('idle', () => {
    restoreMapLayers();
    if (_styleSwapOverlay !== overlay) return;
    requestAnimationFrame(() => { overlay.style.opacity = '0'; });
    let done = false;
    const cleanup = () => {
      if (done) return; done = true;
      overlay.removeEventListener('transitionend', cleanup);
      overlay.remove();
      if (_styleSwapOverlay === overlay) _styleSwapOverlay = null;
    };
    overlay.addEventListener('transitionend', cleanup);
    setTimeout(cleanup, 900);
  });
}

function baseMapShortName(name) {
  return String(name || "").replace(/\s*vector\s*$/i, "");
}

function setBaseMapByName(name) {
  const next = VECTOR_BASEMAPS.find(b => b.name === name);
  if (!next) return;
  const changed = currentBaseLayerName !== next.name;
  currentBaseLayerName = next.name;
  updateMapInfo(currentBaseLayerName);
  if (changed) performMapStyleSwap(next.style);
  refreshLayerControlUI();
}

function cycleBaseMap() {
  const currentIndex = Math.max(0, VECTOR_BASEMAPS.findIndex(b => b.name === currentBaseLayerName));
  const next = VECTOR_BASEMAPS[(currentIndex + 1) % VECTOR_BASEMAPS.length];
  setBaseMapByName(next.name);
}

function layerControlToggleHtml({ label, description = "", checked = false, inputAttrs = "", disabled = false }) {
  const attrs = `${checked ? " checked" : ""}${inputAttrs ? ` ${inputAttrs}` : ""}${disabled ? ' disabled aria-disabled="true"' : ""}`;
  return `<label class="pass-stack-switch${disabled ? " is-disabled" : ""}">
    <input type="checkbox"${attrs}>
    <span class="pass-stack-switch-ui" aria-hidden="true"></span>
    <span><strong>${escapeHtml(label)}</strong>${description ? `<em>${escapeHtml(description)}</em>` : ""}</span>
  </label>`;
}

class AlpineLayerControl {
  onAdd(mapInstance) {
    this._map = mapInstance || map;
    this._drawerOpen = false;
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl maplibregl-ctrl-group alpine-layer-control pass-stack-control";
    el.innerHTML = this._controlHtml();
    this._root = el;
    this._drawer = this._buildDrawer();
    this._map.getContainer().appendChild(this._drawer);
    this._bindRoot();
    this._bindDrawer();
    layerControlInstance = this;
    const poiToggle = this._drawer.querySelector("#mapPoiToggle");
    window.mapPoiToggle = poiToggle;
    this.refresh();
    return el;
  }

  onRemove() {
    this._drawer?.remove();
    this._root?.remove();
    if (layerControlInstance === this) layerControlInstance = null;
  }

  _controlHtml() {
    return `
      <button type="button" class="pass-stack-main" data-action="strip-toggle" aria-label="Layers" aria-expanded="false" aria-controls="passStackStrip" title="Layers">
        <span class="pass-stack-glyph" aria-hidden="true"><span></span><span></span><span></span></span>
      </button>
      <span class="pass-stack-tooltip" role="tooltip">Layers</span>
      <div class="pass-stack-strip" id="passStackStrip" role="group" aria-label="Layer quick controls">
        <button type="button" class="pass-stack-tile" data-action="cycle-map">
          <span class="pass-stack-tile-icon" aria-hidden="true">◇</span>
          <span>Map</span>
          <small data-current-basemap>${escapeHtml(baseMapShortName(currentBaseLayerName))}</small>
        </button>
        <button type="button" class="pass-stack-tile" data-action="toggle-passes" aria-pressed="true">
          <span class="pass-stack-tile-icon" aria-hidden="true">△</span>
          <span>Passes</span>
          <small>markers</small>
        </button>
        <button type="button" class="pass-stack-tile" data-action="toggle-sights" aria-pressed="true">
          <span class="pass-stack-tile-icon" aria-hidden="true">✦</span>
          <span>Sights</span>
          <small>POIs</small>
        </button>
        <button type="button" class="pass-stack-tile" data-action="toggle-tour" aria-pressed="false" hidden>
          <span class="pass-stack-tile-icon" aria-hidden="true">↬</span>
          <span>Tour</span>
          <small>focus</small>
        </button>
        <button type="button" class="pass-stack-tile" data-action="open-drawer" aria-expanded="false" aria-controls="passStackDrawer">
          <span class="pass-stack-tile-icon" aria-hidden="true">⋯</span>
          <span>More</span>
          <small>filters</small>
        </button>
      </div>`;
  }

  _buildDrawer() {
    const drawer = document.createElement("aside");
    drawer.id = "passStackDrawer";
    drawer.className = "pass-stack-drawer";
    drawer.setAttribute("aria-label", "Map layers and filters");
    drawer.setAttribute("aria-hidden", "true");
    drawer.innerHTML = `
      <div class="pass-stack-drawer-head">
        <div>
          <p class="pass-stack-kicker">Pass Stack</p>
          <h2>Map layers</h2>
        </div>
        <button type="button" class="pass-stack-close" data-action="close-drawer" aria-label="Close layer drawer">×</button>
      </div>
      <div class="pass-stack-drawer-body">
        ${this._basemapSectionHtml()}
        ${this._passesSectionHtml()}
        ${this._sightsSectionHtml()}
        ${this._tourSectionHtml()}
      </div>`;
    return drawer;
  }

  _basemapSectionHtml() {
    const cards = VECTOR_BASEMAPS.map((base, index) => `
      <button type="button" class="pass-stack-map-card" data-basemap="${escapeHtml(base.name)}" aria-pressed="false">
        <span class="pass-stack-map-thumb thumb-${index}" aria-hidden="true"></span>
        <span>${escapeHtml(baseMapShortName(base.name))}</span>
      </button>`).join("");
    return `<section class="pass-stack-section">
      <div class="pass-stack-section-title"><span>Basemap</span><small>OpenFreeMap vectors</small></div>
      <div class="pass-stack-map-grid">${cards}</div>
      <div class="pass-stack-toggle-grid">
        ${layerControlToggleHtml({ label: "Globe view", description: "Preview only (disabled)", inputAttrs: "data-inert-toggle", disabled: true })}
        ${layerControlToggleHtml({ label: "Labels", description: "Always on for now", checked: true, inputAttrs: "data-inert-toggle", disabled: true })}
      </div>
    </section>`;
  }

  _passesSectionHtml() {
    const statuses = [...PASS_LAYER_STATUS_KEYS, "estimated"].map(key => `
      <button type="button" class="pass-stack-pill status-${escapeHtml(key)}" data-pass-status="${escapeHtml(key)}" aria-pressed="true">
        ${escapeHtml(PASS_LAYER_STATUS_LABELS[key] || key)}
      </button>`).join("");
    return `<section class="pass-stack-section">
      <div class="pass-stack-section-title"><span>Passes</span><small>Road status + quality</small></div>
      ${layerControlToggleHtml({ label: "Show pass overlays", description: "Markers and clusters", checked: true, inputAttrs: "data-pass-overlay" })}
      <div class="pass-stack-pill-row">${statuses}</div>
      <label class="pass-stack-range">
        <span>Pass quality <output data-pass-quality-label>${escapeHtml(passLayerControlQualityLabel())}</output></span>
        <input type="range" min="0" max="5" step="1" value="0" data-pass-quality>
      </label>
      ${layerControlToggleHtml({ label: "Symbolic icons", description: "Preview only (disabled)", checked: true, inputAttrs: "data-inert-toggle", disabled: true })}
    </section>`;
  }

  _sightsSectionHtml() {
    const families = POI_FAMILY_KEYS.map(key => `
      <button type="button" class="pass-stack-pebble" data-poi-family="${escapeHtml(key)}" aria-pressed="true">
        ${escapeHtml(POI_FAMILY_LABELS[key])}
      </button>`).join("");
    const presets = POI_LAYER_PRESET_IDS.map(id => `
      <button type="button" class="pass-stack-theme" data-poi-preset="${escapeHtml(id)}" aria-pressed="false">
        ${escapeHtml(POI_LAYER_PRESET_LABELS[id])}
      </button>`).join("");
    return `<section class="pass-stack-section">
      <div class="pass-stack-section-title"><span>Sights</span><small>Families + themes</small></div>
      ${layerControlToggleHtml({ label: "Show sights / POIs", description: "Uses the map POI layer", checked: true, inputAttrs: 'id="mapPoiToggle"' })}
      <div class="pass-stack-subtitle">Families</div>
      <div class="pass-stack-pebble-row">${families}</div>
      <div class="pass-stack-subtitle">Theme</div>
      <div class="pass-stack-theme-row">${presets}</div>
      <label class="pass-stack-range">
        <span>Minimum quality <output data-poi-quality-label>${escapeHtml(poiLayerControlQualityLabel())}</output></span>
        <input type="range" min="0" max="5" step="1" value="3" data-poi-quality>
      </label>
      ${layerControlToggleHtml({ label: "Plannable only", description: "Reachable by car", inputAttrs: "data-poi-plannable" })}
    </section>`;
  }

  _tourSectionHtml() {
    return `<section class="pass-stack-section pass-stack-tour-section" data-tour-section hidden>
      <div class="pass-stack-section-title"><span>Tour</span><small>Route context</small></div>
      <div class="pass-stack-locked-list">
        <div><span>Route line</span><strong>Locked</strong></div>
        <div><span>Selected stops</span><strong>Locked</strong></div>
      </div>
      ${layerControlToggleHtml({ label: "Solo focus", description: "Dim non-route map items", inputAttrs: "data-solo-focus" })}
    </section>`;
  }

  _bindRoot() {
    this._root.addEventListener("click", e => {
      e.stopPropagation();
      const btn = e.target.closest("[data-action]");
      if (!btn || !this._root.contains(btn)) return;
      this._handleAction(btn.dataset.action);
    });
    this._root.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      this._setDrawerOpen(false);
      this._root.classList.remove("is-strip-open");
      this.refresh();
    });
  }

  _bindDrawer() {
    ["click", "dblclick", "mousedown", "touchstart", "wheel"].forEach(type => {
      this._drawer.addEventListener(type, e => e.stopPropagation(), { passive: true });
    });
    this._drawer.addEventListener("click", e => {
      const actionBtn = e.target.closest("[data-action]");
      if (actionBtn?.dataset.action === "close-drawer") {
        this._setDrawerOpen(false);
        return;
      }
      const basemapBtn = e.target.closest("[data-basemap]");
      if (basemapBtn) {
        setBaseMapByName(basemapBtn.dataset.basemap);
        return;
      }
      const statusBtn = e.target.closest("[data-pass-status]");
      if (statusBtn) {
        const key = statusBtn.dataset.passStatus;
        if (layerControlState.passStatuses.has(key)) layerControlState.passStatuses.delete(key);
        else layerControlState.passStatuses.add(key);
        notifyLayerFiltersChanged({ passes: true });
        return;
      }
      const familyBtn = e.target.closest("[data-poi-family]");
      if (familyBtn) {
        const key = familyBtn.dataset.poiFamily;
        if (layerControlState.poiFamilies.has(key)) layerControlState.poiFamilies.delete(key);
        else layerControlState.poiFamilies.add(key);
        notifyLayerFiltersChanged({ pois: true });
        return;
      }
      const presetBtn = e.target.closest("[data-poi-preset]");
      if (presetBtn) {
        const id = presetBtn.dataset.poiPreset;
        layerControlState.poiThemePreset = layerControlState.poiThemePreset === id ? "" : id;
        notifyLayerFiltersChanged({ pois: true });
      }
    });
    this._drawer.addEventListener("input", e => {
      if (e.target.matches("[data-pass-quality]")) {
        layerControlState.passQualityMin = (Number(e.target.value) || 0) / 5;
        notifyLayerFiltersChanged({ passes: true });
      } else if (e.target.matches("[data-poi-quality]")) {
        layerControlState.poiQualityMin = (Number(e.target.value) || 0) / 5;
        notifyLayerFiltersChanged({ pois: true });
      }
    });
    this._drawer.addEventListener("change", e => {
      if (e.target.matches("[data-pass-overlay]")) {
        setPassOverlayVisible(e.target.checked);
      } else if (e.target.matches("#mapPoiToggle")) {
        setPoiLayerVisible(e.target.checked);
      } else if (e.target.matches("[data-poi-plannable]")) {
        layerControlState.poiPlannableOnly = !!e.target.checked;
        notifyLayerFiltersChanged({ pois: true });
      } else if (e.target.matches("[data-solo-focus]")) {
        setLayerSoloFocus(e.target.checked);
      }
    });
    this._drawer.addEventListener("keydown", e => {
      if (e.key === "Escape") this._setDrawerOpen(false);
    });
  }

  _handleAction(action) {
    if (action === "strip-toggle") {
      this._root.classList.toggle("is-strip-open");
      this.refresh();
    } else if (action === "cycle-map") {
      cycleBaseMap();
    } else if (action === "toggle-passes") {
      setPassOverlayVisible(!layerControlState.passOverlayVisible);
    } else if (action === "toggle-sights") {
      setPoiLayerVisible(!poiLayerVisible);
    } else if (action === "toggle-tour") {
      setLayerSoloFocus(!layerControlState.soloFocus);
    } else if (action === "open-drawer") {
      this._setDrawerOpen(true);
    }
  }

  _setDrawerOpen(open) {
    this._drawerOpen = !!open;
    this.refresh();
  }

  _setTileState(action, active) {
    const tile = this._root?.querySelector(`[data-action="${action}"]`);
    if (!tile) return;
    tile.classList.toggle("is-active", !!active);
    tile.setAttribute("aria-pressed", String(!!active));
  }

  refresh() {
    if (!this._root || !this._drawer) return;
    const stripOpen = this._root.classList.contains("is-strip-open");
    this._root.querySelector(".pass-stack-main")?.setAttribute("aria-expanded", String(stripOpen));
    this._root.querySelector("[data-current-basemap]").textContent = baseMapShortName(currentBaseLayerName);
    const mapTile = this._root.querySelector('[data-action="cycle-map"]');
    mapTile?.classList.remove("is-active");
    mapTile?.removeAttribute("aria-pressed");
    this._setTileState("toggle-passes", layerControlState.passOverlayVisible);
    this._setTileState("toggle-sights", poiLayerVisible);
    this._setTileState("toggle-tour", plannedRouteActive && layerControlState.soloFocus);
    this._setTileState("open-drawer", this._drawerOpen);

    const tourTile = this._root.querySelector('[data-action="toggle-tour"]');
    if (tourTile) tourTile.hidden = !plannedRouteActive;
    const moreTile = this._root.querySelector('[data-action="open-drawer"]');
    moreTile?.setAttribute("aria-expanded", String(this._drawerOpen));

    this._root.classList.toggle("is-drawer-open", this._drawerOpen);
    this._drawer.classList.toggle("is-open", this._drawerOpen);
    this._drawer.setAttribute("aria-hidden", String(!this._drawerOpen));

    this._drawer.querySelectorAll("[data-basemap]").forEach(btn => {
      const active = btn.dataset.basemap === currentBaseLayerName;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    const passOverlay = this._drawer.querySelector("[data-pass-overlay]");
    if (passOverlay) passOverlay.checked = layerControlState.passOverlayVisible;
    this._drawer.querySelectorAll("[data-pass-status]").forEach(btn => {
      const active = layerControlState.passStatuses.has(btn.dataset.passStatus);
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    const passQuality = this._drawer.querySelector("[data-pass-quality]");
    if (passQuality) passQuality.value = String(Math.round(layerControlState.passQualityMin * 5));
    const passQualityLabel = this._drawer.querySelector("[data-pass-quality-label]");
    if (passQualityLabel) passQualityLabel.textContent = passLayerControlQualityLabel();

    const poiToggle = this._drawer.querySelector("#mapPoiToggle");
    if (poiToggle) poiToggle.checked = poiLayerVisible;
    this._drawer.querySelectorAll("[data-poi-family]").forEach(btn => {
      const active = layerControlState.poiFamilies.has(btn.dataset.poiFamily);
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    this._drawer.querySelectorAll("[data-poi-preset]").forEach(btn => {
      const active = layerControlState.poiThemePreset === btn.dataset.poiPreset;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    const poiQuality = this._drawer.querySelector("[data-poi-quality]");
    if (poiQuality) poiQuality.value = String(Math.round(layerControlState.poiQualityMin * 5));
    const poiQualityLabel = this._drawer.querySelector("[data-poi-quality-label]");
    if (poiQualityLabel) poiQualityLabel.textContent = poiLayerControlQualityLabel();
    const poiPlannable = this._drawer.querySelector("[data-poi-plannable]");
    if (poiPlannable) poiPlannable.checked = layerControlState.poiPlannableOnly;

    this._drawer.querySelectorAll("[data-tour-section]").forEach(section => {
      section.hidden = !plannedRouteActive;
    });
    const soloFocus = this._drawer.querySelector("[data-solo-focus]");
    if (soloFocus) {
      soloFocus.checked = plannedRouteActive && layerControlState.soloFocus;
      soloFocus.disabled = !plannedRouteActive;
    }
  }
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
    ? `<div class="popup-img-wrap is-loading"><img class="popup-img" src="${photoSrc}" alt="${p.name}" loading="lazy"></div>`
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
    ? buildDisclosure('Seasonal closure info', status.info.split("\n\n").map(par => `<p>${escapeHtml(par)}</p>`).join(""))
    : "";
  const tldrBlock = p.tldr
    ? `<div class="popup-tldr">${escapeHtml(p.tldr)}</div>`
    : "";
  const projectionBlock = status?.projection
    ? `<div class="popup-meta projection${status.projection.guessed ? " guess" : ""}">${escapeHtml(status.projection.label)}</div>`
    : "";
  const openingLabelText = status?.openingHint ? openingHintLabel(status.openingHint) : "";
  const openingBlock = openingLabelText
    ? `<div class="popup-meta opening">${escapeHtml(openingLabelText)}</div>`
    : "";
  const historyBlock = status?.history
    ? `<div class="popup-meta history">History: typical open season ${escapeHtml(historySeasonLabel(status.history))} · ${status.history.recordCount} records (${status.history.firstYear}–${status.history.lastYear})</div>`
    : "";
  const whyLine = whyRatingLine(p);
  const whyBlock = whyLine ? `<div class="popup-why">${whyLine}</div>` : "";
  const camsBlock = p.cams && p.cams.length
    ? `<div class="popup-cams" aria-label="Live webcams">
         <div class="popup-cams-label">📹 Live cams</div>
         ${buildDisclosure(`Live cams (${p.cams.length})`,
           `<ul class="popup-cams-list">${p.cams.map(c =>
             `<li><a href="${escapeHtml(c.u)}" target="_blank" rel="noopener"><span class="cam-label">${escapeHtml(c.l)}</span><span class="cam-source">${escapeHtml(c.s)}</span></a></li>`
           ).join("")}</ul>`)}
       </div>`
    : "";
  const planBtnBlock = (p.baseA && p.baseB)
    ? `<div class="popup-actions">${buildPopupRouteButtonHtml("pass", p)}</div>`
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

function isPopupRouteItemSelected(kind, id) {
  return kind === "poi" ? selectedPoiIds.has(id) : selectedPassIds.has(id);
}

function popupRouteButtonState(kind, item) {
  const selected = isPopupRouteItemSelected(kind, item.id);
  return {
    selected,
    label: selected ? "− Remove from selected route" : "＋ Add to selected route",
    ariaLabel: selected
      ? `Remove ${item.name} from selected route`
      : `Add ${item.name} to selected route`,
  };
}

function buildPopupRouteButtonHtml(kind, item) {
  const dataAttr = kind === "poi" ? "data-poi-add" : "data-pass-add";
  const state = popupRouteButtonState(kind, item);
  return `<button class="popup-add-btn" type="button" ${dataAttr}="${escapeHtml(item.id)}" aria-label="${escapeHtml(state.ariaLabel)}" aria-pressed="${state.selected}">${state.label}</button>`;
}

function updatePopupRouteButton(btn, kind, item) {
  const state = popupRouteButtonState(kind, item);
  btn.textContent = state.label;
  btn.setAttribute("aria-label", state.ariaLabel);
  btn.setAttribute("aria-pressed", String(state.selected));
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

function buildDisclosure(label, bodyHTML) {
  return `<button class="disclosure" type="button" aria-expanded="false">${label}</button>` +
         `<div class="disclosure-panel"><div class="disclosure-inner">${bodyHTML}</div></div>`;
}

/* "Why this rating" line — uses the LLM reasoning sentence as the primary
   explanation, with a small sub-score breakdown.
   Sub-scores: sB scenicBeauty, sI summitInterest, dE drivingExperience, pp popularity (all 0-10). */
function whyRatingLine(p) {
  const reasoning = p.reasoning ? escapeHtml(p.reasoning) : "";
  const sg = p.qualitySignals;
  const SCORE_LABELS = {
    known: 'Fame', summit: 'Summit experience',
    scenery: 'Scenery', scenic: 'Scenery', driving: 'Driving'
  };
  let breakdown = "";
  if (sg && typeof sg.sB === "number") {
    breakdown =
        `<span class="why-chips" title="Agent sub-scores 0-10">`
      + `<span class="score-chip">${SCORE_LABELS.scenic} <b>${sg.sB.toFixed(1)}</b></span>`
      + `<span class="score-chip">${SCORE_LABELS.driving} <b>${sg.dE.toFixed(1)}</b></span>`
      + `<span class="score-chip">${SCORE_LABELS.summit} <b>${sg.sI.toFixed(1)}</b></span>`
      + `<span class="score-chip">${SCORE_LABELS.known} <b>${sg.pp.toFixed(1)}</b></span>`
      + `</span>`;
  }
  if (!reasoning && !breakdown) return "";
  const cf = p.confidence;
  const cfTag = cf === "l" ? ' <span class="cf-tag" title="Low confidence — sparse data">·low confidence</span>' : "";
  const summaryRow = `<div class="why-summary">${breakdown}${cfTag}</div>`;
  const reasoningHtml = reasoning ? `<div class="why-reasoning">${reasoning}</div>` : "";
  return summaryRow + (reasoningHtml ? buildDisclosure('Why this score?', reasoningHtml) : "");
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
    ? `<div class="popup-img-wrap is-loading"><img class="popup-img" src="${escapeHtml(poi.bestPhoto)}" alt="${escapeHtml(poi.name)}" loading="lazy"></div>`
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
    ? buildPopupRouteButtonHtml("poi", poi)
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

/* Popup-delegated handler: route selection buttons on POI and pass popups. */
document.addEventListener("click", e => {
  const poiBtn = e.target.closest("[data-poi-add]");
  if (poiBtn) {
    const id = poiBtn.dataset.poiAdd;
    const poi = POI_BY_ID.get(id);
    if (poi && typeof toggleSelectedPoi === "function" && PLANNABLE_POI_IDS.has(id)) {
      const shouldSelect = !selectedPoiIds.has(id);
      if (shouldSelect && typeof advancedModeEl !== "undefined" && !advancedModeEl.checked) {
        advancedModeEl.checked = true;
        if (typeof syncAdvancedMode === "function") syncAdvancedMode();
      }
      toggleSelectedPoi(id, shouldSelect);
      updatePopupRouteButton(poiBtn, "poi", poi);
    }
    return;
  }
  const passBtn = e.target.closest("[data-pass-add]");
  if (passBtn) {
    const id = passBtn.dataset.passAdd;
    const pass = PASS_BY_ID.get(id);
    if (pass && pass.baseA && pass.baseB && typeof toggleSelectedPass === "function") {
      const shouldSelect = !selectedPassIds.has(id);
      if (shouldSelect && typeof advancedModeEl !== "undefined" && !advancedModeEl.checked) {
        advancedModeEl.checked = true;
        if (typeof syncAdvancedMode === "function") syncAdvancedMode();
      }
      toggleSelectedPass(id, shouldSelect);
      updatePopupRouteButton(passBtn, "pass", pass);
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

/* Stops & breaks — pass photo stops, lunch break, driving rest break.
   Persisted in localStorage so users don't keep re-tweaking. Defaults
   are sensible for a typical alpine day so users don't have to touch
   the panel at all. */
const STOPS_LS_KEY = "alpine.planner.stops.v1";
const STOPS_DEFAULTS = Object.freeze({
  passStopMin: 5,         /* minutes per pass for photo/view stop */
  viewpointMode: "recommended", /* "recommended"|"summit"|"all" */
  lunchBreak: "auto",     /* "auto"|"0"|"30"|"45"|"60"|"90" minutes */
  restBreakOn: true,      /* enable driving rest break */
  restInterval: 2.5,      /* hours between driving rest breaks */
  restDuration: 15,       /* minutes per driving rest break */
});
const passStopMinEl   = document.getElementById("passStopMin");
const passStopLabelEl = document.getElementById("passStopLabel");
const viewpointModeEl = document.getElementById("viewpointMode");
const lunchBreakEl    = document.getElementById("lunchBreak");
const restBreakOnEl   = document.getElementById("restBreakOn");
const restBreakDetailEl = document.getElementById("restBreakDetail");
const restIntervalEl  = document.getElementById("restInterval");
const restIntervalLabelEl = document.getElementById("restIntervalLabel");
const restDurationEl  = document.getElementById("restDuration");
const restDurationLabelEl = document.getElementById("restDurationLabel");
const plannerStopsEl  = document.getElementById("plannerStops");
const plannerStopsSubtitleEl = document.getElementById("plannerStopsSubtitle");

function loadStopsConfig() {
  try {
    const raw = localStorage.getItem(STOPS_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

function saveStopsConfig(cfg) {
  try { localStorage.setItem(STOPS_LS_KEY, JSON.stringify(cfg)); } catch { /* private mode */ }
}

function applyStopsConfig(cfg) {
  if (passStopMinEl) passStopMinEl.value = String(cfg.passStopMin ?? STOPS_DEFAULTS.passStopMin);
  if (viewpointModeEl) viewpointModeEl.value = String(cfg.viewpointMode ?? STOPS_DEFAULTS.viewpointMode);
  if (lunchBreakEl)  lunchBreakEl.value  = String(cfg.lunchBreak  ?? STOPS_DEFAULTS.lunchBreak);
  if (restBreakOnEl) restBreakOnEl.checked = cfg.restBreakOn ?? STOPS_DEFAULTS.restBreakOn;
  if (restIntervalEl) restIntervalEl.value = String(cfg.restInterval ?? STOPS_DEFAULTS.restInterval);
  if (restDurationEl) restDurationEl.value = String(cfg.restDuration ?? STOPS_DEFAULTS.restDuration);
}

function currentStopsConfig() {
  return {
    passStopMin: passStopMinEl ? +passStopMinEl.value : STOPS_DEFAULTS.passStopMin,
    viewpointMode: viewpointModeEl ? viewpointModeEl.value : STOPS_DEFAULTS.viewpointMode,
    lunchBreak:  lunchBreakEl ? lunchBreakEl.value : STOPS_DEFAULTS.lunchBreak,
    restBreakOn: restBreakOnEl ? !!restBreakOnEl.checked : STOPS_DEFAULTS.restBreakOn,
    restInterval: restIntervalEl ? +restIntervalEl.value : STOPS_DEFAULTS.restInterval,
    restDuration: restDurationEl ? +restDurationEl.value : STOPS_DEFAULTS.restDuration,
  };
}

/* Compute total break/stop time for a tour. Returns hours and a list of
   the parts so the UI can show a friendly breakdown. The "auto" lunch
   policy adds 45 min on tours that drive ≥ 4 h — the most common case
   where a midday meal is realistic.

   `policyTotalH` lets the caller pin the auto-lunch decision to the user's
   intended day length rather than the (possibly-shrunken) drive time, so
   pre-plan reservation and post-plan accounting agree on whether to add
   lunch. Falls back to `driveH` when not provided (advanced/distance modes). */
function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function intelligentPassStopMin(pass, baseMin) {
  const base = Math.max(0, Number(baseMin) || 0);
  if (base <= 0) return 0;
  const qFallback = Math.max(
    Number(pass?.qScenic) || 0,
    Number(pass?.qApproach) || 0,
    Number(pass?.qSummit) || 0
  );
  const quality = clampNumber(Number(pass?.quality ?? qFallback) || 0, 0, 1);
  const scenic = clampNumber(Math.max(Number(pass?.qScenic) || 0, Number(pass?.qApproach) || 0), 0, 1);
  const elev = Number(pass?.elev) || 0;
  const cams = Array.isArray(pass?.cams) ? pass.cams.length : 0;

  let min = base * (0.6 + 0.9 * quality);
  if (elev >= 3000) min += 5;
  else if (elev >= 2500) min += 4;
  else if (elev >= 2000) min += 3;
  else if (elev >= 1500) min += 2;
  else if (elev >= 1000) min += 1;
  min += scenic * 2;
  if (cams) min += Math.min(3, cams) * 1.25;
  if (pass?.bestPhoto) min += 1.5;
  if (pass?.wikiTitle) min += 0.75;

  return Math.round(clampNumber(min, 2, 25));
}

function computeExtras({ passN, driveH, config, policyTotalH, passList }) {
  const cfg = config || currentStopsConfig();
  const passStops = Array.isArray(passList) ? passList.filter(p => !p?.isPoi) : null;
  const effectivePassN = passStops ? passStops.length : passN;
  const passStopMins = passStops
    ? passStops.map(p => intelligentPassStopMin(p, cfg.passStopMin || 0))
    : null;
  const passStopTotalMin = passStopMins
    ? passStopMins.reduce((sum, min) => sum + min, 0)
    : effectivePassN * (cfg.passStopMin || 0);
  const passStopH = passStopTotalMin / 60;

  let lunchH = 0;
  let lunchAuto = false;
  if (cfg.lunchBreak === "auto") {
    const anchor = policyTotalH != null ? policyTotalH : driveH;
    if (anchor >= 4) { lunchH = 0.75; lunchAuto = true; }
  } else {
    lunchH = (Number(cfg.lunchBreak) || 0) / 60;
  }

  let restH = 0;
  let restCount = 0;
  if (cfg.restBreakOn && cfg.restInterval > 0 && driveH > cfg.restInterval) {
    /* A break "at the end of the drive" is wasted — you stop driving anyway.
       So count breaks BETWEEN drive segments only. ceil(N)-1 gives the count
       of interior boundaries; floor(N - epsilon) is equivalent and simpler. */
    restCount = Math.max(0, Math.ceil(driveH / cfg.restInterval) - 1);
    restH = (restCount * (cfg.restDuration || 0)) / 60;
  }

  const extrasH = passStopH + lunchH + restH;
  return {
    extrasH,
    parts: {
      passStopH, lunchH, restH, lunchAuto, restCount, passN: effectivePassN,
      passStopMins, passStopUniform: !passStopMins || new Set(passStopMins).size <= 1,
    },
    config: cfg,
  };
}

function fmtExtrasSummary(parts) {
  if (!parts) return "";
  const bits = [];
  if (parts.passStopH > 0 && parts.passN > 0) {
    const min = Math.round(parts.passStopH * 60);
    bits.push(parts.passStopUniform === false
      ? `${parts.passN} scenic pass ${parts.passN === 1 ? "stop" : "stops"} (total ${min} min)`
      : `${parts.passN} scenic pass ${parts.passN === 1 ? "stop" : "stops"} (${min} min)`);
  }
  if (parts.lunchH > 0) {
    const min = Math.round(parts.lunchH * 60);
    bits.push(`${min} min lunch${parts.lunchAuto ? " (auto)" : ""}`);
  }
  if (parts.restH > 0 && parts.restCount > 0) {
    const min = Math.round(parts.restH * 60);
    bits.push(`${parts.restCount} rest break${parts.restCount === 1 ? "" : "s"} (${min} min)`);
  }
  return bits.join(" · ");
}

/* Estimated extras for a not-yet-planned tour. Used to reserve time in
   the optimizer's drive+dwell budget when the user is in time mode so
   the final total drive+dwell+extras fits the day-length they chose.
   Heuristic pass-count: ~1 pass per 1.5 h of drive budget, capped at 7. */
function estimateTourPassN(targetValue, targetMode) {
  if (targetMode === "time") return Math.max(2, Math.min(7, Math.round(targetValue / 1.5)));
  return Math.max(2, Math.min(7, Math.round(targetValue / 70)));
}

function plannerStopsSubtitleText(cfg = currentStopsConfig()) {
  const bits = [];
  bits.push(cfg.passStopMin > 0
    ? `${cfg.passStopMin} min scenic stop per pass`
    : "no scenic pass stops");
  if (cfg.passStopMin > 0) {
    bits.push(cfg.viewpointMode === "summit" ? "summits only"
      : cfg.viewpointMode === "all" ? "any viewpoint"
      : "best viewpoint");
  }
  bits.push(cfg.lunchBreak === "auto" ? "lunch break auto"
    : cfg.lunchBreak === "0" || +cfg.lunchBreak === 0 ? "no lunch break"
    : `lunch break ${cfg.lunchBreak} min`);
  const interval = (+cfg.restInterval).toFixed(cfg.restInterval % 1 === 0 ? 0 : 1);
  bits.push(cfg.restBreakOn
    ? `${cfg.restDuration} min rest every ${interval} h`
    : "no driving rest");
  return bits.join(" · ");
}

function refreshStopsUi() {
  if (passStopLabelEl && passStopMinEl) passStopLabelEl.textContent = `${passStopMinEl.value} min`;
  if (restIntervalLabelEl && restIntervalEl) restIntervalLabelEl.textContent = `${(+restIntervalEl.value).toFixed(restIntervalEl.value % 1 === 0 ? 0 : 1)} h`;
  if (restDurationLabelEl && restDurationEl) restDurationLabelEl.textContent = `${restDurationEl.value} min`;
  if (restBreakDetailEl && restBreakOnEl) {
    restBreakDetailEl.style.opacity = restBreakOnEl.checked ? "1" : ".42";
    restIntervalEl.disabled = !restBreakOnEl.checked;
    restDurationEl.disabled = !restBreakOnEl.checked;
  }
  if (plannerStopsSubtitleEl) plannerStopsSubtitleEl.textContent = plannerStopsSubtitleText();
}

if (passStopMinEl) {
  applyStopsConfig({ ...STOPS_DEFAULTS, ...(loadStopsConfig() || {}) });
  refreshStopsUi();
  const onStopsChange = () => {
    refreshStopsUi();
    saveStopsConfig(currentStopsConfig());
  };
  [passStopMinEl, viewpointModeEl, lunchBreakEl, restBreakOnEl, restIntervalEl, restDurationEl]
    .filter(Boolean)
    .forEach(el => el.addEventListener("input", onStopsChange));
}
/* Curated theme set surfaced as chips — full list is 19 but most users
   only need these. The candidate filter still accepts any theme via the
   advanced-mode multi-region picker. */
const CURATED_PREF_THEMES = [
  "unesco", "family-friendly", "photogenic", "iconic",
  "panoramic-view", "historic", "food-drink",
  "hidden-gem", "swimmable", "winter-sport",
];
const THEME_LABELS = {
  "unesco": "UNESCO",
  "family-friendly": "Family-friendly",
  "photogenic": "Photogenic",
  "iconic": "Iconic",
  "panoramic-view": "Panoramic view",
  "historic": "Historic",
  "food-drink": "Food & drink",
  "hidden-gem": "Hidden gem",
  "swimmable": "Swimmable",
  "winter-sport": "Winter sport",
};
function themeLabel(key) {
  return THEME_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " "));
}
const POI_PRESETS = {
  family:   { cats: ["viewpoint-panorama","alpine-lake","scenic-railway","funicular","special-experience","museum-cultural"], themes: ["family-friendly"], minScore: 7, maxCount: 4, label: "Family day · ★7+ · max 4" },
  cultural: { cats: ["castle-fortress","monastery-church","old-town","museum-cultural"], themes: ["unesco","historic"], minScore: 7, maxCount: 4, label: "Cultural tour · ★7+ · max 4" },
  photo:    { cats: ["viewpoint-panorama","alpine-lake","mountain-summit","glacier","waterfall-gorge"], themes: ["photogenic","iconic"], minScore: 8, maxCount: 3, label: "Photo tour · ★8+ · max 3" },
  hidden:   { cats: [], themes: ["hidden-gem"], minScore: 6, maxCount: 3, label: "Hidden gems · ★6+ · max 3" },
  wine:     { cats: ["wine-region","village","old-town"], themes: ["food-drink"], minScore: 6, maxCount: 4, label: "Wine & food · ★6+ · max 4" },
  reset:    { cats: [], themes: [], minScore: 6, maxCount: 3, label: "Default · any category · any theme · ★6+ · max 3" },
};
/* Active presets — multi-select with union semantics. Clicking a preset
   toggles it in/out of the set; the active state is the UNION of all
   active presets' cats/themes, with the LOWEST minScore (most permissive)
   and LARGEST maxCount across them. The "reset" button clears the set
   and every other filter chip. */
const activePresetIds = new Set();
const planRunBtn = document.getElementById("planRun");
const planResult = document.getElementById("planResult");
const planPickBtn= document.getElementById("planPick");
const planLocateBtn = document.getElementById("planLocate");
const planStartSearchEl = document.getElementById("planStartSearch");
const planStartSearchBtn = document.getElementById("planStartSearchBtn");
const planStartSearchResultsEl = document.getElementById("planStartSearchResults");
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
const GEOLOCATION_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 60000,
});
const START_GEOCODE_ENDPOINT = "https://photon.komoot.io/api/";
const START_GEOCODE_LIMIT = 5;
const selectedPassIds = new Set();
const selectedPoiIds  = new Set();
let planLocateDefaults = null;
let planStartSearchDefaultText = null;
let startSearchAbort = null;
let startSearchSeq = 0;
let startSearchResults = [];

function currentStart() {
  if (startSel.value === "custom" && customStart) return customStart;
  return PRESET_STARTS[startSel.value];
}

function showPlanWarning(message) {
  planResult.classList.remove("empty");
  planResult.removeAttribute("aria-busy");
  planResult.innerHTML = `<div class="warn">${escapeHtml(message)}</div>`;
}

function validStartCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function applyCustomStart(name, lat, lon) {
  const nextLat = Number(lat);
  const nextLon = Number(lon);
  if (!validStartCoords(nextLat, nextLon)) return false;

  customStart = { name, lat: nextLat, lon: nextLon };
  const opt = startSel.querySelector('option[value="custom"]');
  if (opt) {
    opt.disabled = false;
    opt.textContent = "📍 " + customStart.name;
  }
  startSel.value = "custom";
  startSel.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function setStartSearchBusy(busy) {
  if (!planStartSearchBtn) return;
  if (planStartSearchDefaultText == null) {
    planStartSearchDefaultText = planStartSearchBtn.textContent || "Search";
  }
  planStartSearchBtn.disabled = busy;
  planStartSearchBtn.setAttribute("aria-busy", String(busy));
  planStartSearchBtn.textContent = busy ? "Searching…" : planStartSearchDefaultText;
  if (!busy) planStartSearchBtn.removeAttribute("aria-busy");
}

function normalizeStartSearchQuery() {
  return (planStartSearchEl?.value || "").trim().replace(/\s+/g, " ");
}

function directStartCoordsFromQuery(query) {
  const m = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return validStartCoords(lat, lon) ? { lat, lon } : null;
}

function geocodeLanguageCode() {
  return typeof navigator !== "undefined" && navigator.language
    ? navigator.language.split("-")[0]
    : "en";
}

function geocodePrimaryName(raw) {
  const props = raw?.properties || raw || {};
  const address = raw?.address || {};
  return String(
    props.name ||
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.hamlet ||
    address.county ||
    address.state ||
    raw?.display_name?.split(",")[0] ||
    "Search result"
  ).trim();
}

function normalizeStartGeocodeResult(raw) {
  const coords = Array.isArray(raw?.geometry?.coordinates) ? raw.geometry.coordinates : null;
  const lat = coords ? Number(coords[1]) : Number(raw?.lat);
  const lon = coords ? Number(coords[0]) : Number(raw?.lon);
  if (!validStartCoords(lat, lon)) return null;
  const name = geocodePrimaryName(raw);
  const props = raw?.properties || {};
  const countryCode = (raw?.properties?.countrycode || "").toUpperCase().slice(0, 2);
  const photonDetail = [
    props.street,
    props.postcode,
    props.city || props.county,
    props.state,
    props.country,
  ].filter(Boolean).join(", ");
  const display = String(raw?.display_name || photonDetail || "").trim();
  const detail = display && display !== name
    ? display
    : `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  return { name, detail, lat, lon, countryCode };
}

function renderStartSearchResults(results, message = "") {
  if (!planStartSearchResultsEl) return;
  startSearchResults = Array.isArray(results) ? results : [];
  if (message) {
    planStartSearchResultsEl.hidden = false;
    planStartSearchResultsEl.innerHTML = `<div class="start-search-empty">${escapeHtml(message)}</div>`;
    return;
  }
  if (!startSearchResults.length) {
    planStartSearchResultsEl.hidden = true;
    planStartSearchResultsEl.innerHTML = "";
    return;
  }
  planStartSearchResultsEl.hidden = false;
  planStartSearchResultsEl.innerHTML = startSearchResults.map((r, i) => `
    <button class="start-search-result" type="button" data-start-result="${i}" style="--i:${i}">
      <strong>${escapeHtml(r.name)}</strong>
      ${r.countryCode ? `<span class="cc-badge">${escapeHtml(r.countryCode)}</span>` : ""}
      <span>${escapeHtml(r.detail)}</span>
    </button>
  `).join("");
}

function selectStartSearchResult(index) {
  const result = startSearchResults[index];
  if (!result) return;
  /* Use the place name verbatim as the dropdown label — no raw lat/lon
     suffix. The coordinates would just clutter the chip with technical
     noise; users who want them can read them in the popup or the URL
     hash. Falls back to a "Custom (lat, lon)" string only if the search
     result has no name (rare). */
  const label = result.name || `Custom (${result.lat.toFixed(3)}, ${result.lon.toFixed(3)})`;
  if (!applyCustomStart(label, result.lat, result.lon)) {
    showPlanWarning("Search result returned invalid coordinates. Try another place or pick on the map.");
    return;
  }
  /* Clear the search field so it's ready for the next query — the
     selected place is now visible in the dropdown above. */
  if (planStartSearchEl) planStartSearchEl.value = "";
  renderStartSearchResults([]);
}

async function searchStartPlaces() {
  const query = normalizeStartSearchQuery();
  if (query.length < 2) {
    renderStartSearchResults([], "Type at least 2 characters to search for a starting point.");
    return;
  }

  const direct = directStartCoordsFromQuery(query);
  if (direct) {
    applyCustomStart(`Custom (${direct.lat.toFixed(3)}, ${direct.lon.toFixed(3)})`, direct.lat, direct.lon);
    renderStartSearchResults([]);
    return;
  }

  if (typeof fetch !== "function") {
    showPlanWarning("Place search is not supported by this browser. Choose a preset or pick a start on the map.");
    return;
  }
  if (pickingStart) {
    pickingStart = false;
    syncPickButtonState();
  }

  if (startSearchAbort) startSearchAbort.abort();
  const seq = ++startSearchSeq;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  startSearchAbort = controller;
  setStartSearchBusy(true);
  renderStartSearchResults([], "Searching places…");

  const params = new URLSearchParams({
    q: query,
    limit: String(START_GEOCODE_LIMIT),
    lang: geocodeLanguageCode(),
  });
  params.set("bbox", "5,43,17.5,49");

  try {
    const response = await fetch(`${START_GEOCODE_ENDPOINT}?${params.toString()}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller?.signal,
    });
    if (!response.ok) throw new Error(`geocode ${response.status}`);
    const payload = await response.json();
    if (seq !== startSearchSeq) return;
    const rows = Array.isArray(payload?.features) ? payload.features : payload;
    const results = Array.isArray(rows)
      ? rows.map(normalizeStartGeocodeResult).filter(Boolean).slice(0, START_GEOCODE_LIMIT)
      : [];
    if (!results.length) {
      renderStartSearchResults([], `No starting points found for “${query}”. Try a town, address, or coordinates.`);
      return;
    }
    renderStartSearchResults(results);
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (seq === startSearchSeq) {
      showPlanWarning("Place search is unavailable right now. Choose a preset, use current location, or pick on the map.");
      renderStartSearchResults([], "Search failed. Try again or pick on the map.");
    }
  } finally {
    if (seq === startSearchSeq) setStartSearchBusy(false);
    if (startSearchAbort === controller) startSearchAbort = null;
  }
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
  if (activePresetIds.size > 0) {
    const labels = [...activePresetIds]
      .filter(id => POI_PRESETS[id])
      .map(id => POI_PRESETS[id].label.split(" · ")[0]);
    if (labels.length === 1) return POI_PRESETS[[...activePresetIds][0]].label;
    return `Stacked: ${labels.join(" + ")} · ★ ${poiMinScoreVal()}+ · max ${poiMaxCountVal()}`;
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
function syncPresetButtons() {
  poiPresetsEl?.querySelectorAll("[data-preset]").forEach(b => {
    b.classList.toggle("active", activePresetIds.has(b.dataset.preset));
  });
}
function clearActivePreset() {
  activePresetIds.clear();
  syncPresetButtons();
  refreshPoiPrefsSubtitle();
}
/* Recompute filter state from the UNION of all currently-active presets:
   union of cats and themes; min(minScore) so each new preset opens up
   the score floor; max(maxCount) so each new preset only relaxes the
   cap. When no presets are active, leaves the manual chip state alone. */
function recomputeFromActivePresets() {
  if (activePresetIds.size === 0) return;
  allowedPoiCategories.clear();
  allowedPoiThemes.clear();
  let minScore = Infinity;
  let maxCount = -Infinity;
  for (const id of activePresetIds) {
    const p = POI_PRESETS[id];
    if (!p) continue;
    for (const c of p.cats)   allowedPoiCategories.add(c);
    for (const t of p.themes) allowedPoiThemes.add(t);
    if (p.minScore < minScore) minScore = p.minScore;
    if (p.maxCount > maxCount) maxCount = p.maxCount;
  }
  if (Number.isFinite(minScore)) {
    poiMinScoreEl.value = String(minScore);
    poiMinScoreLabelEl.textContent = fmtMinScoreLabel(minScore);
  }
  if (Number.isFinite(maxCount)) {
    poiMaxCountEl.value = String(maxCount);
    poiMaxCountLabelEl.textContent = String(maxCount);
  }
  renderPoiPrefsChips();
}
function applyPoiPreset(id) {
  const p = POI_PRESETS[id];
  if (!p) return;
  /* "reset" preset wipes the entire prefs state — single-button escape
     hatch out of any combination of stacked presets and manual chips. */
  if (id === "reset") {
    activePresetIds.clear();
    allowedPoiCategories.clear();
    allowedPoiThemes.clear();
    poiMinScoreEl.value = String(p.minScore);
    poiMaxCountEl.value = String(p.maxCount);
    poiMinScoreLabelEl.textContent = fmtMinScoreLabel(p.minScore);
    poiMaxCountLabelEl.textContent = String(p.maxCount);
    renderPoiPrefsChips();
    syncPresetButtons();
    refreshPoiPrefsSubtitle();
    return;
  }
  /* Toggle: clicking an already-active preset removes it from the
     stack. Clicking an inactive one adds it. State is then recomputed
     as the union of remaining active presets. */
  if (activePresetIds.has(id)) activePresetIds.delete(id);
  else activePresetIds.add(id);
  if (activePresetIds.size === 0) {
    /* All toggled off — restore default neutral state. */
    allowedPoiCategories.clear();
    allowedPoiThemes.clear();
    poiMinScoreEl.value = "6";
    poiMaxCountEl.value = "3";
    poiMinScoreLabelEl.textContent = fmtMinScoreLabel(6);
    poiMaxCountLabelEl.textContent = "3";
    renderPoiPrefsChips();
  } else {
    recomputeFromActivePresets();
  }
  syncPresetButtons();
  refreshPoiPrefsSubtitle();
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
    return `<button type="button" class="pref-chip${active ? " active" : ""}" data-theme="${escapeHtml(t)}" aria-pressed="${active}">${escapeHtml(themeLabel(t))}</button>`;
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
/* Sync the slider labels to whatever value the browser restored on
   reload. The HTML defaults to 200 km / 6 h, but Firefox/Chrome restore
   sliders to the last user-set value without firing an `input` event,
   so the labels would otherwise stay at the hardcoded defaults while
   the slider thumb sat at the restored position. */
if (distLabel && distSlider) distLabel.textContent = `${distSlider.value} km`;
if (timeLabel && timeSlider) {
  const v = +timeSlider.value;
  timeLabel.textContent = v % 1 === 0 ? `${v} h` : `${v.toFixed(1)} h`;
}
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
planStartTimeEl?.addEventListener("change", () => {
  try { localStorage.setItem("alpine.planner.startTime", currentTripStartTime()); } catch {}
  if (plannedRouteGeometry) {
    if (weatherHydrationTimer) clearTimeout(weatherHydrationTimer);
    weatherHydrationTimer = setTimeout(() => {
      weatherHydrationTimer = null;
      hydratePlanWeather();
    }, 350);
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

const planLocateErrorEl = document.getElementById("planLocateError");
let planLocateErrorTimer = null;
function clearPlanLocateError() {
  if (planLocateErrorTimer) { clearTimeout(planLocateErrorTimer); planLocateErrorTimer = null; }
  if (!planLocateErrorEl) return;
  planLocateErrorEl.textContent = "";
  planLocateErrorEl.hidden = true;
}
function showPlanLocateError(message) {
  if (!planLocateErrorEl) return;
  planLocateErrorEl.textContent = message;
  planLocateErrorEl.hidden = false;
  if (planLocateErrorTimer) clearTimeout(planLocateErrorTimer);
  planLocateErrorTimer = setTimeout(clearPlanLocateError, 8000);
}

function locateButtonDefaults() {
  if (!planLocateBtn) return { html: "", title: "" };
  if (!planLocateDefaults) {
    planLocateDefaults = {
      html: planLocateBtn.innerHTML,
      title: planLocateBtn.getAttribute("title") || "",
    };
  }
  return planLocateDefaults;
}

function setLocateButtonBusy(busy) {
  if (!planLocateBtn) return;
  const defaults = locateButtonDefaults();
  planLocateBtn.disabled = busy;
  planLocateBtn.classList.toggle("is-busy", busy);
  if (busy) {
    planLocateBtn.setAttribute("aria-busy", "true");
    planLocateBtn.setAttribute("title", "Locating…");
    planLocateBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span>`;
  } else {
    planLocateBtn.removeAttribute("aria-busy");
    planLocateBtn.setAttribute("title", defaults.title);
    planLocateBtn.innerHTML = defaults.html;
  }
}

function geolocationWarning(error) {
  switch (error?.code) {
    case 1:
      return "Location permission denied. Choose a preset or pick a start on the map.";
    case 2:
      return "Current location unavailable. Choose a preset or pick a start on the map.";
    case 3:
      return "Location request timed out. Choose a preset or pick a start on the map.";
    default:
      return "Could not get current location. Choose a preset or pick a start on the map.";
  }
}

function requestCurrentLocationStart() {
  clearPlanLocateError();
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    const message = "Current location needs HTTPS or localhost. Choose a preset or pick a start on the map.";
    showPlanWarning(message);
    showPlanLocateError(message);
    return;
  }
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    const message = "Current location is not supported by this browser. Choose a preset or pick a start on the map.";
    showPlanWarning(message);
    showPlanLocateError(message);
    return;
  }

  if (pickingStart) {
    pickingStart = false;
    syncPickButtonState();
  }
  setLocateButtonBusy(true);
  try {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocateButtonBusy(false);
        const lat = Number(position?.coords?.latitude);
        const lon = Number(position?.coords?.longitude);
        if (!validStartCoords(lat, lon)) {
          const message = "Current location returned invalid coordinates. Choose a preset or pick a start on the map.";
          showPlanWarning(message);
          showPlanLocateError(message);
          return;
        }
        applyCustomStart(`Current location (${lat.toFixed(3)}, ${lon.toFixed(3)})`, lat, lon);
      },
      (error) => {
        setLocateButtonBusy(false);
        const message = geolocationWarning(error);
        showPlanWarning(message);
        showPlanLocateError(message);
      },
      GEOLOCATION_OPTIONS
    );
  } catch {
    setLocateButtonBusy(false);
    const message = "Could not start location request. Choose a preset or pick a start on the map.";
    showPlanWarning(message);
    showPlanLocateError(message);
  }
}

planPickBtn.addEventListener("click", () => {
  pickingStart = !pickingStart;
  if (pickingStart && activePopup) { activePopup.remove(); activePopup = null; }
  syncPickButtonState();
});
planLocateBtn?.addEventListener("click", requestCurrentLocationStart);
let planStartSearchDebounceTimer = null;
const PLAN_START_SEARCH_DEBOUNCE_MS = 250;
function schedulePlanStartSearch() {
  if (planStartSearchDebounceTimer) clearTimeout(planStartSearchDebounceTimer);
  planStartSearchDebounceTimer = setTimeout(() => {
    planStartSearchDebounceTimer = null;
    const q = (planStartSearchEl?.value || "").trim();
    if (q.length < 3) { renderStartSearchResults([]); return; }
    if (planStartSearchBtn?.disabled) return;
    searchStartPlaces();
  }, PLAN_START_SEARCH_DEBOUNCE_MS);
}
planStartSearchBtn?.addEventListener("click", searchStartPlaces);
planStartSearchEl?.addEventListener("input", schedulePlanStartSearch);
planStartSearchEl?.addEventListener("keydown", e => {
  if (planStartSearchDebounceTimer) {
    clearTimeout(planStartSearchDebounceTimer);
    planStartSearchDebounceTimer = null;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    searchStartPlaces();
  } else if (e.key === "Escape") {
    renderStartSearchResults([]);
  }
});
planStartSearchResultsEl?.addEventListener("click", e => {
  const btn = e.target.closest("button[data-start-result]");
  if (!btn || !planStartSearchResultsEl.contains(btn)) return;
  selectStartSearchResult(Number(btn.dataset.startResult));
});
map.on("click", (e) => {
  if (!pickingStart) return;
  const lat = Number(e.lngLat.lat);
  const lon = Number(e.lngLat.lng);
  if (!validStartCoords(lat, lon)) {
    showPlanWarning("Map click returned invalid coordinates. Choose a preset or try another map point.");
  } else {
    applyCustomStart(`Custom (${lat.toFixed(3)}, ${lon.toFixed(3)})`, lat, lon);
  }
  pickingStart = false;
  syncPickButtonState();
});

function clearPlannedTour() {
  weatherHydrationSeq++;
  if (weatherHydrationTimer) {
    clearTimeout(weatherHydrationTimer);
    weatherHydrationTimer = null;
  }
  setPlannedTourIds([]);
  plannedStart = null;
  plannedRouteActive = false;
  setLayerSoloFocus(false);
  plannedRouteCoords = null;
  plannedRouteGeometry = null;
  if (typeof window !== "undefined") window.plannedRouteGeometry = null;
  plannedRouteFallback = false;
  plannedRouteAlternatives = [];
  activeRouteAlternativeIndex = 0;
  if (activePopup) { activePopup.remove(); activePopup = null; }
  updatePlannedTourLayers();
  updateMapSources();
  refreshLayerControlUI();
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

const WEATHER_TTL = 30 * 60 * 1000;
const WEATHER_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const WEATHER_WIND_WARN_KMH = 50;
let weatherHydrationSeq = 0;
let weatherHydrationTimer = null;

function weatherCacheKey(lat, lng, tripDate) {
  return `alps:weather:${shortHash(`${lat.toFixed(2)}:${lng.toFixed(2)}:${tripDate}`)}`;
}

function stopElevation(item) {
  for (const key of ["elev", "elevation", "altitude", "height", "ele"]) {
    const value = Number(item?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function wmoWeather(code) {
  const c = Number(code);
  if (c === 0) return { icon: "☀", text: "sunny" };
  if (c === 1) return { icon: "🌤", text: "partly cloudy" };
  if (c === 2) return { icon: "⛅", text: "mostly cloudy" };
  if (c === 3) return { icon: "⛅", text: "cloudy" };
  if (c >= 45 && c <= 48) return { icon: "🌫", text: "fog" };
  if (c >= 51 && c <= 67) return { icon: "🌧", text: c >= 61 ? "rain" : "light rain" };
  if (c >= 71 && c <= 77) return { icon: "❄", text: "snow" };
  if (c >= 80 && c <= 86) return { icon: "🌦", text: c >= 85 ? "snow showers" : "showers" };
  if (c >= 95 && c <= 99) return { icon: "⛈", text: "storm" };
  return { icon: "🌤", text: "forecast" };
}

function nearestWeatherHour(hourly, eta) {
  const times = hourly?.time || [];
  if (!times.length) return -1;
  const etaMs = eta.getTime();
  let bestIdx = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]).getTime();
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - etaMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  return bestDelta <= 90 * 60 * 1000 ? bestIdx : -1;
}

async function fetchWeatherForecast(lat, lng, tripDate) {
  const key = weatherCacheKey(lat, lng, tripDate);
  const cached = cacheGet(key, WEATHER_TTL);
  if (cached) return cached;
  return dedupe(key, async () => {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      hourly: "temperature_2m,precipitation,weather_code,wind_speed_10m,snowfall",
      timezone: "auto",
      forecast_days: "7",
    });
    const res = await fetch(`${WEATHER_ENDPOINT}?${params.toString()}`);
    if (!res.ok) throw new Error("weather unavailable");
    const json = await res.json();
    cacheSet(key, json);
    return json;
  });
}

async function mapConcurrent(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

function etaForGeometryStop(geom, stop) {
  const start = currentTripDateTime();
  const idx = stop.idx || 0;
  const distKm = geom.cumKm?.[idx] || 0;
  const driveRatio = geom.totalKm > 0 ? clampNumber(distKm / geom.totalKm, 0, 1) : 0;
  const driveHAtStop = (geom.driveH || 0) * driveRatio;
  const earlierStops = (geom.stops || []).filter(s => s.idx < idx);
  const earlierStopMin = earlierStops.reduce((sum, s) => sum + (s.stopMin || 0) + (s.dwellMin || 0), 0);
  const restMin = (geom.totalRestMin || 0) * (geom.driveH > 0 ? Math.min(1, driveHAtStop / geom.driveH) : 0);
  const lunchMin = geom.driveH > 0 && driveHAtStop >= geom.driveH / 2 ? (geom.totalLunchMin || 0) : 0;
  return new Date(start.getTime() + Math.round((driveHAtStop * 60 + earlierStopMin + restMin + lunchMin) * 60 * 1000));
}

function formatWeatherChip(hourly, hourIdx, elevation) {
  if (hourIdx < 0) return "";
  const temp = Number(hourly.temperature_2m?.[hourIdx]);
  const code = hourly.weather_code?.[hourIdx];
  if (!Number.isFinite(temp) || code == null) return "";
  const precip = Number(hourly.precipitation?.[hourIdx]) || 0;
  const wind = Number(hourly.wind_speed_10m?.[hourIdx]) || 0;
  const snowfall = Number(hourly.snowfall?.[hourIdx]) || 0;
  const w = wmoWeather(code);
  let icon = w.icon;
  let text = w.text;
  if (precip > 0 && !/(rain|showers|snow|storm)/.test(text)) text = "light rain";
  const elev = Number(elevation);
  if (snowfall > 0 && (!Number.isFinite(elev) || elev > 1500)) {
    icon = "❄";
    text = text.includes("snow") ? text : `snow · ${text}`;
  }
  const warnings = [];
  if (wind > WEATHER_WIND_WARN_KMH) warnings.push("⚠ strong wind");
  return `${icon} ${Math.round(temp)}° · ${text}${warnings.length ? ` · ${warnings.join(" · ")}` : ""}`;
}

function setWeatherUnavailableHint(message) {
  const hint = document.getElementById("weatherUnavailableHint");
  if (!hint) return;
  hint.textContent = message || "";
  hint.hidden = !message;
}

function stopWeatherNodes() {
  return Array.from(document.querySelectorAll(".tour-stop-weather"));
}

async function hydratePlanWeather() {
  const seq = ++weatherHydrationSeq;
  const geom = plannedRouteGeometry;
  const chips = stopWeatherNodes();
  if (!geom?.stops?.length || chips.length === 0) return;
  setWeatherUnavailableHint("");
  chips.forEach(chip => { chip.hidden = true; chip.textContent = ""; });
  const tripDate = planDateEl?.value || toDateInputValue(currentTripDate());
  if (daysBetweenDates(todayLocalDate(), currentTripDate()) > 6) {
    setWeatherUnavailableHint("Weather forecasts are available for the next 7 days.");
    return;
  }
  let populated = 0;
  const chipsByTourIndex = new Map(chips.map(chip => [Number(chip.dataset.weatherStop), chip]));
  await mapConcurrent(geom.stops, 10, async stop => {
    const item = stop.item || {};
    const chip = chipsByTourIndex.get(Number(stop.tourIndex));
    if (!chip) return;
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    try {
      const forecast = await fetchWeatherForecast(lat, lng, tripDate);
      if (seq !== weatherHydrationSeq) return;
      const hourIdx = nearestWeatherHour(forecast?.hourly, etaForGeometryStop(geom, stop));
      const text = formatWeatherChip(forecast?.hourly, hourIdx, stopElevation(item));
      if (!chip || !text) return;
      chip.textContent = text;
      chip.hidden = false;
      populated++;
    } catch {
      /* Forecast chips are best-effort and must not block route rendering. */
    }
  });
  if (seq === weatherHydrationSeq && populated === 0) {
    setWeatherUnavailableHint("Weather forecast unavailable for this tour.");
  }
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

function normalizeOsrmRoute(route) {
  return {
    geom: route.geometry.coordinates,
    distanceKm: Math.round(route.distance / 1000),
    durationH: +(route.duration / 3600).toFixed(1),
  };
}

async function osrmRoute(coordsStr, options = {}) {
  const wantsAlternatives = !!options.alternatives;
  const key = `alps:osrm:r:${wantsAlternatives ? "alt:" : ""}${shortHash(coordsStr)}`;
  const cached = cacheGet(key, OSRM_ROUTE_TTL);
  if (cached) { console.log("osrm route: cache hit"); return cached; }
  return dedupe(key, async () => {
    const altParam = wantsAlternatives ? "&alternatives=3" : "";
    const url = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson${altParam}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!j.routes || j.code !== "Ok") throw new Error("OSRM route " + j.code);
    const routes = j.routes.map(normalizeOsrmRoute);
    const out = { ...routes[0], routes };
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
/* Out-and-back pass visits (climb to summit then retrace to the same
   gateway) produce visually ugly hairpin loops on the map and add no
   "stop value" since there's nothing at the summit beyond the view.
   Globally banned: the DP only considers traversal pairs (enter ≠ exit)
   and implicit-pass detection only counts true drive-throughs. */
const ALLOW_OUT_AND_BACK = false;
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
        if (!ALLOW_OUT_AND_BACK && e === s) continue;
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
              if (!ALLOW_OUT_AND_BACK && e === s2) continue;
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
        if (!ALLOW_OUT_AND_BACK && enterSide === exitSide) continue;
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
              if (!ALLOW_OUT_AND_BACK && nextEnterSide === nextExitSide) continue;
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
    const summitStop = p.summitParking || p;
    waypoints.push([enter.lat, enter.lon]);
    wpMatrixIdx.push(1 + 3 * t.passIdx + t.enterSide * 2);
    waypoints.push([summitStop.lat, summitStop.lon]);
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

const ROUTE_PASS_CROSSING_KM = 1.5;
/* When checking implicit-pass detection: gateways must be within this
   distance of the leg polyline AND on opposite sides of the summit
   along the route, otherwise we'd surface out-and-back climbs as
   "drove through" passes. */
const ROUTE_PASS_GATEWAY_KM = 2.5;

function plannerStatusAllowsPass(p, openOnly) {
  if (!openOnly) return true;
  const s = passStatus(p);
  return !!s && (s.state === "open" || s.state === "restricted");
}

function nearestPolylineHit(pt, latlngs, startIdx, endIdx, thresholdKm = ROUTE_PASS_CROSSING_KM) {
  if (!pt || !Array.isArray(latlngs) || latlngs.length === 0) return null;
  const lo = Math.max(0, Math.min(latlngs.length - 1, Math.floor(Math.min(startIdx, endIdx))));
  const hi = Math.max(lo, Math.min(latlngs.length - 1, Math.ceil(Math.max(startIdx, endIdx))));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;

  const cos = Math.cos(pt.lat * Math.PI / 180);
  let bestIdx = -1;
  let bestD2 = Infinity;
  function consider(lat, lon, idx) {
    const dy = (lat - pt.lat) * 111;
    const dx = (lon - pt.lon) * 111 * cos;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIdx = idx;
    }
  }
  for (let i = lo; i <= hi; i++) {
    consider(latlngs[i][0], latlngs[i][1], i);
    if (i >= hi) continue;
    const [aLat, aLon] = latlngs[i];
    const [bLat, bLon] = latlngs[i + 1];
    const ax = (aLon - pt.lon) * 111 * cos;
    const ay = (aLat - pt.lat) * 111;
    const bx = (bLon - pt.lon) * 111 * cos;
    const by = (bLat - pt.lat) * 111;
    const vx = bx - ax;
    const vy = by - ay;
    const vv = vx * vx + vy * vy;
    if (vv <= 0) continue;
    const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / vv));
    consider(aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t, i + t);
  }

  const threshold2 = thresholdKm * thresholdKm;
  return bestD2 <= threshold2
    ? { idx: bestIdx, distanceKm: Math.sqrt(bestD2) }
    : null;
}

function passTraversalHitForRange(pass, latlngs, startIdx, endIdx) {
  if (!pass?.baseA || !pass?.baseB) return null;
  const hit = nearestPolylineHit(pass, latlngs, startIdx, endIdx);
  if (!hit) return null;
  const aHit = nearestPolylineHit(pass.baseA, latlngs, startIdx, endIdx, ROUTE_PASS_GATEWAY_KM);
  const bHit = nearestPolylineHit(pass.baseB, latlngs, startIdx, endIdx, ROUTE_PASS_GATEWAY_KM);
  if (!aHit || !bHit) return null;
  const aBefore = aHit.idx < hit.idx;
  const bBefore = bHit.idx < hit.idx;
  if (aBefore === bBefore) return null;

  const entry = aBefore ? pass.baseA : pass.baseB;
  const exit = aBefore ? pass.baseB : pass.baseA;
  const entryHit = aBefore ? aHit : bHit;
  const exitHit = aBefore ? bHit : aHit;
  const entryAfterSummit = nearestPolylineHit(entry, latlngs, Math.ceil(hit.idx), Math.floor(exitHit.idx), ROUTE_PASS_GATEWAY_KM);
  const exitBeforeSummit = nearestPolylineHit(exit, latlngs, Math.ceil(entryHit.idx), Math.floor(hit.idx), ROUTE_PASS_GATEWAY_KM);
  if (entryAfterSummit || exitBeforeSummit) return null;

  return { hit, aHit, bHit };
}

function routePassCrossingsForPlan({ tourStops, perm, wpMatrixIdx, wpIdx, latlngs, openOnly = false }) {
  const blocked = [];
  const implicitById = new Map();
  const stopCount = (tourStops || []).length;
  if (!Array.isArray(wpMatrixIdx) || !Array.isArray(wpIdx) || !Array.isArray(latlngs)) {
    return { blocked, implicit: [] };
  }

  const plannedIds = new Set((tourStops || []).map(p => p.id));
  const orderByPassIdx = new Map((perm || []).map((t, order) => [t.passIdx, order]));
  const passIdxForMatrix = idx => idx > 0 ? Math.floor((idx - 1) / 3) : -1;
  const blockedSeen = new Set();
  function insertionIndexForLeg(leg) {
    const toM = wpMatrixIdx[leg + 1];
    const toPassIdx = passIdxForMatrix(toM);
    return toPassIdx >= 0 && orderByPassIdx.has(toPassIdx)
      ? orderByPassIdx.get(toPassIdx)
      : stopCount;
  }
  function legForRouteIdx(routeIdx) {
    const limit = Math.min(wpMatrixIdx.length, wpIdx.length) - 1;
    for (let leg = 0; leg < limit; leg++) {
      const a = wpIdx[leg];
      const b = wpIdx[leg + 1];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (routeIdx >= lo && routeIdx <= hi) return leg;
    }
    return Math.max(0, limit - 1);
  }
  function addBlockedPass(pass, fromM, toM) {
    const key = `${pass.id}:${fromM}:${toM}`;
    if (blockedSeen.has(key)) return;
    blockedSeen.add(key);
    blocked.push({ fromM, toM, name: pass.name });
  }
  function addImplicitPass(pass, routeIdx, insertionIndex, distanceKm) {
    const prev = implicitById.get(pass.id);
    const entry = { pass, insertionIndex, routeIdx, distanceKm };
    if (!prev || routeIdx < prev.routeIdx) implicitById.set(pass.id, entry);
  }

  for (let leg = 0; leg < Math.min(wpMatrixIdx.length, wpIdx.length) - 1; leg++) {
    const fromM = wpMatrixIdx[leg];
    const toM = wpMatrixIdx[leg + 1];
    const fromPassIdx = passIdxForMatrix(fromM);
    const toPassIdx = passIdxForMatrix(toM);
    if (fromPassIdx >= 0 && fromPassIdx === toPassIdx) continue;

    const a = wpIdx[leg];
    const b = wpIdx[leg + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    const insertionIndex = insertionIndexForLeg(leg);

    for (const p of PASSES) {
      if (plannedIds.has(p.id)) continue;

      const traversal = passTraversalHitForRange(p, latlngs, a, b);
      if (!traversal) continue;
      const hit = traversal.hit;

      if (!plannerStatusAllowsPass(p, openOnly)) {
        addBlockedPass(p, fromM, toM);
        continue;
      }

      addImplicitPass(p, hit.idx, insertionIndex, hit.distanceKm);
    }
  }

  /* A planned waypoint can split an unplanned pass crossing across two
     adjacent connector legs. Per-leg matching then sees only one gateway per
     leg and misses the actual pass (the Klausen screenshot regression). Do a
     second whole-route pass so true gateway→summit→gateway crossings are
     surfaced even when they straddle a waypoint. */
  for (const p of PASSES) {
    if (plannedIds.has(p.id)) continue;
    const traversal = passTraversalHitForRange(p, latlngs, 0, latlngs.length - 1);
    if (!traversal) continue;
    const hit = traversal.hit;

    const leg = legForRouteIdx(hit.idx);
    const fromM = wpMatrixIdx[leg];
    const toM = wpMatrixIdx[leg + 1];
    if (!plannerStatusAllowsPass(p, openOnly)) {
      addBlockedPass(p, fromM, toM);
      continue;
    }
    addImplicitPass(p, hit.idx, insertionIndexForLeg(leg), hit.distanceKm);
  }

  const implicit = [...implicitById.values()].sort((a, b) =>
    (a.insertionIndex - b.insertionIndex) ||
    (a.routeIdx - b.routeIdx) ||
    a.pass.name.localeCompare(b.pass.name)
  );
  return { blocked, implicit };
}

function mergeImplicitRoutePasses(tourStops, modes, implicitPasses) {
  const mergedStops = (tourStops || []).slice();
  const mergedModes = (modes || []).slice();
  let inserted = 0;
  for (const crossing of implicitPasses || []) {
    const idx = Math.max(0, Math.min(mergedStops.length, crossing.insertionIndex + inserted));
    mergedStops.splice(idx, 0, crossing.pass);
    mergedModes.splice(idx, 0, {
      passIdx: null,
      enterSide: 0,
      exitSide: 1,
      mode: "traverse",
      implicit: true,
    });
    inserted++;
  }
  return { tourStops: mergedStops, modes: mergedModes };
}

const VIEWPOINT_MODE_MIN_Q = Object.freeze({
  summit: Infinity,
  recommended: 0.6,
  all: 0,
});

function scenicKindLabel(kind) {
  switch (kind) {
    case "summit-parking": return "summit parking";
    case "belvedere": return "belvedere";
    case "layby": return "roadside viewpoint";
    case "viewpoint": return "viewpoint";
    default: return "scenic stop";
  }
}

function modeAllowsViewpointSide(mode, side) {
  if (!side || side === "summit" || !mode || mode.implicit) return true;
  if (mode.mode === "traverse") return true;
  const normalizedSide = String(side).toUpperCase();
  const entrySide = mode.enterSide === 0 ? "A" : "B";
  return normalizedSide === entrySide;
}

function scenicStopChoiceForPass(pass, mode, cfg) {
  if (!pass || pass.isPoi) return null;
  const viewpointMode = cfg?.viewpointMode || STOPS_DEFAULTS.viewpointMode;
  const threshold = VIEWPOINT_MODE_MIN_Q[viewpointMode] ?? VIEWPOINT_MODE_MIN_Q.recommended;
  const curated = (pass.viewpoints || [])
    .filter(v => modeAllowsViewpointSide(mode, v.side))
    .map(v => ({ ...v, q: typeof v.q === "number" ? v.q : 0.5 }))
    .filter(v => v.q >= threshold)
    .sort((a, b) => (b.q - a.q) || (a.dwellMin || 0) - (b.dwellMin || 0))[0];

  if (curated) {
    return {
      name: curated.name || "Viewpoint",
      kind: curated.kind || "viewpoint",
      point: { lat: curated.lat, lon: curated.lon },
      side: curated.side || "summit",
      quality: curated.q,
      source: "curated",
    };
  }

  if (pass.summitParking) {
    return {
      name: pass.summitParking.name || "Summit parking",
      kind: pass.summitParking.kind || "summit-parking",
      point: { lat: pass.summitParking.lat, lon: pass.summitParking.lon },
      side: "summit",
      quality: pass.qSummit || pass.quality || 0,
      source: "summit-parking",
    };
  }

  return {
    name: pass.bestPhoto ? "Best-photo summit viewpoint" : "Summit viewpoint",
    kind: "viewpoint",
    point: { lat: pass.lat, lon: pass.lon },
    side: "summit",
    quality: pass.qSummit || pass.quality || 0,
    source: "summit",
  };
}

function nearestUnusedScenicStop(scenicStops, targetIndex, usedIds) {
  let best = null;
  for (const stop of scenicStops) {
    if (usedIds.has(stop.id)) continue;
    const distance = Math.abs(stop.order - targetIndex);
    if (!best ||
        distance < best.distance ||
        (distance === best.distance && (stop.quality || 0) > (best.stop.quality || 0))) {
      best = { stop, distance };
    }
  }
  return best?.stop || null;
}

function planScenicStops({ tourStops, modes, extrasParts, config }) {
  const cfg = config || currentStopsConfig();
  const scenicStops = (tourStops || []).map((p, order) => {
    if (!p || p.isPoi) return null;
    const stopMin = intelligentPassStopMin(p, cfg.passStopMin || 0);
    const mode = modes?.[order] || null;
    const choice = scenicStopChoiceForPass(p, mode, cfg);
    if (!choice) return null;
    return {
      id: `${p.id}:scenic:${order}`,
      passId: p.id,
      passName: p.name,
      order,
      name: choice.name,
      kind: choice.kind,
      kindLabel: scenicKindLabel(choice.kind),
      point: choice.point,
      side: choice.side,
      quality: choice.quality,
      source: choice.source,
      stopMin,
      restMin: 0,
      restNumbers: [],
    };
  }).filter(Boolean);

  const restCount = extrasParts?.restCount || 0;
  const restDuration = Math.max(0, Number(cfg.restDuration) || 0);
  if (restCount > 0 && restDuration > 0 && scenicStops.length) {
    const used = new Set();
    for (let i = 1; i <= restCount; i++) {
      const targetIndex = Math.min(
        scenicStops.length - 1,
        Math.floor((i * scenicStops.length) / (restCount + 1))
      );
      const choice = nearestUnusedScenicStop(scenicStops, targetIndex, used) || scenicStops[targetIndex];
      if (choice) {
        choice.restMin += restDuration;
        choice.restNumbers.push(i);
        used.add(choice.id);
      }
    }
  }

  return scenicStops.filter(s => s.stopMin > 0 || s.restMin > 0);
}

const ROUTE_ALTERNATIVE_LIMIT = 3;

function routeListFromOsrm(routeOut) {
  const routes = Array.isArray(routeOut?.routes) && routeOut.routes.length
    ? routeOut.routes
    : routeOut ? [routeOut] : [];
  const seen = new Set();
  const unique = [];
  for (const route of routes) {
    if (!Array.isArray(route?.geom) || route.geom.length < 2) continue;
    const first = route.geom[0];
    const last = route.geom[route.geom.length - 1];
    const key = [
      Math.round((route.distanceKm || 0) * 10),
      Math.round((route.durationH || 0) * 60),
      first?.[0]?.toFixed?.(4),
      first?.[1]?.toFixed?.(4),
      last?.[0]?.toFixed?.(4),
      last?.[1]?.toFixed?.(4),
      route.geom.length,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(route);
    if (unique.length >= ROUTE_ALTERNATIVE_LIMIT) break;
  }
  return unique;
}

function retraceInfoForRoute(route, plan) {
  const latlngs = Array.isArray(route?.geom)
    ? route.geom.map(([lo, la]) => [la, lo])
    : [];
  if (!plan?.waypoints?.length || latlngs.length < 2) {
    return { latlngs, wpIdx: [], legs: [], overlapM: 0 };
  }
  const wpIdx = orderedPolylineWaypointIndices(plan.waypoints, latlngs);
  const legs = detectRetracedConnectorLegs(latlngs, wpIdx, plan.wpMatrixIdx);
  const overlapM = legs.reduce((sum, r) => sum + (r.overlapM || 0), 0);
  return { latlngs, wpIdx, legs, overlapM };
}

function rankedRouteEntriesFromOsrm(routeOut, plan) {
  return routeListFromOsrm(routeOut)
    .map((route, originalIndex) => ({
      route,
      originalIndex,
      retrace: retraceInfoForRoute(route, plan),
    }))
    .sort((a, b) =>
      (a.retrace.overlapM - b.retrace.overlapM) ||
      (a.retrace.legs.length - b.retrace.legs.length) ||
      (a.originalIndex - b.originalIndex)
    );
}

function routeDisplayForVariant({ route, tourStops, perm, plan, openOnly }) {
  const latlngs = route.geom.map(([lo, la]) => [la, lo]);
  const wpIdx = orderedPolylineWaypointIndices(plan.waypoints, latlngs);
  const crossings = routePassCrossingsForPlan({
    tourStops,
    perm,
    wpMatrixIdx: plan.wpMatrixIdx,
    wpIdx,
    latlngs,
    openOnly,
  });
  if (crossings.blocked.length) {
    return { blocked: crossings.blocked };
  }
  const implicitPasses = crossings.implicit;
  const merged = mergeImplicitRoutePasses(tourStops, perm, implicitPasses);
  return {
    tourStops: merged.tourStops,
    modes: merged.modes,
    implicitPasses: implicitPasses.map(x => x.pass),
    latlngs,
  };
}

function makeRouteAlternative({ route, index, start, baseTourStops, perm, plan, openOnly, stopsConfig, dwellH, policyTotalH, commonResult }) {
  const display = routeDisplayForVariant({ route, tourStops: baseTourStops, perm, plan, openOnly });
  if (display.blocked) return null;
  const passList = (display.tourStops || []).filter(s => !s.isPoi);
  const extras = computeExtras({
    passN: passList.length,
    driveH: route.durationH,
    config: stopsConfig,
    policyTotalH,
    passList,
  });
  const totalH = route.durationH + (dwellH || 0) + extras.extrasH;
  const scenicStops = planScenicStops({
    tourStops: display.tourStops,
    modes: display.modes,
    extrasParts: extras.parts,
    config: stopsConfig,
  });
  const result = {
    ...commonResult,
    start,
    tourStops: display.tourStops,
    km: route.distanceKm,
    driveH: route.durationH,
    dwellH: dwellH || 0,
    extrasH: extras.extrasH,
    extrasParts: extras.parts,
    totalH,
    modes: display.modes,
    implicitPasses: display.implicitPasses,
    scenicStops,
  };
  if (result.targetMode === "time" && Number.isFinite(result.targetValue)) {
    result.inRange = Math.abs(totalH - result.targetValue) <= result.targetValue * Math.max(result.targetTol ?? 0.20, 0.05);
  } else if (result.targetMode === "distance" && Number.isFinite(result.targetValue)) {
    result.inRange = Math.abs(route.distanceKm - result.targetValue) <= result.targetValue * (result.targetTol ?? 0.20);
  }
  if (result.advanced) result.statusWarning = advancedStatusWarning(display.tourStops);
  return {
    label: index === 0 ? "Best road" : `Alternative ${index + 1}`,
    result,
    draw: {
      start,
      tourStops: display.tourStops,
      latlngs: display.latlngs,
      meta: { driveH: route.durationH, dwellH: dwellH || 0, extras, stopsConfig },
    },
  };
}

function routeAlternativeSummaries() {
  return plannedRouteAlternatives.map((alt, index) => ({
    index,
    label: alt.label,
    km: alt.result.km,
    driveH: alt.result.driveH,
    totalH: alt.result.totalH,
  }));
}

function setPlannedRouteAlternatives(alternatives, activeIndex = 0) {
  plannedRouteAlternatives = Array.isArray(alternatives) ? alternatives.filter(Boolean) : [];
  activeRouteAlternativeIndex = Math.max(0, Math.min(activeIndex, plannedRouteAlternatives.length - 1));
}

function activateRouteAlternative(index) {
  const alt = plannedRouteAlternatives[index];
  if (!alt) return;
  activeRouteAlternativeIndex = index;
  showPlanResult({
    ...alt.result,
    routeAlternativeIndex: index,
    routeAlternatives: routeAlternativeSummaries(),
  });
  drawPlannedTour(alt.draw.start, alt.draw.tourStops, alt.draw.latlngs, alt.draw.meta);
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
  let latestDetailedPlan = null;
  let approximateFallback = null;
  let routeWarning = "";
  let residualRetraceLegs = [];
  const retraceLog = [];
  for (let iter = 0; iter < RETRACE_REPAIR_MAX_ITER; iter++) {
    const result = bestExactSelectedTour(matrix, selected.length, passQ, selected);
    if (!result) break;

    const baseTourStops = result.perm.map(t => selected[t.passIdx]);
    const plan = tourWaypointPlan(start, selected, result.perm);
    const waypoints = plan.waypoints;
    approximateFallback = { result, baseTourStops, plan };

    let routeOut;
    try {
      routeOut = await osrmRoute(coordsFromWaypoints(waypoints), { alternatives: true });
    } catch (e) {
      latestDetailedPlan = null;
      routeWarning = "Could not fetch detailed route geometry; map line is approximate.";
      break;
    }

    const rankedRoutes = rankedRouteEntriesFromOsrm(routeOut, plan);
    latestDetailedPlan = { result, baseTourStops, plan, routeOut };
    const bestRetraceLegs = rankedRoutes[0]?.retrace.legs || [];
    residualRetraceLegs = bestRetraceLegs;
    const retraceLegs = iter < RETRACE_REPAIR_MAX_ITER - 1 ? bestRetraceLegs : [];
    if (!retraceLegs.length) break;

    console.log(`advanced planner iter ${iter}: retrace pairs detected:`,
      retraceLegs.map(r => `legs ${r.legA}↔${r.legB} share ${r.overlapM}m`).join("; "));
    applyRetracePenalties(matrix, plan.wpMatrixIdx, retraceLegs);
    retraceLog.push(...retraceLegs.map(r => r.overlapM));
  }

  if (retraceLog.length) {
    console.log(`advanced planner: retraceFixes=${retraceLog.length}`);
  }
  if (residualRetraceLegs.length) {
    routeWarning = "Route still reuses a connector road after repair attempts. Try Road alternatives or adjust the selected stops for a cleaner loop.";
  }

  const finalPlan = latestDetailedPlan || approximateFallback;
  if (!finalPlan) {
    resetPlanButton();
    showPlanResult({ error: "No route found through the selected stops." });
    return;
  }
  const { result, baseTourStops, plan } = finalPlan;
  /* Driving time/distance from the planner matrix as a baseline; OSRM full
     route below replaces them with road-accurate values. Dwell time stays
     separate so it's never lost or mis-labelled (rubber-duck blocking #2). */
  const dwellH = result.dwellH || 0;
  let alternatives = [];
  if (latestDetailedPlan) {
    const commonResult = {
      matched: selected.length,
      poolSize: selected.length,
      inRange: true,
      advanced: true,
      routeWarning,
      tripDate: currentTripDate(),
    };
    alternatives = rankedRouteEntriesFromOsrm(latestDetailedPlan.routeOut, latestDetailedPlan.plan)
      .map((entry, index) => makeRouteAlternative({
        route: entry.route,
        index,
        start,
        baseTourStops,
        perm: result.perm,
        plan,
        openOnly: false,
        stopsConfig: currentStopsConfig(),
        dwellH,
        policyTotalH: null,
        commonResult,
      }))
      .filter(Boolean);
  }

  resetPlanButton();
  if (alternatives.length) {
    setPlannedRouteAlternatives(alternatives);
    activateRouteAlternative(0);
    return;
  }

  const stopsConfig = currentStopsConfig();
  const advExtras = computeExtras({
    passN: baseTourStops.filter(s => !s.isPoi).length,
    driveH: result.h,
    config: stopsConfig,
    passList: baseTourStops,
  });
  const fallbackScenicStops = planScenicStops({
    tourStops: baseTourStops,
    modes: result.perm,
    extrasParts: advExtras.parts,
    config: stopsConfig,
  });
  showPlanResult({
    start,
    tourStops: baseTourStops,
    km: result.km,
    driveH: result.h,
    dwellH,
    extrasH: advExtras.extrasH,
    extrasParts: advExtras.parts,
    totalH: result.h + dwellH + advExtras.extrasH,
    matched: selected.length,
    poolSize: selected.length,
    inRange: true,
    advanced: true,
    routeWarning,
    statusWarning: advancedStatusWarning(baseTourStops),
    tripDate: currentTripDate(),
    modes: result.perm,
    implicitPasses: [],
    scenicStops: fallbackScenicStops,
  });
  drawPlannedTour(start, baseTourStops, null, { driveH: result.h, dwellH, extras: advExtras, stopsConfig });
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
  /* Stops & breaks budget ??? in time mode reserve a slack for pass photo
     stops, lunch and rest breaks so the optimizer's drive+dwell budget
     leaves room for the extras the user expects in the day. */
  const stopsConfig = currentStopsConfig();
  const reservedExtrasH = targetMode === "time"
    ? computeExtras({
        passN: estimateTourPassN(targetValue, targetMode),
        driveH: targetValue,
        config: stopsConfig,
        policyTotalH: targetValue,
      }).extrasH
    : 0;
  const optimizerValue = targetMode === "time"
    ? Math.max(targetValue - reservedExtrasH, targetValue * 0.5)
    : targetValue;
  /* Tolerance is a percentage of the optimizer's smaller budget; widen
     it a touch when we shaved time off so the user-facing tolerance band
     (computed from the original day length) still applies. */
  const optimizerTol = targetMode === "time"
    ? Math.min(0.6, targetTol * targetValue / Math.max(optimizerValue, 0.5))
    : targetTol;
  const targetSpec = { mode: targetMode, value: optimizerValue, tolerance: optimizerTol, avgSpeedKmH: AVG_SPEED_KMH };

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
      preset: activePresetIds.size > 0 ? [...activePresetIds] : null,
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
     between gateways, but the *fastest road* between two selected stops can
     itself run over a third pass.  If that hidden pass violates open-only,
     block the connector edge and re-plan.  If it is allowed, merge it into
     the displayed tour so the route line, list and numbered badges agree.
     We additionally do segment-level retrace detection on the geometry —
     when two distinct connector legs of the tour drive the same valley
     road, we soft-penalise both edges and re-plan to push the optimiser
     toward exploring new ground. */
  const MAX_ITER = RETRACE_REPAIR_MAX_ITER;

  let chosen = null;
  let chosenLatLngs = null;
  let chosenWaypoints = null;
  let chosenPlan = null;
  let chosenBaseTourStops = null;
  let chosenPerm = null;
  let chosenTourStops = null;
  let chosenModes = null;
  let chosenImplicitPasses = [];
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
    const wpIdx = orderedPolylineWaypointIndices(waypoints, latlngs);
    const crossings = routePassCrossingsForPlan({
      tourStops,
      perm: result.perm,
      wpMatrixIdx,
      wpIdx,
      latlngs,
      openOnly,
    });
    const blockedThisIter = crossings.blocked;
    const implicitPassesThisIter = crossings.implicit;

    /* Retrace detection: only meaningful when there's no status-blocked pass
       to resolve first (blocking changes the tour anyway), and
       only on iterations where we still have a re-plan budget left. */
    const retraceLegs = (blockedThisIter.length === 0 && iter < MAX_ITER - 1)
      ? detectRetracedConnectorLegs(latlngs, wpIdx, wpMatrixIdx)
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
      chosenPlan = plan;
      chosenBaseTourStops = tourStops;
      chosenPerm = result.perm;
      const merged = mergeImplicitRoutePasses(tourStops, result.perm, implicitPassesThisIter);
      chosenTourStops = merged.tourStops;
      chosenModes = merged.modes;
      chosenImplicitPasses = implicitPassesThisIter.map(x => x.pass);
    }

    if (blockedThisIter.length === 0 && retraceLegs.length === 0) break;

    /* Apply hard infinitisation for pass crossings outside the active status filter. */
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
    applyRetracePenalties(matrix, wpMatrixIdx, retraceLegs);
    retraceLog.push(...retraceLegs.map(r => r.overlapM));
  }

  console.log(`planner: ${candidates.length} candidates (${passShare.length} passes + ${poiShare.length} POIs) · ${Math.round(plannerMs)} ms total · avoided=[${[...blockedNames].join(",")}] · retraceFixes=${retraceLog.length}`);
  resetPlanButton();

  if (!chosen) {
    if (blockedNames.size > 0) {
      showPlanResult({ error:
        `Couldn't find a tour avoiding pass${blockedNames.size > 1 ? "es" : ""} outside the open/restricted filter ` +
        `(${[...blockedNames].join(", ")}). Try a longer distance or a different start.` });
    } else {
      showPlanResult({ error: "No tour found." });
    }
    return;
  }

  /* Reject fallbacks that overshoot the budget catastrophically — much
     better UX to say "couldn't fit" than to dump a 1300 km tour on a user
     who asked for 200 km. Threshold scales with the active target unit.
     In time mode we evaluate against drive+dwell+extras since that is
     what the user signed up for as their "day length". */
  const passNForCheck = (chosenTourStops || []).filter(s => !s.isPoi).length;
  const actualPassList = (chosenTourStops || []).filter(s => !s.isPoi);
  const extras = computeExtras({
    passN: passNForCheck,
    driveH: chosen.driveH,
    config: stopsConfig,
    policyTotalH: targetMode === "time" ? targetValue : null,
    passList: actualPassList,
  });
  const displayModes = chosenModes || chosen.perm;
  const scenicStops = planScenicStops({
    tourStops: chosenTourStops,
    modes: displayModes,
    extrasParts: extras.parts,
    config: stopsConfig,
  });
  const totalWithExtras = (chosen.driveH || 0) + (chosen.dwellH || 0) + extras.extrasH;
  /* Recompute "in range" against the actual final total (drive + dwell +
     breaks). The optimizer's `chosen.inRange` is computed before OSRM and
     before the breaks pad-out, so it can be stale. */
  const finalInRange = targetMode === "time"
    ? Math.abs(totalWithExtras - targetValue) <= targetValue * Math.max(targetTol, 0.05)
    : chosen.inRange;
  const overshoot = targetMode === "time"
    ? totalWithExtras > targetValue * 1.5
    : chosen.km > targetValue * 1.5;
  if (!finalInRange && overshoot) {
    const tolPct = Math.round(targetTol * 100);
    const targetCopy = targetMode === "time"
      ? `${targetValue} h day from ${start.name}`
      : `${targetValue} km loop from ${start.name}`;
    const closestCopy = targetMode === "time"
      ? `${totalWithExtras.toFixed(1)} h`
      : `${Math.round(chosen.km)} km`;
    showPlanResult({ error:
      `No tour fits within ±${tolPct}% of a ${targetCopy}. ` +
      `Closest possible is ${closestCopy}. Try a longer ${targetMode === "time" ? "day length" : "distance"} ` +
      `or a different start point.` });
    clearPlannedTour();
    return;
  }

  const commonResult = {
    start, tourStops: chosenTourStops,
    matched: chosen.k,
    poolSize: candidates.length,
    totalOpen: allCands.length,
    targetMode, targetValue, targetTol, openOnly,
    poiPrefs: poiPrefsSnapshot,
    tripDate: currentTripDate(),
    avoided: blockedNames.size > 0 ? [...blockedNames] : null,
    candidatePoolNote: candidatePoolNote || null,
  };
  const primaryResult = {
    ...commonResult,
    km: chosen.km,
    driveH: chosen.driveH,
    dwellH: chosen.dwellH || 0,
    extrasH: extras.extrasH,
    extrasParts: extras.parts,
    totalH: totalWithExtras,
    inRange: finalInRange,
    modes: displayModes,   // [{passIdx, enterSide, exitSide, mode}, ...]
    implicitPasses: chosenImplicitPasses,
    scenicStops,
  };
  let alternatives = [];
  if (chosenPlan && chosenBaseTourStops && chosenPerm && chosenWaypoints) {
    try {
      const routeOut = await osrmRoute(coordsFromWaypoints(chosenWaypoints), { alternatives: true });
      alternatives = rankedRouteEntriesFromOsrm(routeOut, chosenPlan)
        .map((entry, index) => makeRouteAlternative({
          route: entry.route,
          index,
          start,
          baseTourStops: chosenBaseTourStops,
          perm: chosenPerm,
          plan: chosenPlan,
          openOnly,
          stopsConfig,
          dwellH: chosen.dwellH || 0,
          policyTotalH: targetMode === "time" ? targetValue : null,
          commonResult,
        }))
        .filter(Boolean);
    } catch {
      alternatives = [];
    }
  }
  if (!alternatives.length) {
    alternatives = [{
      label: "Best road",
      result: primaryResult,
      draw: {
        start,
        tourStops: chosenTourStops,
        latlngs: chosenLatLngs,
        meta: { driveH: chosen.driveH, dwellH: chosen.dwellH || 0, extras, stopsConfig },
      },
    }];
  }
  setPlannedRouteAlternatives(alternatives);
  activateRouteAlternative(0);
}

/* Index in `polyline` of the point closest to lat/lng `wp` (planar approx). */
function closestPolylineIdxInRange(wp, polyline, startIdx = 0, endIdx = polyline.length - 1) {
  const lat0 = wp[0], lon0 = wp[1];
  const cos = Math.cos(lat0 * Math.PI / 180);
  let best = 0, bestD = Infinity;
  const lo = Math.max(0, Math.min(polyline.length - 1, Math.floor(startIdx)));
  const hi = Math.max(lo, Math.min(polyline.length - 1, Math.ceil(endIdx)));
  for (let i = lo; i <= hi; i++) {
    const dy = (polyline[i][0] - lat0) * 111;
    const dx = (polyline[i][1] - lon0) * 111 * cos;
    const d = dx*dx + dy*dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function closestPolylineIdx(wp, polyline) {
  return closestPolylineIdxInRange(wp, polyline);
}

function orderedPolylineWaypointIndices(waypoints, polyline) {
  if (!Array.isArray(waypoints) || !Array.isArray(polyline) || !polyline.length) return [];
  const idxs = [];
  let minIdx = 0;
  for (const wp of waypoints) {
    const idx = closestPolylineIdxInRange(wp, polyline, minIdx, polyline.length - 1);
    idxs.push(idx);
    minIdx = idx;
  }
  return idxs;
}

/* Segment-level retrace detection on the chosen tour's actual route
   geometry. Densifies the polyline at fixed metre spacing, drops samples
   into a coarse spatial grid, then for every pair of points in nearby
   cells with index distance >1 leg checks whether they're geographically
   on top of each other. Accumulated "shared metres" per connector-leg
   pair tells us when two distinct connector drives use the same valley
   road. Only inter-stop connector legs are considered; the climb+descent
   legs within one pass are intentional and ignored.

   Returns [{ legA, legB, overlapM }] for connector pairs whose shared
   road length exceeds RETRACE_MIN_OVERLAP_M. */
const RETRACE_REPAIR_MAX_ITER = 5;
const RETRACE_THRESH_M = 100;      // points within this distance count as "same valley road"
const RETRACE_MIN_OVERLAP_M = 800; // must share at least this many metres to count
const RETRACE_SAMPLE_M = 200;      // densification spacing
const RETRACE_PENALTY_MULT = 3.0;  // strong soft cost; finite edges stay feasible, but repeats lose decisively
const RETRACE_ADJACENT_WAYPOINT_BUFFER_M = 350; // ignore only the natural turn-around area around a shared waypoint

function applyRetracePenaltyValue(table, from, to) {
  if (Number.isFinite(table?.[from]?.[to])) {
    table[from][to] *= RETRACE_PENALTY_MULT;
  }
}

function applyRetracePenalties(matrix, wpMatrixIdx, retraceLegs) {
  for (const r of retraceLegs) {
    const edges = [
      [wpMatrixIdx[r.legA], wpMatrixIdx[r.legA + 1]],
      [wpMatrixIdx[r.legB], wpMatrixIdx[r.legB + 1]],
    ];
    for (const [from, to] of edges) {
      applyRetracePenaltyValue(matrix.dist, from, to);
      applyRetracePenaltyValue(matrix.dist, to, from);
      applyRetracePenaltyValue(matrix.dur, from, to);
      applyRetracePenaltyValue(matrix.dur, to, from);
    }
  }
}

function matrixStopIndex(idx) {
  return idx > 0 ? Math.floor((idx - 1) / 3) : -1;
}

function isRetraceConnectorLeg(leg, wpMatrixIdx) {
  if (!Array.isArray(wpMatrixIdx) || wpMatrixIdx.length <= leg + 1) {
    return (leg % 3) === 0;
  }
  const from = wpMatrixIdx[leg];
  const to = wpMatrixIdx[leg + 1];
  if (from === 0 || to === 0) return true;
  return matrixStopIndex(from) !== matrixStopIndex(to);
}

function cumulativePolylineMetres(latlngs) {
  const cumulative = new Float64Array(latlngs.length);
  for (let i = 1; i < latlngs.length; i++) {
    cumulative[i] = cumulative[i - 1] + haversine(
      { lat: latlngs[i-1][0], lon: latlngs[i-1][1] },
      { lat: latlngs[i][0],   lon: latlngs[i][1]   }
    ) * 1000;
  }
  return cumulative;
}

function isNearSharedAdjacentWaypoint(sample, otherLeg, wpIdx, cumulativeM) {
  if (Math.abs(sample.leg - otherLeg) !== 1) return false;
  const sharedIdx = wpIdx[Math.max(sample.leg, otherLeg)];
  if (!Number.isFinite(sharedIdx) || sharedIdx < 0 || sharedIdx >= cumulativeM.length) return false;
  return Math.abs(cumulativeM[sample.idx] - cumulativeM[sharedIdx]) <= RETRACE_ADJACENT_WAYPOINT_BUFFER_M;
}

function detectRetracedConnectorLegs(latlngs, wpIdx, wpMatrixIdx = null) {
  if (!latlngs.length || wpIdx.length < 2) return [];
  const numLegs = wpIdx.length - 1;
  const cumulativeM = cumulativePolylineMetres(latlngs);

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
    const isConnector = isRetraceConnectorLeg(leg, wpMatrixIdx);
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
          if (q.leg === p.leg &&
              Math.abs(cumulativeM[q.idx] - cumulativeM[p.idx]) <= RETRACE_MIN_OVERLAP_M) {
            continue;
          }
          if (isNearSharedAdjacentWaypoint(p, q.leg, wpIdx, cumulativeM) ||
              isNearSharedAdjacentWaypoint(q, p.leg, wpIdx, cumulativeM)) {
            continue;
          }
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

function renderScenicStopsBlock(scenicStops) {
  if (!Array.isArray(scenicStops) || scenicStops.length === 0) return "";
  const shown = scenicStops.slice(0, 6).map(s => {
    const title = s.source === "curated"
      ? `${s.passName}: ${s.name}`
      : `${s.passName} ${s.kindLabel}`;
    const timeBits = [];
    if (s.stopMin > 0) timeBits.push(`${s.stopMin} min`);
    if (s.restMin > 0) timeBits.push(`${s.restMin} min rest`);
    const restHint = s.restNumbers?.length
      ? `; rest #${s.restNumbers.join("/")}`
      : "";
    return `${escapeHtml(title)} <span class="time-breakdown">(${escapeHtml(timeBits.join(" + ") + restHint)})</span>`;
  });
  const extra = scenicStops.length > shown.length
    ? ` <span class="time-breakdown">+${scenicStops.length - shown.length} more</span>`
    : "";
  return `<div class="popup-meta tight">Scenic stops planned: ${shown.join(" &middot; ")}${extra}</div>`;
}

function renderRouteAlternativesBlock(r) {
  const alternatives = Array.isArray(r.routeAlternatives) ? r.routeAlternatives : [];
  if (alternatives.length < 2) return "";
  const activeIndex = Number.isFinite(r.routeAlternativeIndex) ? r.routeAlternativeIndex : 0;
  const buttons = alternatives.map(alt => {
    const active = alt.index === activeIndex;
    return `<button type="button" class="route-alt-btn${active ? " active" : ""}" data-route-alt="${alt.index}" aria-pressed="${active}">
      <strong>${escapeHtml(alt.label)}</strong>
      <span>${Math.round(alt.km)} km · ${fmtDuration(alt.totalH || alt.driveH)}</span>
    </button>`;
  }).join("");
  return `<div class="route-alternatives" aria-label="Route alternatives">
    <div class="popup-meta tight"><strong>Road alternatives</strong> <span class="time-breakdown">same stops, different roads</span></div>
    <div class="route-alt-list">${buttons}</div>
    </div>`;
}

function cleanStartName(name) {
  return String(name || "").replace(/\s*\(-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\)\s*$/, "").trim() || name;
}

function renderTourStatChips(r) {
  const chips = [];
  const stops = r.tourStops || r.tourPasses || [];
  const passN = stops.filter(p => !p.isPoi).length;
  const poiN = stops.length - passN;
  const driveH = r.driveH ?? r.h;
  const dwellH = r.dwellH ?? 0;
  const extrasH = r.extrasH ?? 0;
  const totalH = r.totalH ?? (driveH != null ? driveH + dwellH + extrasH : null);

  if (r.km != null) chips.push(["Distance", `${Math.round(r.km)} km`]);
  if (totalH != null) chips.push(["Total", fmtDuration(totalH)]);
  if (driveH != null) chips.push(["Driving", fmtDuration(driveH)]);
  if (extrasH > 0) chips.push(["Breaks", fmtDuration(extrasH)]);
  if (stops.length > 0) {
    const stopsText = poiN > 0
      ? `${passN} pass${passN === 1 ? "" : "es"} + ${poiN} POI${poiN === 1 ? "" : "s"}`
      : `${stops.length} stop${stops.length === 1 ? "" : "s"}`;
    chips.push(["Stops", stopsText]);
  }
  if (chips.length === 0) return "";
  return `<ul class="tour-stats-chips">${chips.map(([k, v]) =>
    `<li><span class="chip-k">${escapeHtml(k)}</span><span class="chip-v">${escapeHtml(v)}</span></li>`).join("")}</ul>`;
}

function normalizedTourPoint(point) {
  if (!point) return null;
  const lat = Number(point.lat);
  const lon = Number(point.lon ?? point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    ...point,
    lat,
    lon,
    name: point.name || point.displayName || "",
  };
}

function tourStateForActions(tour = null) {
  if (tour) return tour;
  if (typeof window !== "undefined" && window.plannedRouteGeometry) {
    return window.plannedRouteGeometry;
  }
  return plannedRouteGeometry;
}

function tourStartForActions(tour = null) {
  const activeTour = tourStateForActions(tour);
  return normalizedTourPoint(
    activeTour?.start ||
    plannedStart ||
    (typeof currentStart === "function" ? currentStart() : null)
  );
}

function tourStopsForActions(tour = null) {
  const activeTour = tourStateForActions(tour);
  return activeTour?.stops || activeTour?.tourStops || activeTour?.tourPasses || [];
}

function tourStopPoint(stop) {
  const item = stop?.item || stop;
  return normalizedTourPoint({
    ...(item || {}),
    lat: item?.lat ?? stop?.lat,
    lon: item?.lon ?? item?.lng ?? stop?.lon ?? stop?.lng,
    name: item?.name ?? stop?.name,
  });
}

function tourCoordString(point) {
  const p = normalizedTourPoint(point);
  return p ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : null;
}

function closestPolylineIndex(point, coords) {
  if (!Array.isArray(coords) || !coords.length || !point) return -1;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const [lng, lat] = coords[i];
    const dlat = lat - point.lat;
    const dlng = lng - point.lon;
    const d = dlat * dlat + dlng * dlng;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function pickShapingWaypoints(start, userStops, coords, budget) {
  if (!Array.isArray(coords) || coords.length < 3 || budget <= 0) return [];

  const namedPoints = [start, ...userStops];
  const namedIndices = namedPoints.map(p => closestPolylineIndex(p, coords));
  const segmentSpans = [];
  for (let i = 0; i < userStops.length; i++) {
    const a = namedIndices[i];
    const b = namedIndices[i + 1];
    segmentSpans.push(Math.max(0, b - a));
  }
  const totalSpan = segmentSpans.reduce((s, v) => s + v, 0);
  if (totalSpan === 0) return [];

  const allocations = segmentSpans.map(span => {
    const raw = (span / totalSpan) * budget;
    return Math.min(3, Math.floor(raw));
  });
  let used = allocations.reduce((s, v) => s + v, 0);
  const remainders = segmentSpans
    .map((span, i) => ({ i, frac: (span / totalSpan) * budget - allocations[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (const r of remainders) {
    if (used >= budget) break;
    if (allocations[r.i] >= 3) continue;
    if (segmentSpans[r.i] < 6) continue;
    allocations[r.i]++;
    used++;
  }

  const result = [];
  for (let i = 0; i < userStops.length; i++) {
    const k = allocations[i];
    const a = namedIndices[i];
    const b = namedIndices[i + 1];
    const span = segmentSpans[i];
    if (k === 0 || span < 6) {
      result.push({ stopIdx: i, shaping: [] });
      continue;
    }
    const samples = [];
    for (let j = 1; j <= k; j++) {
      const idx = a + Math.round(span * j / (k + 1));
      const [lng, lat] = coords[idx];
      samples.push({ lat, lon: lng, via: true });
    }
    result.push({ stopIdx: i, shaping: samples });
  }
  return result;
}

function buildGoogleMapsDirectionsUrl(tour = null) {
  const activeTour = tourStateForActions(tour);
  if (!activeTour) return null;
  const start = tourStartForActions(activeTour);
  const startCoord = tourCoordString(start);
  if (!startCoord) return null;

  const userStops = tourStopsForActions(activeTour)
    .map(stop => tourStopPoint(stop))
    .filter(Boolean);
  if (!userStops.length) return null;

  const MAX_INTERMEDIATE = 9;
  const namedIntermediate = userStops.length - 1;
  const shapingBudget = Math.max(0, MAX_INTERMEDIATE - namedIntermediate);
  const routeCoords = activeTour?.coords || activeTour?.geometry?.coords;
  const segments = (Array.isArray(routeCoords) && routeCoords.length > 2 && shapingBudget > 0)
    ? pickShapingWaypoints(start, userStops, routeCoords, shapingBudget)
    : userStops.map((_, i) => ({ stopIdx: i, shaping: [] }));

  const params = new URLSearchParams();
  params.set("api", "1");
  params.set("travelmode", "driving");
  params.set("origin", startCoord);
  params.set("destination", tourCoordString(userStops[userStops.length - 1]));

  const intermediate = [];
  for (let i = 0; i < userStops.length; i++) {
    const seg = segments[i] || { shaping: [] };
    for (const s of seg.shaping) {
      const c = tourCoordString(s);
      if (c) intermediate.push(`via:${c}`);
    }
    if (i < userStops.length - 1) {
      const c = tourCoordString(userStops[i]);
      if (c) intermediate.push(c);
    }
  }
  if (intermediate.length) params.set("waypoints", intermediate.join("|"));

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

function buildTourGpx(tour = null) {
  const activeTour = tourStateForActions(tour);
  if (!activeTour) return null;
  const start = tourStartForActions(activeTour);
  if (!start) return null;
  const stops = tourStopsForActions(activeTour);
  const coords = activeTour?.coords || activeTour?.geometry?.coords || [];
  const totalKm = activeTour?.totalKm;
  const driveH = activeTour?.driveH;

  const now = new Date().toISOString();
  const startName = start.name || "Start";
  const tourName = `Alpine Passes — ${startName}`;
  const desc = [
    `${stops.length} stops`,
    typeof totalKm === "number" ? `${Math.round(totalKm)} km` : null,
    typeof driveH === "number" ? `~${driveH.toFixed(1)} h driving` : null,
  ].filter(Boolean).join(" · ");

  const wpts = [];
  if (Number.isFinite(start.lat) && Number.isFinite(start.lon)) {
    wpts.push(`  <wpt lat="${start.lat.toFixed(6)}" lon="${start.lon.toFixed(6)}">
    <name>${escapeXml(startName)}</name>
    <type>Start</type>
  </wpt>`);
  }
  for (const stop of stops) {
    const item = stop?.item || stop;
    const lat = item?.lat ?? stop?.lat;
    const lon = item?.lon ?? item?.lng ?? stop?.lon ?? stop?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = item?.name || stop?.name || "Stop";
    const elev = Number.isFinite(item?.elev) ? `\n    <ele>${item.elev}</ele>` : "";
    const isPass = item?.kind === "pass" || (item?.elev != null && item?.symbolIconAsset);
    const type = isPass ? "Pass" : "POI";
    wpts.push(`  <wpt lat="${Number(lat).toFixed(6)}" lon="${Number(lon).toFixed(6)}">${elev}
    <name>${escapeXml(name)}</name>
    <type>${type}</type>
  </wpt>`);
  }

  const trkpts = coords
    .filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map(([lng, lat]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`)
    .join("\n");
  const trk = trkpts
    ? `  <trk>
    <name>${escapeXml(tourName)} — planned route</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Alpine Passes"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(tourName)}</name>
    <desc>${escapeXml(desc)}</desc>
    <time>${now}</time>
  </metadata>
${wpts.join("\n")}
${trk}
</gpx>
`;
}

function downloadTourGpx(buttonEl) {
  const xml = buildTourGpx();
  if (!xml) return;
  const blob = new Blob([xml], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10);
  const activeTour = tourStateForActions();
  const startName = activeTour ? (tourStartForActions(activeTour)?.name || "tour") : "tour";
  const slug = String(startName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "tour";
  const filename = `alpine-tour-${today}-${slug}.gpx`;

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);

  if (buttonEl) {
    const labelEl = buttonEl.querySelector(".button-label");
    if (labelEl) {
      const original = labelEl.textContent;
      labelEl.textContent = "Downloaded";
      setTimeout(() => { labelEl.textContent = original; }, 1500);
    }
  }
}

function buildTourShareUrl(tour = null) {
  const activeTour = tourStateForActions(tour);
  if (!activeTour) return null;
  const start = tourStartForActions(activeTour);
  const startCoord = tourCoordString(start);
  if (!startCoord) return null;

  const stopIds = tourStopsForActions(activeTour)
    .map(stop => {
      const item = stop?.item || stop;
      return item?.id ?? stop?.id;
    })
    .filter(id => id != null && String(id).trim().length > 0)
    .map(String);

  const params = new URLSearchParams();
  params.set("start", startCoord);
  if (start.name) params.set("startName", start.name);
  if (stopIds.length) params.set("stops", stopIds.join(","));

  const base = window.location.origin && window.location.origin !== "null"
    ? `${window.location.origin}${window.location.pathname}`
    : window.location.href.split("#")[0].split("?")[0];
  return `${base}#tour=${params.toString()}`;
}

async function copyTourLink(buttonEl) {
  const url = buildTourShareUrl();
  if (!url) return;
  const labelEl = buttonEl?.querySelector(".button-label");
  const originalLabel = buttonEl?.dataset.originalLabel ||
    labelEl?.textContent ||
    buttonEl?.textContent ||
    "Copy link";
  if (buttonEl) buttonEl.dataset.originalLabel = originalLabel;

  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(url);
    if (labelEl) labelEl.textContent = "Copied!";
    window.setTimeout(() => {
      if (labelEl) labelEl.textContent = originalLabel;
    }, 1500);
  } catch (e) {
    window.prompt("Copy this link:", url);
  }
}

function renderPlanResultActions(result = null) {
  const actionTour = result
    ? { start: result.start, stops: result.tourStops || result.tourPasses || [] }
    : null;
  const mapsUrl = buildGoogleMapsDirectionsUrl(actionTour);
  const mapsAttrs = mapsUrl
    ? `href="${escapeHtml(mapsUrl)}"`
    : `href="#" aria-disabled="true"`;
  return `
    <div class="plan-result-actions">
      <a id="planOpenMaps" class="plan-action plan-action-maps" ${mapsAttrs} target="_blank" rel="noopener">
        <span class="button-icon" aria-hidden="true">→</span>
        <span class="button-label">Open in Google Maps</span>
      </a>
      <button id="planCopyLink" class="plan-action plan-action-copy" type="button">
        <span class="button-icon" aria-hidden="true">⎘</span>
        <span class="button-label">Copy link</span>
      </button>
      <a id="planExportGpx" class="plan-action plan-action-gpx" href="#" role="button">
        <span class="button-icon" aria-hidden="true">⬇</span>
        <span class="button-label">Export GPX</span>
      </a>
      <button id="planClear" class="plan-action" type="button">Clear</button>
    </div>`;
}

function refreshPlanResultActions(tour = null) {
  const mapsLink = planResult.querySelector("#planOpenMaps");
  if (!mapsLink) return;
  const mapsUrl = buildGoogleMapsDirectionsUrl(tour);
  if (mapsUrl) {
    mapsLink.href = mapsUrl;
    mapsLink.removeAttribute("aria-disabled");
  } else {
    mapsLink.href = "#";
    mapsLink.setAttribute("aria-disabled", "true");
  }
}

let planResultClickHandlerBound = false;

function handlePlanResultClick(e) {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;

  const clearBtn = target.closest("#planClear");
  if (clearBtn && planResult.contains(clearBtn)) {
    clearPlannedTour();
    planResult.classList.add("empty");
    planResult.innerHTML = "";
    return;
  }

  const copyBtn = target.closest("#planCopyLink");
  if (copyBtn && planResult.contains(copyBtn)) {
    void copyTourLink(copyBtn);
    return;
  }

  const gpxBtn = target.closest("#planExportGpx");
  if (gpxBtn && planResult.contains(gpxBtn)) {
    e.preventDefault();
    downloadTourGpx(gpxBtn);
    return;
  }

  const mapsLink = target.closest("#planOpenMaps");
  if (mapsLink && planResult.contains(mapsLink)) {
    const mapsUrl = buildGoogleMapsDirectionsUrl();
    if (!mapsUrl) {
      e.preventDefault();
      return;
    }
    mapsLink.href = mapsUrl;
    return;
  }

  const altBtn = target.closest("[data-route-alt]");
  if (!altBtn || !planResult.contains(altBtn)) return;
  activateRouteAlternative(Number(altBtn.dataset.routeAlt));
}

function bindPlanResultClickHandler() {
  if (planResultClickHandlerBound) return;
  planResult.addEventListener("click", handlePlanResultClick);
  planResultClickHandlerBound = true;
}

bindPlanResultClickHandler();

function scrollPlanResultIntoView() {
  requestAnimationFrame(() => {
    try {
      planResult.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (_) {
      const ss = document.querySelector(".sidebar-scroll");
      if (ss && planResult) ss.scrollTop = planResult.offsetTop;
    }
  });
}

function showPlanResult(r) {
  planResult.classList.remove("empty");
  planResult.classList.remove("pr-in");
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
    const t = (r.modes || [])[i];
    const weather = ` <span class="tour-stop-weather" data-weather-stop="${i}" hidden></span>`;
    if (p.isPoi) {
      const dwell = p.visitDwellSec ? ` <span class="dwell-badge" title="Typical visit time">${(p.visitDwellSec / 3600).toFixed(1)}h</span>` : "";
      return `<span class="tour-stop poi-stop">${poiCategoryIcon(p.poiCategory, "poi-stop-glyph")} ${escapeHtml(p.name)}${dwell}${weather}</span>`;
    }
    const modeBadge = t?.mode === "out-and-back"
      ? ` <span class="mode-badge" title="Visit summit and return same way">↻</span>`
      : ``;
    return `<span class="tour-stop pass-stop">${escapeHtml(p.name)}${modeBadge}${qualityStarsCompact(p.quality)}${weather}</span>`;
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
    ? `<div class="popup-meta tight success">↻ Re-planned to avoid pass${r.avoided.length > 1 ? "es" : ""} outside the open/restricted filter: ${r.avoided.join(", ")}</div>` : "";
  const implicitPasses = (r.implicitPasses || []).filter(Boolean);
  const implicitPassN = implicitPasses.length;
  const implicitPassBlock = implicitPassN > 0
    ? `<div class="popup-meta tight">Included en-route pass${implicitPassN === 1 ? "" : "es"} crossed by connector road: ${implicitPasses.map(p => escapeHtml(p.name)).join(", ")}</div>`
    : "";
  const title = r.advanced ? "Optimized selected route" : "Best tour";
  /* Time accounting — drive vs dwell vs extras vs total. We always render
     a single "total" up front, and a parenthetical breakdown when there's
     anything beyond drive. */
  const driveH = r.driveH ?? r.h ?? 0;
  const dwellH = r.dwellH ?? 0;
  const extrasH = r.extrasH ?? 0;
  const totalH = r.totalH ?? (driveH + dwellH + extrasH);
  const breakdownBits = [`${fmtDuration(driveH)} driving`];
  if (dwellH > 0) breakdownBits.push(`${fmtDuration(dwellH)} on site`);
  if (extrasH > 0) breakdownBits.push(`${fmtDuration(extrasH)} breaks`);
  const showBreakdown = r.targetMode === "time" || dwellH > 0 || extrasH > 0;
  const timeBlock = showBreakdown
    ? `~<strong>${fmtDuration(totalH)}</strong> total <span class="time-breakdown">(${breakdownBits.join(" + ")})</span>`
    : `~<strong>${fmtDuration(driveH)}</strong> driving`;
  const passN = passOnly.length;
  const poiN  = stops.length - passN;
  const matchedN = r.matched ?? Math.max(0, stops.length - implicitPassN);
  const candidateCopy = r.poolSize != null
    ? `${matchedN} of ${r.poolSize} candidates`
    : `${matchedN} selected`;
  const stopSummary = poiN > 0
    ? `<strong>${passN}</strong> pass${passN === 1 ? "" : "es"} + <strong>${poiN}</strong> POI${poiN === 1 ? "" : "s"}`
    : implicitPassN > 0
      ? `<strong>${passN}</strong> pass${passN === 1 ? "" : "es"} (${matchedN} selected + ${implicitPassN} en-route)`
      : `<strong>${matchedN}</strong> selected pass${matchedN === 1 ? "" : "es"}`;
  const distanceBlock = r.targetMode === "time"
    ? `<strong>${Math.round(r.km)} km</strong>`
    : `<strong>${Math.round(r.km)} km</strong>`;
  const targetBadge = r.targetMode === "time"
    ? ` <span class="target-badge">target ${r.targetValue} h</span>`
    : ``;
  const statsLine = r.advanced
    ? `${stopSummary} · ${distanceBlock} · ${timeBlock}`
    : poiN > 0
      ? `${stopSummary} (${candidateCopy}${implicitPassN > 0 ? ` + ${implicitPassN} en-route` : ""})
         ${r.openOnly ? `(${r.totalOpen} passes shortlisted)` : ""} ·
         ${distanceBlock} · ${timeBlock}${targetBadge}`
      : implicitPassN > 0
        ? `<strong>${passN}</strong> pass${passN === 1 ? "" : "es"} (${candidateCopy} + ${implicitPassN} en-route)
          ${r.openOnly ? `(out of ${r.totalOpen} projected open/restricted passes)` : ""} ·
          ${distanceBlock} · ${timeBlock}${targetBadge}`
        : `<strong>${matchedN}</strong> of ${r.poolSize} candidates
         ${r.openOnly ? `(out of ${r.totalOpen} projected open/restricted passes)` : ""} ·
         ${distanceBlock} · ${timeBlock}${targetBadge}`;
  /* Active POI prefs hint, when any deviates from defaults. */
  const prefsBlock = (r.poiPrefs && (r.poiPrefs.preset || r.poiPrefs.cats.length || r.poiPrefs.themes.length || r.poiPrefs.minScore !== 6 || r.poiPrefs.maxCount !== 3))
    ? (() => {
        if (r.poiPrefs.preset) {
          /* `preset` is now an array (multi-select) — fall back to the
             single-string format from older results for back-compat. */
          const ids = Array.isArray(r.poiPrefs.preset) ? r.poiPrefs.preset : [r.poiPrefs.preset];
          const labels = ids.map(id => POI_PRESETS[id]?.label.split(" · ")[0] || id);
          const lab = labels.length === 1
            ? POI_PRESETS[ids[0]]?.label || ids[0]
            : `Stacked: ${labels.join(" + ")}`;
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
  const breaksBlock = (extrasH > 0 && r.extrasParts)
    ? `<div class="popup-meta tight">Breaks: ${escapeHtml(fmtExtrasSummary(r.extrasParts))}</div>`
    : "";
  const statChips = renderTourStatChips(r);
  const statsBlock = statChips || `<div class="stats">${statsLine}</div>`;
  const startName = cleanStartName(r.start.displayName || r.start.name);
  const scenicStopsBlock = renderScenicStopsBlock(r.scenicStops);
  const routeAlternativesBlock = renderRouteAlternativesBlock(r);
  const tripDateLine = r.tripDate
    ? `<div class="popup-meta tight projection${daysBetweenDates(todayLocalDate(), r.tripDate) > 0 ? " guess" : ""}">Trip date: ${escapeHtml(formatTripDate(r.tripDate))} · projected pass states; guesses are marked “Likely” / “guess”.</div>`
    : "";
  planResult.innerHTML = `
    <h3>${escapeHtml(title)} from ${escapeHtml(startName)}</h3>
    <div class="tour-passes">${stopList}</div>
    ${statsBlock}
    ${implicitPassBlock}
    ${candidatePoolBlock}
    ${breaksBlock}
    ${scenicStopsBlock}
    ${routeAlternativesBlock}
    ${prefsBlock}
    ${tripDateLine}
    <div class="weather-unavailable" id="weatherUnavailableHint" hidden></div>
    ${qualityLine}
    ${modeNote}
    ${avoided}
    ${warn}
    ${routeWarning}
    ${statusWarning}
    ${renderPlanResultActions(r)}`;
  planResult.classList.add("pr-in");
  Array.from(planResult.children).forEach((el, i) => el.style.setProperty("--i", i));
  scrollPlanResultIntoView();
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

function closestPolylineIdxLngLat(lng, lat, coords) {
  const cos = Math.cos(lat * Math.PI / 180);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const dy = (coords[i][1] - lat) * 111;
    const dx = (coords[i][0] - lng) * 111 * cos;
    const d = dx*dx + dy*dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function cumulativeRouteKm(coords) {
  const cumKm = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) {
    cumKm[i] = cumKm[i - 1] + haversine(
      { lat: coords[i - 1][1], lon: coords[i - 1][0] },
      { lat: coords[i][1], lon: coords[i][0] }
    );
  }
  return cumKm;
}

function buildPlannedRouteGeometry(routeCoords, tourStops, meta = {}) {
  const coords = (routeCoords || []).map(([lng, lat]) => [lng, lat]);
  const cumKm = cumulativeRouteKm(coords);
  const cfg = { ...currentStopsConfig(), ...(meta.stopsConfig || {}) };
  const extrasParts = meta.extras?.parts || {};
  const passStopMins = extrasParts.passStopMins || [];
  let passStopIdx = 0;
  const stops = (tourStops || [])
    .map((item, tourIndex) => ({ item, tourIndex }))
    .filter(({ item }) => Number.isFinite(item?.lat) && Number.isFinite(item?.lon))
    .map(({ item, tourIndex }) => {
      const isPoi = !!item.isPoi;
      let stopMin = 0;
      if (!isPoi) {
        const plannedMin = passStopMins[passStopIdx++];
        stopMin = Number.isFinite(plannedMin) ? plannedMin : intelligentPassStopMin(item, cfg.passStopMin || 0);
      }
      return {
        idx: closestPolylineIdxLngLat(item.lon, item.lat, coords),
        tourIndex,
        name: item.name || "Stop",
        isPoi,
        stopMin,
        dwellMin: Math.round((item.visitDwellSec || 0) / 60),
        item,
      };
    })
    .sort((a, b) => a.idx - b.idx);
  const totalDwellMin = Math.round((Number(meta.dwellH) || 0) * 60) ||
    stops.reduce((sum, s) => sum + (s.dwellMin || 0), 0);
  const start = normalizedTourPoint(
    meta.start ||
    plannedStart ||
    (typeof currentStart === "function" ? currentStart() : null)
  );

  return {
    start,
    coords,
    cumKm,
    totalKm: cumKm.length ? cumKm[cumKm.length - 1] : 0,
    driveH: Number(meta.driveH) || 0,
    stops,
    config: cfg,
    totalRestMin: Math.round((extrasParts.restH || 0) * 60),
    totalLunchMin: Math.round((extrasParts.lunchH || 0) * 60),
    totalPassStopMin: stops.reduce((sum, s) => sum + (s.stopMin || 0), 0),
    totalDwellMin,
  };
}

function drawPlannedTour(start, tourStops, latlngs, meta = {}) {
  setPlannedTourIds(tourStops.map(p => p.id));
  plannedStart = start;
  plannedRouteActive = true;
  refreshLayerControlUI();

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
  plannedRouteGeometry = buildPlannedRouteGeometry(routeCoords, tourStops, { ...meta, start });
  if (typeof window !== "undefined") window.plannedRouteGeometry = plannedRouteGeometry;
  plannedRouteFallback = fallback;
  updateMapSources();
  updatePlannedTourLayers(routeCoords, fallback);
  refreshPlanResultActions(plannedRouteGeometry);
  fitLngLatPairs(routeCoords, fallback ? 0.15 : 0.10);
  hydratePlanWeather();
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

function listNoteTextElement() {
  return noteEl?.querySelector(".listnote-text") || noteEl;
}

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
  return passesLayerControlFilter(p) && passesOpenFilter(p) && passesNotableFilter(p);
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
function syncOpenOnlyFilter(userTriggered = false) {
  syncMarkerVisibility();
  renderList(userTriggered);
  renderAdvancedPicker();
}

function renderList(userTriggered = false) {
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
      return `<li data-id="${p.id}" class="${selected ? "selected" : ""}" tabindex="0" role="button" ${advancedModeEl.checked ? `aria-pressed="${selected}"` : ''} title="${advancedModeEl.checked ? "Select this pass for the route" : "Zoom to this pass"}">
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
    if (!listEl.dataset.kbdBound) {
      listEl.dataset.kbdBound = '1';
      listEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        const li = e.target.closest('li[data-id]');
        if (!li || !listEl.contains(li)) return;
        e.preventDefault();
        lastFocusedRow = li;
        li.click();
      });
    }
    lazyLoadPassIcons(listEl);
  }

  if (userTriggered) {
    const rows = listEl.querySelectorAll("li[data-id]");
    const cap = Math.min(rows.length, 12);
    for (let i = 0; i < cap; i++) {
      rows[i].classList.add("row-staggered");
      rows[i].style.setProperty("--row-i", i);
    }
  }

  const noteText = listNoteTextElement();
  if (noteText) {
    noteText.textContent = useSearch
      ? `${total} ${filterTag}match${total === 1 ? "" : "es"}${total > VIEW_LIMIT ? ` (showing first ${VIEW_LIMIT})` : ""}`
      : `${total} ${filterTag}in view${total > VIEW_LIMIT ? ` (showing first ${VIEW_LIMIT})` : ""} · ${PASSES.filter(passesAllFilters).length} ${filterTag}total`;
  }
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
  /* Regions in canonical Alpine-Passes order (matches per-country POI file headers). */
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
  if (!poiLayerControlFilter(p)) return false;
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

function renderPoiList(userTriggered = false) {
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
      return `<li data-poi-id="${escapeHtml(p.id)}" class="poi-row${selected ? " selected" : ""}${notDrivable ? " not-drivable" : ""}" tabindex="0" role="button" ${advanced ? `aria-pressed="${selected}"` : ''} title="${escapeHtml(titleAttr)}">
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
    if (!poiListEl.dataset.kbdBound) {
      poiListEl.dataset.kbdBound = '1';
      poiListEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        const li = e.target.closest('li[data-poi-id]');
        if (!li || !poiListEl.contains(li)) return;
        e.preventDefault();
        lastFocusedRow = li;
        li.click();
      });
    }
  }

  if (userTriggered) {
    const rows = poiListEl.querySelectorAll("li[data-poi-id]");
    const cap = Math.min(rows.length, 12);
    for (let i = 0; i < cap; i++) {
      rows[i].classList.add("row-staggered");
      rows[i].style.setProperty("--row-i", i);
    }
  }

  /* Update tab counters: passes total reflects passes-in-view count;
     POI total reflects the POI list. */
  if (tabCountPois) {
    tabCountPois.textContent = `· ${total}${total > VIEW_LIMIT ? `+` : ""}`;
  }

  /* When the POI tab is active, mirror noteEl text to the POI footnote. */
  if (activeExplorerTab === "pois") {
    const noteText = listNoteTextElement();
    if (noteText) {
      noteText.textContent = useSearch
        ? `${total} match${total === 1 ? "" : "es"}${total > VIEW_LIMIT ? ` (showing first ${VIEW_LIMIT})` : ""}`
        : `${total} in view${total > VIEW_LIMIT ? ` (showing first ${VIEW_LIMIT})` : ""} · ${POIS.length} total`;
    }
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
    const m = listNoteTextElement()?.textContent.match(/^(\d+)/);
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

poiSearchEl?.addEventListener("input", () => { renderPoiList(true); syncPoiMarkerVisibility(); });
poiSortEl?.addEventListener("change", () => renderPoiList(true));
poiCatFilterEl?.addEventListener("change", () => { renderPoiList(true); syncPoiMarkerVisibility(); });
poiRegionFilterEl?.addEventListener("change", () => { renderPoiList(true); syncPoiMarkerVisibility(); });
poiPlannableOnlyEl?.addEventListener("change", () => { renderPoiList(true); syncPoiMarkerVisibility(); });
poiTopOnlyEl?.addEventListener("change", () => { renderPoiList(true); syncPoiMarkerVisibility(); });

searchEl.addEventListener("input", () => renderList(true));
sortEl  .addEventListener("change", () => renderList(true));
sortOpenFirstEl.addEventListener("change", () => renderList(true));
startSel.addEventListener("change", () => renderList(true));
showOpenOnlyEl.addEventListener("change", () => syncOpenOnlyFilter(true));
showNotableOnlyEl.addEventListener("change", () => syncOpenOnlyFilter(true));

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

function restoreTourFromHash() {
  try {
    const hash = window.location.hash || "";
    const m = hash.match(/^#tour=(.+)$/);
    if (!m) return;

    const params = new URLSearchParams(m[1]);
    const startStr = params.get("start");
    if (!startStr) return;

    const [latStr, lonStr] = startStr.split(",");
    const lat = Number(latStr);
    const lon = Number(lonStr);
    if (!validStartCoords(lat, lon)) return;

    const startName = params.get("startName") || `Tour start (${lat.toFixed(3)}, ${lon.toFixed(3)})`;
    applyCustomStart(startName, lat, lon);

    const stopsRaw = params.get("stops") || "";
    const stopIds = stopsRaw.split(",").filter(Boolean);

    if (stopIds.length) {
      if (advancedModeEl && !advancedModeEl.checked) {
        advancedModeEl.checked = true;
        syncAdvancedMode();
      }

      let added = 0;
      for (const id of stopIds) {
        if (PASS_BY_ID.has(id)) {
          toggleSelectedPass(id, true);
          added++;
        } else if (POI_BY_ID.has(id) && (typeof PLANNABLE_POI_IDS === "undefined" || PLANNABLE_POI_IDS.has(id))) {
          toggleSelectedPoi(id, true);
          added++;
        }
      }

      if (added > 0 && typeof planTour === "function") {
        setTimeout(async () => {
          try {
            await planTour();
            setTimeout(scrollPlanResultIntoView, 150);
          } catch (e) {
            console.warn("[alpine] tour-restore planTour failed", e);
          }
        }, 100);
      }
    }

    const planTabRadio = document.getElementById("sidebarTabPlan");
    if (planTabRadio && !planTabRadio.checked) {
      planTabRadio.checked = true;
      planTabRadio.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } catch (e) {
    console.warn("[alpine] restoreTourFromHash error", e);
  }
}

renderList();
restoreTourFromHash();
window.addEventListener("hashchange", () => {
  if (window.location.hash.startsWith("#tour=")) {
    restoreTourFromHash();
  }
});
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

/* ====================================================================
   iter-1 polish: tabs / interactions / reveal / baseline
   ==================================================================== */

/* ── FIX 1: Sliding tab indicator ────────────────────────────────────
   Measures the active label/button inside a tab strip and writes
   --tab-x / --tab-w on the strip element so the CSS ::before pill
   slides to the correct position. */
function syncTabIndicator(strip, itemSel, isActiveFn) {
  const items  = Array.from(strip.querySelectorAll(itemSel));
  const active = items.find(isActiveFn);
  if (!active) return;
  const sr = strip.getBoundingClientRect();
  const ar = active.getBoundingClientRect();
  strip.style.setProperty('--tab-x', (ar.left - sr.left) + 'px');
  strip.style.setProperty('--tab-w', ar.width + 'px');
}

function syncSidebarTabIndicator() {
  const strip = document.querySelector('.sidebar-tab-strip');
  if (!strip) return;
  syncTabIndicator(strip, '.sidebar-tab', label => {
    const id = label.getAttribute('for');
    return id ? !!document.getElementById(id)?.checked : false;
  });
}

function syncExplorerTabIndicator() {
  const strip = document.querySelector('.explorer-tabs');
  if (!strip) return;
  syncTabIndicator(strip, '.explorer-tab', btn => btn.classList.contains('active'));
}

/* Listen for radio changes on the sidebar tabs */
document.querySelectorAll('.sidebar-tab-radio').forEach(radio => {
  radio.addEventListener('change', () => requestAnimationFrame(syncSidebarTabIndicator));
});

/* Wrap showExplorerTab to keep the sub-tab pill in sync */
{
  const _setForIndicator = showExplorerTab;
  showExplorerTab = function () {
    _setForIndicator.apply(this, arguments);
    requestAnimationFrame(syncExplorerTabIndicator);
  };
}

window.addEventListener('resize', () => {
  syncSidebarTabIndicator();
  syncExplorerTabIndicator();
});
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    syncSidebarTabIndicator();
    syncExplorerTabIndicator();
  });
}
/* Initial sync (script is defer — DOM is ready) */
syncSidebarTabIndicator();
syncExplorerTabIndicator();

/* Re-sync the sub-tab pill whenever the Browse panel becomes visible.
   On first activation the panel transitions from display:none so the
   initial syncExplorerTabIndicator() above measured zero dimensions. */
const _browseRadio = document.getElementById('sidebarTabBrowse');
if (_browseRadio) {
  _browseRadio.addEventListener('change', () => requestAnimationFrame(syncExplorerTabIndicator));
}

/* ── FIX 3: Staggered reveal ─────────────────────────────────────────
   An IntersectionObserver adds .is-in to .reveal elements as they
   scroll into the sidebar viewport.  Under prefers-reduced-motion the
   class is added immediately so nothing stays invisible. */
const _revealRoot          = document.querySelector('.sidebar-scroll') || null;
const _prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const _revealObserver = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          _revealObserver.unobserve(entry.target);
        }
      });
    }, { root: _revealRoot, threshold: 0.05 })
  : null;

let _revealFallback = null;

function armReveal(container) {
  clearTimeout(_revealFallback);
  const pending = Array.from(container.querySelectorAll('.reveal:not(.is-in)'));
  if (!pending.length) return;
  if (_prefersReducedMotion || !_revealObserver) {
    pending.forEach(el => el.classList.add('is-in'));
    return;
  }
  pending.forEach(el => _revealObserver.observe(el));
  /* Safety net: ensure nothing stays invisible if the observer is slow */
  _revealFallback = setTimeout(() => {
    container.querySelectorAll('.reveal:not(.is-in)').forEach(el => el.classList.add('is-in'));
  }, 600);
}

/* Add reveal to static planner cards */
document.querySelectorAll('.planner-card, .planner-intro').forEach((el, i) => {
  el.classList.add('reveal');
  el.style.setProperty('--reveal-delay', i * 60 + 'ms');
});
if (_revealRoot) armReveal(_revealRoot);

/* Wrap renderList to stagger the pass rows */
{
  const _rl_reveal = renderList;
  renderList = function () {
    _rl_reveal.apply(this, arguments);
    const listEl = document.getElementById('passList');
    if (!listEl) return;
    listEl.querySelectorAll('li[data-id]').forEach((el, i) => {
      el.classList.add('reveal');
      el.style.setProperty('--reveal-delay', (i % 20) * 30 + 'ms');
    });
    armReveal(listEl);
  };
}

/* Wrap renderPoiList to stagger the POI rows */
{
  const _rpl_reveal = renderPoiList;
  renderPoiList = function () {
    _rpl_reveal.apply(this, arguments);
    const poiListEl = document.getElementById('poiList');
    if (!poiListEl) return;
    poiListEl.querySelectorAll('li[data-poi-id]').forEach((el, i) => {
      el.classList.add('reveal');
      el.style.setProperty('--reveal-delay', (i % 20) * 30 + 'ms');
    });
    armReveal(poiListEl);
  };
}

/* ====================================================================
   iter-4 polish: sticky toolbar / status chip / mobile pill / motion
   ==================================================================== */

/* ── FIX 1: Sticky browse toolbar scroll-elevation ──────────────────
   rAF-throttled scroll listener; detects mobile vs desktop scroller by
   checking getComputedStyle(.sidebar-scroll).overflowY === 'visible'. */
{
  const _ss4     = document.querySelector('.sidebar-scroll');
  let   _elevRaf = null;

  function _setElevation(scrollTop) {
    const elevated = scrollTop > 4;
    document.querySelectorAll('#sidebarPanelBrowse .controls').forEach(c => {
      c.classList.toggle('is-elevated', elevated);
    });
  }

  function _readScrollTop() {
    if (!_ss4) return 0;
    const isMobile = getComputedStyle(_ss4).overflowY === 'visible';
    return isMobile ? (window.scrollY || 0) : _ss4.scrollTop;
  }

  function _onScroll4() {
    if (_elevRaf) return;
    _elevRaf = requestAnimationFrame(() => {
      _elevRaf = null;
      _setElevation(_readScrollTop());
    });
  }

  if (_ss4) _ss4.addEventListener('scroll', _onScroll4, { passive: true });
  window.addEventListener('scroll', _onScroll4, { passive: true });
  window.addEventListener('resize', _onScroll4, { passive: true });
  /* initial state */
  _setElevation(_readScrollTop());
}

/* ── FIX 2: Status chip helper + inject into pass rows ──────────────
   renderStatusChip() replaces the plain SVG status-icon span in each
   pass list row with a colored pill (dot + label + aria). */
function renderStatusChip(state, estimated) {
  const map = { open: 'Open', restricted: 'Restricted', closed: 'Closed' };
  const s   = map[state] ? state : 'unknown';
  const baseLabel = map[s] || 'Unknown';
  const label     = estimated ? `~${baseLabel}` : baseLabel;
  const cls = `status-chip status-chip--${s}${estimated ? ' status-chip--est' : ''}`;
  const aria = `Status: ${estimated ? 'likely ' : ''}${baseLabel.toLowerCase()}`;
  return `<span class="${cls}" role="status" aria-label="${aria}"><span class="status-chip__dot" aria-hidden="true"></span>${label}</span>`;
}

{
  const _rl_chip = renderList;
  renderList = function () {
    _rl_chip.apply(this, arguments);
    const listEl = document.getElementById('passList');
    if (!listEl) return;
    listEl.querySelectorAll('li[data-id]').forEach(li => {
      const p = PASSES.find(x => x.id === li.dataset.id);
      if (!p) return;
      const sv = statusDisplay(passStatus(p));
      const chip = renderStatusChip(sv.state, sv.estimated);
      const si = li.querySelector('.status-icon');
      if (si) si.outerHTML = chip;
    });
  };
}

/* ── FIX 3: Mobile compact status pill ──────────────────────────────
   Fixed bottom-center pill (open/restricted/closed counts).
   Populated via MutationObserver on #updatedText so it stays in sync
   with the live-data IIFE without modifying its async closure. */
function _ensureStatusPill() {
  if (document.querySelector('.status-pill')) return;
  const el = document.createElement('div');
  el.className   = 'status-pill';
  el.role        = 'status';
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
}

function _updateStatusPill() {
  const pill = document.querySelector('.status-pill');
  if (!pill) return;
  let nOpen = 0, nRestricted = 0, nClosed = 0;
  PASSES.forEach(p => {
    const st = statusDisplay(p._status || {}).state;
    if      (st === 'open')       nOpen++;
    else if (st === 'restricted') nRestricted++;
    else if (st === 'closed')     nClosed++;
  });
  pill.innerHTML =
    `<span class="sp-item sp-open"><span class="sp-dot"></span>${nOpen}</span>` +
    `<span class="sp-item sp-restricted"><span class="sp-dot"></span>${nRestricted}</span>` +
    `<span class="sp-item sp-closed"><span class="sp-dot"></span>${nClosed}</span>`;
}

_ensureStatusPill();
/* Observe #updatedText — fires once live data arrives */
{
  const _utEl = document.getElementById('updatedText');
  if (_utEl) {
    new MutationObserver(_updateStatusPill)
      .observe(_utEl, { characterData: true, childList: true, subtree: true });
  }
}
/* Also refresh pill whenever the pass list re-renders */
{
  const _rl_pill = renderList;
  renderList = function () {
    _rl_pill.apply(this, arguments);
    _updateStatusPill();
  };
}

/* ── FIX 4: Reload spin + row :active + count tween ─────────────────
   Reload: capture-phase listener adds .is-busy before location.reload().
   Count tween: rAF interpolation over 250ms on noteEl after renderList. */

/* Reload spin — capture phase fires before existing bubble listener */
{
  const _rb = document.getElementById('refreshBtn');
  if (_rb) {
    _rb.addEventListener('click', function () {
      this.classList.add('is-busy');
    }, true /* capture */);
  }
}

/* Count tween — wrap renderList, interpolate the leading integer */
{
  let _tweenRaf = null;
  const _rl_tween = renderList;
  renderList = function () {
    const oldNoteText = listNoteTextElement();
    const oldText = oldNoteText ? oldNoteText.textContent : '';
    _rl_tween.apply(this, arguments);
    const newNoteText = listNoteTextElement();
    if (!newNoteText || _prefersReducedMotion) return;
    const newText = newNoteText.textContent;
    if (oldText === newText) return;
    const oldN = parseInt(oldText, 10);
    const newN = parseInt(newText, 10);
    if (isNaN(newN) || isNaN(oldN) || oldN === newN) return;
    const suffix = newText.replace(/^\d+/, '');
    if (_tweenRaf) cancelAnimationFrame(_tweenRaf);
    const startT = performance.now();
    const dur    = 250;
    const step   = (ts) => {
      const t   = Math.min((ts - startT) / dur, 1);
      const cur = Math.round(oldN + (newN - oldN) * t);
      newNoteText.textContent = cur + suffix;
      if (t < 1) { _tweenRaf = requestAnimationFrame(step); }
      else        { _tweenRaf = null; }
    };
    _tweenRaf = requestAnimationFrame(step);
  };
}

/* ====================================================================
   iter-5 polish: skeleton shimmer / popup loading / scrollbar
   ==================================================================== */

/* ── FIX 2: bindPopupImage — attach load/error to .popup-img-wrap ── */
function bindPopupImage(wrap) {
  const img = wrap.querySelector('img.popup-img');
  if (!img) return;
  const markLoaded = () => { wrap.classList.remove('is-loading','is-error'); wrap.classList.add('is-loaded'); };
  const markError  = () => { wrap.classList.remove('is-loading','is-loaded'); wrap.classList.add('is-error'); };
  if (!img.getAttribute('src')) { markError(); return; }
  if (img.complete && img.naturalWidth === 0) { markError(); return; }
  if (img.complete && img.naturalWidth > 0) { markLoaded(); return; }
  img.addEventListener('load',  markLoaded, { once: true });
  img.addEventListener('error', markError,  { once: true });
}

/* ── FIX 1: Skeleton rows ────────────────────────────────────────── */
function renderPassSkeletons(n = 6) {
  const list = document.getElementById('passList');
  if (!list) return;
  list.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const li = document.createElement('li');
    li.className = 'pass-skeleton';
    li.style.setProperty('--skel-delay', (i * -120) + 'ms');
    li.innerHTML = `<span class="sk-dot skeleton"></span>
      <div class="sk-lines">
        <span class="sk-title skeleton"></span>
        <span class="sk-meta skeleton"></span>
      </div>`;
    list.appendChild(li);
  }
}

/* Wrap renderList: refreshing state + is-entering stagger on new rows */
{
  let _skelFirst5 = true;
  const _rl_skel5 = renderList;
  renderList = function () {
    const list = document.getElementById('passList');
    if (list && !_skelFirst5) {
      list.dataset.state = 'refreshing';
    }
    _skelFirst5 = false;
    _rl_skel5.apply(this, arguments);
    if (!list) return;
    requestAnimationFrame(() => { delete list.dataset.state; });
    list.querySelectorAll('li[data-id]').forEach((li, i) => {
      li.classList.add('is-entering');
      li.style.setProperty('--i', i % 20);
      li.addEventListener('animationend', () => li.classList.remove('is-entering'), { once: true });
    });
  };
}

/* Issue 3 fix: search/sort addEventListener calls captured the original renderList
   reference before the wrapper above was applied, so they bypass the wrapper.
   A MutationObserver decouples the .is-entering stagger from the call site —
   any code that modifies #passList children (old or new renderList) gets the effect. */
{
  const _passListEl = document.getElementById('passList');
  if (_passListEl) {
    const _passMO = new MutationObserver(() => {
      if (_passListEl.querySelector('.pass-skeleton')) return; // skip skeleton phase
      _passListEl.querySelectorAll('li[data-id]').forEach((li, i) => {
        if (li.classList.contains('is-entering')) return; // wrapper already applied it
        li.classList.add('is-entering');
        li.style.setProperty('--i', i % 20);
        li.addEventListener('animationend', () => li.classList.remove('is-entering'), { once: true });
      });
    });
    _passMO.observe(_passListEl, { childList: true });
  }
}

/* ====================================================================
   iter-6 polish: popup positioning + disclosure + score labels
   ==================================================================== */

/* ── Delegated disclosure toggle ──────────────────────────────────── */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.disclosure');
  if (!btn) return;
  const open = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!open));
});

/* ====================================================================
   iter-7 polish: body stagger / close exit / picker slide / spacing
   ==================================================================== */

/* ── FIX 1: applyBodyStagger ─────────────────────────────────────── */
function applyBodyStagger(popupEl) {
  const body = popupEl ? popupEl.querySelector('.popup-body') : null;
  if (!body) return;
  const kids = Array.from(body.children);
  const n = kids.length || 1;
  const step = Math.max(24, Math.min(40, Math.floor(320 / n)));
  body.style.setProperty('--stagger-step', step + 'ms');
  kids.forEach((el, i) => el.style.setProperty('--stagger-i', Math.min(i, 9)));
  body.classList.remove('ap-body-stagger');
  void body.offsetWidth;
  body.classList.add('ap-body-stagger');
  setTimeout(() => body.classList.remove('ap-body-stagger'), 120 + 9 * 40 + 240 + 80);
}

/* ── FIX 2: wrapPopupClose + generation counter ──────────────────── */
let _popupOpenGen = 0;

function wrapPopupClose(popup) {
  const origRemove = popup.remove.bind(popup);
  let closing = false;
  popup.remove = function() {
    if (closing) return origRemove();
    const el = popup.getElement && popup.getElement();
    if (!el) return origRemove();
    closing = true;
    el.classList.add('ap-popup--closing');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(origRemove, reduced ? 120 : 180);
  };
}

/* ====================================================================
   iter-9 polish: a11y / keyboard / focus
   ==================================================================== */

/* ── FIX 2: Escape key closes active popup ───────────────────────────── */
if (!window.__escClosePopupBound) {
  window.__escClosePopupBound = true;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activePopup) {
      e.stopPropagation();
      try { activePopup.remove(); } catch (_) {}
    }
  });
}
