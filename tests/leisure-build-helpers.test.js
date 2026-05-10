const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, relPath)).href;
}

const geoModule = import(moduleUrl("tools/leisure/lib/geo.mjs"));
const scoringModule = import(moduleUrl("tools/leisure/lib/scoring.mjs"));

test("haversineM returns canonical great-circle distances", async () => {
  const { haversineM } = await geoModule;

  assert.equal(haversineM({ lat: 46, lon: 8 }, { lat: 46, lon: 8 }), 0);
  assert.ok(Math.abs(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111_195) < 150);
  assert.ok(Math.abs(haversineM({ lat: 48.8566, lon: 2.3522 }, { lat: 51.5074, lon: -0.1278 }) - 343_556) < 1_000);
});

test("leisureCost penalizes highways, rewards scenery, and applies out-and-back multiplier", async () => {
  const { leisureCost } = await scoringModule;

  const primary = leisureCost(1_000, "primary", 0);
  const motorway = leisureCost(1_000, "motorway", 0);
  const scenicPrimary = leisureCost(1_000, "primary", 0.4);

  assert.ok(motorway > primary);
  assert.ok(scenicPrimary < primary);
  assert.equal(leisureCost(1_000, "primary", 0.1, 1.6), leisureCost(1_000, "primary", 0.1) * 1.6);
});

test("z-normalization centers values and handles constant inputs", async () => {
  const { statsFor, zNormalize, zScore } = await scoringModule;
  const values = [1, 2, 3, 4, 5];
  const normalized = zNormalize(values);
  const mean = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  const variance = normalized.reduce((sum, value) => sum + value ** 2, 0) / normalized.length;

  assert.ok(Math.abs(mean) < 1e-12);
  assert.ok(Math.abs(variance - 1) < 1e-12);
  assert.equal(zScore(3, statsFor(values)), 0);
  assert.deepEqual(zNormalize([5, 5, 5]), [0, 0, 0]);
});

test("cache key hashes are deterministic for identical inputs", async () => {
  const { cacheKeyHash, osrmChunkHash, shortHash } = await scoringModule;
  const points = [
    { id: "a", lat: 46.1234567, lon: 8.1234567 },
    { id: "b", lat: 47.7654321, lon: 9.7654321 },
  ];

  assert.equal(shortHash("same payload"), shortHash("same payload"));
  assert.equal(cacheKeyHash({ v: 1, ids: ["a", "b"] }), cacheKeyHash({ v: 1, ids: ["a", "b"] }));
  assert.equal(osrmChunkHash(points, [0], [1]), osrmChunkHash(points, [0], [1]));
  assert.notEqual(osrmChunkHash(points, [0], [1]), osrmChunkHash(points, [1], [0]));
});

test("k-nearest helpers select bounded nearest neighbours without mutating inputs", async () => {
  const { nearestByDistance, selectKNearestCandidates } = await scoringModule;
  const origin = { id: "j0", lat: 46, lon: 8 };
  const candidates = [
    { id: "far", lat: 46, lon: 8.5 },
    { id: "near", lat: 46.01, lon: 8 },
    { id: "middle", lat: 46.05, lon: 8 },
  ];
  const scored = [
    { id: "slow", leisureCost: 40, distanceM: 1 },
    { id: "best", leisureCost: 10, distanceM: 9 },
    { id: "tie-nearer", leisureCost: 10, distanceM: 3 },
  ];
  const originalOrder = scored.map((item) => item.id);

  assert.deepEqual(nearestByDistance(origin, candidates, 2, 20_000).map((item) => item.id), ["near", "middle"]);
  assert.deepEqual(selectKNearestCandidates(scored, 2).map((item) => item.id), ["tie-nearer", "best"]);
  assert.deepEqual(scored.map((item) => item.id), originalOrder);
});
