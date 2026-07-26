import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { lineDistanceMeters, validateCanonicalEntity } from "../assets/js/nature/domain.mjs";
import { assessTrailRouteExport, serializeTrailRouteGpx } from "../assets/js/nature/route-export.mjs";
import { NPS_HARDING_ACCESS_ID, NPS_HARDING_ROUTE_ID, ingestNpsPublicTrails } from "../tools/nature/lib/nps-public-trails-adapter.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = path.join(REPO_ROOT, "data/snapshots/nps-public-trails/harding-icefield-trail.geojson");
const METADATA = path.join(REPO_ROOT, "data/snapshots/nps-public-trails/harding-icefield-trail.snapshot.json");

test("official NPS Harding snapshot produces a complete governed route and exact lower access", async () => {
  const result = await ingestNpsPublicTrails(REPO_ROOT);
  const route = result.records.find((record) => record.id === NPS_HARDING_ROUTE_ID);
  const access = result.records.find((record) => record.id === NPS_HARDING_ACCESS_ID);

  assert.ok(route);
  assert.ok(access);
  assert.deepEqual(validateCanonicalEntity(route), []);
  assert.deepEqual(validateCanonicalEntity(access), []);
  assert.equal(route.geometry.coordinates.length, 5479);
  assert.deepEqual(route.geometry.coordinates[0], route.geometry.coordinates.at(-1));
  assert.deepEqual(access.geometry.coordinates, route.geometry.coordinates[0]);
  assert.equal(route.geometryCompleteness, "complete");
  assert.equal(route.navigationSuitability, true);
  assert.equal(route.access.legal, "legal");
  assert.equal(access.legalAccess, "legal");
  assert.equal(route.sourceAssertions.filter((item) => item.fieldPath === "/geometry").length, 6);
  assert.equal(route.exportMetadata.sourceNotices.length, 7);
  assert.equal(Math.round(lineDistanceMeters(route.geometry)), 13068);
  assert.equal(route.metrics.distanceMeters, 12553, "NPS reported distance remains distinct from computed geometry length");

  const assessment = assessTrailRouteExport(route, "gpx", { asOf: "2026-07-26T15:30:00Z" });
  assert.equal(assessment.allowed, true, assessment.message);
  const gpx = serializeTrailRouteGpx(route, { asOf: "2026-07-26T15:30:00Z" });
  assert.match(gpx, /sourceRecordId="30488"/);
  assert.match(gpx, /sourceRecordId="harding-icefield-trail-guide"/);
  assert.match(gpx, /No protection is claimed in original U\.S\. Government works/);
});

test("NPS adapter refuses changed snapshot bytes before parsing", async (t) => {
  const fixture = await fixturePaths(t);
  const raw = await readFile(SNAPSHOT, "utf8");
  await writeFile(fixture.snapshotPath, `${raw}\n`, "utf8");
  await assert.rejects(ingestNpsPublicTrails(REPO_ROOT, fixture), /snapshot hash mismatch/);
});

test("NPS adapter refuses disconnected or reordered centerline topology after hash review", async (t) => {
  const fixture = await fixturePaths(t);
  const [snapshot, metadata] = await Promise.all([
    readFile(SNAPSHOT, "utf8").then(JSON.parse),
    readFile(METADATA, "utf8").then(JSON.parse),
  ]);
  const bridge = snapshot.features.find((feature) => feature.properties.OBJECTID === 29918);
  bridge.geometry.coordinates[0][0] += 0.01;
  const raw = `${JSON.stringify(snapshot)}\n`;
  metadata.snapshot.sha256 = createHash("sha256").update(raw).digest("hex");
  await Promise.all([
    writeFile(fixture.snapshotPath, raw, "utf8"),
    writeFile(fixture.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
  ]);
  await assert.rejects(ingestNpsPublicTrails(REPO_ROOT, fixture), /topology is disconnected/);
});

async function fixturePaths(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "itinera-nps-trails-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotPath = path.join(root, "snapshot.geojson");
  const metadataPath = path.join(root, "metadata.json");
  await Promise.all([
    readFile(SNAPSHOT).then((bytes) => writeFile(snapshotPath, bytes)),
    readFile(METADATA).then((bytes) => writeFile(metadataPath, bytes)),
  ]);
  return { snapshotPath, metadataPath };
}
