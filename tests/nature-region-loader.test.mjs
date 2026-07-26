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
      viewportRequestBytes: 8000000,
      initialNatureDataBytes: 10064000,
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

function spatialCellFixture(cellId, entities, options = {}) {
  const [zoom, x, y] = cellId.split("/").map(Number);
  const core = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "nature-spatial-cell-package",
    generated: true,
    cellId,
    zoom,
    x,
    y,
    shardIndex: 0,
    shardCount: 1,
    entities,
    ...(options.coreOverrides || {}),
  };
  const document = { ...core, contentHash: hashCore(core) };
  const contentHash = options.entryOverrides?.contentHash ?? document.contentHash;
  const hashPrefix = contentHash.slice("sha256:".length, "sha256:".length + 16);
  const entry = {
    shardIndex: 0,
    shardCount: 1,
    url: `assets/data/nature/spatial/cells/${zoom}/${x}/${y}/${hashPrefix}.json`,
    contentHash,
    bytes: Buffer.byteLength(`${buildCanonicalJson(document)}\n`),
    entityCount: entities.length,
    ...(options.entryOverrides || {}),
  };
  return {
    document,
    entry,
    cell: {
      cellId,
      zoom,
      x,
      y,
      entityCount: entities.length,
      packages: [entry],
    },
  };
}

function spatialIndexFixture(cellFixtures, options = {}) {
  const cells = cellFixtures.map((fixture) => fixture.cell)
    .toSorted((left, right) => left.cellId.localeCompare(right.cellId));
  const core = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "nature-spatial-index",
    generated: true,
    zoom: 8,
    cellCount: cells.length,
    packageCount: cells.reduce((sum, cell) => sum + cell.packages.length, 0),
    cells,
    ...(options.coreOverrides || {}),
  };
  const document = { ...core, contentHash: hashCore(core) };
  const contentHash = options.referenceOverrides?.contentHash ?? document.contentHash;
  const hashPrefix = contentHash.slice("sha256:".length, "sha256:".length + 16);
  const reference = {
    zoom: 8,
    url: `assets/data/nature/spatial/index/${hashPrefix}.json`,
    contentHash,
    bytes: Buffer.byteLength(`${buildCanonicalJson(document)}\n`),
    cellCount: document.cellCount,
    packageCount: document.packageCount,
    ...(options.referenceOverrides || {}),
  };
  return { document, reference };
}

function spatialEnvironment(cellFixtures, options = {}) {
  const regional = pair("japan", [
    entity("place:jp-regional-only", ["JP-13"], "japan"),
  ]);
  const index = options.indexFixture ?? spatialIndexFixture(cellFixtures);
  const manifestDocument = manifest([regional.entry], {
    spatialIndex: index.reference,
  });
  const routes = new Map([
    [DEFAULT_NATURE_MANIFEST_URL, manifestDocument],
    [regional.entry.url, regional.document],
    [index.reference.url, () => textJsonResponse(index.document)],
  ]);
  for (const fixture of cellFixtures) {
    routes.set(fixture.entry.url, () => textJsonResponse(fixture.document));
  }
  for (const [url, route] of options.routeOverrides || []) routes.set(url, route);
  const router = createFetchRouter(routes);
  const loader = new RegionalPackageLoader({
    ...(options.loaderOptions || {}),
    fetchImpl: router.fetchImpl,
    cryptoImpl: webcrypto,
  });
  return { ...router, loader, index, manifestDocument, regional };
}

function textJsonResponse(value, status = 200) {
  const raw = `${buildCanonicalJson(value)}\n`;
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return raw;
    },
  };
}

test("manifest-only boot defers the spatial index and viewport fetches only intersecting cells", async () => {
  const shared = entity("place:spatial-shared", ["JP-13"], "japan");
  const west = spatialCellFixture("8/128/128", [
    entity("place:spatial-west", ["JP-13"], "japan"),
    shared,
  ]);
  const east = spatialCellFixture("8/129/128", [
    shared,
    entity("place:spatial-east", ["JP-13"], "japan"),
  ]);
  const far = spatialCellFixture("8/200/100", [
    entity("place:spatial-far", ["JP-13"], "japan"),
  ]);
  const setup = spatialEnvironment([west, east, far]);

  await setup.loader.loadManifest();
  assert.deepEqual(
    setup.calls.map((call) => call.url),
    [DEFAULT_NATURE_MANIFEST_URL],
  );

  const bounds = [0, -1, 2, 0];
  const [first, concurrent] = await Promise.all([
    setup.loader.loadViewport(bounds),
    setup.loader.loadViewport(bounds),
  ]);
  assert.deepEqual(first.entities.map((item) => item.id), [
    "place:spatial-east",
    "place:spatial-shared",
    "place:spatial-west",
  ]);
  assert.deepEqual(concurrent.entities, first.entities);
  assert.deepEqual(first.cellIds, ["8/128/128", "8/129/128"]);
  assert.equal(first.rawPackageBytes, west.entry.bytes + east.entry.bytes);
  assert.deepEqual(setup.loader.cachedSpatialCellIds, first.cellIds);
  assert.equal(setup.calls.filter((call) => call.url === setup.index.reference.url).length, 1);
  assert.equal(setup.calls.filter((call) => call.url === west.entry.url).length, 1);
  assert.equal(setup.calls.filter((call) => call.url === east.entry.url).length, 1);
  assert.equal(setup.calls.some((call) => call.url === far.entry.url), false);
  assert.equal(setup.calls.some((call) => call.url === setup.regional.entry.url), false);

  const callCount = setup.calls.length;
  await setup.loader.loadViewport(bounds);
  assert.equal(setup.calls.length, callCount);
  assert.equal(setup.loader.hasCachedSpatialCell("8/128/128"), true);
  assert.equal(setup.loader.getCachedSpatialCell("8/128/128").cellId, "8/128/128");
});

test("wrapped viewport bounds select both sides of the antimeridian", async () => {
  const east = spatialCellFixture("8/255/127", [
    entity("place:dateline-east", ["JP-13"], "japan"),
  ]);
  const west = spatialCellFixture("8/0/127", [
    entity("place:dateline-west", ["JP-13"], "japan"),
  ]);
  const middle = spatialCellFixture("8/128/127", [
    entity("place:dateline-middle", ["JP-13"], "japan"),
  ]);
  const setup = spatialEnvironment([east, west, middle]);

  const viewport = await setup.loader.loadViewport([178, 0, -178, 1]);
  assert.deepEqual(viewport.cellIds, ["8/0/127", "8/255/127"]);
  assert.deepEqual(viewport.entities.map((item) => item.id), [
    "place:dateline-east",
    "place:dateline-west",
  ]);
  assert.equal(setup.calls.some((call) => call.url === middle.entry.url), false);
});

test("viewport validates bounds before fetching and old manifests retain regional loading", async () => {
  const japan = pair("japan", [entity("place:jp-old-manifest", ["JP-13"], "japan")]);
  const setup = environment([japan]);
  await assert.rejects(
    setup.loader.loadViewport([0, 20, 1, 10]),
    errorCode("invalid_viewport_bounds"),
  );
  assert.equal(setup.calls.length, 0);
  await assert.rejects(
    setup.loader.loadSpatialIndex(),
    errorCode("spatial_index_not_found"),
  );
  assert.equal((await setup.loader.loadRegion("japan")).entities.length, 1);
});

test("spatial index and cell byte, identity, and hash failures fail closed", async (t) => {
  await t.test("index bytes", async () => {
    const cell = spatialCellFixture("8/128/128", [
      entity("place:index-bytes", ["JP-13"], "japan"),
    ]);
    const index = spatialIndexFixture([cell]);
    index.reference.bytes += 1;
    const setup = spatialEnvironment([cell], { indexFixture: index });
    await assert.rejects(
      setup.loader.loadSpatialIndex(),
      errorCode("spatial_index_bytes_mismatch"),
    );
  });

  await t.test("index hash", async () => {
    const cell = spatialCellFixture("8/128/128", [
      entity("place:index-hash", ["JP-13"], "japan"),
    ]);
    const index = spatialIndexFixture([cell]);
    const corrupt = structuredClone(index.document);
    corrupt.cells[0].entityCount = 2;
    corrupt.cells[0].packages[0].entityCount = 2;
    assert.equal(
      Buffer.byteLength(`${buildCanonicalJson(corrupt)}\n`),
      index.reference.bytes,
    );
    const setup = spatialEnvironment([cell], {
      indexFixture: index,
      routeOverrides: [[index.reference.url, () => textJsonResponse(corrupt)]],
    });
    await assert.rejects(
      setup.loader.loadSpatialIndex(),
      errorCode("spatial_index_hash_mismatch"),
    );
  });

  await t.test("cell identity", async () => {
    const cell = spatialCellFixture("8/128/128", [
      entity("place:cell-identity", ["JP-13"], "japan"),
    ]);
    const corrupt = structuredClone(cell.document);
    corrupt.cellId = "8/129/128";
    corrupt.x = 129;
    assert.equal(
      Buffer.byteLength(`${buildCanonicalJson(corrupt)}\n`),
      cell.entry.bytes,
    );
    const setup = spatialEnvironment([cell], {
      routeOverrides: [[cell.entry.url, () => textJsonResponse(corrupt)]],
    });
    await assert.rejects(
      setup.loader.loadViewport([0, -1, 1, 0]),
      errorCode("spatial_package_identity_mismatch"),
    );
  });

  await t.test("cell hash", async () => {
    const cell = spatialCellFixture("8/128/128", [
      entity("place:cell-hash-a", ["JP-13"], "japan"),
    ]);
    const corrupt = structuredClone(cell.document);
    corrupt.entities[0].id = "place:cell-hash-b";
    assert.equal(
      Buffer.byteLength(`${buildCanonicalJson(corrupt)}\n`),
      cell.entry.bytes,
    );
    const setup = spatialEnvironment([cell], {
      routeOverrides: [[cell.entry.url, () => textJsonResponse(corrupt)]],
    });
    await assert.rejects(
      setup.loader.loadViewport([0, -1, 1, 0]),
      errorCode("spatial_package_hash_mismatch"),
    );
  });
});

test("viewport rejects conflicting copies of one entity across cells", async () => {
  const first = spatialCellFixture("8/128/128", [
    entity("place:viewport-conflict", ["JP-13"], "japan", { label: "first" }),
  ]);
  const second = spatialCellFixture("8/129/128", [
    entity("place:viewport-conflict", ["JP-13"], "japan", { label: "second" }),
  ]);
  const setup = spatialEnvironment([first, second]);
  await assert.rejects(
    setup.loader.loadViewport([0, -1, 2, 0]),
    errorCode("spatial_entity_conflict"),
  );
});

test("viewport request caps refuse before cell fetch and validate overrides", async () => {
  const first = spatialCellFixture("8/128/128", [
    entity("place:limit-first", ["JP-13"], "japan"),
  ]);
  const second = spatialCellFixture("8/129/128", [
    entity("place:limit-second", ["JP-13"], "japan"),
  ]);
  const setup = spatialEnvironment([first, second]);

  await assert.rejects(
    setup.loader.loadViewport([0, -1, 2, 0], { maxCells: 1 }),
    errorCode("viewport_request_limit_exceeded"),
  );
  assert.equal(setup.calls.some((call) => call.url === first.entry.url), false);
  assert.equal(setup.calls.some((call) => call.url === second.entry.url), false);

  const advertisedBytes = first.entry.bytes + second.entry.bytes;
  await assert.rejects(
    setup.loader.loadViewport([0, -1, 2, 0], { maxBytes: advertisedBytes - 1 }),
    (error) => error?.code === "viewport_request_limit_exceeded"
      && error.details.packageBytes === advertisedBytes
      && error.details.maxBytes === advertisedBytes - 1,
  );
  assert.equal(setup.calls.some((call) => call.url === first.entry.url), false);
  assert.equal(setup.calls.some((call) => call.url === second.entry.url), false);

  await assert.rejects(
    setup.loader.loadViewport([0, -1, 2, 0], { maxCells: 2, maxPackages: 1 }),
    errorCode("viewport_request_limit_exceeded"),
  );
  assert.equal(setup.calls.some((call) => call.url === first.entry.url), false);
  await assert.rejects(
    setup.loader.loadViewport([0, -1, 2, 0], { maxCells: 0 }),
    errorCode("invalid_viewport_limit"),
  );
  await assert.rejects(
    setup.loader.loadViewport([0, -1, 2, 0], { maxBytes: 0 }),
    errorCode("invalid_viewport_limit"),
  );
  assert.throws(
    () => new RegionalPackageLoader({
      fetchImpl: setup.fetchImpl,
      cryptoImpl: webcrypto,
      spatialCellCacheLimit: 0,
    }),
    /spatialCellCacheLimit must be a positive safe integer/,
  );
  assert.throws(
    () => new RegionalPackageLoader({
      fetchImpl: setup.fetchImpl,
      cryptoImpl: webcrypto,
      maxViewportBytes: 0,
    }),
    /maxViewportBytes must be a positive safe integer/,
  );
  assert.throws(
    () => new RegionalPackageLoader({
      fetchImpl: setup.fetchImpl,
      cryptoImpl: webcrypto,
      maxSpatialCellConcurrency: 0,
    }),
    /maxSpatialCellConcurrency must be a positive safe integer/,
  );
});

test("spatial cell cache evicts least-recently-used entries at its configured bound", async () => {
  const first = spatialCellFixture("8/128/128", [
    entity("place:cache-first", ["JP-13"], "japan"),
  ]);
  const second = spatialCellFixture("8/129/128", [
    entity("place:cache-second", ["JP-13"], "japan"),
  ]);
  const third = spatialCellFixture("8/130/128", [
    entity("place:cache-third", ["JP-13"], "japan"),
  ]);
  const setup = spatialEnvironment([first, second, third], {
    loaderOptions: { spatialCellCacheLimit: 2 },
  });

  await setup.loader.loadViewport([0, -1, 1, 0]);
  await setup.loader.loadViewport([1.5, -1, 2, 0]);
  await setup.loader.loadViewport([3, -1, 4, 0]);
  assert.deepEqual(setup.loader.cachedSpatialCellIds, ["8/129/128", "8/130/128"]);
  assert.equal(setup.loader.hasCachedSpatialCell("8/128/128"), false);

  setup.loader.getCachedSpatialCell("8/129/128");
  await setup.loader.loadViewport([0, -1, 1, 0]);
  assert.deepEqual(setup.loader.cachedSpatialCellIds, ["8/128/128", "8/129/128"]);
  assert.equal(setup.loader.hasCachedSpatialCell("8/130/128"), false);
  assert.equal(setup.calls.filter((call) => call.url === first.entry.url).length, 2);
});

test("spatial cell network concurrency is globally bounded across one viewport", async () => {
  const cells = Array.from({ length: 4 }, (_, index) => spatialCellFixture(
    `8/${128 + index}/128`,
    [entity(`place:concurrency-${index}`, ["JP-13"], "japan")],
  ));
  const gates = cells.map(() => deferred());
  const started = [];
  let active = 0;
  let maximumActive = 0;
  const setup = spatialEnvironment(cells, {
    loaderOptions: { maxSpatialCellConcurrency: 2 },
    routeOverrides: cells.map((fixture, index) => [
      fixture.entry.url,
      async () => {
        started.push(fixture.cell.cellId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gates[index].promise;
        active -= 1;
        return textJsonResponse(fixture.document);
      },
    ]),
  });

  const loading = setup.loader.loadViewport([0, -1, 5.5, 0]);
  await waitFor(() => started.length === 2);
  assert.equal(active, 2);
  assert.equal(maximumActive, 2);
  assert.deepEqual(started, ["8/128/128", "8/129/128"]);

  gates[0].resolve();
  gates[1].resolve();
  await waitFor(() => started.length === 4);
  assert.equal(maximumActive, 2);
  gates[2].resolve();
  gates[3].resolve();

  const viewport = await loading;
  assert.equal(viewport.entities.length, 4);
  assert.equal(active, 0);
  assert.equal(maximumActive, 2);
});

test("aborting one viewport caller preserves a shared in-flight cell fetch", async () => {
  const cell = spatialCellFixture("8/128/128", [
    entity("place:shared-abort", ["JP-13"], "japan"),
  ]);
  const gate = deferred();
  let fetches = 0;
  let underlyingAborts = 0;
  const setup = spatialEnvironment([cell], {
    loaderOptions: { maxSpatialCellConcurrency: 1 },
    routeOverrides: [[cell.entry.url, async (_url, options) => {
      fetches += 1;
      const onAbort = () => {
        underlyingAborts += 1;
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      await gate.promise;
      options.signal.removeEventListener("abort", onAbort);
      return textJsonResponse(cell.document);
    }]],
  });
  await setup.loader.loadSpatialIndex();

  const controller = new AbortController();
  const departingCaller = setup.loader.loadViewport(
    [0, -1, 1, 0],
    { signal: controller.signal },
  );
  const survivingCaller = setup.loader.loadViewport([0, -1, 1, 0]);
  await waitFor(() => fetches === 1);
  await new Promise((resolve) => setTimeout(resolve, 0));

  controller.abort();
  await assert.rejects(departingCaller, errorCode("aborted"));
  assert.equal(underlyingAborts, 0);
  gate.resolve();

  const viewport = await survivingCaller;
  assert.deepEqual(viewport.entities.map((item) => item.id), ["place:shared-abort"]);
  assert.equal(fetches, 1);
  assert.equal(underlyingAborts, 0);
});

test("rapid aborted viewports cancel queued and orphaned in-flight work", async () => {
  const cells = Array.from({ length: 6 }, (_, index) => spatialCellFixture(
    `8/${128 + index}/128`,
    [entity(`place:rapid-pan-${index}`, ["JP-13"], "japan")],
  ));
  let active = 0;
  let allowSuccess = false;
  let abortedFetches = 0;
  let maximumActive = 0;
  let started = 0;
  const routeOverrides = cells.map((fixture) => [
    fixture.entry.url,
    (_url, options) => new Promise((resolve, reject) => {
      let settled = false;
      active += 1;
      started += 1;
      maximumActive = Math.max(maximumActive, active);

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        active -= 1;
        options.signal.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = () => {
        abortedFetches += 1;
        const error = new Error("aborted");
        error.name = "AbortError";
        finish(reject, error);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (allowSuccess) {
        queueMicrotask(() => finish(resolve, textJsonResponse(fixture.document)));
      }
    }),
  ]);
  const setup = spatialEnvironment(cells, {
    loaderOptions: { maxSpatialCellConcurrency: 2 },
    routeOverrides,
  });
  await setup.loader.loadSpatialIndex();

  const firstController = new AbortController();
  const first = setup.loader.loadViewport(
    [0, -1, 8.3, 0],
    { signal: firstController.signal },
  );
  await waitFor(() => started === 2);
  firstController.abort();
  await assert.rejects(first, errorCode("aborted"));

  const secondController = new AbortController();
  const second = setup.loader.loadViewport(
    [0, -1, 8.3, 0],
    { signal: secondController.signal },
  );
  await waitFor(() => started === 4);
  secondController.abort();
  await assert.rejects(second, errorCode("aborted"));

  allowSuccess = true;
  const finalViewport = await setup.loader.loadViewport([0, -1, 8.3, 0]);
  assert.equal(finalViewport.entities.length, 6);
  assert.equal(started, 10);
  assert.equal(abortedFetches, 4);
  assert.equal(active, 0);
  assert.equal(maximumActive, 2);
  assert.equal(setup.loader.cachedSpatialCellIds.length, 6);
});

test("failed spatial cell jobs leave no stale promise and retry cleanly", async () => {
  const cell = spatialCellFixture("8/128/128", [
    entity("place:spatial-retry", ["JP-13"], "japan"),
  ]);
  let attempts = 0;
  const setup = spatialEnvironment([cell], {
    routeOverrides: [[cell.entry.url, () => {
      attempts += 1;
      return attempts === 1
        ? textJsonResponse({}, 503)
        : textJsonResponse(cell.document);
    }]],
  });

  await assert.rejects(
    setup.loader.loadViewport([0, -1, 1, 0]),
    errorCode("spatial_package_fetch_failed"),
  );
  assert.equal(setup.loader.hasCachedSpatialCell(cell.cell.cellId), false);

  const viewport = await setup.loader.loadViewport([0, -1, 1, 0]);
  assert.deepEqual(viewport.entities.map((item) => item.id), ["place:spatial-retry"]);
  assert.equal(attempts, 2);
  assert.equal(setup.loader.hasCachedSpatialCell(cell.cell.cellId), true);
});
