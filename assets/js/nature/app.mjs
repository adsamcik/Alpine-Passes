import { RegionalPackageLoader } from "./region-loader.mjs";
import { searchEntities, rankDiscovery } from "./discovery.mjs";
import {
  displayName,
  flattenPositions,
  geometryBounds,
  validPosition,
} from "./domain.mjs";
import { buildMixedModeItinerary } from "./itinerary.mjs";
import {
  createBrowserRoutingGateway,
  installLegacyRoutingBridge,
} from "./routing.mjs";

const DISCOVERABLE_TYPES = new Set([
  "Place",
  "NaturalFeature",
  "ProtectedArea",
  "TrailRoute",
  "Amenity",
]);
const REGION_LABELS = Object.freeze({
  "eu-alps": "European Alps",
  japan: "Japan",
  "north-america": "United States & Canada",
  norway: "Norway",
  switzerland: "Switzerland",
  "uk-ireland": "United Kingdom & Ireland",
});
const EMPTY_COLLECTION = Object.freeze({ type: "FeatureCollection", features: [] });
const MAP_IDS = Object.freeze({
  routesSource: "nature-discovery-routes",
  pointsSource: "nature-discovery-points",
  routeLayer: "nature-discovery-route-lines",
  overviewRouteLayer: "nature-discovery-overview-route-lines",
  pointLayer: "nature-discovery-place-points",
  accessLayer: "nature-discovery-access-points",
});

export class NatureUiError extends Error {
  constructor(message, code = "nature_ui_error") {
    super(message);
    this.name = "NatureUiError";
    this.code = code;
  }
}

/** Build UI choices from the generated manifest, never from a hard-coded URL list. */
export function buildRegionOptions(manifest) {
  const grouped = new Map();
  for (const entry of manifest?.packages || []) {
    if (!entry?.regionId) continue;
    const item = grouped.get(entry.regionId) || {
      regionId: entry.regionId,
      jurisdictions: new Set(),
    };
    for (const id of entry.jurisdictionIds || []) item.jurisdictions.add(id);
    grouped.set(entry.regionId, item);
  }
  const options = [];
  const uk = grouped.get("uk-ireland");
  if (uk?.jurisdictions.has("GB-SCT")) {
    options.push({
      value: "scotland",
      packageRegionId: "uk-ireland",
      jurisdictionId: "GB-SCT",
      label: "Scotland — priority coverage (incomplete)",
      priority: true,
    });
  }
  for (const item of [...grouped.values()].sort((a, b) =>
    regionLabel(a.regionId).localeCompare(regionLabel(b.regionId)))) {
    options.push({
      value: item.regionId,
      packageRegionId: item.regionId,
      jurisdictionId: null,
      label: regionLabel(item.regionId),
      priority: false,
    });
  }
  return options;
}

/**
 * Separates the <=64 KB manifest bootstrap from explicit regional activation.
 * Browser startup calls initialize(); only the Load region button calls load().
 */
export function createDiscoveryDataSession(loader) {
  if (!loader?.loadManifest || !loader?.loadRegion) {
    throw new TypeError("A RegionalPackageLoader-compatible object is required");
  }
  let options = [];
  return Object.freeze({
    async initialize(initOptions = {}) {
      const manifest = await loader.loadManifest(initOptions);
      options = buildRegionOptions(manifest);
      return { manifest, options };
    },
    async load(selection, loadOptions = {}) {
      const chosen = typeof selection === "string"
        ? options.find((option) => option.value === selection)
        : selection;
      if (!chosen?.packageRegionId) {
        throw new NatureUiError("Choose a region advertised by the manifest", "invalid_region");
      }
      const packageSet = await loader.loadRegion(chosen.packageRegionId, loadOptions);
      const entities = chosen.jurisdictionId
        ? packageSet.entities.filter((entity) =>
          (entity.jurisdictionIds || []).includes(chosen.jurisdictionId))
        : packageSet.entities;
      return { selection: chosen, packageSet, entities };
    },
  });
}

/** Search and evidence-aware ranking with a hard result cap. */
export function filterAndRankEntities(entities, filters = {}) {
  const activity = cleanFilter(filters.activity);
  const interest = cleanFilter(filters.interest);
  const timeBudgetMinutes = finitePositive(filters.timeBudgetMinutes);
  let candidates = (entities || []).filter((entity) =>
    DISCOVERABLE_TYPES.has(entity?.entityType)
    && entity.sensitivity?.action !== "exclude"
    && entity.sensitivity?.action !== "redact");

  if (activity) {
    candidates = candidates.filter((entity) => (entity.activities || []).includes(activity));
  }
  if (interest) {
    candidates = candidates.filter((entity) => {
      const terms = [
        ...(entity.themes || []),
        ...(entity.classifications || []).flatMap((item) => [item.normalized, item.original]),
      ].filter(Boolean).map((value) => String(value).toLowerCase());
      return terms.some((term) => term === interest || term.includes(interest));
    });
  }
  if (timeBudgetMinutes) {
    candidates = candidates.filter((entity) => {
      const duration = entityDurationMinutes(entity);
      return duration == null || duration <= timeBudgetMinutes;
    });
  }

  const searched = searchEntities(candidates, filters.query || "");
  const relevance = new Map(searched.map((result) => [result.entity.id, result.relevance]));
  const assessments = rankDiscovery(
    searched.map((result) => result.entity),
    {
      activities: activity ? [activity] : [],
      hiddenOnly: Boolean(filters.hiddenOnly),
      requireVerifiedAccess: Boolean(filters.requireVerifiedAccess),
      accessModes: filters.accessModes || [],
      season: cleanFilter(filters.season) || undefined,
    },
  ).map((assessment) => ({
    ...assessment,
    score: roundScore(assessment.score * 0.82 + (relevance.get(assessment.entity.id) ?? 1) * 0.18),
  }));
  assessments.sort((a, b) => b.score - a.score
    || displayName(a.entity).localeCompare(displayName(b.entity)));
  const maximum = Math.max(1, Math.min(50, Number(filters.limit) || 36));
  return assessments.slice(0, maximum);
}

export function entityCardModel(entity, assessment = {}) {
  const legal = entity?.access?.legal || entity?.legalAccess || "unknown";
  const assertions = entity?.sourceAssertions || [];
  const evidenceKinds = [...new Set(assertions.map((item) => item.evidenceKind).filter(Boolean))];
  const duration = entityDurationMinutes(entity);
  return {
    id: entity.id,
    title: displayName(entity),
    entityType: humanize(entity.entityType),
    summary: entity.summary || entity.rationale || "No descriptive summary is available.",
    access: accessLabel(legal),
    accessCode: legal,
    geometry: geometryLabel(entity),
    duration: duration == null ? "Time unknown" : formatMinutes(duration),
    confidence: Number.isFinite(entity.quality?.confidence)
      ? `${Math.round(entity.quality.confidence * 100)}% confidence`
      : "Confidence unknown",
    season: entity.seasons?.length ? entity.seasons.map(humanize).join(", ") : "Season unknown",
    effort: routeEffortLabel(entity),
    verification: humanize(entity.quality?.verificationStatus || "unverified"),
    evidence: assertions.length
      ? `${assertions.length} source assertion${assertions.length === 1 ? "" : "s"}: ${evidenceKinds.map(humanize).join(", ") || "type unknown"}`
      : "No source assertions supplied",
    reasons: assessment.reasons || [],
    uncertainties: assessment.uncertainties || [],
    score: Number.isFinite(assessment.score) ? assessment.score : null,
  };
}

export function attachLinkedEntities(entity, entitiesById) {
  if (entity?.entityType !== "TrailRoute") return entity;
  const values = entitiesById instanceof Map ? [...entitiesById.values()] : Object.values(entitiesById || {});
  const lookup = entitiesById instanceof Map
    ? entitiesById
    : new Map(values.map((item) => [item.id, item]));
  const accessIds = new Set(entity.accessPointIds || []);
  const transportIds = new Set(entity.transportConnectionIds || []);
  for (const candidate of values) {
    if (candidate.entityType === "AccessPoint" && (candidate.linkedEntityIds || []).includes(entity.id)) {
      accessIds.add(candidate.id);
    }
  }
  return {
    ...entity,
    accessPoints: [...accessIds].map((id) => lookup.get(id)).filter(Boolean),
    transportConnections: [...transportIds].map((id) => lookup.get(id)).filter(Boolean),
  };
}

export function serializeTrailRouteGpx(entity) {
  if (entity?.entityType !== "TrailRoute") {
    throw new NatureUiError("Only trail routes can be exported", "gpx_not_route");
  }
  if (entity.navigationSuitability !== true) {
    throw new NatureUiError(
      "GPX export is disabled because this geometry is not verified as navigation-suitable",
      "gpx_navigation_unsuitable",
    );
  }
  const lines = entity.geometry?.type === "LineString"
    ? [entity.geometry.coordinates]
    : entity.geometry?.type === "MultiLineString"
      ? entity.geometry.coordinates
      : [];
  if (!lines.length || lines.some((line) => !Array.isArray(line)
      || line.length < 2 || line.some((position) => !validPosition(position)))) {
    throw new NatureUiError("Route geometry is missing or invalid", "gpx_invalid_geometry");
  }
  const segments = lines.map((line) => `<trkseg>${line.map((position) => {
    const elevation = Number.isFinite(position[2]) ? `<ele>${position[2]}</ele>` : "";
    return `<trkpt lat="${position[1]}" lon="${position[0]}">${elevation}</trkpt>`;
  }).join("")}</trkseg>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Itinera" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${escapeXml(displayName(entity))}</name></metadata><trk><name>${escapeXml(displayName(entity))}</name>${segments}</trk></gpx>\n`;
}

export function buildMapFeatureCollections(entities, selectedId = null, caps = {}) {
  const routeLimit = Math.max(1, Math.min(1000, Number(caps.routes) || 180));
  const pointLimit = Math.max(1, Math.min(5000, Number(caps.points) || 500));
  const routes = [];
  const points = [];
  for (const entity of entities || []) {
    const properties = {
      id: entity.id,
      entityType: entity.entityType,
      title: displayName(entity),
      selected: entity.id === selectedId,
      completeness: entity.geometryCompleteness || "not_applicable",
      navigationSuitable: entity.navigationSuitability === true,
    };
    if (entity.entityType === "TrailRoute"
        && ["LineString", "MultiLineString"].includes(entity.geometry?.type)
        && routes.length < routeLimit) {
      routes.push({ type: "Feature", id: entity.id, properties, geometry: entity.geometry });
    } else if (entity.geometry?.type === "Point"
        && validPosition(entity.geometry.coordinates)
        && points.length < pointLimit) {
      points.push({ type: "Feature", id: entity.id, properties, geometry: entity.geometry });
    }
  }
  return {
    routes: { type: "FeatureCollection", features: routes },
    points: { type: "FeatureCollection", features: points },
  };
}

class NatureDiscoveryApp {
  constructor(root, gateway) {
    this.root = root;
    this.gateway = gateway;
    this.loader = new RegionalPackageLoader();
    this.session = createDiscoveryDataSession(this.loader);
    this.options = [];
    this.entities = [];
    this.entitiesById = new Map();
    this.assessments = [];
    this.selection = null;
    this.selectedId = null;
    this.map = null;
    this.mapEventsBound = false;
    this.loadController = null;
    this.refs = findRefs();
  }

  async initialize() {
    this.bindControls();
    this.setStatus("Loading the regional manifest…", "loading");
    this.refs.panel.setAttribute("aria-busy", "true");
    try {
      const initialized = await this.session.initialize();
      this.options = initialized.options;
      this.populateRegions();
      this.setStatus("Choose a region, then load it. Regional data is not downloaded until you ask.", "ready");
    } catch (error) {
      this.showError(error, () => this.initialize());
    } finally {
      this.refs.panel.removeAttribute("aria-busy");
    }
    this.connectMap();
  }

  bindControls() {
    this.refs.form.addEventListener("submit", (event) => event.preventDefault());
    this.refs.load.addEventListener("click", () => this.loadSelectedRegion());
    this.refs.region.addEventListener("change", () => {
      this.entities = [];
      this.entitiesById.clear();
      this.assessments = [];
      this.currentMapEntities = [];
      this.selectedId = null;
      this.refs.results.replaceChildren();
      this.refs.detail.hidden = true;
      this.refs.count.textContent = "Not loaded";
      this.renderMap();
      this.updateLoadButton();
      this.setStatus("Region changed. Activate Load region to download its package.", "ready");
    });
    for (const ref of [this.refs.activity, this.refs.time, this.refs.interest, this.refs.hidden, this.refs.verified]) {
      ref.addEventListener("change", () => this.renderResults());
    }
    let searchTimer = 0;
    this.refs.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.renderResults(), 160);
    });
  }

  populateRegions() {
    this.refs.region.replaceChildren();
    for (const option of this.options) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      node.selected = option.priority;
      this.refs.region.append(node);
    }
    if (!this.refs.region.value && this.options[0]) this.refs.region.value = this.options[0].value;
    this.updateLoadButton();
  }

  updateLoadButton() {
    this.refs.load.textContent = this.refs.region.value === "scotland" ? "Explore Scotland" : "Load region";
  }

  async loadSelectedRegion() {
    const selection = this.options.find((option) => option.value === this.refs.region.value);
    if (!selection) return this.showError(new NatureUiError("Choose a region", "invalid_region"));
    this.loadController?.abort();
    this.loadController = new AbortController();
    this.refs.load.disabled = true;
    this.refs.panel.setAttribute("aria-busy", "true");
    this.setStatus(`Loading ${selection.label}…`, "loading");
    try {
      const loaded = await this.session.load(selection, { signal: this.loadController.signal });
      this.selection = loaded.selection;
      this.entities = loaded.entities;
      this.entitiesById = new Map(loaded.packageSet.entities.map((entity) => [entity.id, entity]));
      this.setStatus(`${selection.label} loaded. Coverage is evolving and is not a completeness claim.`, "ready");
      this.renderResults();
    } catch (error) {
      if (error?.code !== "aborted" && error?.name !== "AbortError") {
        this.showError(error, () => this.loadSelectedRegion());
      }
    } finally {
      this.refs.load.disabled = false;
      this.refs.panel.removeAttribute("aria-busy");
    }
  }

  filters() {
    return {
      query: this.refs.search.value,
      activity: this.refs.activity.value,
      timeBudgetMinutes: Number(this.refs.time.value) || null,
      interest: this.refs.interest.value,
      hiddenOnly: this.refs.hidden.checked,
      requireVerifiedAccess: this.refs.verified.checked,
      limit: 36,
    };
  }

  renderResults() {
    if (!this.entities.length) return;
    this.assessments = filterAndRankEntities(this.entities, this.filters());
    this.refs.results.replaceChildren();
    this.refs.count.textContent = `${this.assessments.length} result${this.assessments.length === 1 ? "" : "s"} shown (maximum 36)`;
    if (!this.assessments.length) {
      const empty = element("li", "discover-empty", "No evidence-qualified places match these filters.");
      this.refs.results.append(empty);
    }
    for (const assessment of this.assessments) {
      this.refs.results.append(this.createCard(assessment));
    }
    const mapEntities = linkedMapEntities(this.assessments.map((item) => item.entity), this.entitiesById);
    this.currentMapEntities = mapEntities;
    this.renderMap();
  }

  createCard(assessment) {
    const model = entityCardModel(assessment.entity, assessment);
    const item = element("li", "discover-result");
    const article = element("article", "discover-card");
    if (model.accessCode === "unknown") article.classList.add("is-uncertain");
    const select = element("button", "discover-card-select");
    select.type = "button";
    select.setAttribute("aria-label", `Show ${model.title} details and geometry`);
    select.append(
      element("span", "discover-card-type", `${model.entityType} · ${model.geometry}`),
      element("strong", "discover-card-title", model.title),
      element("span", "discover-card-summary", model.summary),
    );
    const facts = element("div", "discover-card-facts");
    facts.append(
      chip(model.access, model.accessCode === "unknown" ? "warning" : "neutral"),
      chip(model.duration),
      chip(model.season),
      chip(model.effort),
      chip(model.confidence),
    );
    const evidenceText = [
      model.evidence,
      model.reasons.length ? `Why it ranks: ${model.reasons.join("; ")}.` : "",
      model.uncertainties.length ? `Uncertainties: ${model.uncertainties.join("; ")}.` : "",
    ].filter(Boolean).join(" ");
    const why = element("p", "discover-card-evidence", evidenceText);
    select.addEventListener("click", () => this.selectEntity(assessment.entity.id));
    article.append(select, facts, why);
    item.append(article);
    return item;
  }

  selectEntity(id, fit = true) {
    const entity = this.entitiesById.get(id) || this.entities.find((item) => item.id === id);
    if (!entity) return;
    this.selectedId = id;
    const assessment = this.assessments.find((item) => item.entity.id === id) || {};
    this.renderDetail(entity, assessment);
    this.renderMap();
    if (fit) fitEntityGeometry(this.map, entity);
  }

  renderDetail(entity, assessment) {
    const enriched = attachLinkedEntities(entity, this.entitiesById);
    const model = entityCardModel(enriched, assessment);
    this.refs.detail.replaceChildren();
    this.refs.detail.hidden = false;
    const heading = element("h2", "discover-detail-title", model.title);
    heading.tabIndex = -1;
    const facts = element("dl", "discover-detail-facts");
    addDefinition(facts, "Access", model.access);
    addDefinition(facts, "Geometry", model.geometry);
    addDefinition(facts, "Season", model.season);
    addDefinition(facts, "Route effort", model.effort);
    addDefinition(facts, "Evidence", `${model.verification}; ${model.evidence}`);
    addDefinition(facts, "Jurisdictions", (entity.jurisdictionIds || []).join(", ") || "Unknown");
    const uncertainties = element("div", "discover-uncertainties");
    const allUnknowns = [...new Set([
      ...model.uncertainties,
      ...(entity.quality?.flags || []).map((flag) => humanize(flag)),
    ])];
    uncertainties.append(element("h3", "", "Known uncertainties"));
    const unknownList = element("ul");
    for (const text of allUnknowns.length ? allUnknowns : ["No explicit uncertainty flag was supplied; verify current conditions."]) {
      unknownList.append(element("li", "", text));
    }
    uncertainties.append(unknownList);
    this.refs.detail.append(heading, element("p", "discover-detail-summary", model.summary), facts);
    if (enriched.entityType === "TrailRoute") this.appendRouteDetails(enriched);
    this.refs.detail.append(uncertainties);
    heading.focus({ preventScroll: true });
  }

  appendRouteDetails(route) {
    const connections = element("section", "discover-connections");
    connections.append(element("h3", "", "Access and onward connections"));
    const list = element("ul");
    for (const point of route.accessPoints || []) {
      list.append(element("li", "",
        `${displayName(point)} — ${accessLabel(point.legalAccess || "unknown")}; ${(point.accessModes || []).join(", ") || "modes unknown"}`));
    }
    for (const connection of route.transportConnections || []) {
      list.append(element("li", "",
        `${displayName(connection)} — ${humanize(connection.transportMode || "mode unknown")}; schedule ${humanize(connection.schedule?.freshness || "unknown")}`));
    }
    if (!list.childElementCount) list.append(element("li", "", "No linked access point or transport connection is supplied."));
    connections.append(list);

    const actions = element("div", "discover-detail-actions");
    const plan = element("button", "discover-plan-action", "Plan access + route");
    plan.type = "button";
    plan.addEventListener("click", () => this.planRoute(route, output));
    const gpx = element("button", "discover-gpx-action", "Download GPX");
    gpx.type = "button";
    const gpxAllowed = route.navigationSuitability === true;
    gpx.disabled = !gpxAllowed;
    if (!gpxAllowed) {
      gpx.title = "Disabled: geometry is not verified as navigation-suitable";
      gpx.setAttribute("aria-describedby", "discoverGpxSafety");
    } else {
      gpx.addEventListener("click", () => downloadGpx(route));
    }
    actions.append(plan, gpx);
    const safety = element("p", "discover-gpx-safety",
      gpxAllowed
        ? "GPX is available, but always verify current closures, hazards and local guidance."
        : "GPX disabled: this geometry is explicitly not navigation-suitable.");
    safety.id = "discoverGpxSafety";
    const output = element("div", "discover-itinerary-output");
    output.setAttribute("aria-live", "polite");
    this.refs.detail.append(connections, actions, safety, output);
  }

  async planRoute(route, output) {
    output.replaceChildren(element("p", "", "Building explicit journey legs…"));
    try {
      const origin = mapCenter(this.map)
        || route.accessPoints?.find((point) => validPosition(point.geometry?.coordinates))?.geometry.coordinates;
      const accessMode = route.accessPoints?.some((point) => (point.accessModes || []).includes("car"))
        ? "car" : "transit";
      const itinerary = await buildMixedModeItinerary({
        origin,
        experience: route,
        gateway: this.gateway,
        accessMode,
        returnStrategy: "return_to_vehicle",
      });
      const heading = element("h3", "", "Journey legs");
      const list = element("ol", "discover-itinerary-legs");
      for (const leg of itinerary.legs) {
        list.append(element("li", "", `${humanize(leg.mode)} — ${leg.label}; ${formatMinutes(Math.round((leg.durationSeconds || 0) / 60))}`));
      }
      output.replaceChildren(heading, list,
        element("p", "discover-safety-note", itinerary.safetyNotice));
    } catch (error) {
      const code = error?.code || "itinerary_error";
      output.replaceChildren(element("p", "discover-refusal",
        `Planning refused [${code}]: ${error?.message || "Unknown itinerary failure"}`));
    }
  }

  connectMap() {
    const ready = window.ItineraApp?.map;
    if (ready) return this.attachMap(ready);
    window.addEventListener("itinera-map-ready", (event) => this.attachMap(event.detail?.map), { once: true });
  }

  attachMap(map) {
    if (!map) return;
    this.map = map;
    map.on("style.load", () => {
      window.requestAnimationFrame(() => this.renderMap());
    });
    map.on("idle", () => {
      if (!hasNatureMapState(map)) this.renderMap();
    });
    this.renderMap();
  }

  renderMap() {
    if (!this.map || typeof this.map.getSource !== "function") return;
    const collections = buildMapFeatureCollections(this.currentMapEntities || [], this.selectedId);
    try {
      setSource(this.map, MAP_IDS.routesSource, collections.routes);
      setSource(this.map, MAP_IDS.pointsSource, collections.points);
      ensureNatureLayers(this.map);
      if (!this.mapEventsBound) {
        const selectFeature = (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (id) this.selectEntity(id);
        };
        this.map.on("click", MAP_IDS.routeLayer, selectFeature);
        this.map.on("click", MAP_IDS.overviewRouteLayer, selectFeature);
        this.map.on("click", MAP_IDS.pointLayer, selectFeature);
        this.map.on("click", MAP_IDS.accessLayer, selectFeature);
        this.mapEventsBound = true;
      }
    } catch {
      // A concurrent legacy style switch will emit style.load and retry safely.
    }
  }

  setStatus(message, state) {
    this.refs.status.className = `discover-status is-${state}`;
    this.refs.status.setAttribute("aria-live", "polite");
    this.refs.status.textContent = message;
  }

  showError(error, retry) {
    const code = error?.code || "nature_data_error";
    this.refs.status.className = "discover-status is-error";
    this.refs.status.setAttribute("aria-live", "assertive");
    this.refs.status.replaceChildren(element("span", "", `Unable to load nature data [${code}]: ${error?.message || "Unknown error"}. `));
    if (retry) {
      const button = element("button", "discover-retry", "Retry");
      button.type = "button";
      button.addEventListener("click", retry, { once: true });
      this.refs.status.append(button);
    }
  }
}

function ensureNatureLayers(map) {
  if (!map.getLayer(MAP_IDS.routeLayer)) {
    map.addLayer({
      id: MAP_IDS.routeLayer,
      type: "line",
      source: MAP_IDS.routesSource,
      minzoom: 4,
      filter: ["==", ["get", "completeness"], "complete"],
      paint: {
        "line-color": ["case", ["==", ["get", "selected"], true], "#ffb020", "#35c4a4"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 10, 5, 14, 8],
        "line-opacity": ["case", ["==", ["get", "navigationSuitable"], true], 0.95, 0.7],
      },
    });
  }
  if (!map.getLayer(MAP_IDS.overviewRouteLayer)) {
    map.addLayer({
      id: MAP_IDS.overviewRouteLayer,
      type: "line",
      source: MAP_IDS.routesSource,
      minzoom: 4,
      filter: ["!=", ["get", "completeness"], "complete"],
      paint: {
        "line-color": ["case", ["==", ["get", "selected"], true], "#ffb020", "#35c4a4"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 10, 5, 14, 8],
        "line-opacity": ["case", ["==", ["get", "navigationSuitable"], true], 0.95, 0.7],
        "line-dasharray": [2, 2],
      },
    });
  }
  if (!map.getLayer(MAP_IDS.pointLayer)) {
    map.addLayer({
      id: MAP_IDS.pointLayer,
      type: "circle",
      source: MAP_IDS.pointsSource,
      minzoom: 5,
      filter: ["!=", ["get", "entityType"], "AccessPoint"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 11, 7],
        "circle-color": ["case", ["==", ["get", "selected"], true], "#ffb020", "#54d1ff"],
        "circle-stroke-color": "#071014",
        "circle-stroke-width": 1.5,
      },
    });
  }
  if (!map.getLayer(MAP_IDS.accessLayer)) {
    map.addLayer({
      id: MAP_IDS.accessLayer,
      type: "circle",
      source: MAP_IDS.pointsSource,
      minzoom: 9,
      filter: ["==", ["get", "entityType"], "AccessPoint"],
      paint: {
        "circle-radius": 6,
        "circle-color": "#f5f0d8",
        "circle-stroke-color": "#d2732a",
        "circle-stroke-width": 2,
      },
    });
  }
}

function setSource(map, id, data) {
  const source = map.getSource(id);
  if (source?.setData) source.setData(data);
  else map.addSource(id, { type: "geojson", data: data || EMPTY_COLLECTION });
}

function hasNatureMapState(map) {
  return Boolean(
    map.getSource(MAP_IDS.routesSource)
    && map.getSource(MAP_IDS.pointsSource)
    && map.getLayer(MAP_IDS.routeLayer)
    && map.getLayer(MAP_IDS.overviewRouteLayer)
    && map.getLayer(MAP_IDS.pointLayer)
    && map.getLayer(MAP_IDS.accessLayer)
  );
}

function fitEntityGeometry(map, entity) {
  if (!map) return;
  const bounds = geometryBounds(entity.geometry);
  if (!bounds) return;
  if (bounds[0] === bounds[2] && bounds[1] === bounds[3]) {
    map.easeTo?.({ center: [bounds[0], bounds[1]], zoom: Math.max(map.getZoom?.() || 0, 10) });
  } else {
    map.fitBounds?.([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 64, maxZoom: 13 });
  }
}

function linkedMapEntities(entities, lookup) {
  const out = new Map(entities.map((entity) => [entity.id, entity]));
  for (const entity of entities) {
    if (entity.entityType !== "TrailRoute") continue;
    const linked = attachLinkedEntities(entity, lookup);
    for (const point of linked.accessPoints || []) out.set(point.id, point);
  }
  return [...out.values()];
}

function findRefs() {
  const id = (value) => {
    const node = document.getElementById(value);
    if (!node) throw new NatureUiError(`Missing #${value}`, "missing_markup");
    return node;
  };
  const panel = id("discoverPanel");
  const form = panel.querySelector(".discover-controls");
  if (!form) throw new NatureUiError("Missing Discover filter form", "missing_markup");
  return {
    panel,
    form,
    region: id("discoverRegion"),
    load: id("discoverLoadRegion"),
    activity: id("discoverActivity"),
    time: id("discoverTimeBudget"),
    interest: id("discoverInterest"),
    search: id("discoverSearch"),
    hidden: id("discoverHidden"),
    verified: id("discoverVerified"),
    status: id("discoverStatus"),
    count: id("discoverCount"),
    results: id("discoverResults"),
    detail: id("discoverDetail"),
  };
}

function element(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function chip(text, kind = "neutral") {
  return element("span", `discover-chip is-${kind}`, text);
}

function addDefinition(list, term, value) {
  list.append(element("dt", "", term), element("dd", "", value));
}

function mapCenter(map) {
  const center = map?.getCenter?.();
  const point = center ? [Number(center.lng), Number(center.lat)] : null;
  return validPosition(point) ? point : null;
}

function downloadGpx(route) {
  const payload = serializeTrailRouteGpx(route);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/gpx+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${displayName(route).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "route"}.gpx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function entityDurationMinutes(entity) {
  const values = [
    entity?.metrics?.typicalDurationMinutes,
    entity?.typicalVisitMinutes,
    entity?.visitMinutes,
  ];
  const value = values.find((candidate) => Number.isFinite(candidate) && candidate > 0);
  return value == null ? null : Math.round(value);
}

function routeEffortLabel(entity) {
  if (entity?.entityType !== "TrailRoute") return "Effort not applicable";
  const parts = [];
  const distance = Number(entity.metrics?.distanceMeters);
  const ascent = Number(entity.metrics?.ascentMeters);
  const difficulty = entity.metrics?.difficulty
    || entity.difficulty?.label
    || entity.difficulty?.grade
    || entity.difficulty;
  if (Number.isFinite(distance) && distance > 0) {
    parts.push(`${(distance / 1000).toFixed(distance < 10_000 ? 1 : 0)} km`);
  }
  if (Number.isFinite(ascent) && ascent > 0) parts.push(`${Math.round(ascent)} m ascent`);
  if (typeof difficulty === "string" && difficulty.trim()) parts.push(humanize(difficulty));
  return parts.length ? parts.join(" · ") : "Effort unknown";
}

function geometryLabel(entity) {
  const type = entity?.geometry?.type;
  if (entity?.entityType === "TrailRoute") {
    const completeness = humanize(entity.geometryCompleteness || "unknown completeness");
    const grade = entity.navigationSuitability === true ? "navigation-suitable" : "not navigation-suitable";
    return `${completeness} ${humanize(type || "geometry unknown")} · ${grade}`;
  }
  return type === "Point" ? "Point location" : humanize(type || "Geometry unknown");
}

function accessLabel(value) {
  switch (value) {
    case "legal": return "Verified public access";
    case "restricted": return "Restricted — verify conditions";
    case "private": return "Private — public access not permitted";
    default: return "Unknown — not verified";
  }
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "Time unknown";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} h${remainder ? ` ${remainder} min` : ""}`;
}

function regionLabel(regionId) {
  return REGION_LABELS[regionId] || humanize(regionId);
}

function humanize(value) {
  return String(value || "unknown").replace(/[_-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function cleanFilter(value) {
  return String(value || "").trim().toLowerCase();
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function roundScore(value) {
  return Math.round(value * 1000) / 1000;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]);
}

function initializeAccessibleTabs() {
  const radios = [...document.querySelectorAll(".sidebar-tab-radio")];
  const records = radios.map((radio) => {
    const label = document.querySelector(`label[for="${radio.id}"]`);
    const panelId = label?.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    if (label) {
      label.id ||= `${radio.id}Label`;
      label.setAttribute("role", "tab");
    }
    if (panel && label) panel.setAttribute("aria-labelledby", label.id);
    radio.tabIndex = -1;
    return { radio, label, panel };
  }).filter((record) => record.label && record.panel);

  const sync = () => {
    for (const record of records) {
      const active = record.radio.checked;
      record.label.setAttribute("aria-selected", String(active));
      record.label.tabIndex = active ? 0 : -1;
      record.panel.hidden = !active;
    }
  };
  const activate = (index, focus = true) => {
    const record = records[(index + records.length) % records.length];
    if (!record) return;
    record.radio.checked = true;
    record.radio.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
    if (focus) record.label.focus();
  };
  records.forEach((record, index) => {
    record.radio.addEventListener("change", sync);
    record.label.addEventListener("keydown", (event) => {
      let target = null;
      if (["ArrowRight", "ArrowDown"].includes(event.key)) target = index + 1;
      if (["ArrowLeft", "ArrowUp"].includes(event.key)) target = index - 1;
      if (event.key === "Home") target = 0;
      if (event.key === "End") target = records.length - 1;
      if (["Enter", " "].includes(event.key)) target = index;
      if (target == null) return;
      event.preventDefault();
      activate(target);
    });
  });
  sync();
  return { sync, activate };
}

function startBrowserApp() {
  const root = document.getElementById("discoverPanel");
  if (!root) return;
  const tabs = initializeAccessibleTabs();
  let gateway = null;
  try {
    gateway = createBrowserRoutingGateway();
    installLegacyRoutingBridge(gateway);
  } catch (error) {
    console.warn("Configured routing gateway could not be initialized", error);
  }
  const app = new NatureDiscoveryApp(root, gateway);
  window.ItineraNature = Object.assign(window.ItineraNature || {}, {
    app,
    tabs,
    gatewayConfigured: Boolean(gateway),
    getStatus: () => ({
      region: app.selection?.value || null,
      entityCount: app.entities.length,
      resultCount: app.assessments.length,
    }),
  });
  app.initialize();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startBrowserApp, { once: true });
  } else {
    startBrowserApp();
  }
}
