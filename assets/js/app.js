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
  const sourceLabel = d.sourceLabel ? ` <span class="source-label">${escapeHtml(d.sourceLabel)}</span>` : "";
  return `<span class="src-badge ${d.sourceMeta.className}" title="${escapeHtml(d.sourceMeta.title)}">● ${escapeHtml(d.sourceMeta.label)}</span>${sourceLabel}`;
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
    /* Keep the WebGL basemap close to Leaflet's marker-pane frame rate.
       The bridge default is 32 ms, which makes markers visibly outrun
       the vector canvas during drag/wheel interactions. */
    updateInterval: 16,
    padding: 0.25,
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
function makeMarkerIcon(statusOrState, badgeNumber = null, estimated = false) {
  const cls = typeof statusOrState === "string"
    ? `${statusOrState}${estimated ? " estimated" : ""}`
    : statusDisplay(statusOrState).className;
  const badge = badgeNumber != null ? `<div class="tour-badge">${badgeNumber}</div>` : "";
  return L.divIcon({
    className: "",
    html: `<div class="pass-marker-wrap"><div class="pass-marker ${cls}">${iconSvg("alpine-status", "marker-icon")}</div>${badge}</div>`,
    iconSize: [24, 24], iconAnchor: [12, 12],
  });
}

const passCluster = L.markerClusterGroup({
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
  maxClusterRadius: 50,
  disableClusteringAtZoom: 11,
  chunkedLoading: true,
});
map.addLayer(passCluster);

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
      (statusView.detail ? ` <span class="sub status-detail">${escapeHtml(statusView.detail)}</span>` : "") +
      ` <span class="popup-source">${sourceBadgeHtml(status)}</span>`
    : `<span class="badge unknown">Loading…</span>`;
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
  const linkParts = [];
  if (passDetail) linkParts.push(`<a href="${passDetail}" target="_blank" rel="noopener">↗ alpen-paesse.ch</a>`);
  linkParts.push(`<a href="${wikiHref}" target="_blank" rel="noopener">↗ Wikipedia</a>`);

  return `<div class="popup">${img}
    <div class="popup-body">
      <div class="popup-title">
        <h2>${p.name}</h2>
        ${qualityStars(p.quality)}
      </div>
      <div class="popup-headline">
        <span class="popup-elev">${p.elev} m</span>
        ${p.alt ? `<span class="popup-alt">${escapeHtml(p.alt)}</span>` : ""}
      </div>
      <div class="popup-status">${stateLine}</div>
      ${metaBlock}
      ${projectionBlock}
      ${openingBlock}
      ${historyBlock}
      ${tldrBlock}
      ${whyBlock}
      ${info}
      ${camsBlock}
      <div class="popup-links">${linkParts.join("")}</div>
    </div></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
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
      m._popupBuilt = true;
    }
    const wiki = await fetchWiki(p.wikiTitle, p.wikiLang);
    m.setPopupContent(buildPopupHtml(p, passStatus(p), wiki));
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

/* ───────────────────────── preset routes (CH) ───────────────────────── */
const ROUTES = [
  { id: "three-pass", name: "Drei-Pässe-Tour", short: "3 passes",
    summary: "The Swiss alpine classic — Susten · Grimsel · Furka.", color: "#ff9f1c",
    passes: ["sustenpass", "grimselpass", "furkapass"],
    waypoints: [[47.0502,8.3093],[46.7081,8.5993],[46.7283,8.4458],[46.7060,8.2275],
                [46.5614,8.3372],[46.5714,8.3739],[46.5722,8.4147],[46.6122,8.4914],
                [46.6364,8.5942],[47.0502,8.3093]] },
  { id: "four-pass", name: "Vier-Pässe-Tour", short: "4 passes",
    summary: "Three-Pass + Gotthard via the cobbled Tremola road.", color: "#e63946",
    passes: ["sustenpass", "grimselpass", "furkapass", "gotthardpass"],
    waypoints: [[47.0502,8.3093],[46.7081,8.5993],[46.7283,8.4458],[46.7060,8.2275],
                [46.5614,8.3372],[46.5714,8.3739],[46.5722,8.4147],[46.6122,8.4914],
                [46.6364,8.5942],[46.6202,8.5675],[46.5550,8.5642],[46.5294,8.6097],
                [46.7081,8.5993],[47.0502,8.3093]] },
  { id: "klausen-pragel", name: "Klausen + Pragel", short: "Eastern loop",
    summary: "Quiet, technical and beautiful — Klausenpass east, Pragelpass back.", color: "#4cc9f0",
    passes: ["klausenpass", "pragelpass"],
    waypoints: [[47.0502,8.3093],[46.8800,8.6422],[46.8725,8.7717],[46.8694,8.8556],
                [46.8847,8.9094],[46.9197,8.9881],[46.9856,8.8533],[46.9750,8.7625],
                [47.0207,8.6533],[47.0502,8.3093]] },
  { id: "bruenig-glaubenbielen", name: "Brünig + Glaubenbielen", short: "Panoramastrasse",
    summary: "Gentler scenic loop through Obwalden + Entlebuch's Panoramastrasse.", color: "#2ec4b6",
    passes: ["bruenigpass", "glaubenbielenpass"],
    waypoints: [[47.0502,8.3093],[46.8954,8.2453],[46.7833,8.1633],[46.7634,8.1413],
                [46.7269,8.1856],[46.7634,8.1413],[46.8333,8.1869],[46.7989,8.0625],
                [46.8164,8.0381],[46.9528,8.0214],[46.9919,8.0639],[47.0502,8.3093]] },
];

const overlayLayers = {};
ROUTES.forEach(r => {
  const lg = L.layerGroup();
  lg.__route = r; lg.__loaded = false;
  overlayLayers[
    `<span class="route-layer-swatch route-${r.id}"></span>` +
    `${r.name} <span class="route-layer-meta">· ${r.short}</span>`
  ] = lg;
});
L.control.layers(baseLayers, overlayLayers, { position: "topright", collapsed: true }).addTo(map);
map.on("overlayadd", e => { if (e.layer.__route && !e.layer.__loaded) drawRoute(e.layer); });

const ROUTE_TTL = 30 * 24 * 60 * 60 * 1000;
async function drawRoute(layer) {
  layer.__loaded = true;
  const r = layer.__route;
  let geom = null, stats = null, fallback = false;
  try {
    const coords = r.waypoints.map(([la,lo]) => `${lo},${la}`).join(";");
    const out = await osrmRoute(coords);
    geom = out.geom;
    stats = { distanceKm: out.distanceKm, durationH: out.durationH };
  } catch (e) { console.warn("OSRM failed for", r.id, e); }
  if (!geom) { geom = r.waypoints.map(([la,lo]) => [lo,la]); fallback = true; }
  const latlngs = geom.map(([lo, la]) => [la, lo]);
  const passNames = r.passes.map(slug => PASSES.find(p => p.slug === slug)?.name).filter(Boolean).join(" → ");
  layer.addLayer(L.polyline(latlngs, { color:"#000", weight:11, opacity:0.45, lineCap:"round", lineJoin:"round" }));
  layer.addLayer(L.polyline(latlngs, { color:"#fff", weight:7,  opacity:0.90, lineCap:"round", lineJoin:"round" }));
  const main = L.polyline(latlngs, { color:r.color, weight:5, opacity:1, lineCap:"round", lineJoin:"round" });
  layer.addLayer(main);
  const statsLine = stats ? `${stats.distanceKm} km · ~${stats.durationH} h driving`
                          : (fallback ? "approximate (router unavailable)" : "");
  main.bindTooltip(
    `<div class="route-tooltip-name route-${r.id}">${r.name}</div>
     <div class="route-tooltip-stats">${statsLine}</div>`,
    { sticky:true, direction:"top", className:"route-tt" });
  main.bindPopup(
    `<div class="popup-body route-popup-body route-${r.id}">
       <h2>${r.name}</h2>
       <div class="sub">${r.summary}</div>
       <div class="popup-meta">${statsLine}</div>
       <div class="popup-meta">Passes: ${passNames}</div>
       ${fallback ? '<div class="popup-meta warning">Routing API unavailable.</div>' : ''}
     </div>`, { maxWidth: 280 });
}

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
const planRunBtn = document.getElementById("planRun");
const planResult = document.getElementById("planResult");
const planPickBtn= document.getElementById("planPick");
const advancedModeEl = document.getElementById("planAdvanced");
const advancedPlannerEl = document.getElementById("advancedPlanner");
const advancedPassSearchEl = document.getElementById("planPassSearch");
const advancedPassPickerEl = document.getElementById("planPassPicker");
const selectedPassesEl = document.getElementById("selectedPasses");
const selectedPassCountEl = document.getElementById("selectedPassCount");
const clearSelectedPassesBtn = document.getElementById("clearSelectedPasses");
const advancedPlannerNoteEl = document.getElementById("advancedPlannerNote");
const ADVANCED_MAX_PASSES = 10;
const ADVANCED_PICKER_LIMIT = 100;
const selectedPassIds = new Set();

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
function selectedAdvancedPasses() {
  return [...selectedPassIds].map(id => PASS_BY_ID.get(id)).filter(p => p?.baseA && p?.baseB);
}
function advancedDefaultNote() {
  const count = selectedPassIds.size;
  return count === 0
    ? "Advanced mode optimizes the shortest loop through every selected pass and returns to the start."
    : `Selected route will visit all ${count} pass${count === 1 ? "" : "es"} in the shortest optimized order.`;
}
function setAdvancedNote(message = advancedDefaultNote(), warn = false) {
  advancedPlannerNoteEl.textContent = message;
  advancedPlannerNoteEl.classList.toggle("warn", warn);
}
function passPickerMatches(p, q) {
  if (!q) return true;
  return `${p.name} ${p.alt || ""}`.toLowerCase().includes(q);
}
function renderAdvancedSelection() {
  const selected = selectedAdvancedPasses();
  selectedPassCountEl.textContent = String(selected.length);
  selectedPassesEl.classList.toggle("empty", selected.length === 0);
  selectedPassesEl.innerHTML = selected.length
    ? selected.map(p => `
      <span class="selected-pass-chip">
        <span title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <button type="button" data-remove-id="${escapeHtml(p.id)}" aria-label="Remove ${escapeHtml(p.name)}">×</button>
      </span>`).join("")
    : "No passes selected.";
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
    const disabled = !selected && selectedPassIds.size >= ADVANCED_MAX_PASSES;
    const status = passStatus(p);
    const label = listStatusLabel(status);
    const source = statusDisplay(status).sourceMeta.label;
    return `<label class="pass-picker-row${selected ? " selected" : ""}">
      <input type="checkbox" value="${escapeHtml(p.id)}"${selected ? " checked" : ""}${disabled ? " disabled" : ""}>
      <span>
        <span class="pass-picker-name">${escapeHtml(p.name)} ${qualityStarsCompact(p.quality)}</span>
        <span class="pass-picker-meta">${p.elev} m · ${escapeHtml(label)} · ${escapeHtml(source)}</span>
      </span>
    </label>`;
  }).join("") + (items.length > shown.length
    ? `<div class="pass-picker-empty">${items.length - shown.length} more match${items.length - shown.length === 1 ? "" : "es"} — keep typing to narrow.</div>`
    : "");
}
function toggleSelectedPass(id, checked = !selectedPassIds.has(id)) {
  const p = PASS_BY_ID.get(id);
  if (!p?.baseA || !p?.baseB) return;
  if (checked) {
    if (!selectedPassIds.has(id) && selectedPassIds.size >= ADVANCED_MAX_PASSES) {
      renderAdvancedPicker();
      setAdvancedNote(`Advanced mode supports up to ${ADVANCED_MAX_PASSES} passes at once. Clear one before adding another.`, true);
      return;
    }
    selectedPassIds.add(id);
  } else {
    selectedPassIds.delete(id);
  }
  renderAdvancedSelection();
  renderAdvancedPicker();
  if (typeof renderList === "function") renderList();
}
function syncAdvancedMode() {
  const advanced = advancedModeEl.checked;
  advancedPlannerEl.hidden = !advanced;
  distSlider.disabled = advanced;
  openOnlyEl.disabled = advanced;
  distSlider.closest("label")?.classList.toggle("disabled", advanced);
  openOnlyEl.closest("label")?.classList.toggle("disabled", advanced);
  resetPlanButton();
  renderAdvancedSelection();
  renderAdvancedPicker();
  if (typeof renderList === "function") renderList();
}

distSlider.addEventListener("input", () => { distLabel.textContent = `${distSlider.value} km`; });
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
clearSelectedPassesBtn.addEventListener("click", () => {
  selectedPassIds.clear();
  renderAdvancedSelection();
  renderAdvancedPicker();
  renderList();
});

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
    const p = PASSES.find(x => x.id === id);
    if (p && p._marker) {
      updatePassMarkerIcon(p);
      p._marker.setZIndexOffset(0);
    }
  });
}

async function fetchTable(points) {
  const coords = points.map(p => `${p.lon},${p.lat}`).join(";");
  return osrmTable(coords);
}

/* ───────────────────── OSRM caching helpers ─────────────────────
   Repeat tour-plans with the same start + candidates (or repeat preset-route
   toggles) hit OSRM unnecessarily.  Cache table + route results in
   localStorage keyed by a short hash of the coordinate string.  TTLs are
   long because road networks rarely change. */
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
     PASS_QUALITY_POWER  exponent on per-visit raw quality. >1 emphasises
                         individual pass quality over headcount.
     PASS_PER_VISIT_COST flat cost subtracted per pass. Sub-median passes
                         contribute negatively, so they only get added
                         when they meaningfully fill out a tour. */
const PASS_QUALITY_POWER = 3;
const PASS_PER_VISIT_COST = 1.0;

function bestTourGated(matrix, N, targetKm, tolerance, maxPasses, passQ) {
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
    const raw = enterSide === exitSide
      ? q.qApproach + q.qSummit       // out-and-back: one approach + summit
      : 2 * q.qApproach + q.qSummit;  // traversal: both approaches + summit
    /* Cube transform + per-pass cost so the planner stops stuffing the
       route with low-quality filler. Without this, traceQuality is a
       pure sum of raw quality and an extra mediocre pass *always* lifts
       the score, leading to e.g. five Pre-Alps cols beating one Klausen.
       The cube emphasises individual pass quality (a 0.9-quality pass is
       ~3× more valuable than a 0.6-quality pass instead of 1.5×); the
       constant cost makes a sub-median pass hurt the tour score. */
    return Math.pow(raw, PASS_QUALITY_POWER) - PASS_PER_VISIT_COST;
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
          const closeness = -Math.abs(total - targetKm * 1000) / 1000;
          const score = traceQ * 1e6 + closeness;
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

  /* Total duration along the chosen tour. */
  const dur = matrix.dur;
  let totalS = 0, prevIdx = 0;
  for (const t of tour) {
    const enterIdx = t.enterSide === 0 ? baseA(t.passIdx) : baseB(t.passIdx);
    const exitIdx  = t.exitSide  === 0 ? baseA(t.passIdx) : baseB(t.passIdx);
    totalS += dur[prevIdx][enterIdx];
    totalS += visitDur(t.passIdx, t.enterSide, t.exitSide);
    prevIdx = exitIdx;
  }
  totalS += dur[prevIdx][0];

  return {
    perm: tour,
    km: sol.total / 1000,
    h: totalS / 3600,
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
function bestExactSelectedTour(matrix, N, passQ) {
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
    return enterSide === exitSide
      ? q.qApproach + q.qSummit
      : 2 * q.qApproach + q.qSummit;
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

  let totalS = 0, totalQuality = 0, prevIdx = 0;
  for (const t of tour) {
    const enterIdx = sideIdx(t.passIdx, t.enterSide);
    const exitIdx = sideIdx(t.passIdx, t.exitSide);
    totalS += matrixValue(dur, prevIdx, enterIdx);
    totalS += visitDur(t.passIdx, t.enterSide, t.exitSide);
    totalQuality += visitQuality(t.passIdx, t.enterSide, t.exitSide);
    prevIdx = exitIdx;
  }
  totalS += matrixValue(dur, prevIdx, 0);

  return {
    perm: tour,
    km: bestTotal / 1000,
    h: totalS / 3600,
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

function plannerPointsForPasses(start, passes) {
  const points = [start];
  passes.forEach(p => {
    points.push({ lat: p.baseA.lat, lon: p.baseA.lon });
    points.push({ lat: p.lat,        lon: p.lon       });
    points.push({ lat: p.baseB.lat, lon: p.baseB.lon });
  });
  return points;
}

function waypointsForTour(start, passes, perm) {
  const waypoints = [[start.lat, start.lon]];
  perm.forEach(t => {
    const p = passes[t.passIdx];
    const enter = t.enterSide === 0 ? p.baseA : p.baseB;
    const exit  = t.exitSide  === 0 ? p.baseA : p.baseB;
    waypoints.push([enter.lat, enter.lon]);
    waypoints.push([p.lat, p.lon]);
    waypoints.push([exit.lat, exit.lon]);
  });
  waypoints.push([start.lat, start.lon]);
  return waypoints;
}

function coordsFromWaypoints(waypoints) {
  return waypoints.map(([la, lo]) => `${lo},${la}`).join(";");
}

function advancedStatusWarning(tourPasses) {
  const flagged = tourPasses.filter(p => {
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

  const selected = selectedAdvancedPasses();
  if (selected.length === 0) {
    showPlanResult({ error: "Select at least one pass for advanced planning." });
    return;
  }
  if (selected.length > ADVANCED_MAX_PASSES) {
    showPlanResult({ error: `Select no more than ${ADVANCED_MAX_PASSES} passes at once.` });
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
  const result = bestExactSelectedTour(matrix, selected.length, passQ);
  if (!result) {
    resetPlanButton();
    showPlanResult({ error: "No route found through the selected passes." });
    return;
  }

  const tourPasses = result.perm.map(t => selected[t.passIdx]);
  const waypoints = waypointsForTour(start, selected, result.perm);
  let latlngs = null;
  let routeWarning = "";
  try {
    const routeOut = await osrmRoute(coordsFromWaypoints(waypoints));
    latlngs = routeOut.geom.map(([lo, la]) => [la, lo]);
    result.km = routeOut.distanceKm;
    result.h = routeOut.durationH;
  } catch (e) {
    routeWarning = "Could not fetch detailed route geometry; map line is approximate.";
  }

  resetPlanButton();
  showPlanResult({
    start,
    tourPasses,
    km: result.km,
    h: result.h,
    matched: selected.length,
    poolSize: selected.length,
    inRange: true,
    advanced: true,
    routeWarning,
    statusWarning: advancedStatusWarning(tourPasses),
    tripDate: currentTripDate(),
    modes: result.perm,
  });
  drawPlannedTour(start, tourPasses, latlngs);
}

async function planTour() {
  if (advancedModeEl.checked) {
    await planSelectedTour();
    return;
  }
  clearPlannedTour();
  const start = currentStart();
  if (!start) { showPlanResult({ error: "Pick a start point." }); return; }
  const targetKm = +distSlider.value;
  const openOnly = openOnlyEl.checked;
  const allCands = PASSES.filter(p => {
    if (!p.baseA || !p.baseB) return false;            /* need traversal data */
    if (!openOnly) return true;
    const s = passStatus(p);
    if (!s) return false;
    return s.state === "open" || s.state === "restricted";
  });

  /* Pre-filter candidates by haversine distance.  Cap firmly at
     targetKm × 0.55 so the planner can't reach for famous-but-distant
     passes and produce a wildly out-of-budget tour.  No silent fallback
     that broadens to all-of-Alps. */
  const upperHaversine = targetKm * 0.55;
  let candidates = allCands
    .map(p => ({ p, d: haversine(start, p) }))
    .filter(x => x.d <= upperHaversine);

  /* Sort by composite (distance, quality) — closer & higher-quality first. */
  candidates.sort((a, b) => {
    return (a.d - 0.4 * a.p.quality * targetKm) -
           (b.d - 0.4 * b.p.quality * targetKm);
  });
  candidates = candidates.slice(0, PLANNER_MAX_CANDIDATES).map(x => x.p);

  if (candidates.length === 0) {
    showPlanResult({ error: openOnly
      ? `No projected open/restricted passes within reach of ${start.name} for a ${targetKm} km loop on ${formatTripDate(currentTripDate())}. ` +
        `Try a longer distance, change start point, or uncheck open-only.`
      : `No passes within reach of ${start.name} for a ${targetKm} km loop. ` +
        `Try a longer distance.` });
    return;
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
     closed pass NOT in the tour, mark those edges as Infinity, and re-plan. */
  const closedKnown = (openOnly ? PASSES.filter(p => passStatus(p).state === "closed") : []);
  const MAX_ITER = 5;

  let chosen = null;
  let chosenLatLngs = null;
  let chosenWaypoints = null;
  let chosenTourPasses = null;
  const blockedNames = new Set();
  let plannerMs = 0;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const t0 = performance.now();
    const passQ = candidates.map(p => ({
      qSummit: p.qSummit || 0,
      qApproach: p.qApproach || 0,
    }));
    const result = bestTourGated(matrix, candidates.length, targetKm, 0.20, PLANNER_MAX_PASSES, passQ);
    plannerMs += performance.now() - t0;
    if (!result) break;

    const tourPasses = result.perm.map(t => candidates[t.passIdx]);
    const waypoints = waypointsForTour(start, candidates, result.perm);

    const coordsStr = coordsFromWaypoints(waypoints);
    let routeOut;
    try { routeOut = await osrmRoute(coordsStr); }
    catch { break; }
    const latlngs = routeOut.geom.map(([lo, la]) => [la, lo]);

    if (!closedKnown.length) {
      chosen = result; chosenLatLngs = latlngs;
      chosenWaypoints = waypoints; chosenTourPasses = tourPasses;
      break;
    }

    /* Slice polyline per leg by snapping waypoints to nearest polyline pt.
       Each pass contributes 3 legs: connect-in (prev→enter), climb (enter→summit),
       descent (summit→exit). The climb+descent legs are intentional; we only
       check connect-in (and the final exit→next or exit→start) for closures. */
    const wpIdx = waypoints.map(wp => closestPolylineIdx(wp, latlngs));
    const tourIds = new Set(tourPasses.map(p => p.id));
    /* Map matrix-index for each waypoint (1 + 3*i + p where p∈{0,1,2}). */
    const wpMatrixIdx = [0];
    result.perm.forEach(t => {
      wpMatrixIdx.push(1 + 3 * t.passIdx + t.enterSide * 2);   // 0→A_idx 0, 1→B_idx 2
      wpMatrixIdx.push(1 + 3 * t.passIdx + 1);                  // summit
      wpMatrixIdx.push(1 + 3 * t.passIdx + t.exitSide  * 2);
    });
    wpMatrixIdx.push(0);

    const blockedThisIter = [];
    for (let leg = 0; leg < waypoints.length - 1; leg++) {
      const a = wpIdx[leg], b = wpIdx[leg + 1];
      const slice = latlngs.slice(Math.min(a, b), Math.max(a, b) + 1);
      const fromM = wpMatrixIdx[leg], toM = wpMatrixIdx[leg + 1];
      /* Skip legs internal to the same pass (enter→summit→exit). */
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

    if (blockedThisIter.length === 0) {
      chosen = result; chosenLatLngs = latlngs;
      chosenWaypoints = waypoints; chosenTourPasses = tourPasses;
      break;
    }
    for (const b of blockedThisIter) {
      matrix.dist[b.fromM][b.toM] = Infinity;
      matrix.dur [b.fromM][b.toM] = Infinity;
      matrix.dist[b.toM][b.fromM] = Infinity;
      matrix.dur [b.toM][b.fromM] = Infinity;
      blockedNames.add(b.name);
    }
  }

  console.log(`planner: ${candidates.length} candidates · ${Math.round(plannerMs)} ms total · avoided=[${[...blockedNames].join(",")}]`);
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
     who asked for 200 km. */
  if (!chosen.inRange && chosen.km > targetKm * 1.5) {
    showPlanResult({ error:
      `No tour fits within ±20% of ${targetKm} km from ${start.name}. ` +
      `Closest possible is ${Math.round(chosen.km)} km. Try a longer distance ` +
      `or a different start point.` });
    clearPlannedTour();
    return;
  }

  showPlanResult({
    start, tourPasses: chosenTourPasses, km: chosen.km, h: chosen.h, matched: chosen.k,
    poolSize: candidates.length, totalOpen: allCands.length, inRange: chosen.inRange,
    targetKm, openOnly, tripDate: currentTripDate(),
    avoided: blockedNames.size > 0 ? [...blockedNames] : null,
    modes: chosen.perm,   // [{passIdx, enterSide, exitSide, mode}, ...]
  });
  drawPlannedTour(start, chosenTourPasses, chosenLatLngs);
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

function showPlanResult(r) {
  planResult.classList.remove("empty");
  planResult.removeAttribute("aria-busy");
  if (r.loading) {
    planResult.setAttribute("aria-busy", "true");
    const title = r.advanced ? "Optimizing selected route…" : "Planning best tour…";
    const detail = r.advanced ? "Checking selected passes and route order." : "Scoring candidates, routing, and avoiding projected closures.";
    planResult.innerHTML = `<div class="loading-row"><span class="spinner" aria-hidden="true"></span><span><strong>${title}</strong><span>${detail}</span></span></div>`;
    return;
  }
  if (r.error)   { planResult.innerHTML = `<div class="warn">${r.error}</div>`; return; }
  const arrow = ' <span class="arrow">→</span> ';
  /* Annotate each pass with its visit mode: traversal or summit-and-back. */
  const passList = r.tourPasses.map((p, i) => {
    const t = r.modes[i];
    const modeBadge = t.mode === "out-and-back"
      ? ` <span class="mode-badge" title="Visit summit and return same way">↻</span>`
      : ``;
    return `${p.name}${modeBadge}${qualityStarsCompact(p.quality)}`;
  }).join(arrow);
  const avgQ = r.tourPasses.length
    ? r.tourPasses.reduce((s, p) => s + (p.quality || 0), 0) / r.tourPasses.length
    : 0;
  const obCount = r.modes.filter(m => m.mode === "out-and-back").length;
  const modeNote = obCount > 0
    ? `<div class="popup-meta tight"><span class="mode-badge">↻</span> ${obCount} of ${r.modes.length} passes visited summit-and-back</div>`
    : "";
  const qualityLine = avgQ > 0
    ? `<div class="popup-meta tight">Tour quality: <strong class="tour-quality">${"★".repeat(Math.round(avgQ * 5))}</strong> <span>(avg ${avgQ.toFixed(2)})</span></div>`
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
  const statsLine = r.advanced
    ? `<strong>${r.matched}</strong> selected pass${r.matched === 1 ? "" : "es"} ·
       <strong>${Math.round(r.km)} km</strong> · ~<strong>${fmtDuration(r.h)}</strong> driving`
    : `<strong>${r.matched}</strong> of ${r.poolSize} candidates
       ${r.openOnly ? `(out of ${r.totalOpen} projected open/restricted passes)` : ""} ·
       <strong>${Math.round(r.km)} km</strong> · ~<strong>${fmtDuration(r.h)}</strong> driving`;
  const tripDateLine = r.tripDate
    ? `<div class="popup-meta tight projection${daysBetweenDates(todayLocalDate(), r.tripDate) > 0 ? " guess" : ""}">Trip date: ${escapeHtml(formatTripDate(r.tripDate))} · projected pass states; guesses are marked “Likely” / “guess”.</div>`
    : "";
  planResult.innerHTML = `
    <h3>${title} from ${r.start.name}</h3>
    <div class="tour-passes">${passList}</div>
    <div class="stats">${statsLine}</div>
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

function drawPlannedTour(start, tourPasses, latlngs) {
  plannedTourIds = tourPasses.map(p => p.id);
  plannedLayer = L.layerGroup().addTo(map);
  plannedStartMarker = L.marker([start.lat, start.lon], {
    icon: L.divIcon({
      className: "",
      html: `<div class="start-marker"><span>${start.name[0]}</span></div>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    }), zIndexOffset: 500,
  }).addTo(map).bindTooltip(`Start: ${start.name}`, { direction: "top", offset: [0, -12] });

  tourPasses.forEach((p, idx) => {
    p._marker.setIcon(makeMarkerIcon(passStatus(p), idx + 1));
    p._marker._currentState = `${statusSignature(passStatus(p))}:${idx + 1}`;
    p._marker.setZIndexOffset(400);
  });

  /* Geometry was already fetched by the planner.  Just draw it. */
  if (latlngs && latlngs.length > 1) {
    plannedLayer.addLayer(L.polyline(latlngs, { color:"#000",    weight:11, opacity:0.45, lineCap:"round", lineJoin:"round" }));
    plannedLayer.addLayer(L.polyline(latlngs, { color:"#fff",    weight:7,  opacity:0.90, lineCap:"round", lineJoin:"round" }));
    plannedLayer.addLayer(L.polyline(latlngs, { color:"#ffd166", weight:5,  opacity:1,    lineCap:"round", lineJoin:"round" }));
    map.fitBounds(L.latLngBounds(latlngs).pad(0.10));
  } else {
    /* Fallback to straight lines if router was unavailable. */
    const wp = [[start.lat, start.lon], ...tourPasses.map(p => [p.lat, p.lon]), [start.lat, start.lon]];
    plannedLayer.addLayer(L.polyline(wp, { color:"#000",    weight:6,   opacity:0.40, lineCap:"round", lineJoin:"round" }));
    plannedLayer.addLayer(L.polyline(wp, { color:"#ffd166", weight:3.5, opacity:0.85, dashArray:"4 6", lineCap:"round", lineJoin:"round" }));
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
   quality cutoff. Tune here to widen or tighten the highlights filter. */
const NOTABLE_MIN_QUALITY = 0.5;

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
  passCluster.clearLayers();
  passCluster.addLayers(visibleMarkers);
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
      return `<li data-id="${p.id}" class="${selected ? "selected" : ""}" title="${advancedModeEl.checked ? "Select this pass for the route" : "Zoom to this pass"}">
        ${iconSvg("alpine-status", `status-icon ${statusView.className}`)}
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
  }

  noteEl.textContent = useSearch
    ? `${total} ${filterTag}match${total === 1 ? "" : "es"}${total > VIEW_LIMIT ? ` (showing first ${VIEW_LIMIT})` : ""}`
    : `${total} ${filterTag}in view${total > VIEW_LIMIT ? ` (showing first ${VIEW_LIMIT})` : ""} · ${PASSES.filter(passesAllFilters).length} ${filterTag}total`;
}

searchEl.addEventListener("input", renderList);
sortEl  .addEventListener("change", renderList);
sortOpenFirstEl.addEventListener("change", renderList);
startSel.addEventListener("change", renderList);
showOpenOnlyEl.addEventListener("change", syncOpenOnlyFilter);
showNotableOnlyEl.addEventListener("change", syncOpenOnlyFilter);

/* Debounce viewport-driven re-renders: panning fires moveend many times
   per second; renderList() is cheap (~5 ms) but rebuilding 80 li's is
   visible jank on slow devices. */
let moveTimer = null;
map.on("moveend", () => {
  if (searchEl.value) return;       /* search results aren't viewport-bound */
  clearTimeout(moveTimer);
  moveTimer = setTimeout(renderList, 120);
});
renderList();
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

