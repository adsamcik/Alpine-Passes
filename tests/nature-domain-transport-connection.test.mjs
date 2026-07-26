import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isPlanningBlockingQualityFlag,
  validateCanonicalEntity,
} from "../assets/js/nature/domain.mjs";

function transportConnection(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    id: "transport:canonical-fixture",
    entityType: "TransportConnection",
    jurisdictionIds: ["GB-SCT"],
    names: [{ language: "en", kind: "primary", value: "Canonical transport fixture" }],
    geometry: {
      type: "LineString",
      coordinates: [[-4.2, 57.1], [-4.1, 57.2]],
    },
    transportMode: "bus",
    endpointIds: ["access:fixture-origin", "access:fixture-destination"],
    direction: "both",
    operating: true,
    schedule: { timezone: "Europe/London" },
    sourceAssertions: [{
      sourceId: "official-transport-source",
      sourceRecordId: "connection-42",
      fieldPath: "/",
      evidenceKind: "verified_official",
      verificationStatus: "verified",
      confidence: 0.98,
    }],
    quality: {
      confidence: 0.98,
      verificationStatus: "verified",
      assessedAt: "2026-07-26",
      freshness: "current",
      flags: [],
    },
    sensitivity: { action: "publish" },
    ...overrides,
  };
}

test("canonical TransportConnection accepts a complete two-endpoint record", () => {
  assert.deepEqual(validateCanonicalEntity(transportConnection()), []);
});

test("canonical TransportConnection rejects duplicate or non-binary endpoint lists", () => {
  const duplicateErrors = validateCanonicalEntity(transportConnection({
    endpointIds: ["access:same-stop", "access:same-stop"],
  }));
  assert.ok(duplicateErrors.includes("TransportConnection.endpointIds must be unique"));

  for (const endpointIds of [
    ["access:only-one"],
    ["access:one", "access:two", "access:three"],
  ]) {
    const errors = validateCanonicalEntity(transportConnection({ endpointIds }));
    assert.ok(errors.includes(
      "TransportConnection.endpointIds must identify exactly two ends",
    ));
  }
});

test("canonical TransportConnection rejects unsupported direction and operating types", () => {
  const errors = validateCanonicalEntity(transportConnection({
    direction: "sideways",
    operating: "yes",
  }));
  assert.ok(errors.includes("TransportConnection.direction is unsupported"));
  assert.ok(errors.includes(
    "TransportConnection.operating must be boolean when supplied",
  ));
});

test("canonical TransportConnection rejects empty or whitespace-only schedule timezones", () => {
  for (const timezone of ["", "   "]) {
    const errors = validateCanonicalEntity(transportConnection({
      schedule: { timezone },
    }));
    assert.ok(errors.includes(
      "TransportConnection.schedule.timezone must be non-empty when supplied",
    ));
  }
});

test("JSON schema exposes the same closed TransportConnection field constraints", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/nature-domain.schema.json", import.meta.url),
    "utf8",
  ));
  const properties = schema.$defs.transportConnection.allOf[1].properties;

  assert.equal(properties.endpointIds.minItems, 2);
  assert.equal(properties.endpointIds.maxItems, 2);
  assert.equal(properties.endpointIds.uniqueItems, true);
  assert.deepEqual(properties.direction.enum, ["outbound", "return", "both"]);
  assert.equal(properties.operating.type, "boolean");
  assert.equal(properties.schedule.properties.timezone.type, "string");
  assert.equal(properties.schedule.properties.timezone.minLength, 1);
  assert.equal(properties.schedule.properties.timezone.pattern, "\\S");
});

test("planning quality flags distinguish safety blockers from disclosed parking unknowns", () => {
  for (const flag of [
    "unsafe_access",
    "legal_access_unknown",
    "stopping_permission_unknown",
    "transport_schedule_unverified",
    "generalized_geometry",
    "legal_status_unknown",
    "avalanche_conditions_unknown",
    "critical_condition_unknown",
  ]) {
    assert.equal(isPlanningBlockingQualityFlag(flag), true, flag);
  }

  for (const flag of [
    "current_road_status_requires_local_verification",
    "parking_capacity_unknown",
    "parking_centroid_not_surveyed",
    "parking_fee_unknown",
    "parking_hours_unknown",
    "current_conditions_require_local_verification",
    "official_centerline",
    "source_geometry_surveyed_2016",
    "enclosed_route_section",
  ]) {
    assert.equal(isPlanningBlockingQualityFlag(flag), false, flag);
  }
});
