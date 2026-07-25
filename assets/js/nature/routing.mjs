import { validPosition } from "./domain.mjs";

export const ROUTING_PROFILES = Object.freeze(["car", "foot", "hiking"]);

export class RoutingError extends Error {
  constructor(message, code = "routing_error", details = {}) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
    this.details = details;
  }
}

export class RoutingGateway {
  constructor(provider, options = {}) {
    if (!provider || typeof provider.route !== "function" || typeof provider.matrix !== "function") {
      throw new TypeError("RoutingGateway requires a route and matrix provider");
    }
    this.provider = provider;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async route(request) {
    const normalized = normalizeRouteRequest(request);
    return withTimeout(
      this.provider.route(normalized),
      this.timeoutMs,
      `Routing timed out for ${normalized.profile}`,
    ).then((result) => normalizeRouteResult(result, normalized));
  }

  async matrix(request) {
    const normalized = normalizeMatrixRequest(request);
    return withTimeout(
      this.provider.matrix(normalized),
      this.timeoutMs,
      `Routing matrix timed out for ${normalized.profile}`,
    ).then((result) => normalizeMatrixResult(result, normalized));
  }
}

export class SameOriginRoutingProvider {
  constructor(baseUrl = "/api/routing/v1", fetchImpl = globalThis.fetch) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  async route(request) {
    return this.#post("route", request);
  }

  async matrix(request) {
    return this.#post("matrix", request);
  }

  async #post(path, body) {
    if (typeof this.fetchImpl !== "function") {
      throw new RoutingError("Fetch is unavailable", "transport_unavailable");
    }
    const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new RoutingError("Routing service returned unreadable data", "invalid_response");
    }
    if (!response.ok || payload?.error) {
      throw new RoutingError(
        payload?.error?.message || `Routing request failed (${response.status})`,
        payload?.error?.code || "upstream_failure",
        { status: response.status },
      );
    }
    return payload;
  }
}

/**
 * Explicit local-development adapter for the public OSRM demo. It is never
 * selected automatically on a public hostname and is not a production
 * dependency.
 */
export class LocalDemoOsrmProvider {
  constructor(options = {}) {
    this.endpoint = options.endpoint || "https://router.project-osrm.org";
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    const hostname = options.hostname ?? globalThis.location?.hostname ?? "";
    const local = ["", "localhost", "127.0.0.1", "::1"].includes(hostname);
    if (!local && !options.allowExplicitNonProductionUse) {
      throw new RoutingError(
        "The public OSRM demo adapter is restricted to local development",
        "demo_provider_forbidden",
      );
    }
  }

  async route(request) {
    if (request.profile !== "car") {
      throw new RoutingError("The local OSRM demo adapter only supports car routing", "profile_unavailable");
    }
    const coordinates = encodeCoordinates(request.coordinates);
    const alternatives = request.alternatives ? "&alternatives=3" : "";
    const response = await this.fetchImpl(
      `${this.endpoint}/route/v1/driving/${coordinates}?overview=full&geometries=geojson${alternatives}`,
    );
    const payload = await response.json();
    if (!response.ok || payload.code !== "Ok" || !payload.routes?.length) {
      throw new RoutingError(`OSRM route failed: ${payload.code || response.status}`, "upstream_failure");
    }
    return {
      provider: "osrm-demo",
      routes: payload.routes.map((route) => ({
        geometry: route.geometry,
        distanceMeters: route.distance,
        durationSeconds: route.duration,
      })),
    };
  }

  async matrix(request) {
    if (request.profile !== "car") {
      throw new RoutingError("The local OSRM demo adapter only supports car routing", "profile_unavailable");
    }
    const coordinates = encodeCoordinates(request.coordinates);
    const response = await this.fetchImpl(
      `${this.endpoint}/table/v1/driving/${coordinates}?annotations=distance,duration`,
    );
    const payload = await response.json();
    if (!response.ok || payload.code !== "Ok") {
      throw new RoutingError(`OSRM table failed: ${payload.code || response.status}`, "upstream_failure");
    }
    return {
      provider: "osrm-demo",
      distancesMeters: payload.distances,
      durationsSeconds: payload.durations,
    };
  }
}

export function createBrowserRoutingGateway() {
  const meta = globalThis.document?.querySelector('meta[name="itinera-routing-api"]');
  const baseUrl = meta?.content?.trim();
  if (baseUrl) return new RoutingGateway(new SameOriginRoutingProvider(baseUrl));
  const hostname = globalThis.location?.hostname ?? "";
  if (["", "localhost", "127.0.0.1", "::1"].includes(hostname)) {
    return new RoutingGateway(new LocalDemoOsrmProvider({ hostname }));
  }
  return null;
}

export function installLegacyRoutingBridge(gateway = createBrowserRoutingGateway()) {
  if (!gateway || typeof globalThis.window === "undefined") return null;
  const bridge = {
    async table(coordinates) {
      const points = typeof coordinates === "string"
        ? decodeCoordinates(coordinates)
        : coordinates;
      const result = await gateway.matrix({ profile: "car", coordinates: points });
      return { dist: result.distancesMeters, dur: result.durationsSeconds };
    },
    async route(coordinates, options = {}) {
      const points = typeof coordinates === "string"
        ? decodeCoordinates(coordinates)
        : coordinates;
      const result = await gateway.route({
        profile: "car",
        coordinates: points,
        alternatives: Boolean(options.alternatives),
      });
      const routes = result.routes.map((route) => ({
        geom: route.geometry.coordinates,
        distanceKm: Math.round(route.distanceMeters / 1000),
        durationH: +(route.durationSeconds / 3600).toFixed(1),
      }));
      return { ...routes[0], routes };
    },
    gateway,
  };
  globalThis.window.ItineraRouting = bridge;
  return bridge;
}

export function normalizeRouteRequest(request) {
  const profile = normalizeProfile(request?.profile);
  const coordinates = normalizeCoordinates(request?.coordinates, 2);
  return {
    profile,
    coordinates,
    alternatives: Boolean(request?.alternatives),
    avoid: Array.isArray(request?.avoid) ? [...new Set(request.avoid.map(String))].sort() : [],
    departureTime: normalizeIsoDate(request?.departureTime),
    constraints: request?.constraints && typeof request.constraints === "object"
      ? { ...request.constraints }
      : {},
  };
}

export function normalizeMatrixRequest(request) {
  const profile = normalizeProfile(request?.profile);
  const coordinates = normalizeCoordinates(request?.coordinates, 2);
  return {
    profile,
    coordinates,
    departureTime: normalizeIsoDate(request?.departureTime),
  };
}

function normalizeRouteResult(result, request) {
  const routes = Array.isArray(result?.routes) ? result.routes : [];
  if (!routes.length) throw new RoutingError("Routing provider returned no route", "no_route");
  return {
    provider: result.provider || "configured",
    profile: request.profile,
    routes: routes.map((route, index) => {
      const geometry = route.geometry?.type === "LineString"
        ? route.geometry
        : { type: "LineString", coordinates: route.geometry?.coordinates || route.geom || [] };
      normalizeCoordinates(geometry.coordinates, 2);
      if (!Number.isFinite(route.distanceMeters) || route.distanceMeters < 0) {
        throw new RoutingError(`Route ${index} has invalid distance`, "invalid_response");
      }
      if (!Number.isFinite(route.durationSeconds) || route.durationSeconds < 0) {
        throw new RoutingError(`Route ${index} has invalid duration`, "invalid_response");
      }
      return {
        geometry,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        warnings: Array.isArray(route.warnings) ? route.warnings : [],
      };
    }),
  };
}

function normalizeMatrixResult(result, request) {
  const size = request.coordinates.length;
  const distances = result?.distancesMeters;
  const durations = result?.durationsSeconds;
  if (!validMatrix(distances, size) || !validMatrix(durations, size)) {
    throw new RoutingError("Routing provider returned an invalid matrix", "invalid_response");
  }
  return {
    provider: result.provider || "configured",
    profile: request.profile,
    distancesMeters: distances,
    durationsSeconds: durations,
  };
}

function normalizeProfile(profile) {
  if (!ROUTING_PROFILES.includes(profile)) {
    throw new RoutingError(`Unsupported routing profile: ${profile}`, "invalid_request");
  }
  return profile;
}

function normalizeCoordinates(coordinates, minimum) {
  if (!Array.isArray(coordinates) || coordinates.length < minimum) {
    throw new RoutingError(`At least ${minimum} coordinates are required`, "invalid_request");
  }
  const normalized = coordinates.map((position) => [Number(position?.[0]), Number(position?.[1])]);
  if (normalized.some((position) => !validPosition(position))) {
    throw new RoutingError("Coordinates must be valid [longitude, latitude] pairs", "invalid_request");
  }
  return normalized;
}

function normalizeIsoDate(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RoutingError("Invalid departure time", "invalid_request");
  return date.toISOString();
}

function validMatrix(matrix, size) {
  return Array.isArray(matrix)
    && matrix.length === size
    && matrix.every((row) => Array.isArray(row)
      && row.length === size
      && row.every((value) => value == null || (Number.isFinite(value) && value >= 0)));
}

function encodeCoordinates(coordinates) {
  return coordinates.map(([lon, lat]) => `${lon},${lat}`).join(";");
}

function decodeCoordinates(value) {
  return String(value).split(";").map((pair) => pair.split(",").map(Number));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new RoutingError(message, "timeout")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

