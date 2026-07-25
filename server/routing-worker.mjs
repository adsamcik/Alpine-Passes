const API_PREFIX = "/api/routing/v1";
const ROUTE_PATH = `${API_PREFIX}/route`;
const MATRIX_PATH = `${API_PREFIX}/matrix`;
const PUBLIC_OSRM_HOST = "router.project-osrm.org";
export const ORIGIN_METADATA_TOKEN = "__ITINERA_ORIGIN__";

export const ROUTING_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  upstreamBytes: 5 * 1024 * 1024,
  routeCoordinates: 25,
  matrixCoordinates: 32,
  avoidValues: 16,
  avoidValueLength: 64,
  geometryCoordinates: 200_000,
  timeoutMinMs: 100,
  timeoutMaxMs: 20_000,
  timeoutDefaultMs: 8_000,
});

const PROFILES = Object.freeze({
  car: {
    envName: "CAR",
    upstreamProfile: "driving",
  },
  foot: {
    envName: "FOOT",
    upstreamProfile: "walking",
  },
  hiking: {
    envName: "HIKING",
    upstreamProfile: "hiking",
  },
});

const ROUTE_FIELDS = new Set([
  "profile",
  "coordinates",
  "alternatives",
  "avoid",
  "departureTime",
  "constraints",
]);
const MATRIX_FIELDS = new Set([
  "profile",
  "coordinates",
  "departureTime",
]);
const NON_PRODUCTION_ENVIRONMENTS = new Set([
  "dev",
  "development",
  "local",
  "test",
  "demo",
  "preview",
]);

class RoutingWorkerError extends Error {
  constructor(code, message, status, options = {}) {
    super(message);
    this.name = "RoutingWorkerError";
    this.code = code;
    this.status = status;
    this.retryable = Boolean(options.retryable);
    this.field = options.field || null;
    this.headers = options.headers || null;
  }
}

export function createRoutingWorker(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      if (url.pathname !== ROUTE_PATH && url.pathname !== MATRIX_PATH) {
        if (url.pathname.startsWith(`${API_PREFIX}/`)) {
          return errorResponse(
            new RoutingWorkerError("not_found", "Routing endpoint not found", 404),
            requestIdFor(request),
          );
        }
        if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
          return serveStaticAsset(request, env.ASSETS);
        }
        return new Response("Not found", {
          status: 404,
          headers: securityHeaders(),
        });
      }

      const requestId = requestIdFor(request);
      if (request.method !== "POST") {
        return errorResponse(
          new RoutingWorkerError("method_not_allowed", "Use POST for routing requests", 405, {
            headers: { allow: "POST" },
          }),
          requestId,
        );
      }

      try {
        requireJsonContentType(request);
        const body = await readRequestJson(request);
        const normalized = url.pathname === ROUTE_PATH
          ? normalizeRouteRequest(body)
          : normalizeMatrixRequest(body);
        const profileConfig = resolveProfileConfig(env, normalized.profile);
        const result = url.pathname === ROUTE_PATH
          ? await proxyRoute(fetchImpl, profileConfig, normalized, requestId)
          : await proxyMatrix(fetchImpl, profileConfig, normalized, requestId);
        return jsonResponse(result, 200, requestId);
      } catch (error) {
        return errorResponse(normalizeError(error), requestId);
      }
    },
  };
}

async function serveStaticAsset(request, assets) {
  const response = await assets.fetch(request);
  const contentType = response.headers.get("content-type") || "";
  if (!/^text\/html(?:\s*;|$)/i.test(contentType)) return response;

  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "geolocation=(self), camera=(), microphone=()");

  const html = await response.text();
  if (!html.includes(ORIGIN_METADATA_TOKEN)) {
    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const replaced = html
    .split(ORIGIN_METADATA_TOKEN)
    .join(new URL(request.url).origin);
  headers.delete("content-length");
  headers.delete("content-md5");
  headers.delete("etag");
  return new Response(replaced, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readRequestJson(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > ROUTING_LIMITS.requestBytes) {
    throw new RoutingWorkerError("request_too_large", "Routing request is too large", 413);
  }

  const text = await request.text();
  if (byteLength(text) > ROUTING_LIMITS.requestBytes) {
    throw new RoutingWorkerError("request_too_large", "Routing request is too large", 413);
  }
  if (!text.trim()) {
    throw new RoutingWorkerError("invalid_json", "Routing request body is empty", 400);
  }

  try {
    const value = JSON.parse(text);
    if (!isRecord(value)) {
      throw new RoutingWorkerError("invalid_request", "Routing request must be a JSON object", 400);
    }
    return value;
  } catch (error) {
    if (error instanceof RoutingWorkerError) throw error;
    throw new RoutingWorkerError("invalid_json", "Routing request contains invalid JSON", 400);
  }
}

function requireJsonContentType(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new RoutingWorkerError(
      "unsupported_media_type",
      "Routing requests require application/json",
      415,
    );
  }
}

function normalizeRouteRequest(body) {
  rejectUnknownFields(body, ROUTE_FIELDS);
  const profile = normalizeProfile(body.profile);
  const coordinates = normalizeCoordinates(
    body.coordinates,
    2,
    ROUTING_LIMITS.routeCoordinates,
    "coordinates",
  );
  if (new Set(coordinates.map(([lon, lat]) => `${lon},${lat}`)).size < 2) {
    throw invalidField("coordinates", "Route coordinates must contain two distinct positions");
  }

  if (body.alternatives != null && typeof body.alternatives !== "boolean") {
    throw invalidField("alternatives", "alternatives must be a boolean");
  }

  const avoid = body.avoid == null ? [] : body.avoid;
  if (!Array.isArray(avoid) || avoid.length > ROUTING_LIMITS.avoidValues) {
    throw invalidField(
      "avoid",
      `avoid must be an array of at most ${ROUTING_LIMITS.avoidValues} strings`,
    );
  }
  for (const value of avoid) {
    if (typeof value !== "string" || !value || value.length > ROUTING_LIMITS.avoidValueLength) {
      throw invalidField(
        "avoid",
        `avoid values must be non-empty strings of at most ${ROUTING_LIMITS.avoidValueLength} characters`,
      );
    }
  }

  const constraints = body.constraints == null ? {} : body.constraints;
  if (!isRecord(constraints)) {
    throw invalidField("constraints", "constraints must be a JSON object");
  }
  const departureTime = normalizeDepartureTime(body.departureTime);

  if (avoid.length || Object.keys(constraints).length || departureTime !== null) {
    throw new RoutingWorkerError(
      "unsupported_options",
      "The configured OSRM-compatible gateway cannot safely honor avoid, constraints, or departureTime",
      422,
    );
  }

  return {
    profile,
    coordinates,
    alternatives: body.alternatives === true,
  };
}

function normalizeMatrixRequest(body) {
  rejectUnknownFields(body, MATRIX_FIELDS);
  const profile = normalizeProfile(body.profile);
  const coordinates = normalizeCoordinates(
    body.coordinates,
    2,
    ROUTING_LIMITS.matrixCoordinates,
    "coordinates",
  );
  const departureTime = normalizeDepartureTime(body.departureTime);
  if (departureTime !== null) {
    throw new RoutingWorkerError(
      "unsupported_options",
      "The configured OSRM-compatible gateway cannot safely honor departureTime",
      422,
    );
  }
  return { profile, coordinates };
}

function normalizeProfile(value) {
  if (typeof value !== "string" || !Object.hasOwn(PROFILES, value)) {
    throw invalidField("profile", "profile must be one of car, foot, or hiking");
  }
  return value;
}

function normalizeCoordinates(value, minimum, maximum, field) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw invalidField(
      field,
      `${field} must contain between ${minimum} and ${maximum} positions`,
    );
  }
  return value.map((position, index) => {
    if (!Array.isArray(position) || position.length !== 2) {
      throw invalidField(field, `${field}[${index}] must be [longitude, latitude]`);
    }
    const [lon, lat] = position;
    if (
      typeof lon !== "number"
      || typeof lat !== "number"
      || !Number.isFinite(lon)
      || !Number.isFinite(lat)
      || lon < -180
      || lon > 180
      || lat < -90
      || lat > 90
    ) {
      throw invalidField(
        field,
        `${field}[${index}] must contain finite longitude/latitude values`,
      );
    }
    return [lon, lat];
  });
}

function normalizeDepartureTime(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw invalidField("departureTime", "departureTime must be an ISO date-time string");
  }
  return new Date(value).toISOString();
}

function rejectUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new RoutingWorkerError(
      "invalid_request",
      `Unknown routing request field: ${unknown.sort()[0]}`,
      400,
      { field: unknown.sort()[0] },
    );
  }
}

function resolveProfileConfig(env, profile) {
  const profileDefinition = PROFILES[profile];
  const prefix = `ROUTING_${profileDefinition.envName}`;
  const demoAllowed = publicDemoAllowed(env);
  let baseUrl = stringEnv(env, `${prefix}_BASE_URL`)
    || stringEnv(env, `${prefix}_UPSTREAM_URL`);

  if (!baseUrl && profile === "car" && demoAllowed) {
    baseUrl = `https://${PUBLIC_OSRM_HOST}`;
  }
  if (!baseUrl) {
    throw new RoutingWorkerError(
      "profile_unavailable",
      `No routing upstream is configured for profile ${profile}`,
      503,
      { retryable: false },
    );
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RoutingWorkerError(
      "upstream_misconfigured",
      `The ${profile} routing upstream URL is invalid`,
      503,
    );
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new RoutingWorkerError(
      "upstream_misconfigured",
      `The ${profile} routing upstream must use HTTP or HTTPS`,
      503,
    );
  }
  if (parsed.protocol === "http:" && !insecureUpstreamAllowed(env)) {
    throw new RoutingWorkerError(
      "insecure_upstream_forbidden",
      `The ${profile} routing upstream must use HTTPS`,
      503,
    );
  }
  if (parsed.hostname.toLowerCase() === PUBLIC_OSRM_HOST && !demoAllowed) {
    throw new RoutingWorkerError(
      "demo_provider_forbidden",
      "The public OSRM demonstration server is disabled outside explicit non-production mode",
      503,
    );
  }

  const upstreamProfile = stringEnv(env, `${prefix}_UPSTREAM_PROFILE`)
    || profileDefinition.upstreamProfile;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(upstreamProfile)) {
    throw new RoutingWorkerError(
      "upstream_misconfigured",
      `The ${profile} upstream profile is invalid`,
      503,
    );
  }

  return {
    profile,
    baseUrl: parsed,
    upstreamProfile,
    providerId: boundedEnv(env, `${prefix}_PROVIDER_ID`, 64) || `configured-${profile}`,
    authorization: boundedEnv(env, `${prefix}_AUTHORIZATION`, 4_096),
    apiKey: boundedEnv(env, `${prefix}_API_KEY`, 4_096),
    timeoutMs: boundedInteger(
      env[`${prefix}_TIMEOUT_MS`] ?? env.ROUTING_TIMEOUT_MS,
      ROUTING_LIMITS.timeoutDefaultMs,
      ROUTING_LIMITS.timeoutMinMs,
      ROUTING_LIMITS.timeoutMaxMs,
    ),
  };
}

async function proxyRoute(fetchImpl, config, request, requestId) {
  const upstreamUrl = buildUpstreamUrl(
    config,
    "route",
    request.coordinates,
    request.alternatives
      ? { overview: "full", geometries: "geojson", alternatives: "3", steps: "false" }
      : { overview: "full", geometries: "geojson", alternatives: "false", steps: "false" },
  );
  const payload = await fetchUpstreamJson(fetchImpl, upstreamUrl, config, requestId);

  if (payload?.code === "NoRoute" || (payload?.code === "Ok" && !payload.routes?.length)) {
    throw new RoutingWorkerError("no_route", "No route was found for the requested profile", 422);
  }
  if (payload?.code !== "Ok" || !Array.isArray(payload.routes) || !payload.routes.length) {
    throw new RoutingWorkerError(
      "upstream_invalid_response",
      "Routing upstream returned an invalid route response",
      502,
      { retryable: true },
    );
  }

  const routes = payload.routes.slice(0, request.alternatives ? 3 : 1).map((route, index) => {
    if (
      !route
      || !validNonNegative(route.distance)
      || !validNonNegative(route.duration)
      || !validLineString(route.geometry)
    ) {
      throw new RoutingWorkerError(
        "upstream_invalid_response",
        `Routing upstream returned invalid route ${index}`,
        502,
        { retryable: true },
      );
    }
    return {
      geometry: {
        type: "LineString",
        coordinates: route.geometry.coordinates,
      },
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      warnings: [],
    };
  });

  return {
    provider: config.providerId,
    profile: request.profile,
    routes,
  };
}

async function proxyMatrix(fetchImpl, config, request, requestId) {
  const upstreamUrl = buildUpstreamUrl(
    config,
    "table",
    request.coordinates,
    { annotations: "distance,duration" },
  );
  const payload = await fetchUpstreamJson(fetchImpl, upstreamUrl, config, requestId);

  if (payload?.code !== "Ok") {
    throw new RoutingWorkerError(
      "upstream_invalid_response",
      "Routing upstream returned an invalid matrix response",
      502,
      { retryable: true },
    );
  }

  const size = request.coordinates.length;
  if (!validMatrix(payload.distances, size) || !validMatrix(payload.durations, size)) {
    throw new RoutingWorkerError(
      "upstream_invalid_response",
      "Routing upstream returned malformed matrix values",
      502,
      { retryable: true },
    );
  }

  return {
    provider: config.providerId,
    profile: request.profile,
    distancesMeters: payload.distances,
    durationsSeconds: payload.durations,
  };
}

function buildUpstreamUrl(config, service, coordinates, query) {
  const url = new URL(config.baseUrl.href);
  const basePath = url.pathname.replace(/\/+$/, "");
  const encodedCoordinates = coordinates
    .map(([lon, lat]) => `${formatCoordinate(lon)},${formatCoordinate(lat)}`)
    .join(";");
  url.pathname = `${basePath}/${service}/v1/${config.upstreamProfile}/${encodedCoordinates}`;
  url.hash = "";
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function fetchUpstreamJson(fetchImpl, url, config, requestId) {
  if (typeof fetchImpl !== "function") {
    throw new RoutingWorkerError(
      "upstream_unavailable",
      "Routing upstream transport is unavailable",
      502,
      { retryable: true },
    );
  }

  const headers = new Headers({
    accept: "application/json",
    "x-request-id": requestId,
  });
  if (config.authorization) headers.set("authorization", config.authorization);
  if (config.apiKey) headers.set("x-api-key", config.apiKey);

  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new RoutingWorkerError(
        "upstream_timeout",
        `Routing upstream timed out after ${config.timeoutMs} ms`,
        504,
        { retryable: true },
      ));
    }, config.timeoutMs);
  });

  let response;
  try {
    response = await Promise.race([
      Promise.resolve(fetchImpl(url.href, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      })),
      timeoutPromise,
    ]);
  } catch (error) {
    if (error instanceof RoutingWorkerError) throw error;
    if (controller.signal.aborted) {
      throw new RoutingWorkerError(
        "upstream_timeout",
        `Routing upstream timed out after ${config.timeoutMs} ms`,
        504,
        { retryable: true },
      );
    }
    throw new RoutingWorkerError(
      "upstream_unavailable",
      "Routing upstream could not be reached",
      502,
      { retryable: true },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!(response instanceof Response)) {
    throw new RoutingWorkerError(
      "upstream_invalid_response",
      "Routing upstream returned an unreadable response",
      502,
      { retryable: true },
    );
  }

  const retryAfter = response.headers.get("retry-after");
  if (!response.ok) {
    const headersOut = retryAfter ? { "retry-after": retryAfter } : null;
    throw new RoutingWorkerError(
      response.status === 429 ? "upstream_rate_limited" : "upstream_failure",
      response.status === 429
        ? "Routing upstream is rate limited"
        : "Routing upstream request failed",
      response.status === 429 ? 503 : 502,
      { retryable: true, headers: headersOut },
    );
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > ROUTING_LIMITS.upstreamBytes) {
    throw new RoutingWorkerError(
      "upstream_response_too_large",
      "Routing upstream response is too large",
      502,
      { retryable: true },
    );
  }
  const text = await response.text();
  if (byteLength(text) > ROUTING_LIMITS.upstreamBytes) {
    throw new RoutingWorkerError(
      "upstream_response_too_large",
      "Routing upstream response is too large",
      502,
      { retryable: true },
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new RoutingWorkerError(
      "upstream_invalid_response",
      "Routing upstream returned invalid JSON",
      502,
      { retryable: true },
    );
  }
}

function validLineString(geometry) {
  return geometry?.type === "LineString"
    && Array.isArray(geometry.coordinates)
    && geometry.coordinates.length >= 2
    && geometry.coordinates.length <= ROUTING_LIMITS.geometryCoordinates
    && geometry.coordinates.every((position) => (
      Array.isArray(position)
      && (position.length === 2 || position.length === 3)
      && typeof position[0] === "number"
      && typeof position[1] === "number"
      && Number.isFinite(position[0])
      && Number.isFinite(position[1])
      && position[0] >= -180
      && position[0] <= 180
      && position[1] >= -90
      && position[1] <= 90
      && (position.length === 2
        || (typeof position[2] === "number" && Number.isFinite(position[2])))
    ));
}

function validMatrix(matrix, size) {
  return Array.isArray(matrix)
    && matrix.length === size
    && matrix.every((row) => (
      Array.isArray(row)
      && row.length === size
      && row.every((value) => value === null || validNonNegative(value))
    ));
}

function validNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function publicDemoAllowed(env) {
  const environment = String(
    env.ROUTING_ENVIRONMENT
    || env.ENVIRONMENT
    || "production",
  ).trim().toLowerCase();
  return truthy(env.ROUTING_ALLOW_PUBLIC_OSRM_DEMO)
    && NON_PRODUCTION_ENVIRONMENTS.has(environment);
}

function insecureUpstreamAllowed(env) {
  const environment = String(
    env.ROUTING_ENVIRONMENT
    || env.ENVIRONMENT
    || "production",
  ).trim().toLowerCase();
  return truthy(env.ROUTING_ALLOW_INSECURE_UPSTREAM)
    && NON_PRODUCTION_ENVIRONMENTS.has(environment);
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function boundedEnv(env, key, maximum) {
  const value = stringEnv(env, key);
  if (!value) return null;
  if (value.length > maximum || /[\r\n]/.test(value)) {
    throw new RoutingWorkerError(
      "upstream_misconfigured",
      `Routing environment value ${key} is invalid`,
      503,
    );
  }
  return value;
}

function stringEnv(env, key) {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function formatCoordinate(value) {
  return Number(value.toFixed(7)).toString();
}

function invalidField(field, message) {
  return new RoutingWorkerError("invalid_request", message, 400, { field });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function requestIdFor(request) {
  const incoming = request.headers.get("x-request-id") || "";
  if (/^[A-Za-z0-9._:-]{1,64}$/.test(incoming)) return incoming;
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `routing-${Date.now().toString(36)}`;
}

function normalizeError(error) {
  if (error instanceof RoutingWorkerError) return error;
  return new RoutingWorkerError(
    "internal_error",
    "Routing gateway failed unexpectedly",
    500,
    { retryable: false },
  );
}

function errorResponse(error, requestId) {
  const payload = {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      retryable: error.retryable,
    },
  };
  if (error.field) payload.error.field = error.field;
  return jsonResponse(payload, error.status, requestId, error.headers);
}

function jsonResponse(value, status, requestId, extraHeaders = null) {
  const headers = new Headers({
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestId,
  });
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(value), { status, headers });
}

function securityHeaders() {
  return {
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

export default createRoutingWorker();
