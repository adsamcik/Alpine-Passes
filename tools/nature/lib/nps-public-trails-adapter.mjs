import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  SCHEMA_VERSION,
  lineDistanceMeters,
  samePosition,
  validPosition,
} from "../../../assets/js/nature/domain.mjs";

export const NPS_PUBLIC_TRAILS_SOURCE_ID = "nps-public-trails";
export const NPS_HARDING_ROUTE_ID = "route:us-ak-harding-icefield-out-and-back";
export const NPS_HARDING_ACCESS_ID = "access:us-ak-exit-glacier-trailhead";
export const NPS_HARDING_SUPERSEDED_SEED_IDS = Object.freeze([
  NPS_HARDING_ROUTE_ID,
  NPS_HARDING_ACCESS_ID,
]);

const SNAPSHOT_RELATIVE_PATH = "data/snapshots/nps-public-trails/harding-icefield-trail.geojson";
const METADATA_RELATIVE_PATH = "data/snapshots/nps-public-trails/harding-icefield-trail.snapshot.json";
const EXPECTED_OBJECT_ID_ORDER = Object.freeze([30488, 29918, 31241, 30504, 31691, 29968]);
const PUBLIC_DOMAIN_NOTICE = Object.freeze({
  publisher: "National Park Service",
  licenceId: "US-PUBLIC-DOMAIN",
  licenceVersion: "17 U.S.C. 105; NPS disclaimer accessed 2026-07-26",
  licenceUrl: "https://www.nps.gov/aboutus/disclaimer.htm",
  attribution: "National Park Service. No protection is claimed in original U.S. Government works.",
});

export async function ingestNpsPublicTrails(repoRoot, options = {}) {
  const snapshotPath = options.snapshotPath || path.join(repoRoot, SNAPSHOT_RELATIVE_PATH);
  const metadataPath = options.metadataPath || path.join(repoRoot, METADATA_RELATIVE_PATH);
  const [snapshotBytes, metadataBytes] = await Promise.all([
    readFile(snapshotPath),
    readFile(metadataPath, "utf8"),
  ]);
  const metadata = JSON.parse(metadataBytes);
  validateMetadata(metadata);
  const digest = createHash("sha256").update(snapshotBytes).digest("hex");
  if (digest !== metadata.snapshot.sha256) {
    throw new Error(`NPS snapshot hash mismatch: expected ${metadata.snapshot.sha256}, received ${digest}`);
  }

  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const joinedCoordinates = validateAndJoinSnapshot(snapshot, metadata);
  const outAndBackCoordinates = [
    ...joinedCoordinates,
    ...joinedCoordinates.slice(0, -1).reverse(),
  ];
  const route = createRoute(outAndBackCoordinates, snapshot.features, metadata);
  const accessPoint = createAccessPoint(joinedCoordinates[0], metadata);

  return {
    adapterId: "nps-public-trails",
    records: [route, accessPoint],
    redirects: {
      "us-ak-harding-icefield-out-and-back": route.id,
      "us-ak-exit-glacier-trailhead": accessPoint.id,
    },
    inventories: [{
      source: SNAPSHOT_RELATIVE_PATH,
      records: snapshot.features.length,
      emittedRecords: 2,
      sha256: digest,
      retrievedAt: metadata.retrievedAt,
      replacementIds: [...NPS_HARDING_SUPERSEDED_SEED_IDS],
    }],
  };
}

function validateMetadata(metadata) {
  if (metadata?.schemaVersion !== SCHEMA_VERSION
      || metadata?.sourceId !== NPS_PUBLIC_TRAILS_SOURCE_ID
      || !metadata.snapshot
      || !metadata.guidance
      || !metadata.accessGuidance
      || !metadata.rights) {
    throw new Error("NPS snapshot metadata is incomplete or uses an unsupported schema");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(metadata.retrievedAt)) {
    throw new Error("NPS snapshot metadata requires an exact UTC retrieval time");
  }
  if (!/^[a-f0-9]{64}$/.test(metadata.snapshot.sha256)) {
    throw new Error("NPS snapshot metadata requires a SHA-256 digest");
  }
  if (JSON.stringify(metadata.snapshot.orderedObjectIds) !== JSON.stringify(EXPECTED_OBJECT_ID_ORDER)) {
    throw new Error("NPS snapshot metadata has an unexpected segment order");
  }
  if (metadata.guidance.roundTripMiles !== 7.8
      || metadata.guidance.oneWayMiles !== 3.9
      || metadata.guidance.durationMinutes?.minimum !== 360
      || metadata.guidance.durationMinutes?.maximum !== 480
      || metadata.guidance.elevationGainFeetPerMile !== 1000
      || metadata.guidance.difficulty !== "Strenuous") {
    throw new Error("NPS Harding visitor-guidance facts changed without adapter review");
  }
  if (metadata.accessGuidance.parkingAvailable !== true
      || metadata.accessGuidance.roadAccessibleInSummer !== true) {
    throw new Error("NPS Harding access guidance changed without adapter review");
  }
  for (const field of ["licenceId", "licenceVersion", "licenceUrl", "attribution"]) {
    if (metadata.rights[field] !== PUBLIC_DOMAIN_NOTICE[field]) {
      throw new Error(`NPS rights metadata ${field} changed without governance review`);
    }
  }
}

function validateAndJoinSnapshot(snapshot, metadata) {
  if (snapshot?.type !== "FeatureCollection" || !Array.isArray(snapshot.features)) {
    throw new Error("NPS snapshot must be a GeoJSON FeatureCollection");
  }
  if (snapshot.features.length !== EXPECTED_OBJECT_ID_ORDER.length) {
    throw new Error("NPS snapshot must contain exactly the reviewed Harding segments");
  }
  const byObjectId = new Map();
  let rawCoordinateCount = 0;
  for (const feature of snapshot.features) {
    const properties = feature?.properties;
    const objectId = properties?.OBJECTID;
    if (!Number.isSafeInteger(objectId) || byObjectId.has(objectId)) {
      throw new Error("NPS snapshot contains a missing or duplicate OBJECTID");
    }
    if (!EXPECTED_OBJECT_ID_ORDER.includes(objectId)) {
      throw new Error(`NPS snapshot contains unreviewed OBJECTID ${objectId}`);
    }
    if (feature?.type !== "Feature"
        || feature.geometry?.type !== "LineString"
        || !Array.isArray(feature.geometry.coordinates)
        || feature.geometry.coordinates.length < 2
        || !feature.geometry.coordinates.every(validPosition)) {
      throw new Error(`NPS OBJECTID ${objectId} has invalid line geometry`);
    }
    for (const [field, expected] of [
      ["TRLNAME", metadata.snapshot.trailName],
      ["TRLSTATUS", metadata.snapshot.status],
      ["PUBLICDISPLAY", metadata.snapshot.publicDisplay],
      ["DATAACCESS", metadata.snapshot.dataAccess],
      ["TRLUSE", metadata.snapshot.use],
      ["UNITCODE", metadata.snapshot.unitCode],
      ["UNITNAME", metadata.snapshot.unitName],
      ["FEATUREID", metadata.snapshot.featureId],
      ["MAINTAINER", "National Park Service"],
    ]) {
      if (properties[field] !== expected) {
        throw new Error(`NPS OBJECTID ${objectId} has unexpected ${field}`);
      }
    }
    rawCoordinateCount += feature.geometry.coordinates.length;
    byObjectId.set(objectId, feature);
  }
  if (rawCoordinateCount !== metadata.snapshot.rawCoordinateCount) {
    throw new Error("NPS snapshot raw coordinate count changed without review");
  }

  const joined = [];
  for (const objectId of EXPECTED_OBJECT_ID_ORDER) {
    const coordinates = byObjectId.get(objectId).geometry.coordinates;
    if (joined.length && !samePosition(joined.at(-1), coordinates[0], 1e-10)) {
      throw new Error(`NPS Harding segment topology is disconnected before OBJECTID ${objectId}`);
    }
    joined.push(...(joined.length ? coordinates.slice(1) : coordinates));
  }
  if (joined.length !== metadata.snapshot.joinedCoordinateCount) {
    throw new Error("NPS snapshot joined coordinate count changed without review");
  }
  return joined.map((position) => [...position]);
}

function createRoute(outAndBackCoordinates, features, metadata) {
  const geometry = { type: "LineString", coordinates: outAndBackCoordinates };
  const officialRoundTripMeters = Math.round(metadata.guidance.roundTripMiles * 1609.344);
  const approximateAscentMeters = Math.round(metadata.guidance.oneWayMiles * metadata.guidance.elevationGainFeetPerMile * 0.3048);
  const geometryLengthMeters = Math.round(lineDistanceMeters(geometry));
  const geometryAssertions = EXPECTED_OBJECT_ID_ORDER.map((objectId) => {
    const feature = features.find((candidate) => candidate.properties.OBJECTID === objectId);
    const sourceDate = new Date(feature.properties.SOURCEDATE).toISOString().slice(0, 10);
    return {
      id: `assert:nps-harding-geometry-${objectId}`,
      sourceId: NPS_PUBLIC_TRAILS_SOURCE_ID,
      sourceRecordId: String(objectId),
      fieldPath: "/geometry",
      originalClassification: {
        trailStatus: feature.properties.TRLSTATUS,
        surface: feature.properties.TRLSURFACE,
        trailType: feature.properties.TRLTYPE,
        trailClass: feature.properties.TRLCLASS,
        trailUse: feature.properties.TRLUSE,
        mapMethod: feature.properties.MAPMETHOD,
      },
      evidenceKind: "verified_official",
      verificationStatus: "verified",
      confidence: 0.97,
      observedAt: metadata.retrievedAt,
      retrievedAt: metadata.retrievedAt,
      notes: `Current official service retrieval publishes this mapping-grade segment as Existing, Unrestricted, and Public Map Display. Underlying NPS source date: ${sourceDate}; no coordinates were simplified.`,
    };
  });
  const guideAssertion = (id, fieldPath, value, evidenceKind, notes) => ({
    id,
    sourceId: NPS_PUBLIC_TRAILS_SOURCE_ID,
    sourceRecordId: metadata.guidance.sourceRecordId,
    fieldPath,
    value,
    evidenceKind,
    verificationStatus: "verified",
    confidence: evidenceKind === "derived" ? 0.91 : 0.98,
    observedAt: `${metadata.guidance.publisherUpdatedAt}T00:00:00Z`,
    retrievedAt: metadata.guidance.retrievedAt,
    notes,
  });
  const sourceAssertions = [
    ...geometryAssertions,
    guideAssertion("assert:nps-harding-reported-distance", "/metrics/distanceMeters", officialRoundTripMeters, "derived", `Converted the NPS-reported ${metadata.guidance.roundTripMiles}-mile round trip to metres. The unsimplified joined centerline measures ${geometryLengthMeters} m; both values are retained rather than forced to agree.`),
    guideAssertion("assert:nps-harding-duration", "/metrics/typicalDurationMinutes", 420, "derived", "The schema currently stores one typical duration; 420 minutes is the midpoint of the NPS 6–8 hour guidance, and the full range is retained in the source note."),
    guideAssertion("assert:nps-harding-elevation", "/metrics/ascentMeters", approximateAscentMeters, "derived", "Approximate ascent derives from the NPS statement of about 1,000 feet gained per mile over the 3.9-mile outbound hike; descent is symmetric only as an out-and-back approximation."),
    guideAssertion("assert:nps-harding-difficulty", "/difficulty", metadata.guidance.difficulty, "verified_official", "NPS visitor guidance calls the hike strenuous. The source segment label Class 3: Developed is retained separately as a trail class, not converted into a hiking grade."),
    guideAssertion("assert:nps-harding-access", "/access", "legal", "verified_official", "The current NPS visitor page presents the Harding Icefield Trail as a public park hike; always check current conditions and closures before departure."),
  ];
  const sourceNotices = [
    ...EXPECTED_OBJECT_ID_ORDER.map((objectId) => sourceNotice({
      sourceRecordId: String(objectId),
      product: "NPS Public Trails Geographic",
      sourceUrl: `${metadata.snapshot.serviceUrl}/query?objectIds=${objectId}&outFields=*&returnGeometry=true&outSR=4326&f=geojson`,
      transformationNotice: "One reviewed NPS LineString segment was joined in the documented OBJECTID order; the joined outbound path was reversed to form an out-and-back. Coordinates were not simplified, rounded, interpolated, or map-traced.",
    })),
    sourceNotice({
      sourceRecordId: metadata.guidance.sourceRecordId,
      product: "Kenai Fjords National Park Harding Icefield Trail visitor guidance",
      sourceUrl: metadata.guidance.url,
      transformationNotice: "Distance, duration, elevation-gain, difficulty, access, and hazard facts were normalized into structured fields. No photographs, logos, maps, or long-form NPS text were copied.",
    }),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    id: NPS_HARDING_ROUTE_ID,
    entityType: "TrailRoute",
    jurisdictionIds: ["US", "US-AK"],
    names: [{ language: "en", value: "Harding Icefield Trail out-and-back", kind: "primary" }],
    geometry,
    routeNature: "established",
    geometryCompleteness: "complete",
    navigationSuitability: true,
    activities: ["hiking"],
    journeyShape: "out_and_back",
    direction: "both",
    accessPointIds: [NPS_HARDING_ACCESS_ID],
    access: { legal: "legal", modes: ["car", "foot", "hiking"] },
    metrics: { distanceMeters: officialRoundTripMeters, ascentMeters: approximateAscentMeters, descentMeters: approximateAscentMeters, typicalDurationMinutes: 420 },
    difficulty: {
      originalScale: "NPS visitor guidance",
      originalGrade: metadata.guidance.difficulty,
      normalizedBand: "strenuous",
      normalizationCaveat: "Personal difficulty varies. NPS source-segment Class 3: Developed is a trail-development class, not a hiking difficulty grade.",
    },
    trailSegments: [{ surface: "Native", trailClass: "Class 3: Developed" }],
    summary: `Official NPS centerline assembled as a full out-and-back (computed geometry length about ${(geometryLengthMeters / 1609.344).toFixed(1)} mi). NPS visitor guidance reports ${metadata.guidance.roundTripMiles} mi, calls the hike strenuous, and advises ${metadata.guidance.durationMinutes.minimum / 60}–${metadata.guidance.durationMinutes.maximum / 60} hours. Snow and avalanche hazards can persist into July; check current park conditions before departure.`,
    sourceAssertions,
    exportMetadata: { sourceNotices },
    quality: {
      confidence: 0.94,
      verificationStatus: "verified",
      assessedAt: "2026-07-26",
      geometryConfidence: 0.97,
      accessConfidence: 0.86,
      freshness: "current",
      flags: ["current_conditions_require_local_verification", "official_centerline", "source_geometry_surveyed_2016"],
      notes: "NPS still publishes all six source segments as Existing, unrestricted public-display trail geometry. Their mapping source dates are 2016; the visitor guide was updated 2026-07-20. Navigation suitability means the complete official centerline can be exported, not that conditions are live or risk-free.",
    },
    sensitivity: {
      action: "publish",
      reason: "NPS explicitly marks every reviewed trail segment Unrestricted and Public Map Display; no sensitive wildlife location or media is included.",
      authoritySourceId: NPS_PUBLIC_TRAILS_SOURCE_ID,
    },
    originalSourceIds: sourceNotices.map(({ sourceId, sourceRecordId }) => ({ sourceId, recordId: sourceRecordId })),
    deliveryRegions: ["north-america"],
  };
}

function createAccessPoint(coordinates, metadata) {
  const assertions = [
    {
      id: "assert:nps-harding-access-point-geometry",
      sourceId: NPS_PUBLIC_TRAILS_SOURCE_ID,
      sourceRecordId: String(EXPECTED_OBJECT_ID_ORDER[0]),
      fieldPath: "/geometry",
      evidenceKind: "verified_official",
      verificationStatus: "verified",
      confidence: 0.96,
      observedAt: metadata.retrievedAt,
      retrievedAt: metadata.retrievedAt,
      notes: "The access point is the exact first coordinate of the official outbound Harding trail centerline, not a separately surveyed parking centroid.",
    },
    {
      id: "assert:nps-harding-access-point-legal",
      sourceId: NPS_PUBLIC_TRAILS_SOURCE_ID,
      sourceRecordId: metadata.guidance.sourceRecordId,
      fieldPath: "/legalAccess",
      value: "legal",
      evidenceKind: "verified_official",
      verificationStatus: "verified",
      confidence: 0.96,
      observedAt: `${metadata.guidance.publisherUpdatedAt}T00:00:00Z`,
      retrievedAt: metadata.guidance.retrievedAt,
      notes: "Current NPS visitor guidance presents this trail for public hiking; current closures and conditions must still be checked.",
    },
    {
      id: "assert:nps-exit-glacier-parking",
      sourceId: NPS_PUBLIC_TRAILS_SOURCE_ID,
      sourceRecordId: metadata.accessGuidance.sourceRecordId,
      fieldPath: "/parking",
      value: { stoppingAllowed: true, spaces: null, fee: null },
      evidenceKind: "verified_official",
      verificationStatus: "verified",
      confidence: 0.84,
      observedAt: `${metadata.accessGuidance.publisherUpdatedAt}T00:00:00Z`,
      retrievedAt: metadata.accessGuidance.retrievedAt,
      notes: "NPS reports automobile and RV parking in the Exit Glacier area, potentially limited at midday. This record does not assert the parking centroid, capacity, fee, hours, or current road status.",
    },
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: NPS_HARDING_ACCESS_ID,
    entityType: "AccessPoint",
    jurisdictionIds: ["US", "US-AK"],
    names: [{ language: "en", value: "Harding Icefield Trail lower access", kind: "primary" }],
    geometry: { type: "Point", coordinates: [...coordinates] },
    accessModes: ["car", "foot", "hiking"],
    legalAccess: "legal",
    parking: { name: "Exit Glacier area parking", stoppingAllowed: true, spaces: null, opensLocal: null, closesLocal: null, fee: null },
    summary: "Lower endpoint of the official Harding trail centerline. NPS reports nearby Exit Glacier area parking, but its exact centroid, capacity, fee, hours, and live road status remain unknown.",
    sourceAssertions: assertions,
    quality: {
      confidence: 0.87,
      verificationStatus: "verified",
      assessedAt: "2026-07-26",
      geometryConfidence: 0.96,
      accessConfidence: 0.84,
      freshness: "current",
      flags: ["current_road_status_requires_local_verification", "parking_capacity_unknown", "parking_centroid_not_surveyed", "parking_fee_unknown", "parking_hours_unknown"],
      notes: "The point is the official route endpoint, not an inferred parking centroid. Parking availability is official NPS guidance; operational details remain explicitly unknown.",
    },
    sensitivity: { action: "publish", reason: "Public visitor access on an NPS-published unrestricted trail.", authoritySourceId: NPS_PUBLIC_TRAILS_SOURCE_ID },
    originalSourceIds: assertions.map((assertion) => ({ sourceId: assertion.sourceId, recordId: assertion.sourceRecordId })),
    deliveryRegions: ["north-america"],
  };
}

function sourceNotice({ sourceRecordId, product, sourceUrl, transformationNotice }) {
  return {
    sourceId: NPS_PUBLIC_TRAILS_SOURCE_ID,
    sourceRecordId,
    publisher: PUBLIC_DOMAIN_NOTICE.publisher,
    product,
    licenceId: PUBLIC_DOMAIN_NOTICE.licenceId,
    licenceVersion: PUBLIC_DOMAIN_NOTICE.licenceVersion,
    licenceUrl: PUBLIC_DOMAIN_NOTICE.licenceUrl,
    attribution: PUBLIC_DOMAIN_NOTICE.attribution,
    sourceUrl,
    transformationNotice,
  };
}
