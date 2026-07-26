import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalDemoOsrmProvider,
  SameOriginRoutingProvider,
} from "../assets/js/nature/routing.mjs";

test("same-origin provider invokes browser fetch with globalThis as its receiver", async () => {
  const calls = [];
  function browserBrandedFetch(url, options) {
    assert.equal(this, globalThis);
    calls.push({ url, options });
    return Promise.resolve(new Response(JSON.stringify({
      provider: "fixture",
      routes: [{
        geometry: { type: "LineString", coordinates: [[7, 46], [8, 47]] },
        distanceMeters: 100,
        durationSeconds: 10,
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }

  const provider = new SameOriginRoutingProvider("/api/routing/v1/", browserBrandedFetch);
  const result = await provider.route({
    profile: "car",
    coordinates: [[7, 46], [8, 47]],
  });

  assert.equal(result.provider, "fixture");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/routing/v1/route");
  assert.equal(calls[0].options.method, "POST");
});

test("local demo provider invokes browser fetch with globalThis as its receiver", async () => {
  const calls = [];
  function browserBrandedFetch(url) {
    assert.equal(this, globalThis);
    calls.push(url);
    return Promise.resolve(new Response(JSON.stringify({
      code: "Ok",
      routes: [{
        geometry: { type: "LineString", coordinates: [[7, 46], [8, 47]] },
        distance: 100,
        duration: 10,
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }

  const provider = new LocalDemoOsrmProvider({
    hostname: "localhost",
    fetchImpl: browserBrandedFetch,
  });
  const result = await provider.route({
    profile: "car",
    coordinates: [[7, 46], [8, 47]],
  });

  assert.equal(result.provider, "osrm-demo");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/route\/v1\/driving\/7,46;8,47/);
});

test("same-origin provider preserves the explicit unavailable-fetch refusal", async () => {
  const provider = new SameOriginRoutingProvider("/api/routing/v1", null);
  await assert.rejects(
    provider.route({ profile: "car", coordinates: [[7, 46], [8, 47]] }),
    (error) => error?.code === "transport_unavailable",
  );
});
