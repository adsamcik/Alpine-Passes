import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildNatureData,
  canonicalJson,
  runIsolatedAdapters,
  shardRegionalPackage,
} from "../tools/nature/build.mjs";
import { ingestLegacyRepository } from "../tools/nature/lib/legacy-adapter.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("legacy POI cache is joined exactly, preserved losslessly, and never upgrades verification", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "itinera-legacy-cache-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await writeLegacyFixture(fixtureRoot);

  const result = await ingestLegacyRepository(fixtureRoot);
  const poi = result.records.find((record) =>
    record.entityType === "Place" && record.names[0].value === "Exact Place");
  const prices = result.records.filter((record) => record.entityType === "Price");
  const accessPoints = result.records.filter((record) => record.entityType === "AccessPoint");
  const cacheInventory = result.inventories.find((item) =>
    item.source === "assets/data/poi-prices.json");

  assert.ok(poi);
  assert.equal(prices.length, 1);
  assert.equal(accessPoints.length, 1);
  assert.deepEqual(result.unmatchedCacheKeys, ["Unmatched Place"]);
  assert.deepEqual(cacheInventory.unmatchedCacheKeys, ["Unmatched Place"]);
  assert.equal(cacheInventory.records, 2);
  assert.equal(cacheInventory.matchedRecords, 1);
  assert.equal(cacheInventory.unmatchedRecords, 1);

  const expectedMatched = fixtureCacheEntries()["Exact Place"];
  const expectedUnmatched = fixtureCacheEntries()["Unmatched Place"];
  const price = prices[0];
  assert.deepEqual(price.legacy.cacheRecord, expectedMatched);
  assert.deepEqual(cacheInventory.unmatchedCacheEntries, {
    "Unmatched Place": expectedUnmatched,
  });
  assert.deepEqual(
    {
      [price.legacy.cacheKey]: price.legacy.cacheRecord,
      ...cacheInventory.unmatchedCacheEntries,
    },
    fixtureCacheEntries(),
    "every cache record remains recoverable after migration",
  );

  assert.equal(price.priceKind, "from");
  assert.equal(price.amount, 12.5);
  assert.equal(price.currency, "CHF");
  assert.deepEqual(price.linkedEntityIds, [poi.id]);
  assert.deepEqual(poi.priceIds, [price.id]);
  assert.equal(price.quality.verificationStatus, "unverified");
  assert.ok(price.sourceAssertions.every((assertion) =>
    assertion.verificationStatus === "unverified"));
  assert.equal(
    price.sourceAssertions.find((assertion) =>
      assertion.sourceId === "legacy-poi-price-cache").evidenceKind,
    "third_party_claim",
  );
  assert.ok(!result.records.some((record) => record.entityType === "OpeningSchedule"));
  assert.equal(poi.cacheAccess.getting_there, "Preserve this text; do not parse 09:00–17:00.");

  const parking = accessPoints[0];
  assert.deepEqual(parking.geometry.coordinates, [8.125, 46.25]);
  assert.equal(parking.parking.name, "Exact cache parking");
  assert.equal(parking.parking.spaces, 17);
  assert.equal(parking.parking.fee, null);
  assert.equal(parking.legalAccess, "unknown");
  assert.ok(parking.sourceAssertions.some((assertion) =>
    assertion.sourceId === "legacy-poi-price-cache"
      && assertion.fieldPath === "/geometry"
      && assertion.verificationStatus === "unverified"));
  assert.deepEqual(poi.accessPointIds, [parking.id]);

  assert.equal(result.redirects.poi1, poi.id);
  assert.deepEqual(Object.keys(result.redirects), ["poi1"]);
});

test("adapter failures remain isolated when another adapter succeeds", async () => {
  const goodRecord = canonicalPlace("place:test-isolation", "test-region", 80);
  const ingestion = await runIsolatedAdapters([
    {
      id: "broken-adapter",
      async run() {
        throw new Error("fixture adapter failed");
      },
    },
    {
      id: "good-adapter",
      async run() {
        return {
          records: [goodRecord],
          redirects: { legacy: goodRecord.id },
          inventories: [],
        };
      },
    },
  ]);

  assert.equal(ingestion.results.length, 1);
  assert.equal(ingestion.results[0].adapterId, "good-adapter");
  assert.deepEqual(ingestion.results[0].records, [goodRecord]);
  assert.deepEqual(ingestion.failures, [{
    adapterId: "broken-adapter",
    message: "fixture adapter failed",
    isolated: true,
  }]);
});

test("regional shards are deterministic, budget-bound, and reject an oversized entity", () => {
  const records = [
    canonicalPlace("place:shard-c", "test-region", 650),
    canonicalPlace("place:shard-a", "test-region", 650),
    canonicalPlace("place:shard-d", "test-region", 650),
    canonicalPlace("place:shard-b", "test-region", 650),
  ];
  const budget = 2_300;
  const forward = shardRegionalPackage("test-region", records, budget);
  const reverse = shardRegionalPackage("test-region", [...records].reverse(), budget);

  assert.ok(forward.length > 1);
  assert.deepEqual(
    forward.map((shard) => shard.serialized),
    reverse.map((shard) => shard.serialized),
  );
  assert.deepEqual(
    forward.map((shard) => shard.shardIndex),
    Array.from({ length: forward.length }, (_, index) => index),
  );
  assert.ok(forward.every((shard) =>
    shard.shardCount === forward.length
      && Buffer.byteLength(shard.serialized) <= budget
      && shard.packageDocument.regionId === "test-region"
      && shard.packageDocument.shardIndex === shard.shardIndex
      && shard.packageDocument.shardCount === shard.shardCount));

  assert.throws(
    () => shardRegionalPackage(
      "test-region",
      [canonicalPlace("place:too-large", "test-region", 8_000)],
      1_000,
    ),
    /cannot fit regional package budget/,
  );
});

test("build emits deterministic multi-entry manifests, bounded raw files, failures, and redirects", async (t) => {
  const firstOutput = await mkdtemp(path.join(os.tmpdir(), "itinera-build-a-"));
  const secondOutput = await mkdtemp(path.join(os.tmpdir(), "itinera-build-b-"));
  t.after(async () => {
    await Promise.all([
      rm(firstOutput, { recursive: true, force: true }),
      rm(secondOutput, { recursive: true, force: true }),
    ]);
  });
  const budget = 2_300;
  const records = [
    canonicalPlace("place:build-c", "test-region", 650),
    canonicalPlace("place:build-a", "test-region", 650),
    canonicalPlace("place:build-d", "test-region", 650),
    canonicalPlace("place:build-b", "test-region", 650),
  ];

  const first = await buildNatureData({
    repoRoot: REPO_ROOT,
    outputRoot: firstOutput,
    budgets: { regionalPackageBytes: budget },
    adapters: buildAdapters(records),
  });
  const second = await buildNatureData({
    repoRoot: REPO_ROOT,
    outputRoot: secondOutput,
    budgets: { regionalPackageBytes: budget },
    adapters: buildAdapters([...records].reverse()),
  });

  const firstManifestText = await readFile(path.join(firstOutput, "manifest.v1.json"), "utf8");
  const secondManifestText = await readFile(path.join(secondOutput, "manifest.v1.json"), "utf8");
  const manifest = JSON.parse(firstManifestText);
  assert.equal(first.buildId, second.buildId);
  assert.equal(firstManifestText, secondManifestText);
  assert.equal(manifest.budgets.regionalPackageBytes, budget);

  const regionEntries = manifest.packages.filter((entry) => entry.regionId === "test-region");
  assert.ok(regionEntries.length > 1);
  assert.deepEqual(
    regionEntries.map((entry) => entry.shardIndex),
    Array.from({ length: regionEntries.length }, (_, index) => index),
  );
  assert.ok(regionEntries.every((entry) =>
    entry.shardCount === regionEntries.length && entry.bytes <= budget));

  for (const entry of regionEntries) {
    const filename = path.basename(entry.url);
    const packagePath = path.join(firstOutput, "packages", entry.regionId, filename);
    const [raw, fileStats] = await Promise.all([
      readFile(packagePath, "utf8"),
      stat(packagePath),
    ]);
    const document = JSON.parse(raw);
    assert.equal(fileStats.size, entry.bytes);
    assert.ok(fileStats.size <= budget);
    assert.equal(document.regionId, entry.regionId);
    assert.equal(document.shardIndex, entry.shardIndex);
    assert.equal(document.shardCount, entry.shardCount);
    const core = { ...document };
    delete core.contentHash;
    assert.equal(
      document.contentHash,
      `sha256:${createHash("sha256").update(canonicalJson(core)).digest("hex")}`,
    );
  }

  const redirectDocument = JSON.parse(
    await readFile(path.join(firstOutput, "legacy-id-redirects.v1.json"), "utf8"),
  );
  assert.deepEqual(redirectDocument.redirects, {
    "legacy-build-a": "place:build-a",
    "legacy-build-b": "place:build-b",
  });
  const ingestionReport = JSON.parse(
    await readFile(path.join(firstOutput, "ingestion-report.v1.json"), "utf8"),
  );
  assert.deepEqual(ingestionReport.failures, [{
    adapterId: "broken-fixture",
    isolated: true,
    message: "isolated build fixture failure",
  }]);
  assert.deepEqual(
    ingestionReport.adapters.find((adapter) => adapter.id === "fixture-records")
      .unmatchedCacheKeys,
    [],
  );

  const firstFiles = await packageFiles(firstOutput);
  const secondFiles = await packageFiles(secondOutput);
  assert.deepEqual(firstFiles, secondFiles);
});

function buildAdapters(records) {
  return [
    {
      id: "broken-fixture",
      async run() {
        throw new Error("isolated build fixture failure");
      },
    },
    {
      id: "fixture-records",
      async run() {
        return {
          adapterId: "fixture-records",
          records,
          redirects: {
            "legacy-build-b": "place:build-b",
            "legacy-build-a": "place:build-a",
          },
          inventories: [{ source: "test fixture", records: records.length }],
        };
      },
    },
  ];
}

function canonicalPlace(id, regionId, summaryLength) {
  return {
    schemaVersion: "1.0.0",
    id,
    entityType: "Place",
    jurisdictionIds: ["CH"],
    names: [{ language: "en", value: id, kind: "primary" }],
    geometry: { type: "Point", coordinates: [8, 46] },
    summary: "x".repeat(summaryLength),
    sourceAssertions: [{
      id: `${id}:source`,
      sourceId: "manual-seed-routes",
      sourceRecordId: id,
      fieldPath: "/",
      evidenceKind: "maintainer_curated",
      verificationStatus: "unverified",
      confidence: 0.25,
      observedAt: null,
      validFrom: null,
      validUntil: null,
      retrievedAt: null,
      notes: "Deterministic pipeline fixture.",
    }],
    quality: {
      confidence: 0.25,
      verificationStatus: "unverified",
      assessedAt: "2026-07-26",
      geometryConfidence: 0.25,
      accessConfidence: 0.1,
      freshness: "unknown",
      flags: ["test_fixture"],
    },
    sensitivity: {
      action: "publish",
      reason: "Synthetic pipeline fixture.",
    },
    deliveryRegions: [regionId],
  };
}

async function packageFiles(outputRoot) {
  const regionRoot = path.join(outputRoot, "packages", "test-region");
  const names = (await readdir(regionRoot)).sort();
  return Promise.all(names.map(async (name) => [
    name,
    await readFile(path.join(regionRoot, name), "utf8"),
  ]));
}

async function writeLegacyFixture(root) {
  const inputs = [
    ["assets/js/passes-data.js", "ALPS_RAW", []],
    ["assets/js/japan-passes.js", "JAPAN_PASSES", []],
    ["assets/js/uk-ireland-passes.js", "UK_IRELAND_PASSES", []],
    ["assets/js/swiss-pois.js", "SWISS_POIS", [{
      n: "Exact Place",
      la: 46,
      lo: 8,
      cat: "museum",
      access: ["car"],
      region: "Bern",
    }]],
    ["assets/js/french-pois.js", "FRENCH_POIS", []],
    ["assets/js/italy-pois.js", "ITALY_POIS", []],
    ["assets/js/austrian-pois.js", "AUSTRIAN_POIS", []],
    ["assets/js/japan-pois.js", "JAPAN_POIS", []],
    ["assets/js/uk-pois.js", "UK_POIS", []],
    ["assets/js/irish-pois.js", "IRISH_POIS", []],
    ["assets/js/japan-scenic-drives.js", "JAPAN_SCENIC_DRIVES", []],
    ["assets/js/uk-ireland-scenic-drives.js", "UK_IRELAND_SCENIC_DRIVES", []],
  ];
  for (const [relativePath, variable, value] of inputs) {
    const filename = path.join(root, relativePath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, `const ${variable} = ${JSON.stringify(value)};\n`, "utf8");
  }
  const cachePath = path.join(root, "assets/data/poi-prices.json");
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify({
    schema_version: 2,
    default_currency: "CHF",
    last_refreshed_at: "2026-07-23T19:07:58Z",
    entries: fixtureCacheEntries(),
  }, null, 2)}\n`, "utf8");
}

function fixtureCacheEntries() {
  return {
    "Exact Place": {
      kind: "paid",
      from_adult: 12.5,
      currency: "CHF",
      source_url: "https://www.wikidata.org/wiki/Q123",
      source_kind: "wikidata",
      verified_at: "2026-07-20",
      notes: "Adult starting price; other tariffs are not represented.",
      car_status: "gateway-parking",
      parking: {
        la: 46.25,
        lo: 8.125,
        name: "Exact cache parking",
        cost: "CHF 4",
        currency: "CHF",
        spaces: 17,
      },
      getting_there: "Preserve this text; do not parse 09:00–17:00.",
    },
    "Unmatched Place": {
      kind: "free",
      source_url: "https://example.test/unmatched",
      source_kind: "manual",
      verified_at: "2026-07-21",
      notes: "A stale key retained for migration review.",
    },
  };
}
