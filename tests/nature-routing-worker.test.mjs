import test from "node:test";
import assert from "node:assert/strict";

import {
  ORIGIN_METADATA_TOKEN,
  ROUTING_LIMITS,
  createRoutingWorker,
} from "../server/routing-worker.mjs";

const API_ROOT = "https://itinera.test/api/routing/v1";
const ROUTE_COORDINATES = [[8.2, 46.8], [8.3, 46.9]];

test("non-HTML static responses are passed through without origin replacement", async () => {
  let assetRequest = null;
  const worker = createRoutingWorker({
    fetchImpl: () => {
      throw new Error("upstream fetch should not run");
    },
  });
  const env = {
    ASSETS: {
      async fetch(request) {
        assetRequest = request;
        return new Response(`${ORIGIN_METADATA_TOKEN}/asset-body`, {
          status: 200,
          headers: {
            "content-type": "text/css",
            "x-asset-header": "preserved",
          },
        });
      },
    },
  };

  const response = await worker.fetch(new Request("https://itinera.test/map.css"), env);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), `${ORIGIN_METADATA_TOKEN}/asset-body`);
  assert.equal(assetRequest.url, "https://itinera.test/map.css");
  assert.equal(response.headers.get("x-asset-header"), "preserved");
  assert.equal(response.headers.get("x-frame-options"), null);
});

test("HTML static responses replace the exact origin token and add security headers", async () => {
  const worker = createRoutingWorker();
  const html = `<meta content="${ORIGIN_METADATA_TOKEN}/assets/og.png"><p>${ORIGIN_METADATA_TOKEN}</p>`;
  const env = {
    ASSETS: {
      async fetch() {
        return new Response(html, {
          status: 203,
          statusText: "Non-Authoritative Information",
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=60",
            "content-language": "en",
            etag: '"stale-html-etag"',
            "content-length": String(Buffer.byteLength(html)),
          },
        });
      },
    },
  };

  const response = await worker.fetch(
    new Request("https://preview.itinera.test/index.html"),
    env,
  );
  const body = await response.text();

  assert.equal(response.status, 203);
  assert.equal(response.statusText, "Non-Authoritative Information");
  assert.equal(
    body,
    '<meta content="https://preview.itinera.test/assets/og.png"><p>https://preview.itinera.test</p>',
  );
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  assert.equal(response.headers.get("content-language"), "en");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(
    response.headers.get("permissions-policy"),
    "geolocation=(self), camera=(), microphone=()",
  );
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("content-length"), null);
});

test("routing endpoints require POST and return structured errors", async () => {
  const worker = createRoutingWorker();
  const response = await worker.fetch(new Request(`${API_ROOT}/route`), {});
  const payload = await response.json();

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(payload.error.code, "method_not_allowed");
  assert.equal(typeof payload.error.requestId, "string");
  assert.equal(payload.error.retryable, false);
});

test("route requests use the exact configured upstream for every profile", async () => {
  const calls = [];
  const worker = createRoutingWorker({
    async fetchImpl(url, options) {
      calls.push({ url: new URL(url), options });
      return jsonResponse(osrmRoutePayload());
    },
  });
  const env = {
    ROUTING_CAR_BASE_URL: "https://car-router.example/osrm",
    ROUTING_CAR_PROVIDER_ID: "car-prod",
    ROUTING_FOOT_BASE_URL: "https://foot-router.example/base",
    ROUTING_FOOT_UPSTREAM_PROFILE: "pedestrian",
    ROUTING_FOOT_PROVIDER_ID: "foot-prod",
    ROUTING_HIKING_BASE_URL: "https://hike-router.example",
    ROUTING_HIKING_UPSTREAM_PROFILE: "trail",
    ROUTING_HIKING_PROVIDER_ID: "hike-prod",
  };

  const expectations = [
    ["car", "car-router.example", "/osrm/route/v1/driving/", "car-prod"],
    ["foot", "foot-router.example", "/base/route/v1/pedestrian/", "foot-prod"],
    ["hiking", "hike-router.example", "/route/v1/trail/", "hike-prod"],
  ];
  for (const [profile, hostname, pathPrefix, provider] of expectations) {
    const response = await post(worker, "route", {
      profile,
      coordinates: ROUTE_COORDINATES,
      alternatives: false,
      avoid: [],
      departureTime: null,
      constraints: {},
    }, env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.profile, profile);
    assert.equal(payload.provider, provider);
    assert.equal(payload.routes[0].distanceMeters, 12_345);
    const call = calls.at(-1);
    assert.equal(call.url.hostname, hostname);
    assert.ok(call.url.pathname.startsWith(pathPrefix), call.url.pathname);
    assert.equal(call.options.method, "GET");
  }

  assert.equal(calls.length, 3);
});

test("hiking never falls back to a configured foot profile", async () => {
  let upstreamCalls = 0;
  const worker = createRoutingWorker({
    fetchImpl() {
      upstreamCalls += 1;
      return jsonResponse(osrmRoutePayload());
    },
  });
  const response = await post(worker, "route", {
    profile: "hiking",
    coordinates: ROUTE_COORDINATES,
  }, {
    ROUTING_FOOT_BASE_URL: "https://foot-router.example",
  });
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.error.code, "profile_unavailable");
  assert.equal(upstreamCalls, 0);
});

test("the public OSRM demo is forbidden by default and in production", async () => {
  let upstreamCalls = 0;
  const worker = createRoutingWorker({
    fetchImpl() {
      upstreamCalls += 1;
      return jsonResponse(osrmRoutePayload());
    },
  });
  const baseEnv = {
    ROUTING_CAR_BASE_URL: "https://router.project-osrm.org",
  };

  const defaultResponse = await post(worker, "route", routeBody("car"), baseEnv);
  const productionResponse = await post(worker, "route", routeBody("car"), {
    ...baseEnv,
    ROUTING_ALLOW_PUBLIC_OSRM_DEMO: "true",
    ROUTING_ENVIRONMENT: "production",
  });

  assert.equal(defaultResponse.status, 503);
  assert.equal((await defaultResponse.json()).error.code, "demo_provider_forbidden");
  assert.equal(productionResponse.status, 503);
  assert.equal((await productionResponse.json()).error.code, "demo_provider_forbidden");
  assert.equal(upstreamCalls, 0);
});

test("the public OSRM demo requires both an explicit flag and non-production environment", async () => {
  let calledUrl = null;
  const worker = createRoutingWorker({
    fetchImpl(url) {
      calledUrl = new URL(url);
      return jsonResponse(osrmRoutePayload());
    },
  });
  const response = await post(worker, "route", routeBody("car"), {
    ROUTING_ALLOW_PUBLIC_OSRM_DEMO: "true",
    ROUTING_ENVIRONMENT: "development",
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.profile, "car");
  assert.equal(calledUrl.hostname, "router.project-osrm.org");
  assert.match(calledUrl.pathname, /\/route\/v1\/driving\//);
});

test("server-side authorization is used without forwarding browser credentials", async () => {
  let upstreamHeaders = null;
  const worker = createRoutingWorker({
    fetchImpl(_url, options) {
      upstreamHeaders = new Headers(options.headers);
      return jsonResponse(osrmRoutePayload());
    },
  });
  const request = new Request(`${API_ROOT}/route`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer browser-token",
      cookie: "private=browser-cookie",
      "x-request-id": "safe-request-id",
    },
    body: JSON.stringify(routeBody("car")),
  });
  const response = await worker.fetch(request, {
    ROUTING_CAR_BASE_URL: "https://car-router.example",
    ROUTING_CAR_AUTHORIZATION: "Bearer server-secret",
    ROUTING_CAR_API_KEY: "server-api-key",
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamHeaders.get("authorization"), "Bearer server-secret");
  assert.equal(upstreamHeaders.get("x-api-key"), "server-api-key");
  assert.equal(upstreamHeaders.get("cookie"), null);
  assert.equal(upstreamHeaders.get("x-request-id"), "safe-request-id");
  assert.equal(response.headers.get("x-request-id"), "safe-request-id");
});

test("strict validation rejects unknown profiles, fields, bounds, and unsupported options", async (t) => {
  const worker = createRoutingWorker({
    fetchImpl() {
      throw new Error("invalid requests must not reach an upstream");
    },
  });
  const env = { ROUTING_CAR_BASE_URL: "https://car-router.example" };
  const cases = [
    ["unknown profile", { ...routeBody("car"), profile: "cycling" }, 400, "invalid_request"],
    ["unknown field", { ...routeBody("car"), provider: "pick-me" }, 400, "invalid_request"],
    ["invalid coordinate", { ...routeBody("car"), coordinates: [[181, 0], [0, 0]] }, 400, "invalid_request"],
    [
      "coordinate bound",
      {
        ...routeBody("car"),
        coordinates: Array.from(
          { length: ROUTING_LIMITS.routeCoordinates + 1 },
          (_, index) => [8 + index / 100, 46],
        ),
      },
      400,
      "invalid_request",
    ],
    ["avoid cannot be ignored", { ...routeBody("car"), avoid: ["toll"] }, 422, "unsupported_options"],
    [
      "constraints cannot be ignored",
      { ...routeBody("car"), constraints: { wheelchair: true } },
      422,
      "unsupported_options",
    ],
    [
      "departure time cannot be ignored",
      { ...routeBody("car"), departureTime: "2026-08-10T08:00:00Z" },
      422,
      "unsupported_options",
    ],
  ];

  for (const [name, body, status, code] of cases) {
    await t.test(name, async () => {
      const response = await post(worker, "route", body, env);
      const payload = await response.json();
      assert.equal(response.status, status);
      assert.equal(payload.error.code, code);
    });
  }
});

test("matrix requests are bounded, profile-specific, and normalized", async () => {
  let calledUrl = null;
  const worker = createRoutingWorker({
    fetchImpl(url) {
      calledUrl = new URL(url);
      return jsonResponse({
        code: "Ok",
        distances: [[0, 1_200], [1_250, 0]],
        durations: [[0, 120], [125, 0]],
      });
    },
  });
  const response = await post(worker, "matrix", {
    profile: "foot",
    coordinates: ROUTE_COORDINATES,
    departureTime: null,
  }, {
    ROUTING_FOOT_BASE_URL: "https://foot-router.example/api",
    ROUTING_FOOT_UPSTREAM_PROFILE: "pedestrian",
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.profile, "foot");
  assert.deepEqual(payload.distancesMeters, [[0, 1_200], [1_250, 0]]);
  assert.deepEqual(payload.durationsSeconds, [[0, 120], [125, 0]]);
  assert.match(calledUrl.pathname, /\/api\/table\/v1\/pedestrian\//);
  assert.equal(calledUrl.searchParams.get("annotations"), "distance,duration");
});

test("malformed matrices and route geometries are rejected", async (t) => {
  await t.test("matrix shape", async () => {
    const worker = createRoutingWorker({
      fetchImpl() {
        return jsonResponse({
          code: "Ok",
          distances: [[0]],
          durations: [[0]],
        });
      },
    });
    const response = await post(worker, "matrix", {
      profile: "car",
      coordinates: ROUTE_COORDINATES,
    }, {
      ROUTING_CAR_BASE_URL: "https://car-router.example",
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "upstream_invalid_response");
  });

  await t.test("route geometry", async () => {
    const worker = createRoutingWorker({
      fetchImpl() {
        return jsonResponse(osrmRoutePayload({
          type: "LineString",
          coordinates: [[8.2, 146.8], [8.3, 46.9]],
        }));
      },
    });
    const response = await post(worker, "route", routeBody("car"), {
      ROUTING_CAR_BASE_URL: "https://car-router.example",
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "upstream_invalid_response");
  });
});

test("upstream timeouts and rate limits return safe structured errors", async (t) => {
  await t.test("timeout", async () => {
    const worker = createRoutingWorker({
      fetchImpl(_url, options) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
    });
    const response = await post(worker, "route", routeBody("car"), {
      ROUTING_CAR_BASE_URL: "https://car-router.example/private-path",
      ROUTING_CAR_TIMEOUT_MS: "100",
    });
    const payload = await response.json();

    assert.equal(response.status, 504);
    assert.equal(payload.error.code, "upstream_timeout");
    assert.equal(payload.error.retryable, true);
    assert.doesNotMatch(payload.error.message, /car-router|private-path/);
  });

  await t.test("rate limit", async () => {
    const worker = createRoutingWorker({
      fetchImpl() {
        return jsonResponse({ message: "secret upstream detail" }, {
          status: 429,
          headers: { "retry-after": "12" },
        });
      },
    });
    const response = await post(worker, "route", routeBody("car"), {
      ROUTING_CAR_BASE_URL: "https://car-router.example",
    });
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "12");
    assert.equal(payload.error.code, "upstream_rate_limited");
    assert.doesNotMatch(payload.error.message, /secret upstream detail/);
  });
});

test("body and content-type limits fail before calling an upstream", async (t) => {
  let upstreamCalls = 0;
  const worker = createRoutingWorker({
    fetchImpl() {
      upstreamCalls += 1;
      return jsonResponse(osrmRoutePayload());
    },
  });
  const env = { ROUTING_CAR_BASE_URL: "https://car-router.example" };

  await t.test("content type", async () => {
    const response = await worker.fetch(new Request(`${API_ROOT}/route`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(routeBody("car")),
    }), env);
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error.code, "unsupported_media_type");
  });

  await t.test("body size", async () => {
    const response = await worker.fetch(new Request(`${API_ROOT}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...routeBody("car"),
        padding: "x".repeat(ROUTING_LIMITS.requestBytes),
      }),
    }), env);
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "request_too_large");
  });

  assert.equal(upstreamCalls, 0);
});

function routeBody(profile) {
  return {
    profile,
    coordinates: ROUTE_COORDINATES,
    alternatives: false,
    avoid: [],
    departureTime: null,
    constraints: {},
  };
}

function osrmRoutePayload(geometry = {
  type: "LineString",
  coordinates: ROUTE_COORDINATES,
}) {
  return {
    code: "Ok",
    routes: [{
      geometry,
      distance: 12_345,
      duration: 1_234,
    }],
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function post(worker, operation, body, env) {
  return worker.fetch(new Request(`${API_ROOT}/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env);
}
