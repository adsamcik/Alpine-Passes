import assert from "node:assert/strict";
import test from "node:test";

import {
  assessTrailRouteExport,
  DEFAULT_GPX_EXPORT_POLICY,
  ROUTE_EXPORT_METADATA_CONTRACT,
  RouteExportError,
  serializeTrailRouteGeoJson,
  serializeTrailRouteGpx,
} from "../assets/js/nature/route-export.mjs";

const EXPORT_AS_OF = "2026-07-26T12:00:00Z";
const EXPORT_OPTIONS = Object.freeze({
  asOf: EXPORT_AS_OF,
  gpxPolicy: Object.freeze({
    maxGeometryAssessmentAgeMilliseconds: 10 * 24 * 60 * 60 * 1_000,
    maxGeometryObservationAgeMilliseconds: 10 * 24 * 60 * 60 * 1_000,
    maxFutureSkewMilliseconds: 5 * 60 * 1_000,
  }),
});

function sourceNotice(overrides = {}) {
  return {
    sourceId: "source:route-authority",
    sourceRecordId: "route-42",
    publisher: "Highland Paths & Access Authority",
    product: "Verified Paths <Spring 2026>",
    licenceId: "OGL",
    licenceVersion: "3.0",
    licenceUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    attribution: "Contains authority path data © Crown copyright 2026",
    sourceUrl: "https://data.example.test/routes/42?edition=spring&format=geojson",
    transformationNotice: "Coordinates converted to WGS84; vertices otherwise unchanged.",
    ...overrides,
  };
}

function route(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    id: "route:verified-42",
    entityType: "TrailRoute",
    names: [{ language: "en", kind: "primary", value: "Verified Ridge & Loch" }],
    geometry: {
      type: "LineString",
      coordinates: [[-4.2, 57.1, 30], [-4.1, 57.2, 90], [-4.0, 57.15, 40]],
    },
    geometryCompleteness: "complete",
    navigationSuitability: true,
    sensitivity: { action: "publish" },
    access: { legal: "legal", modes: ["hiking"] },
    quality: {
      verificationStatus: "verified",
      freshness: "current",
      assessedAt: "2026-07-20",
      flags: [],
    },
    sourceAssertions: [{
      sourceId: "source:route-authority",
      sourceRecordId: "route-42",
      fieldPath: "/geometry",
      evidenceKind: "verified_official",
      verificationStatus: "verified",
      observedAt: "2026-07-19T10:00:00Z",
    }],
    exportMetadata: { sourceNotices: [sourceNotice()] },
    ...overrides,
  };
}

test("route export declares the exact route-provided source notice contract", () => {
  assert.equal(ROUTE_EXPORT_METADATA_CONTRACT.field, "exportMetadata.sourceNotices");
  assert.deepEqual([...ROUTE_EXPORT_METADATA_CONTRACT.requiredFields], [
    "sourceId",
    "sourceRecordId",
    "publisher",
    "product",
    "licenceId",
    "licenceVersion",
    "licenceUrl",
    "attribution",
    "sourceUrl",
    "transformationNotice",
  ]);
});

test("all downloads fail closed until every asserted source record has a complete notice", () => {
  for (const format of ["geojson", "gpx"]) {
    const absent = assessTrailRouteExport(
      route({ exportMetadata: undefined }),
      format,
      EXPORT_OPTIONS,
    );
    assert.equal(absent.allowed, false);
    assert.equal(absent.code, `${format}_source_notices_incomplete`);
    assert.deepEqual(absent.sourceNoticeSet.sourceReferences, [{
      sourceId: "source:route-authority",
      sourceRecordId: "route-42",
    }]);
    assert.deepEqual(absent.sourceNoticeSet.missingSourceReferences, absent.sourceNoticeSet.sourceReferences);

    for (const missingField of ROUTE_EXPORT_METADATA_CONTRACT.requiredFields) {
      const incompleteNotice = sourceNotice();
      delete incompleteNotice[missingField];
      const result = assessTrailRouteExport(route({
        exportMetadata: { sourceNotices: [incompleteNotice] },
      }), format, EXPORT_OPTIONS);
      assert.equal(result.allowed, false, `${format} must reject missing ${missingField}`);
      assert.equal(result.code, `${format}_source_notices_incomplete`);
    }
  }

  assert.throws(
    () => serializeTrailRouteGeoJson(route({ exportMetadata: undefined })),
    (error) => error instanceof RouteExportError
      && error.code === "geojson_source_notices_incomplete",
  );
});

test("notice coverage is exact by source ID and record ID", () => {
  const secondAssertion = {
    sourceId: "source:name-authority",
    sourceRecordId: "name-9",
    fieldPath: "/names/0",
    verificationStatus: "verified",
    retrievedAt: "2026-07-20T12:00:00Z",
  };
  const twoSourceRoute = route({
    sourceAssertions: [...route().sourceAssertions, secondAssertion],
    exportMetadata: { sourceNotices: [sourceNotice()] },
  });
  const missing = assessTrailRouteExport(twoSourceRoute, "geojson");
  assert.equal(missing.allowed, false);
  assert.deepEqual(missing.sourceNoticeSet.missingSourceReferences, [{
    sourceId: "source:name-authority",
    sourceRecordId: "name-9",
  }]);

  const complete = route({
    ...twoSourceRoute,
    exportMetadata: {
      sourceNotices: [
        sourceNotice(),
        sourceNotice({
          sourceId: "source:name-authority",
          sourceRecordId: "name-9",
          publisher: "Gaelic Names Board",
          product: "Official Place Names",
          sourceUrl: "https://names.example.test/records/name-9",
          transformationNotice: "Name retained verbatim.",
        }),
      ],
    },
  });
  assert.equal(assessTrailRouteExport(complete, "geojson").allowed, true);

  const duplicate = route({
    exportMetadata: { sourceNotices: [sourceNotice(), sourceNotice()] },
  });
  assert.equal(assessTrailRouteExport(duplicate, "geojson").allowed, false);

  const unmatched = route({
    exportMetadata: {
      sourceNotices: [
        sourceNotice(),
        sourceNotice({ sourceId: "source:not-asserted", sourceRecordId: "record-404" }),
      ],
    },
  });
  const unmatchedResult = assessTrailRouteExport(unmatched, "geojson");
  assert.equal(unmatchedResult.allowed, false);
  assert.deepEqual(unmatchedResult.sourceNoticeSet.unexpectedSourceReferences, [
    { sourceId: "source:not-asserted", sourceRecordId: "record-404" },
  ]);
});

test("GPX has additional navigation, sensitivity, representation, and provenance gates", () => {
  const cases = [
    [route({ navigationSuitability: false }), "gpx_navigation_unsuitable"],
    [route({ geometryCompleteness: "partial" }), "gpx_incomplete_geometry"],
    [route({ sensitivity: undefined }), "gpx_sensitivity_not_publishable"],
    [route({ sensitivity: { action: "coarsen" } }), "gpx_sensitivity_not_publishable"],
    [route({ quality: { ...route().quality, flags: ["generalized_geometry"] } }), "gpx_reduced_geometry"],
    [route({ geometryRepresentation: "simplified_overview" }), "gpx_reduced_geometry"],
    [route({ quality: { ...route().quality, verificationStatus: "unverified" } }), "gpx_geometry_provenance_unverified"],
    [route({ quality: { ...route().quality, freshness: "stale" } }), "gpx_geometry_provenance_unverified"],
    [route({ quality: { ...route().quality, assessedAt: "not-a-date" } }), "gpx_geometry_provenance_unverified"],
    [route({
      sourceAssertions: [{ ...route().sourceAssertions[0], verificationStatus: "unverified" }],
    }), "gpx_geometry_provenance_unverified"],
    [route({
      sourceAssertions: [{ ...route().sourceAssertions[0], observedAt: undefined }],
    }), "gpx_geometry_provenance_unverified"],
    [route({
      sourceAssertions: [{ ...route().sourceAssertions[0], validUntil: "2000-01-01" }],
    }), "gpx_geometry_provenance_expired"],
  ];
  for (const [candidate, expectedCode] of cases) {
    const result = assessTrailRouteExport(candidate, "gpx", EXPORT_OPTIONS);
    assert.equal(result.allowed, false, expectedCode);
    assert.equal(result.code, expectedCode);
  }

  const overviewGeoJson = assessTrailRouteExport(route({
    navigationSuitability: false,
    geometryCompleteness: "overview_only",
    quality: { ...route().quality, flags: ["overview_geometry_only"] },
  }), "geojson");
  assert.equal(overviewGeoJson.allowed, true, "GeoJSON may carry non-navigation overview geometry when notices are complete");
});

test("GPX requires explicitly legal access and fails closed for every other access state", () => {
  assert.equal(assessTrailRouteExport(route(), "gpx", EXPORT_OPTIONS).allowed, true);

  for (const legal of [undefined, "unknown", "private", "restricted"]) {
    const candidate = route({
      access: legal === undefined ? undefined : { legal, modes: ["hiking"] },
    });
    const result = assessTrailRouteExport(candidate, "gpx", EXPORT_OPTIONS);
    assert.equal(result.allowed, false, `GPX must reject ${legal ?? "missing"} access`);
    assert.equal(result.code, "gpx_access_not_legal");
  }
});

test("GPX geometry assessment and observation ages use the injected assessment time", () => {
  const cases = [
    [route({
      quality: { ...route().quality, assessedAt: "2026-07-16T11:59:59Z" },
    }), "gpx_geometry_assessment_stale"],
    [route({
      quality: { ...route().quality, assessedAt: "2026-07-26T12:05:01Z" },
    }), "gpx_geometry_assessment_future"],
    [route({
      sourceAssertions: [{
        ...route().sourceAssertions[0],
        observedAt: "2026-07-16T11:59:59Z",
      }],
    }), "gpx_geometry_observation_stale"],
    [route({
      sourceAssertions: [{
        ...route().sourceAssertions[0],
        observedAt: "2026-07-26T12:05:01Z",
      }],
    }), "gpx_geometry_observation_future"],
  ];

  for (const [candidate, expectedCode] of cases) {
    const result = assessTrailRouteExport(candidate, "gpx", EXPORT_OPTIONS);
    assert.equal(result.allowed, false, expectedCode);
    assert.equal(result.code, expectedCode);
  }

  const withinSkew = route({
    quality: { ...route().quality, assessedAt: "2026-07-26T12:04:59Z" },
    sourceAssertions: [{
      ...route().sourceAssertions[0],
      observedAt: "2026-07-26T12:04:59Z",
    }],
  });
  assert.equal(
    assessTrailRouteExport(withinSkew, "gpx", EXPORT_OPTIONS).allowed,
    true,
    "configured clock skew is inclusive and deterministic",
  );
});

test("GPX rejects invalid assessment inputs and exposes finite fail-closed defaults", () => {
  assert.ok(DEFAULT_GPX_EXPORT_POLICY.maxGeometryAssessmentAgeMilliseconds > 0);
  assert.ok(DEFAULT_GPX_EXPORT_POLICY.maxGeometryObservationAgeMilliseconds > 0);
  assert.ok(DEFAULT_GPX_EXPORT_POLICY.maxFutureSkewMilliseconds >= 0);
  assert.equal(
    Object.values(DEFAULT_GPX_EXPORT_POLICY).every(Number.isFinite),
    true,
  );

  const invalidAsOf = assessTrailRouteExport(route(), "gpx", {
    ...EXPORT_OPTIONS,
    asOf: "not-an-instant",
  });
  assert.equal(invalidAsOf.allowed, false);
  assert.equal(invalidAsOf.code, "gpx_assessment_time_invalid");

  const invalidPolicy = assessTrailRouteExport(route(), "gpx", {
    ...EXPORT_OPTIONS,
    gpxPolicy: {
      ...EXPORT_OPTIONS.gpxPolicy,
      maxGeometryObservationAgeMilliseconds: -1,
    },
  });
  assert.equal(invalidPolicy.allowed, false);
  assert.equal(invalidPolicy.code, "gpx_policy_invalid");
});

test("GeoJSON remains available with exact notices when GPX safety gates deny export", () => {
  const nonNavigableCandidate = route({
    access: { legal: "restricted", modes: ["hiking"] },
    quality: { ...route().quality, assessedAt: "2000-01-01" },
    sourceAssertions: [{
      ...route().sourceAssertions[0],
      observedAt: "2030-01-01T00:00:00Z",
    }],
  });
  const gpx = assessTrailRouteExport(nonNavigableCandidate, "gpx", EXPORT_OPTIONS);
  assert.equal(gpx.allowed, false);
  assert.equal(gpx.code, "gpx_access_not_legal");

  const geojson = assessTrailRouteExport(nonNavigableCandidate, "geojson", EXPORT_OPTIONS);
  assert.equal(geojson.allowed, true);
  const payload = JSON.parse(serializeTrailRouteGeoJson(nonNavigableCandidate, EXPORT_OPTIONS));
  assert.equal(payload.metadata.exportSourceNotices.status, "complete");
  assert.deepEqual(payload.metadata.exportSourceNotices.notices, [sourceNotice()]);
});

test("GPX carries exact route-provided source notices with XML escaping", () => {
  const gpx = serializeTrailRouteGpx(route(), EXPORT_OPTIONS);
  assert.match(gpx, /xmlns:itinera="urn:itinera:route-export:1"/);
  assert.match(gpx, /itinera:sourceNotices status="complete"/);
  assert.match(gpx, /sourceId="source:route-authority"/);
  assert.match(gpx, /sourceRecordId="route-42"/);
  assert.match(gpx, /<itinera:publisher>Highland Paths &amp; Access Authority<\/itinera:publisher>/);
  assert.match(gpx, /<itinera:product>Verified Paths &lt;Spring 2026&gt;<\/itinera:product>/);
  assert.match(gpx, /itinera:licence id="OGL" version="3\.0" url="https:\/\/www\.nationalarchives\.gov\.uk\/doc\/open-government-licence\/version\/3\/"/);
  assert.match(gpx, /Contains authority path data © Crown copyright 2026/);
  assert.match(gpx, /sourceUrl>https:\/\/data\.example\.test\/routes\/42\?edition=spring&amp;format=geojson/);
  assert.match(gpx, /transformationNotice>Coordinates converted to WGS84; vertices otherwise unchanged/);
});

test("GeoJSON carries exact notices as structured metadata and retains assertion provenance", () => {
  const payload = JSON.parse(serializeTrailRouteGeoJson(route()));
  const exportNotices = payload.metadata.exportSourceNotices;
  assert.equal(exportNotices.status, "complete");
  assert.deepEqual(exportNotices.notices, [sourceNotice()]);
  assert.deepEqual(exportNotices.sourceReferences, [{
    sourceId: "source:route-authority",
    sourceRecordId: "route-42",
  }]);
  assert.deepEqual(exportNotices.missingSourceReferences, []);
  assert.equal(payload.metadata.provenance[0].sourceId, "source:route-authority");
  assert.deepEqual(payload.features[0].properties.exportSourceNotices, exportNotices);
});

test("notice URLs must be absolute HTTP(S) references", () => {
  for (const invalid of ["", "javascript:alert(1)", "../terms", "ftp://example.test/licence", "https://user:secret@example.test/terms"]) {
    const licence = assessTrailRouteExport(route({
      exportMetadata: { sourceNotices: [sourceNotice({ licenceUrl: invalid })] },
    }), "geojson");
    assert.equal(licence.allowed, false);
    assert.equal(licence.code, "geojson_source_notices_incomplete");

    const source = assessTrailRouteExport(route({
      exportMetadata: { sourceNotices: [sourceNotice({ sourceUrl: invalid })] },
    }), "geojson");
    assert.equal(source.allowed, false);
  }
});
