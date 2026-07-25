import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";

import {
  DEFAULT_NATURE_MANIFEST_URL,
  RegionLoaderError,
  RegionalPackageLoader,
  canonicalJson,
} from "../assets/js/nature/region-loader.mjs";
import { canonicalJson as buildCanonicalJson } from "../tools/nature/build.mjs";

const SCHEMA_VERSION = "1.0.0";

function entity(id, jurisdictionIds, regionId, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    entityType: "Place",
    jurisdictionIds,
    deliveryRegions: [regionId],
    geometry: { type: "Point", coordinates: [0, 0] },
    ...extra,
  };
}

function packageDocument(regionId, entities, coreOverrides = {}) {
  const core = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "nature-region-package",
    generated: true,
    regionId,
    entities,
    ...coreOverrides,
  };
  return {
    ...core,
    contentHash: hashCore(core),
  };
}

function manifestEntry(document, overrides = {}) {
  const regionId = overrides.regionId ?? document.regionId;
  const contentHash = overrides.contentHash ?? document.contentHash;
  const jurisdictionIds = overrides.jurisdictionIds
    ?? [...new Set(document.entities.flatMap((item) => item.jurisdictionIds || []))].sort();
  const hashPrefix = contentHash.slice("sha256:".length, "sha256:".length + 16);
  return {
    regionId,
    url: "assets/data/nature/packages/" + regionId + "/" + hashPrefix + ".json",
    contentHash,
    bytes: JSON.stringify(document).length,
    bounds: [0, 0, 0, 0],
    jurisdictionIds,
    entityCounts: { Place: document.entities.length },
    completeEstablishedRoutes: 0,
    attributionSourceIds: [],
    ...overrides,
  };
}

function manifest(entries, overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "nature-package-manifest",
    generated: true,
    buildId: "0123456789abcdef",
    packages: entries,
    budgets: {
      manifestBytes: 64000,
      regionalPackageBytes: 2500000,
      initialNatureDataBytes: 64000,
    },
    ...overrides,
  };
}

function pair(regionId, entities, options = {}) {
  const document = packageDocument(regionId, entities, options.coreOverrides);
  const entry = manifestEntry(document, options.entryOverrides);
  return { document, entry };
}

function hashCore(core) {
  return "sha256:" + createHash("sha256")
    .update(buildCanonicalJson(core))
    .digest("hex");
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(value);
    },
  };
}

function invalidJsonResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      throw new SyntaxError("invalid JSON");
    },
  };
}

function createFetchRouter(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const key = String(url);
    calls.push({ url: key, options: structuredClone(options) });
    if (!routes.has(key)) return jsonResponse({ error: "not found" }, 404);
    const route = routes.get(key);
    if (typeof route === "function") return route(key, options);
    return jsonResponse(route);
  };
  return { calls, fetchImpl };
}

function environment(pairs, options = {}) {
  const entries = pairs.map((item) => item.entry);
  const manifestDocument = options.manifestDocument ?? manifest(entries);
  const routes = new Map([[DEFAULT_NATURE_MANIFEST_URL, manifestDocument]]);
  for (const item of pairs) routes.set(item.entry.url, item.document);
  for (const [url, route] of options.routeOverrides || []) routes.set(url, route);
  const router = createFetchRouter(routes);
  const loader = new RegionalPackageLoader({
    fetchImpl: router.fetchImpl,
    cryptoImpl: Object.hasOwn(options, "cryptoImpl") ? options.cryptoImpl : webcrypto,
  });
  return { ...router, loader, manifestDocument };
}

function errorCode(code) {
  return (error) => {
    assert.ok(error instanceof RegionLoaderError);
    assert.equal(error.code, code);
    return true;
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
}

test("loader canonical JSON exactly matches the nature build pipeline hash rule", () => {
  const value = {
    z: [{ b: 2, a: 1 }],
    a: { delta: true, alpha: null },
    nested: { c: { y: 2, x: 1 }, b: [3, 2, 1] },
  };
  assert.equal(canonicalJson(value), buildCanonicalJson(value));
  assert.equal(
    canonicalJson(value),
    '{"a":{"alpha":null,"delta":true},"nested":{"b":[3,2,1],"c":{"x":1,"y":2}},"z":[{"a":1,"b":2}]}',
  );
});

test("only requested content-addressed packages are fetched and cached in memory", async () => {
  const japan = pair("japan", [
    entity("place:jp-kyoto", ["JP-26"], "japan"),
  ]);
  const norway = pair("norway", [
    entity("place:no-jotunheimen", ["NO-34"], "norway"),
  ]);
  const { calls, loader } = environment([japan, norway]);

  assert.equal(calls.length, 0);
  const firstJapan = await loader.loadRegion("japan");
  assert.deepEqual(
    calls.map((call) => call.url),
    [DEFAULT_NATURE_MANIFEST_URL, japan.entry.url],
  );
  assert.equal(calls[0].options.cache, "no-cache");
  assert.equal(calls[1].options.cache, "force-cache");
  assert.ok(!calls.some((call) => call.url === norway.entry.url));
  assert.ok(Object.isFrozen(firstJapan));
  assert.ok(Object.isFrozen(firstJapan.entities[0]));

  const cachedJapan = await loader.loadRegion("japan");
  assert.equal(cachedJapan, firstJapan);
  assert.equal(calls.length, 2);
  assert.equal(loader.hasCachedRegion("japan"), true);
  assert.equal(loader.getCachedRegion("japan"), firstJapan);

  const requested = await loader.loadRegions(["norway", "japan", "norway"]);
  assert.deepEqual(requested.map((item) => item.regionId), ["norway", "japan"]);
  assert.deepEqual(loader.cachedRegionIds, ["japan", "norway"]);
  assert.equal(calls.filter((call) => call.url === norway.entry.url).length, 1);
});

test("concurrent region loads share one fetch while caller aborts remain isolated", async () => {
  const japan = pair("japan", [
    entity("place:jp-nagano", ["JP-20"], "japan"),
  ]);
  const gate = deferred();
  const packageRoute = async () => {
    await gate.promise;
    return jsonResponse(japan.document);
  };
  const setup = environment([japan], {
    routeOverrides: [[japan.entry.url, packageRoute]],
  });
  await setup.loader.loadManifest();

  const controller = new AbortController();
  const abortedCaller = setup.loader.loadRegion("japan", { signal: controller.signal });
  const survivingCaller = setup.loader.loadRegion("japan");
  await waitFor(
    () => setup.calls.filter((call) => call.url === japan.entry.url).length === 1,
  );

  controller.abort();
  await assert.rejects(abortedCaller, errorCode("aborted"));
  gate.resolve();

  const loaded = await survivingCaller;
  assert.equal(loaded.regionId, "japan");
  assert.equal(
    setup.calls.filter((call) => call.url === japan.entry.url).length,
    1,
  );
  assert.equal(await setup.loader.loadRegion("japan"), loaded);
});

test("a pre-aborted signal rejects before starting any network request", async () => {
  const japan = pair("japan", [
    entity("place:jp-hokkaido", ["JP-01"], "japan"),
  ]);
  const setup = environment([japan]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    setup.loader.loadRegion("japan", controller.signal),
    errorCode("aborted"),
  );
  assert.equal(setup.calls.length, 0);
});

test("unknown and invalid region IDs fail with stable codes without package overfetch", async () => {
  const japan = pair("japan", [
    entity("place:jp-aomori", ["JP-02"], "japan"),
  ]);
  const setup = environment([japan]);

  await assert.rejects(
    setup.loader.loadRegion("north-america"),
    errorCode("region_not_found"),
  );
  assert.deepEqual(
    setup.calls.map((call) => call.url),
    [DEFAULT_NATURE_MANIFEST_URL],
  );
  await assert.rejects(
    setup.loader.loadRegion("../japan"),
    errorCode("invalid_region_id"),
  );
  assert.equal(setup.calls.length, 1);
});

test("manifest schema, identity, duplicate regions, and content addressing are enforced", async (t) => {
  const japan = pair("japan", [
    entity("place:jp-toyama", ["JP-16"], "japan"),
  ]);
  const cases = [
    {
      name: "schema version",
      mutate(document) {
        document.schemaVersion = "2.0.0";
      },
      code: "manifest_schema_mismatch",
    },
    {
      name: "artifact identity",
      mutate(document) {
        document.artifactType = "nature-index";
      },
      code: "manifest_invalid",
    },
    {
      name: "duplicate region",
      mutate(document) {
        document.packages.push(structuredClone(document.packages[0]));
      },
      code: "manifest_invalid",
    },
    {
      name: "content-addressed filename",
      mutate(document) {
        document.packages[0].url = "assets/data/nature/packages/japan/latest.json";
      },
      code: "manifest_invalid",
    },
    {
      name: "cross-region URL",
      mutate(document) {
        const filename = document.packages[0].url.split("/").at(-1);
        document.packages[0].url = "assets/data/nature/packages/norway/" + filename;
      },
      code: "manifest_invalid",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const manifestDocument = manifest([japan.entry]);
      item.mutate(manifestDocument);
      const setup = environment([japan], { manifestDocument });
      await assert.rejects(
        setup.loader.loadRegion("japan"),
        errorCode(item.code),
      );
      assert.equal(
        setup.calls.filter((call) => call.url === japan.entry.url).length,
        0,
      );
    });
  }
});

test("malformed JSON and HTTP failures have source-specific stable error codes", async (t) => {
  const japan = pair("japan", [
    entity("place:jp-gifu", ["JP-21"], "japan"),
  ]);

  await t.test("manifest JSON", async () => {
    const router = createFetchRouter(new Map([
      [DEFAULT_NATURE_MANIFEST_URL, () => invalidJsonResponse()],
    ]));
    const loader = new RegionalPackageLoader({
      fetchImpl: router.fetchImpl,
      cryptoImpl: webcrypto,
    });
    await assert.rejects(loader.loadManifest(), errorCode("manifest_invalid_json"));
  });

  await t.test("manifest HTTP", async () => {
    const router = createFetchRouter(new Map([
      [DEFAULT_NATURE_MANIFEST_URL, () => jsonResponse({}, 503)],
    ]));
    const loader = new RegionalPackageLoader({
      fetchImpl: router.fetchImpl,
      cryptoImpl: webcrypto,
    });
    await assert.rejects(loader.loadManifest(), errorCode("manifest_fetch_failed"));
  });

  await t.test("package JSON", async () => {
    const setup = environment([japan], {
      routeOverrides: [[japan.entry.url, () => invalidJsonResponse()]],
    });
    await assert.rejects(
      setup.loader.loadRegion("japan"),
      errorCode("package_invalid_json"),
    );
  });

  await t.test("package HTTP", async () => {
    const setup = environment([japan], {
      routeOverrides: [[japan.entry.url, () => jsonResponse({}, 502)]],
    });
    await assert.rejects(
      setup.loader.loadRegion("japan"),
      errorCode("package_fetch_failed"),
    );
  });
});

test("package schema, region, jurisdictions, entity IDs, and delivery identity are verified", async (t) => {
  const cases = [
    {
      name: "package schema",
      create() {
        return pair(
          "japan",
          [entity("place:jp-ishikawa", ["JP-17"], "japan")],
          { coreOverrides: { schemaVersion: "2.0.0" } },
        );
      },
      code: "package_schema_mismatch",
    },
    {
      name: "package region",
      create() {
        const norway = pair(
          "norway",
          [entity("place:no-vestland", ["NO-46"], "norway")],
        );
        norway.entry = manifestEntry(norway.document, { regionId: "japan" });
        return norway;
      },
      code: "package_identity_mismatch",
    },
    {
      name: "manifest jurisdiction union",
      create() {
        return pair(
          "japan",
          [entity("place:jp-yamanashi", ["JP-19"], "japan")],
          { entryOverrides: { jurisdictionIds: ["JP-20"] } },
        );
      },
      code: "package_jurisdiction_mismatch",
    },
    {
      name: "invalid entity ID",
      create() {
        return pair(
          "japan",
          [entity("x", ["JP-13"], "japan")],
        );
      },
      code: "package_entity_invalid",
    },
    {
      name: "duplicate entity ID",
      create() {
        return pair(
          "japan",
          [
            entity("place:jp-duplicate", ["JP-13"], "japan"),
            entity("place:jp-duplicate", ["JP-13"], "japan"),
          ],
        );
      },
      code: "package_entity_invalid",
    },
    {
      name: "entity schema",
      create() {
        return pair(
          "japan",
          [entity("place:jp-schema", ["JP-13"], "japan", { schemaVersion: "2.0.0" })],
        );
      },
      code: "package_entity_invalid",
    },
    {
      name: "delivery region",
      create() {
        return pair(
          "japan",
          [entity("place:jp-misassigned", ["JP-13"], "norway")],
        );
      },
      code: "package_identity_mismatch",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = item.create();
      const setup = environment([fixture]);
      await assert.rejects(
        setup.loader.loadRegion("japan"),
        errorCode(item.code),
      );
      assert.equal(setup.loader.hasCachedRegion("japan"), false);
    });
  }
});

test("declared and recomputed package hashes must match the manifest", async (t) => {
  await t.test("declared hash mismatch", async () => {
    const japan = pair("japan", [
      entity("place:jp-declared-hash", ["JP-13"], "japan"),
    ]);
    japan.document.contentHash = "sha256:" + "f".repeat(64);
    const setup = environment([japan]);
    await assert.rejects(
      setup.loader.loadRegion("japan"),
      errorCode("package_hash_mismatch"),
    );
  });

  await t.test("payload corruption after hashing", async () => {
    const japan = pair("japan", [
      entity("place:jp-corrupt", ["JP-13"], "japan"),
    ]);
    japan.document.entities[0].unexpectedMutation = "corrupt";
    const setup = environment([japan]);
    await assert.rejects(
      setup.loader.loadRegion("japan"),
      errorCode("package_hash_mismatch"),
    );
  });

  await t.test("Web Crypto unavailable", async () => {
    const japan = pair("japan", [
      entity("place:jp-no-crypto", ["JP-13"], "japan"),
    ]);
    const setup = environment([japan], { cryptoImpl: {} });
    await assert.rejects(
      setup.loader.loadRegion("japan"),
      errorCode("hash_unavailable"),
    );
  });
});

test("failed regional requests are not cached and can be retried", async () => {
  const japan = pair("japan", [
    entity("place:jp-retry", ["JP-13"], "japan"),
  ]);
  let attempts = 0;
  const setup = environment([japan], {
    routeOverrides: [[japan.entry.url, () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({}, 503)
        : jsonResponse(japan.document);
    }]],
  });

  await assert.rejects(
    setup.loader.loadRegion("japan"),
    errorCode("package_fetch_failed"),
  );
  assert.equal(setup.loader.hasCachedRegion("japan"), false);

  const loaded = await setup.loader.loadRegion("japan");
  assert.equal(loaded.regionId, "japan");
  assert.equal(attempts, 2);
  assert.equal(setup.loader.hasCachedRegion("japan"), true);
});
test("sharded regions fetch all shards concurrently and return one deduplicated package set", async () => {
  const shared = entity("place:jp-shared", ["JP-13"], "japan", { label: "same" });
  const shardZero = pair(
    "japan",
    [
      entity("place:jp-alpha", ["JP-13"], "japan"),
      shared,
    ],
    {
      coreOverrides: { shardIndex: 0, shardCount: 2 },
      entryOverrides: { shardIndex: 0, shardCount: 2 },
    },
  );
  const shardOne = pair(
    "japan",
    [
      shared,
      entity("place:jp-zeta", ["JP-13"], "japan"),
    ],
    {
      coreOverrides: { shardIndex: 1, shardCount: 2 },
      entryOverrides: { shardIndex: 1, shardCount: 2 },
    },
  );

  const gate = deferred();
  let started = 0;
  const delayed = (document) => async () => {
    started += 1;
    await gate.promise;
    return jsonResponse(document);
  };
  const setup = environment([shardOne, shardZero], {
    routeOverrides: [
      [shardZero.entry.url, delayed(shardZero.document)],
      [shardOne.entry.url, delayed(shardOne.document)],
    ],
  });

  const loading = setup.loader.loadRegion("japan");
  await waitFor(() => started === 2);
  assert.equal(
    setup.calls.filter((call) =>
      [shardZero.entry.url, shardOne.entry.url].includes(call.url)).length,
    2,
  );
  gate.resolve();

  const logical = await loading;
  assert.equal(logical.artifactType, "nature-region-package-set");
  assert.equal(logical.regionId, "japan");
  assert.equal(logical.shardCount, 2);
  assert.deepEqual(
    logical.packages.map((document) => document.shardIndex),
    [0, 1],
  );
  assert.deepEqual(
    logical.contentHashes,
    [shardZero.document.contentHash, shardOne.document.contentHash],
  );
  assert.deepEqual(
    logical.entities.map((item) => item.id),
    ["place:jp-alpha", "place:jp-shared", "place:jp-zeta"],
  );
  assert.deepEqual(logical.jurisdictionIds, ["JP-13"]);
  assert.ok(Object.isFrozen(logical.packages[0]));
  assert.equal(await setup.loader.loadRegion("japan"), logical);
  assert.equal(started, 2);
});

test("manifest shard metadata must be complete, consistent, and zero-based", async (t) => {
  function shards() {
    return [
      pair(
        "japan",
        [entity("place:jp-shard-a", ["JP-13"], "japan")],
        {
          coreOverrides: { shardIndex: 0, shardCount: 2 },
          entryOverrides: { shardIndex: 0, shardCount: 2 },
        },
      ),
      pair(
        "japan",
        [entity("place:jp-shard-b", ["JP-13"], "japan")],
        {
          coreOverrides: { shardIndex: 1, shardCount: 2 },
          entryOverrides: { shardIndex: 1, shardCount: 2 },
        },
      ),
    ];
  }

  const cases = [
    {
      name: "missing identity on one shard",
      mutate(items) {
        delete items[1].entry.shardIndex;
        delete items[1].entry.shardCount;
      },
    },
    {
      name: "only one shard field",
      mutate(items) {
        delete items[1].entry.shardCount;
      },
    },
    {
      name: "count does not match entry count",
      mutate(items) {
        items[0].entry.shardCount = 3;
        items[1].entry.shardCount = 3;
      },
    },
    {
      name: "duplicate index leaves a gap",
      mutate(items) {
        items[1].entry.shardIndex = 0;
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixtures = shards();
      item.mutate(fixtures);
      const setup = environment(fixtures);
      await assert.rejects(
        setup.loader.loadRegion("japan"),
        errorCode("manifest_invalid"),
      );
      assert.equal(
        setup.calls.filter((call) => call.url !== DEFAULT_NATURE_MANIFEST_URL).length,
        0,
      );
    });
  }
});

test("package shard identity must exactly match its manifest entry", async () => {
  const mismatch = pair(
    "japan",
    [entity("place:jp-shard-mismatch", ["JP-13"], "japan")],
    {
      coreOverrides: { shardIndex: 1, shardCount: 2 },
      entryOverrides: { shardIndex: 0, shardCount: 1 },
    },
  );
  const setup = environment([mismatch]);

  await assert.rejects(
    setup.loader.loadRegion("japan"),
    errorCode("package_identity_mismatch"),
  );
  assert.equal(setup.loader.hasCachedRegion("japan"), false);
});

test("conflicting duplicate entity IDs across shards invalidate the logical region", async () => {
  const shardZero = pair(
    "japan",
    [entity("place:jp-conflict", ["JP-13"], "japan", { label: "first" })],
    {
      coreOverrides: { shardIndex: 0, shardCount: 2 },
      entryOverrides: { shardIndex: 0, shardCount: 2 },
    },
  );
  const shardOne = pair(
    "japan",
    [entity("place:jp-conflict", ["JP-13"], "japan", { label: "second" })],
    {
      coreOverrides: { shardIndex: 1, shardCount: 2 },
      entryOverrides: { shardIndex: 1, shardCount: 2 },
    },
  );
  const setup = environment([shardZero, shardOne]);

  await assert.rejects(
    setup.loader.loadRegion("japan"),
    errorCode("package_entity_conflict"),
  );
  assert.equal(setup.loader.hasCachedRegion("japan"), false);
  assert.equal(
    setup.calls.filter((call) => call.url !== DEFAULT_NATURE_MANIFEST_URL).length,
    2,
  );
});

test("one corrupt shard rejects and prevents caching of the whole logical region", async () => {
  const shardZero = pair(
    "japan",
    [entity("place:jp-good-shard", ["JP-13"], "japan")],
    {
      coreOverrides: { shardIndex: 0, shardCount: 2 },
      entryOverrides: { shardIndex: 0, shardCount: 2 },
    },
  );
  const shardOne = pair(
    "japan",
    [entity("place:jp-corrupt-shard", ["JP-13"], "japan")],
    {
      coreOverrides: { shardIndex: 1, shardCount: 2 },
      entryOverrides: { shardIndex: 1, shardCount: 2 },
    },
  );
  shardOne.document.entities[0].corruption = true;
  const setup = environment([shardZero, shardOne]);

  await assert.rejects(
    setup.loader.loadRegion("japan"),
    errorCode("package_hash_mismatch"),
  );
  assert.equal(setup.loader.hasCachedRegion("japan"), false);
  assert.equal(
    setup.calls.filter((call) => call.url !== DEFAULT_NATURE_MANIFEST_URL).length,
    2,
  );
});
