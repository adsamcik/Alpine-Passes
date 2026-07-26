import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateCanonicalEntity } from "../assets/js/nature/domain.mjs";

function notice(overrides = {}) {
  return {
    sourceId: "official-route-source",
    sourceRecordId: "route-42",
    publisher: "Example Park Authority",
    product: "Official route geometry",
    licenceId: "CC-BY-4.0",
    licenceVersion: "4.0",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "Example Park Authority, CC BY 4.0",
    sourceUrl: "https://example.test/routes/42",
    transformationNotice: "Coordinates retained; properties normalized by Itinera.",
    ...overrides,
  };
}

function route(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    id: "route:export-metadata-fixture",
    entityType: "TrailRoute",
    jurisdictionIds: ["GB-SCT"],
    names: [{ language: "en", kind: "primary", value: "Export fixture" }],
    geometry: { type: "LineString", coordinates: [[-4.2, 57.1], [-4.1, 57.2]] },
    routeNature: "established",
    geometryCompleteness: "complete",
    navigationSuitability: true,
    activities: ["hiking"],
    journeyShape: "point_to_point",
    access: { legal: "legal", modes: ["hiking"] },
    sourceAssertions: [{
      sourceId: "official-route-source",
      sourceRecordId: "route-42",
      fieldPath: "/geometry",
      evidenceKind: "verified_official",
      verificationStatus: "verified",
      confidence: 0.98,
    }],
    quality: {
      confidence: 0.98,
      verificationStatus: "verified",
      assessedAt: "2026-07-26",
      geometryConfidence: 0.98,
      freshness: "current",
      flags: [],
    },
    sensitivity: { action: "publish" },
    exportMetadata: { sourceNotices: [notice()] },
    ...overrides,
  };
}

function schemaAdditionalProperties(value, definition) {
  if (definition.additionalProperties !== false) return [];
  const declaredProperties = new Set(Object.keys(definition.properties || {}));
  return Object.keys(value)
    .filter((property) => !declaredProperties.has(property));
}

test("canonical route export metadata validates complete per-source notices", () => {
  assert.deepEqual(validateCanonicalEntity(route()), []);
});

test("route export metadata rejects unsafe URLs, duplicate notices, and assertion gaps", () => {
  const unsafe = route({
    sourceAssertions: [
      ...route().sourceAssertions,
      { ...route().sourceAssertions[0], sourceRecordId: "route-43" },
    ],
    exportMetadata: {
      sourceNotices: [
        notice({ licenceUrl: "javascript:alert(1)" }),
        notice(),
      ],
    },
  });
  const errors = validateCanonicalEntity(unsafe);
  assert.ok(errors.some((error) => error.includes("licenceUrl must be an absolute HTTP(S) URL")));
  assert.ok(errors.some((error) => error.includes("duplicates official-route-source/route-42")));
  assert.ok(errors.some((error) => error.includes("lacks a notice for official-route-source/route-43")));
});

test("route export metadata requires exact assertion coverage and credential-free URLs", () => {
  const candidate = route({
    sourceAssertions: [{
      ...route().sourceAssertions[0],
      sourceRecordId: undefined,
    }],
    exportMetadata: {
      sourceNotices: [notice({
        sourceId: "unasserted-source",
        sourceUrl: "https://user:secret@example.test/routes/42",
      })],
    },
  });
  const errors = validateCanonicalEntity(candidate);
  assert.ok(errors.some((error) => error.includes("requires sourceAssertions[0].sourceRecordId")));
  assert.ok(errors.some((error) => error.includes("has no matching assertion for unasserted-source/route-42")));
  assert.ok(errors.some((error) => error.includes("sourceUrl must be an absolute HTTP(S) URL")));
});

test("runtime validation and the JSON schema both reject export metadata extensions", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/nature-domain.schema.json", import.meta.url),
    "utf8",
  ));
  const metadataCandidate = route({
    exportMetadata: {
      sourceNotices: [notice()],
      generatedAt: "2026-07-26T12:00:00Z",
    },
  });
  const noticeCandidate = route({
    exportMetadata: {
      sourceNotices: [notice({ rightsReviewedBy: "unmodeled reviewer" })],
    },
  });

  const metadataRuntimeErrors = validateCanonicalEntity(metadataCandidate);
  const noticeRuntimeErrors = validateCanonicalEntity(noticeCandidate);
  assert.ok(metadataRuntimeErrors.some((error) =>
    error.includes("TrailRoute.exportMetadata has unsupported properties: generatedAt")));
  assert.ok(noticeRuntimeErrors.some((error) =>
    error.includes("TrailRoute export source notice 0 has unsupported properties: rightsReviewedBy")));

  assert.deepEqual(
    schemaAdditionalProperties(metadataCandidate.exportMetadata, schema.$defs.routeExportMetadata),
    ["generatedAt"],
  );
  assert.deepEqual(
    schemaAdditionalProperties(
      noticeCandidate.exportMetadata.sourceNotices[0],
      schema.$defs.routeSourceNotice,
    ),
    ["rightsReviewedBy"],
  );
});

test("JSON schema exposes the same closed route export notice contract", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/nature-domain.schema.json", import.meta.url),
    "utf8",
  ));
  const definition = schema.$defs.routeSourceNotice;
  assert.equal(schema.$defs.routeExportMetadata.additionalProperties, false);
  assert.equal(definition.additionalProperties, false);
  assert.deepEqual(definition.required, [
    "sourceId", "sourceRecordId", "publisher", "product", "licenceId",
    "licenceVersion", "licenceUrl", "attribution", "sourceUrl",
    "transformationNotice",
  ]);
  assert.equal(definition.properties.licenceUrl.pattern, "^https?://(?![^/?#]*@)");
  assert.equal(definition.properties.sourceUrl.pattern, "^https?://(?![^/?#]*@)");
  assert.equal(schema.$defs.routeExportMetadata.properties.sourceNotices.minItems, 1);
  assert.equal(schema.$defs.trailRoute.allOf[1].properties.exportMetadata.$ref,
    "#/$defs/routeExportMetadata");
});
