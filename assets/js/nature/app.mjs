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
import {
  buildJourneyOptions,
  renderHikeDetail,
} from "./hike-detail.mjs";
import {
  RouteExportError,
  routeExportFilename,
  serializeTrailRouteGeoJson as serializeRouteGeoJson,
  serializeTrailRouteGpx as serializeRouteGpx,
} from "./route-export.mjs";

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
const DISCOVERY_RESULT_BATCH_SIZE = 36;
const DEFAULT_MAP_CAPS = Object.freeze({ routes: 180, points: 500 });

export class NatureUiError extends Error {
  constructor(message, code = "nature_ui_error") {
    super(message);
    this.name = "NatureUiError";
    this.code = code;
  }
}

export class RegionLoadCoordinator {
  constructor() {
    this.requestId = 0;
    this.controller = null;
  }

  begin() {
    const previousController = this.controller;
    const controller = new AbortController();
    const request = Object.freeze({
      requestId: ++this.requestId,
      controller,
      signal: controller.signal,
    });
    this.controller = controller;
    previousController?.abort();
    return request;
  }

  isCurrent(request) {
    return Boolean(
      request
      && request.requestId === this.requestId
      && request.controller === this.controller,
    );
  }

  invalidate(onInvalidate) {
    const controller = this.controller;
    this.requestId += 1;
    this.controller = null;
    controller?.abort();
    onInvalidate?.(this.requestId);
    return this.requestId;
  }

  finish(request) {
    if (!this.isCurrent(request)) return false;
    this.controller = null;
    return true;
  }
}

export async function runLatestRegionLoad(coordinator, load, handlers = {}) {
  if (!coordinator
      || typeof coordinator.begin !== "function"
      || typeof coordinator.isCurrent !== "function"
      || typeof coordinator.finish !== "function") {
    throw new TypeError("A RegionLoadCoordinator-compatible object is required");
  }
  if (typeof load !== "function") throw new TypeError("A region load function is required");

  const request = coordinator.begin();
  try {
    handlers.onStart?.(request);
    const value = await load(request);
    if (!coordinator.isCurrent(request)) return { status: "stale", request, value };
    handlers.onSuccess?.(value, request);
    return { status: "applied", request, value };
  } catch (error) {
    if (!coordinator.isCurrent(request)) return { status: "stale", request, error };
    handlers.onError?.(error, request);
    return { status: "failed", request, error };
  } finally {
    if (coordinator.finish(request)) handlers.onFinish?.(request);
  }
}

export function validateJourneyPlanSelection(route, selection, options = {}) {
  if (route?.entityType !== "TrailRoute") {
    throw new NatureUiError("A TrailRoute is required for journey planning", "invalid_experience");
  }
  if (!selection || typeof selection !== "object") {
    throw new NatureUiError(
      "Choose how to reach the route and what happens after it",
      "journey_selection_required",
    );
  }
  const available = buildJourneyOptions(route, options);
  const accessMode = selection.accessMode;
  const returnStrategy = selection.returnStrategy;
  if (!available.accessModes.some((option) => option.value === accessMode)) {
    throw new NatureUiError(
      "The selected access mode is not supported by this route's linked data",
      "unsupported_access_mode",
    );
  }
  if (!available.returnStrategies.some((option) => option.value === returnStrategy)) {
    throw new NatureUiError(
      "The selected return strategy is not supported by this route shape",
      "unsupported_return_strategy",
    );
  }
  return { accessMode, returnStrategy };
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
 * Separates the <=64 KB manifest bootstrap from explicit regional search loads.
 * Viewport cells support the map; the Load region button remains the deliberate
 * path for complete regional search/list data during the compatibility period.
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
    async loadViewport(bounds, loadOptions = {}) {
      if (typeof loader.loadViewport !== "function") {
        throw new NatureUiError(
          "This data loader does not support viewport packages",
          "viewport_loading_unavailable",
        );
      }
      const packageSet = await loader.loadViewport(bounds, loadOptions);
      return {
        packageSet,
        entities: packageSet.entities || [],
      };
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
  const requested = Number(filters.limit);
  const maximum = Math.max(1, Math.min(
    assessments.length || 1,
    Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : DISCOVERY_RESULT_BATCH_SIZE,
  ));
  return assessments.slice(0, maximum);
}

export function entityCardModel(entity, assessment = {}) {
  const legal = entity?.access?.legal || entity?.legalAccess || "unknown";
  const assertions = entity?.sourceAssertions || [];
  const evidenceKinds = [...new Set(assertions.map((item) => item.evidenceKind).filter(Boolean))];
  const duration = entityDurationMinutes(entity);
  const discoveryLane = assessment.lane || entity?.discovery?.lane || "general";
  const uncertainties = [...(assessment.uncertainties || [])];
  if (discoveryLane === "quieter_lead"
      && !uncertainties.some((value) => /unverified discovery lead/i.test(value))) {
    uncertainties.push("Less-known status is an unverified discovery lead, not a quality claim.");
  }
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
    discoveryLane,
    discoveryLaneLabel: discoveryLaneLabel(discoveryLane),
    reasons: assessment.reasons || [],
    uncertainties,
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
  const segmentIds = new Set(entity.segmentIds || []);
  const hazardIds = new Set(entity.hazardRefs || []);
  const conditionIds = new Set(entity.conditionRefs || []);
  const restrictionIds = new Set(entity.restrictionRefs || []);
  const permitRequirementIds = new Set(entity.permitRequirementIds || []);
  for (const candidate of values) {
    if (!(candidate.linkedEntityIds || []).includes(entity.id)) continue;
    if (candidate.entityType === "AccessPoint") accessIds.add(candidate.id);
    if (candidate.entityType === "TransportConnection") transportIds.add(candidate.id);
    if (candidate.entityType === "TrailSegment") segmentIds.add(candidate.id);
    if (candidate.entityType === "Hazard") hazardIds.add(candidate.id);
    if (candidate.entityType === "Condition") conditionIds.add(candidate.id);
    if (candidate.entityType === "Restriction") restrictionIds.add(candidate.id);
    if (candidate.entityType === "PermitRequirement") permitRequirementIds.add(candidate.id);
  }
  return {
    ...entity,
    accessPoints: [...accessIds].map((id) => lookup.get(id)).filter(Boolean),
    transportConnections: [...transportIds].map((id) => lookup.get(id)).filter(Boolean),
    trailSegments: [...segmentIds].map((id) => lookup.get(id)).filter(Boolean),
    hazards: [...hazardIds].map((id) => lookup.get(id)).filter(Boolean),
    conditions: [...conditionIds].map((id) => lookup.get(id)).filter(Boolean),
    restrictions: [...restrictionIds].map((id) => lookup.get(id)).filter(Boolean),
    permitRequirements: [...permitRequirementIds].map((id) => lookup.get(id)).filter(Boolean),
  };
}

export function serializeTrailRouteGpx(entity) {
  try {
    return serializeRouteGpx(entity);
  } catch (error) {
    if (error instanceof RouteExportError) {
      throw new NatureUiError(error.message, error.code);
    }
    throw error;
  }
}

export function serializeTrailRouteGeoJson(entity) {
  try {
    return serializeRouteGeoJson(entity);
  } catch (error) {
    if (error instanceof RouteExportError) {
      throw new NatureUiError(error.message, error.code);
    }
    throw error;
  }
}

export function rankMapEntitiesForDisplay(entities, selectedId = null) {
  const unique = new Map();
  for (const entity of entities || []) {
    if (!entity?.id || unique.has(entity.id)) continue;
    unique.set(entity.id, entity);
  }
  return [...unique.values()].sort((left, right) =>
    mapEvidencePriority(right, selectedId) - mapEvidencePriority(left, selectedId)
      || displayName(left).localeCompare(displayName(right))
      || left.id.localeCompare(right.id));
}

export function buildMapFeatureCollections(entities, selectedId = null, caps = {}) {
  const routeLimit = Math.max(1, Math.min(1000,
    Number(caps.routes) || DEFAULT_MAP_CAPS.routes));
  const pointLimit = Math.max(1, Math.min(5000,
    Number(caps.points) || DEFAULT_MAP_CAPS.points));
  const ranked = rankMapEntitiesForDisplay(entities, selectedId);
  const routeCandidates = [];
  const pointCandidates = [];
  for (const entity of ranked) {
    if (entity.entityType === "TrailRoute"
        && ["LineString", "MultiLineString"].includes(entity.geometry?.type)) {
      routeCandidates.push(entity);
    } else if (entity.geometry?.type === "Point"
        && validPosition(entity.geometry.coordinates)) {
      pointCandidates.push(entity);
    }
  }
  const feature = (entity) => ({
    type: "Feature",
    id: entity.id,
    properties: {
      id: entity.id,
      entityType: entity.entityType,
      title: displayName(entity),
      selected: entity.id === selectedId,
      completeness: entity.geometryCompleteness || "not_applicable",
      navigationSuitable: entity.navigationSuitability === true,
      evidencePriority: roundScore(mapEvidencePriority(entity, selectedId)),
    },
    geometry: entity.geometry,
  });
  const routes = routeCandidates.slice(0, routeLimit).map(feature);
  const points = pointCandidates.slice(0, pointLimit).map(feature);
  const rendered = routes.length + points.length;
  const mappable = routeCandidates.length + pointCandidates.length;
  return {
    routes: { type: "FeatureCollection", features: routes },
    points: { type: "FeatureCollection", features: points },
    counts: {
      loaded: ranked.length,
      mappable,
      rendered,
      capped: Math.max(0, mappable - rendered),
      unsupported: Math.max(0, ranked.length - mappable),
      routes: { loaded: routeCandidates.length, rendered: routes.length, limit: routeLimit },
      points: { loaded: pointCandidates.length, rendered: points.length, limit: pointLimit },
    },
  };
}

function mapEvidencePriority(entity, selectedId) {
  const verification = {
    verified: 3,
    partially_verified: 2,
    unverified: 1,
  }[entity?.quality?.verificationStatus] || 0;
  const freshness = {
    current: 3,
    recent: 2,
    stale: 1,
  }[entity?.quality?.freshness] || 0;
  const access = {
    legal: 3,
    restricted: 2,
    unknown: 1,
    private: 0,
  }[entity?.access?.legal || entity?.legalAccess] || 0;
  const assertions = entity?.sourceAssertions || [];
  const verifiedAssertions = assertions.filter((assertion) =>
    assertion?.verificationStatus === "verified"
      || assertion?.evidenceKind === "verified_official").length;
  const assertionRatio = assertions.length ? verifiedAssertions / assertions.length : 0;
  const evidence = unitInterval(entity?.discovery?.evidenceQuality,
    entity?.quality?.confidence || 0);
  const confidence = unitInterval(entity?.quality?.confidence, 0);
  const criticalUnknowns = (entity?.quality?.flags || []).filter((flag) =>
    flag === "critical_access_unknown" || flag === "critical_condition_unknown").length;
  return (entity?.id === selectedId ? 1000 : 0)
    + verification * 100
    + evidence * 40
    + confidence * 30
    + assertionRatio * 20
    + freshness * 8
    + access * 4
    - criticalUnknowns * 25;
}

class NatureDiscoveryApp {
  constructor(root, gateway) {
    this.root = root;
    this.gateway = gateway;
    this.loader = new RegionalPackageLoader();
    this.session = createDiscoveryDataSession(this.loader);
    this.options = [];
    this.entities = [];
    this.viewportEntities = [];
    this.regionEntitiesById = new Map();
    this.entitiesById = new Map();
    this.assessments = [];
    this.viewportResultLimit = DISCOVERY_RESULT_BATCH_SIZE;
    this.viewportResultTotal = 0;
    this.currentMapEntities = [];
    this.mapRenderCounts = null;
    this.selection = null;
    this.selectedId = null;
    this.map = null;
    this.mapEventsBound = false;
    this.viewportEventsBound = false;
    this.regionLoads = new RegionLoadCoordinator();
    this.viewportController = null;
    this.viewportRequestId = 0;
    this.viewportTimer = 0;
    this.viewportState = "idle";
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
      this.setStatus(
        "Choose a region for full search; map places stream from verified visible cells as you pan or zoom.",
        "ready",
      );
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
      this.invalidateRegionLoad();
      this.selection = null;
      this.entities = [];
      this.regionEntitiesById.clear();
      this.rebuildEntityLookup();
      this.assessments = [];
      this.currentMapEntities = [];
      this.selectedId = null;
      this.refs.detail.hidden = true;
      this.viewportResultLimit = DISCOVERY_RESULT_BATCH_SIZE;
      this.renderResults();
      this.updateLoadButton();
      this.setStatus("Region changed. Activate Load region for full search; visible map cells remain available.", "ready");
    });
    for (const ref of [this.refs.activity, this.refs.time, this.refs.interest, this.refs.hidden, this.refs.verified]) {
      ref.addEventListener("change", () => {
        if (!this.selection) this.viewportResultLimit = DISCOVERY_RESULT_BATCH_SIZE;
        this.renderResults();
      });
    }
    let searchTimer = 0;
    this.refs.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (!this.selection) this.viewportResultLimit = DISCOVERY_RESULT_BATCH_SIZE;
        this.renderResults();
      }, 160);
    });
    this.refs.showMore.addEventListener("click", () => {
      if (this.selection) return;
      const firstNewIndex = this.assessments.length;
      this.viewportResultLimit = Math.min(
        this.viewportResultTotal || this.viewportEntities.length,
        this.viewportResultLimit + DISCOVERY_RESULT_BATCH_SIZE,
      );
      this.renderResults();
      this.refs.results
        .querySelector(`[data-result-index="${firstNewIndex}"] .discover-card-select`)
        ?.focus();
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

  invalidateRegionLoad() {
    this.regionLoads.invalidate(() => {
      this.refs.load.disabled = false;
      this.refs.panel.removeAttribute("aria-busy");
    });
  }

  async loadSelectedRegion() {
    const selection = this.options.find((option) => option.value === this.refs.region.value);
    if (!selection) return this.showError(new NatureUiError("Choose a region", "invalid_region"));
    return runLatestRegionLoad(
      this.regionLoads,
      ({ signal }) => this.session.load(selection, { signal }),
      {
        onStart: () => {
          this.refs.load.disabled = true;
          this.refs.panel.setAttribute("aria-busy", "true");
          this.setStatus(`Loading ${selection.label}…`, "loading");
        },
        onSuccess: (loaded) => {
          this.selection = loaded.selection;
          this.entities = loaded.entities;
          this.regionEntitiesById = new Map(
            loaded.packageSet.entities.map((entity) => [entity.id, entity]),
          );
          this.rebuildEntityLookup();
          this.setStatus(
            `${selection.label} loaded. Coverage is evolving and is not a completeness claim.`,
            "ready",
          );
          this.renderResults();
        },
        onError: (error) => {
          if (error?.code !== "aborted" && error?.name !== "AbortError") {
            this.showError(error, () => this.loadSelectedRegion());
          }
        },
        onFinish: () => {
          this.refs.load.disabled = false;
          this.refs.panel.removeAttribute("aria-busy");
        },
      },
    );
  }

  filters(limit = DISCOVERY_RESULT_BATCH_SIZE) {
    return {
      query: this.refs.search.value,
      activity: this.refs.activity.value,
      timeBudgetMinutes: Number(this.refs.time.value) || null,
      interest: this.refs.interest.value,
      hiddenOnly: this.refs.hidden.checked,
      requireVerifiedAccess: this.refs.verified.checked,
      limit,
    };
  }

  renderResults() {
    const isRegionSearch = Boolean(this.selection);
    const source = isRegionSearch ? this.entities : this.viewportEntities;
    const title = isRegionSearch ? "Evidence-ranked region results" : "Visible map results";
    this.refs.resultsTitle.textContent = title;
    this.refs.results.setAttribute("aria-label", title);
    this.refs.results.removeAttribute("aria-busy");
    this.refs.results.replaceChildren();
    this.refs.showMore.hidden = true;
    this.viewportResultTotal = 0;

    if (!source.length) {
      this.assessments = [];
      this.currentMapEntities = [];
      this.refs.count.textContent = isRegionSearch
        ? "0 region results shown"
        : "0 visible results shown";
      const message = !isRegionSearch && this.viewportState === "loading"
        ? "Visible-cell results are loading."
        : !isRegionSearch
          ? "No visible-cell results are available. Zoom or pan to retry, or explore a region for full search."
          : "No evidence-qualified places match these filters.";
      this.refs.results.append(element("li", "discover-empty", message));
      this.renderMap();
      return;
    }

    const ranked = filterAndRankEntities(source, this.filters(
      isRegionSearch ? DISCOVERY_RESULT_BATCH_SIZE : source.length,
    ));
    this.viewportResultTotal = isRegionSearch ? 0 : ranked.length;
    this.assessments = isRegionSearch
      ? ranked
      : ranked.slice(0, this.viewportResultLimit);
    this.refs.count.textContent = isRegionSearch
      ? `${this.assessments.length} result${this.assessments.length === 1 ? "" : "s"} shown (maximum ${DISCOVERY_RESULT_BATCH_SIZE})`
      : `${this.assessments.length} of ${ranked.length} visible result${ranked.length === 1 ? "" : "s"} shown`;
    if (!this.assessments.length) {
      this.refs.results.append(element(
        "li",
        "discover-empty",
        "No evidence-qualified places match these filters.",
      ));
    }
    this.assessments.forEach((assessment, index) => {
      this.refs.results.append(this.createCard(assessment, index));
    });
    if (!isRegionSearch && this.assessments.length < ranked.length) {
      const remaining = ranked.length - this.assessments.length;
      this.refs.showMore.hidden = false;
      this.refs.showMore.textContent = `Show next ${Math.min(DISCOVERY_RESULT_BATCH_SIZE, remaining)} visible results (${remaining} remaining)`;
    }
    this.currentMapEntities = isRegionSearch
      ? linkedMapEntities(
        this.assessments.map((item) => item.entity),
        this.entitiesById,
      )
      : ranked.map((item) => item.entity);
    this.renderMap();
  }

  createCard(assessment, index = 0) {
    const model = entityCardModel(assessment.entity, assessment);
    const item = element("li", "discover-result");
    item.dataset.entityId = model.id;
    item.dataset.resultIndex = String(index);
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
    if (model.discoveryLaneLabel) {
      facts.append(chip(
        model.discoveryLaneLabel,
        model.discoveryLane === "quieter_lead" ? "warning" : "neutral",
      ));
    }
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
    if (enriched.entityType === "TrailRoute") {
      this.refs.detail.append(heading, element("p", "discover-detail-summary", model.summary));
      renderHikeDetail(this.refs.detail, enriched, {
        assessment,
        onPlan: (route, output, journeyOptions) =>
          this.planRoute(route, output, journeyOptions),
        onDownloadGpx: (route) => downloadRouteFile(
          serializeTrailRouteGpx(route),
          "application/gpx+xml",
          routeExportFilename(route, "gpx"),
        ),
        onDownloadGeoJson: (route) => downloadRouteFile(
          serializeTrailRouteGeoJson(route),
          "application/geo+json",
          routeExportFilename(route, "geojson"),
        ),
      });
      heading.focus({ preventScroll: true });
      return;
    }
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
    this.refs.detail.append(uncertainties);
    heading.focus({ preventScroll: true });
  }


  async planRoute(route, output, selectedOptions) {
    output.replaceChildren(element("p", "", "Building explicit journey legs…"));
    try {
      const { accessMode, returnStrategy } = validateJourneyPlanSelection(route, selectedOptions);
      const origin = mapCenter(this.map)
        || route.accessPoints?.find((point) => validPosition(point.geometry?.coordinates))?.geometry.coordinates;
      const itinerary = await buildMixedModeItinerary({
        origin,
        experience: route,
        gateway: this.gateway,
        accessMode,
        returnStrategy,
      });
      const heading = element("h3", "", "Journey legs");
      const list = element("ol", "discover-itinerary-legs");
      for (const leg of itinerary.legs) {
        list.append(element("li", "", `${humanize(leg.mode)} — ${leg.label}; ${formatMinutes(Math.round((leg.durationSeconds || 0) / 60))}`));
      }
      output.replaceChildren(heading, list,
        element("p", "discover-safety-note", itinerary.safetyNotice));
      return { ok: true, itinerary };
    } catch (error) {
      const code = error?.code || "itinerary_error";
      const message = `Planning refused [${code}]: ${error?.message || "Unknown itinerary failure"}`;
      output.replaceChildren(element("p", "discover-refusal",
        message));
      return { ok: false, code, message };
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
    if (!this.viewportEventsBound) {
      map.on("moveend", () => this.scheduleViewportLoad());
      this.viewportEventsBound = true;
    }
    this.renderMap();
    this.scheduleViewportLoad(0);
  }

  scheduleViewportLoad(delayMilliseconds = 140) {
    clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => {
      this.loadVisibleViewport();
    }, Math.max(0, Number(delayMilliseconds) || 0));
  }

  async loadVisibleViewport() {
    const bounds = mapViewportBounds(this.map);
    if (!bounds) return;
    const requestId = ++this.viewportRequestId;
    this.viewportController?.abort();
    this.viewportController = new AbortController();
    this.setViewportState("loading");
    if (!this.selection) this.refs.results.setAttribute("aria-busy", "true");
    if (!this.selection && !this.refs.panel.hasAttribute("aria-busy")) {
      this.setStatus(
        "Loading nature places in the visible map. Choose a region for full search.",
        "loading",
      );
    }
    try {
      const loaded = await this.session.loadViewport(bounds, {
        signal: this.viewportController.signal,
      });
      if (requestId !== this.viewportRequestId) return;
      this.viewportEntities = loaded.entities;
      this.viewportResultLimit = DISCOVERY_RESULT_BATCH_SIZE;
      this.rebuildEntityLookup();
      this.clearUnavailableViewportSelection();
      this.setViewportState("ready");
      if (!this.selection && !this.refs.panel.hasAttribute("aria-busy")) {
        const count = this.viewportEntities.length;
        this.setStatus(
          `${count} visible-map record${count === 1 ? "" : "s"} loaded from spatial cells. Choose a region for full search; inventory is not a completeness claim.`,
          "ready",
        );
      }
      if (!this.selection) this.renderResults();
      else this.renderMap();
    } catch (error) {
      if (requestId !== this.viewportRequestId
          || error?.code === "aborted"
          || error?.name === "AbortError") return;
      const tooBroad = error?.code === "viewport_request_limit_exceeded";
      this.viewportEntities = [];
      this.viewportResultLimit = DISCOVERY_RESULT_BATCH_SIZE;
      this.rebuildEntityLookup();
      this.clearUnavailableViewportSelection();
      this.setViewportState(tooBroad ? "too-broad" : "error");
      if (!this.selection) this.renderResults();
      else this.renderMap();
      if (!this.selection && !this.refs.panel.hasAttribute("aria-busy")) {
        this.setStatus(
          tooBroad
            ? "The visible area is too broad for detailed cell loading. Zoom in, or choose a region for full search."
            : "Visible-map data is unavailable. Pan to retry, or choose a region for the compatibility search path.",
          tooBroad ? "ready" : "error",
        );
      }
    }
  }

  rebuildEntityLookup() {
    this.entitiesById = new Map(this.regionEntitiesById);
    for (const entity of this.viewportEntities) {
      if (!this.entitiesById.has(entity.id)) this.entitiesById.set(entity.id, entity);
    }
  }

  clearUnavailableViewportSelection() {
    if (this.selection || !this.selectedId || this.entitiesById.has(this.selectedId)) return;
    this.selectedId = null;
    this.refs.detail.replaceChildren();
    this.refs.detail.hidden = true;
  }

  setViewportState(state) {
    this.viewportState = state;
    this.root.dataset.viewportState = state;
  }

  mapEntities() {
    if (!this.selection) return [...(this.currentMapEntities || [])];
    const combined = new Map();
    for (const entity of this.currentMapEntities || []) combined.set(entity.id, entity);
    for (const entity of this.viewportEntities) {
      if (!combined.has(entity.id)) combined.set(entity.id, entity);
    }
    return [...combined.values()];
  }

  renderMap() {
    if (!this.map || typeof this.map.getSource !== "function") return;
    const collections = buildMapFeatureCollections(this.mapEntities(), this.selectedId);
    this.mapRenderCounts = collections.counts;
    this.updateMapDisclosure(collections.counts);
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

  updateMapDisclosure(counts) {
    const loaded = counts?.loaded || 0;
    const rendered = counts?.rendered || 0;
    const capped = counts?.capped || 0;
    const unsupported = counts?.unsupported || 0;
    const available = this.selection ? loaded : this.viewportEntities.length;
    const excluded = Math.max(0, available - loaded);
    const parts = [
      `${counts?.points?.rendered || 0} point${counts?.points?.rendered === 1 ? "" : "s"}`,
      `${counts?.routes?.rendered || 0} route${counts?.routes?.rendered === 1 ? "" : "s"}`,
    ];
    const lead = this.selection
      ? `Map renders ${rendered} of ${loaded} loaded record${loaded === 1 ? "" : "s"}`
      : `Map renders ${rendered} of ${loaded} filter-eligible loaded record${loaded === 1 ? "" : "s"}; ${available} visible-cell record${available === 1 ? " is" : "s are"} loaded`;
    let explanation = "Evidence, verification, access, and the selected record determine map priority; names only break ties.";
    if (excluded) {
      explanation = `${excluded} loaded record${excluded === 1 ? " is" : "s are"} excluded by current discovery eligibility or filters. ${explanation}`;
    }
    if (capped) {
      explanation = `${capped} lower-priority mappable record${capped === 1 ? " is" : "s are"} outside the evidence-aware map caps. ${explanation}`;
    }
    if (unsupported) {
      explanation += ` ${unsupported} loaded record${unsupported === 1 ? " has" : "s have"} no supported point or route geometry.`;
    }
    this.refs.mapCount.textContent = `${lead} (${parts.join(", ")}). ${explanation}`;
    this.refs.mapCount.dataset.loaded = String(loaded);
    this.refs.mapCount.dataset.available = String(available);
    this.refs.mapCount.dataset.rendered = String(rendered);
    this.refs.mapCount.dataset.capped = String(capped);
  }

  setStatus(message, state) {
    this.refs.status.className = `discover-status is-${state}`;
    this.refs.status.setAttribute("aria-live", state === "error" ? "assertive" : "polite");
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
    mapCount: id("discoverMapCount"),
    resultsTitle: id("discoverResultsTitle"),
    count: id("discoverCount"),
    results: id("discoverResults"),
    showMore: id("discoverShowMore"),
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

export function mapViewportBounds(map) {
  const bounds = map?.getBounds?.();
  if (!bounds) return null;
  const array = typeof bounds.toArray === "function" ? bounds.toArray() : null;
  const west = Number(bounds.getWest?.() ?? array?.[0]?.[0]);
  const southRaw = Number(bounds.getSouth?.() ?? array?.[0]?.[1]);
  const east = Number(bounds.getEast?.() ?? array?.[1]?.[0]);
  const northRaw = Number(bounds.getNorth?.() ?? array?.[1]?.[1]);
  if (![west, southRaw, east, northRaw].every(Number.isFinite)) return null;

  const mercatorLimit = 85.0511287798066;
  const south = Math.max(-mercatorLimit, Math.min(mercatorLimit, southRaw));
  const north = Math.max(-mercatorLimit, Math.min(mercatorLimit, northRaw));
  if (south >= north) return null;

  let longitudeSpan = east - west;
  while (longitudeSpan < 0) longitudeSpan += 360;
  if (longitudeSpan >= 360) return [-180, south, 180, north];

  const normalizedWest = wrapLongitude(west);
  let normalizedEast = normalizedWest + longitudeSpan;
  if (normalizedEast > 180) normalizedEast -= 360;
  return [normalizedWest, south, normalizedEast, north];
}

function wrapLongitude(value) {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

function mapCenter(map) {
  const center = map?.getCenter?.();
  const point = center ? [Number(center.lng), Number(center.lat)] : null;
  return validPosition(point) ? point : null;
}

function downloadRouteFile(payload, type, filename) {
  const url = URL.createObjectURL(new Blob([payload], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
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

function discoveryLaneLabel(lane) {
  switch (lane) {
    case "iconic": return "Iconic";
    case "quieter_verified": return "Verified quieter place";
    case "quieter_lead": return "Unverified discovery lead";
    default: return null;
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

function unitInterval(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function roundScore(value) {
  return Math.round(value * 1000) / 1000;
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
      viewportResultTotal: app.viewportResultTotal,
      viewportEntityCount: app.viewportEntities.length,
      viewportState: app.viewportState,
      mapLoadedCount: app.mapRenderCounts?.loaded || 0,
      mapAvailableCount: app.selection
        ? app.mapRenderCounts?.loaded || 0
        : app.viewportEntities.length,
      mapRenderedCount: app.mapRenderCounts?.rendered || 0,
      mapCappedCount: app.mapRenderCounts?.capped || 0,
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
