import { SCHEMA_VERSION } from "./domain.mjs";

export const DEFAULT_NATURE_MANIFEST_URL = "assets/data/nature/manifest.v1.json";
export const NATURE_PACKAGE_SCHEMA_VERSION = SCHEMA_VERSION;
export const DEFAULT_MAX_VIEWPORT_CELLS = 64;
export const DEFAULT_MAX_VIEWPORT_PACKAGES = 128;
export const DEFAULT_MAX_VIEWPORT_BYTES = 8_000_000;
export const DEFAULT_SPATIAL_CELL_CACHE_LIMIT = 128;

const MANIFEST_ARTIFACT_TYPE = "nature-package-manifest";
const PACKAGE_ARTIFACT_TYPE = "nature-region-package";
const SPATIAL_INDEX_ARTIFACT_TYPE = "nature-spatial-index";
const SPATIAL_CELL_PACKAGE_ARTIFACT_TYPE = "nature-spatial-cell-package";
const SPATIAL_INDEX_ZOOM = 8;
const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REGION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/;
const JURISDICTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SPATIAL_INDEX_REFERENCE_KEYS = Object.freeze([
  "bytes",
  "cellCount",
  "contentHash",
  "packageCount",
  "url",
  "zoom",
]);
const SPATIAL_INDEX_DOCUMENT_KEYS = Object.freeze([
  "artifactType",
  "cellCount",
  "cells",
  "contentHash",
  "generated",
  "packageCount",
  "schemaVersion",
  "zoom",
]);
const SPATIAL_CELL_INDEX_KEYS = Object.freeze([
  "cellId",
  "entityCount",
  "packages",
  "x",
  "y",
  "zoom",
]);
const SPATIAL_PACKAGE_INDEX_KEYS = Object.freeze([
  "bytes",
  "contentHash",
  "entityCount",
  "shardCount",
  "shardIndex",
  "url",
]);
const SPATIAL_CELL_PACKAGE_KEYS = Object.freeze([
  "artifactType",
  "cellId",
  "contentHash",
  "entities",
  "generated",
  "schemaVersion",
  "shardCount",
  "shardIndex",
  "x",
  "y",
  "zoom",
]);

export class RegionLoaderError extends Error {
  constructor(message, code = "region_loader_error", details = {}, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RegionLoaderError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class RegionalPackageLoader {
  #fetchImpl;
  #cryptoImpl;
  #manifestUrl;
  #schemaVersion;
  #manifest = null;
  #manifestIndex = null;
  #manifestPromise = null;
  #regionCache = new Map();
  #regionPromises = new Map();
  #spatialIndex = null;
  #spatialIndexPromise = null;
  #spatialCellCache = new Map();
  #spatialCellPromises = new Map();
  #maxViewportCells;
  #maxViewportPackages;
  #maxViewportBytes;
  #spatialCellCacheLimit;

  constructor(options = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError("RegionalPackageLoader requires a fetch implementation");
    }
    const manifestUrl = options.manifestUrl ?? DEFAULT_NATURE_MANIFEST_URL;
    if (typeof manifestUrl !== "string" || !manifestUrl.trim()) {
      throw new TypeError("RegionalPackageLoader requires a non-empty manifestUrl");
    }
    this.#fetchImpl = fetchImpl;
    this.#cryptoImpl = Object.hasOwn(options, "cryptoImpl")
      ? options.cryptoImpl
      : globalThis.crypto;
    this.#manifestUrl = manifestUrl;
    this.#schemaVersion = options.schemaVersion ?? NATURE_PACKAGE_SCHEMA_VERSION;
    this.#maxViewportCells = configuredPositiveLimit(
      options.maxViewportCells,
      DEFAULT_MAX_VIEWPORT_CELLS,
      "maxViewportCells",
    );
    this.#maxViewportPackages = configuredPositiveLimit(
      options.maxViewportPackages,
      DEFAULT_MAX_VIEWPORT_PACKAGES,
      "maxViewportPackages",
    );
    this.#maxViewportBytes = configuredPositiveLimit(
      options.maxViewportBytes,
      DEFAULT_MAX_VIEWPORT_BYTES,
      "maxViewportBytes",
    );
    this.#spatialCellCacheLimit = configuredPositiveLimit(
      options.spatialCellCacheLimit,
      DEFAULT_SPATIAL_CELL_CACHE_LIMIT,
      "spatialCellCacheLimit",
    );
  }

  get manifestUrl() {
    return this.#manifestUrl;
  }

  get cachedRegionIds() {
    return [...this.#regionCache.keys()].sort();
  }

  get cachedSpatialCellIds() {
    return [...this.#spatialCellCache.keys()].sort();
  }

  async loadManifest(options = {}) {
    const signal = optionSignal(options);
    throwIfAborted(signal);

    if (this.#manifest) {
      return awaitWithAbort(Promise.resolve(this.#manifest), signal);
    }

    if (!this.#manifestPromise) {
      const tracked = this.#fetchManifest()
        .then(({ document, index }) => {
          this.#manifest = deepFreeze(document);
          this.#manifestIndex = index;
          return this.#manifest;
        })
        .finally(() => {
          if (this.#manifestPromise === tracked) this.#manifestPromise = null;
        });
      this.#manifestPromise = tracked;
    }

    return awaitWithAbort(this.#manifestPromise, signal);
  }

  async loadRegion(regionId, options = {}) {
    const normalizedRegionId = normalizeRegionId(regionId);
    const signal = optionSignal(options);
    throwIfAborted(signal);

    if (this.#regionCache.has(normalizedRegionId)) {
      return awaitWithAbort(
        Promise.resolve(this.#regionCache.get(normalizedRegionId)),
        signal,
      );
    }

    let tracked = this.#regionPromises.get(normalizedRegionId);
    if (!tracked) {
      tracked = this.#fetchRegion(normalizedRegionId)
        .then((document) => {
          const immutableDocument = deepFreeze(document);
          this.#regionCache.set(normalizedRegionId, immutableDocument);
          return immutableDocument;
        })
        .finally(() => {
          if (this.#regionPromises.get(normalizedRegionId) === tracked) {
            this.#regionPromises.delete(normalizedRegionId);
          }
        });
      this.#regionPromises.set(normalizedRegionId, tracked);
    }

    return awaitWithAbort(tracked, signal);
  }

  async loadRegions(regionIds, options = {}) {
    if (!Array.isArray(regionIds)) {
      throw new RegionLoaderError(
        "regionIds must be an array",
        "invalid_region_id",
      );
    }
    const uniqueRegionIds = [];
    const seen = new Set();
    for (const regionId of regionIds) {
      const normalized = normalizeRegionId(regionId);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        uniqueRegionIds.push(normalized);
      }
    }
    return Promise.all(
      uniqueRegionIds.map((regionId) => this.loadRegion(regionId, options)),
    );
  }

  hasCachedRegion(regionId) {
    return this.#regionCache.has(normalizeRegionId(regionId));
  }

  getCachedRegion(regionId) {
    return this.#regionCache.get(normalizeRegionId(regionId)) || null;
  }

  async loadSpatialIndex(options = {}) {
    const signal = optionSignal(options);
    throwIfAborted(signal);
    const manifest = await this.loadManifest({ signal });
    const reference = manifest.spatialIndex;
    if (!reference) {
      throw new RegionLoaderError(
        "Nature manifest does not advertise a spatial index",
        "spatial_index_not_found",
      );
    }

    if (this.#spatialIndex) {
      return awaitWithAbort(Promise.resolve(this.#spatialIndex), signal);
    }

    if (!this.#spatialIndexPromise) {
      const tracked = this.#fetchSpatialIndex(reference)
        .then((document) => {
          this.#spatialIndex = deepFreeze(document);
          return this.#spatialIndex;
        })
        .finally(() => {
          if (this.#spatialIndexPromise === tracked) this.#spatialIndexPromise = null;
        });
      this.#spatialIndexPromise = tracked;
    }

    return awaitWithAbort(this.#spatialIndexPromise, signal);
  }

  async loadViewport(bounds, options = {}) {
    const normalizedBounds = validateViewportBounds(bounds);
    const signal = optionSignal(options);
    const limits = viewportRequestLimits(
      options,
      this.#maxViewportCells,
      this.#maxViewportPackages,
      this.#maxViewportBytes,
    );
    throwIfAborted(signal);
    const spatialIndex = await this.loadSpatialIndex({ signal });
    const selectedCells = selectSpatialCells(
      spatialIndex.cells,
      normalizedBounds,
      spatialIndex.zoom,
    );
    const packageCount = selectedCells.reduce(
      (total, entry) => total + entry.packages.length,
      0,
    );
    const packageBytes = selectedCells.reduce(
      (total, entry) => total + entry.packages.reduce(
        (cellTotal, packageEntry) => cellTotal + packageEntry.bytes,
        0,
      ),
      0,
    );
    const manifestMaxBytes = this.#manifest?.budgets?.viewportRequestBytes
      ?? this.#maxViewportBytes;
    const maxBytes = Math.min(limits.maxBytes, manifestMaxBytes);
    if (selectedCells.length > limits.maxCells
        || packageCount > limits.maxPackages
        || packageBytes > maxBytes) {
      throw new RegionLoaderError(
        "Viewport exceeds spatial cell, package, or raw-byte request limits",
        "viewport_request_limit_exceeded",
        {
          cellCount: selectedCells.length,
          packageCount,
          maxCells: limits.maxCells,
          maxPackages: limits.maxPackages,
          packageBytes,
          maxBytes,
        },
      );
    }
    const loading = Promise.all(
      selectedCells.map((entry) => this.#loadSpatialCell(entry)),
    );
    const cells = await awaitWithAbort(loading, signal);
    return deepFreeze(buildLogicalSpatialViewport(
      normalizedBounds,
      spatialIndex.zoom,
      cells,
      this.#schemaVersion,
      packageBytes,
    ));
  }

  hasCachedSpatialCell(cellId) {
    return this.#spatialCellCache.has(normalizeCellId(cellId));
  }

  getCachedSpatialCell(cellId) {
    const normalized = normalizeCellId(cellId);
    const cached = this.#spatialCellCache.get(normalized);
    if (!cached) return null;
    this.#spatialCellCache.delete(normalized);
    this.#spatialCellCache.set(normalized, cached);
    return cached;
  }

  async #fetchManifest() {
    const document = await fetchJson(
      this.#fetchImpl,
      this.#manifestUrl,
      "manifest",
      "no-cache",
    );
    return validateManifest(document, this.#schemaVersion);
  }

  async #fetchRegion(regionId) {
    await this.loadManifest();
    const entries = this.#manifestIndex.get(regionId);
    if (!entries) {
      throw new RegionLoaderError(
        "No regional package is advertised for " + regionId,
        "region_not_found",
        { regionId },
      );
    }

    const documents = await Promise.all(
      entries.map((entry) => this.#fetchPackage(entry, regionId)),
    );
    return buildLogicalRegionPackage(
      regionId,
      documents,
      this.#schemaVersion,
    );
  }

  async #fetchPackage(entry, regionId) {
    const details = {
      regionId,
      ...(entry.shardIndex === undefined ? {} : { shardIndex: entry.shardIndex }),
    };
    const document = await fetchJson(
      this.#fetchImpl,
      entry.url,
      "package",
      "force-cache",
      details,
    );
    await validatePackage(
      document,
      entry,
      regionId,
      this.#schemaVersion,
      this.#cryptoImpl,
    );
    return document;
  }

  async #fetchSpatialIndex(reference) {
    const document = await fetchJsonWithBytes(
      this.#fetchImpl,
      reference.url,
      "spatial_index",
      "force-cache",
      reference.bytes,
    );
    await validateSpatialIndex(
      document,
      reference,
      this.#schemaVersion,
      this.#cryptoImpl,
    );
    return document;
  }

  #loadSpatialCell(entry) {
    if (this.#spatialCellCache.has(entry.cellId)) {
      const cached = this.#spatialCellCache.get(entry.cellId);
      this.#spatialCellCache.delete(entry.cellId);
      this.#spatialCellCache.set(entry.cellId, cached);
      return Promise.resolve(cached);
    }

    let tracked = this.#spatialCellPromises.get(entry.cellId);
    if (!tracked) {
      tracked = this.#fetchSpatialCell(entry)
        .then((document) => {
          const immutableDocument = deepFreeze(document);
          this.#spatialCellCache.delete(entry.cellId);
          this.#spatialCellCache.set(entry.cellId, immutableDocument);
          while (this.#spatialCellCache.size > this.#spatialCellCacheLimit) {
            this.#spatialCellCache.delete(this.#spatialCellCache.keys().next().value);
          }
          return immutableDocument;
        })
        .finally(() => {
          if (this.#spatialCellPromises.get(entry.cellId) === tracked) {
            this.#spatialCellPromises.delete(entry.cellId);
          }
        });
      this.#spatialCellPromises.set(entry.cellId, tracked);
    }
    return tracked;
  }

  async #fetchSpatialCell(entry) {
    const documents = await Promise.all(
      entry.packages.map((packageEntry) =>
        this.#fetchSpatialCellPackage(entry, packageEntry)),
    );
    return buildLogicalSpatialCell(entry, documents, this.#schemaVersion);
  }

  async #fetchSpatialCellPackage(cellEntry, packageEntry) {
    const details = {
      cellId: cellEntry.cellId,
      shardIndex: packageEntry.shardIndex,
    };
    const document = await fetchJsonWithBytes(
      this.#fetchImpl,
      packageEntry.url,
      "spatial_package",
      "force-cache",
      packageEntry.bytes,
      details,
    );
    await validateSpatialCellPackage(
      document,
      cellEntry,
      packageEntry,
      this.#schemaVersion,
      this.#cryptoImpl,
    );
    return document;
  }
}

export function createRegionalPackageLoader(options = {}) {
  return new RegionalPackageLoader(options);
}

export function canonicalJson(value) {
  return JSON.stringify(sortCanonicalValue(value));
}

async function fetchJson(fetchImpl, url, kind, cache, details = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new RegionLoaderError(
        "Regional data loading was aborted",
        "aborted",
        details,
        { cause: error },
      );
    }
    throw new RegionLoaderError(
      "Unable to fetch nature " + kind,
      kind + "_fetch_failed",
      details,
      { cause: error },
    );
  }

  if (!response || response.ok !== true) {
    throw new RegionLoaderError(
      "Nature " + kind + " request failed",
      kind + "_fetch_failed",
      { ...details, status: Number(response?.status) || 0 },
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new RegionLoaderError(
      "Nature " + kind + " is not valid JSON",
      kind + "_invalid_json",
      details,
      { cause: error },
    );
  }
}

function validateManifest(document, schemaVersion) {
  if (!isPlainObject(document)) {
    throw manifestInvalid("Manifest must be an object");
  }
  if (document.schemaVersion !== schemaVersion) {
    throw new RegionLoaderError(
      "Unsupported nature manifest schema version",
      "manifest_schema_mismatch",
      { expected: schemaVersion, actual: document.schemaVersion ?? null },
    );
  }
  if (document.artifactType !== MANIFEST_ARTIFACT_TYPE || document.generated !== true) {
    throw manifestInvalid("Manifest identity is invalid");
  }
  if (typeof document.buildId !== "string" || !/^[a-f0-9]{16}$/.test(document.buildId)) {
    throw manifestInvalid("Manifest buildId is invalid");
  }
  if (!Array.isArray(document.packages)) {
    throw manifestInvalid("Manifest packages must be an array");
  }
  if (!isPlainObject(document.budgets)) {
    throw manifestInvalid("Manifest budgets must be an object");
  }
  if (Object.hasOwn(document.budgets, "viewportRequestBytes")
      && (!Number.isSafeInteger(document.budgets.viewportRequestBytes)
        || document.budgets.viewportRequestBytes < 1)) {
    throw manifestInvalid("Manifest viewportRequestBytes budget is invalid");
  }

  const index = new Map();
  const packageUrls = new Set();
  for (const [position, entry] of document.packages.entries()) {
    if (!isPlainObject(entry)) {
      throw manifestInvalid("Manifest package entry must be an object", { position });
    }
    const regionId = validateManifestRegionId(entry.regionId, position);
    if (typeof entry.url !== "string" || !entry.url.trim()) {
      throw manifestInvalid("Manifest package URL is invalid", { regionId });
    }
    if (typeof entry.contentHash !== "string" || !SHA256_PATTERN.test(entry.contentHash)) {
      throw manifestInvalid("Manifest package hash is invalid", { regionId });
    }
    if (packageUrls.has(entry.url)) {
      throw manifestInvalid("Manifest contains a duplicate package URL", { regionId });
    }
    packageUrls.add(entry.url);
    validateJurisdictionIds(
      entry.jurisdictionIds,
      "manifest_invalid",
      "Manifest package jurisdictionIds",
      { regionId, requireSorted: true },
    );
    validateContentAddressedUrl(entry);
    const regionEntries = index.get(regionId) || [];
    regionEntries.push(entry);
    index.set(regionId, regionEntries);
  }

  for (const [regionId, entries] of index) {
    index.set(regionId, validateManifestShardEntries(regionId, entries));
  }

  if (Object.hasOwn(document, "spatialIndex")) {
    validateSpatialIndexReference(document.spatialIndex);
  }

  return { document, index };
}

function validateManifestShardEntries(regionId, entries) {
  const identities = entries.map((entry) => shardIdentity(
    entry,
    "manifest_invalid",
    { regionId },
  ));
  const hasShards = identities.some(Boolean);

  if (!hasShards) {
    if (entries.length !== 1) {
      throw manifestInvalid(
        "Multiple packages for one region require shardIndex and shardCount",
        { regionId },
      );
    }
    return entries;
  }
  if (identities.some((identity) => !identity)) {
    throw manifestInvalid(
      "Every package in a sharded region must declare shard identity",
      { regionId },
    );
  }

  const shardCount = identities[0].shardCount;
  if (shardCount !== entries.length
      || identities.some((identity) => identity.shardCount !== shardCount)) {
    throw manifestInvalid(
      "Regional shardCount does not match the advertised package entries",
      { regionId, shardCount },
    );
  }

  const indexed = entries
    .map((entry, position) => ({
      entry,
      shardIndex: identities[position].shardIndex,
    }))
    .sort((left, right) => left.shardIndex - right.shardIndex);
  for (let expected = 0; expected < shardCount; expected += 1) {
    if (indexed[expected]?.shardIndex !== expected) {
      throw manifestInvalid(
        "Regional shard indexes must be unique and contiguous from zero",
        { regionId, shardCount },
      );
    }
  }
  return indexed.map(({ entry }) => entry);
}

function shardIdentity(value, code, details) {
  const hasIndex = Object.hasOwn(value, "shardIndex");
  const hasCount = Object.hasOwn(value, "shardCount");
  if (hasIndex !== hasCount) {
    throw new RegionLoaderError(
      "shardIndex and shardCount must be declared together",
      code,
      details,
    );
  }
  if (!hasIndex) return null;
  if (!Number.isSafeInteger(value.shardIndex)
      || !Number.isSafeInteger(value.shardCount)
      || value.shardIndex < 0
      || value.shardCount < 1
      || value.shardIndex >= value.shardCount) {
    throw new RegionLoaderError(
      "Shard identity is invalid",
      code,
      details,
    );
  }
  return {
    shardIndex: value.shardIndex,
    shardCount: value.shardCount,
  };
}

function validatePackageShardIdentity(document, manifestEntry, regionId) {
  const details = { regionId };
  const documentIdentity = shardIdentity(
    document,
    "package_identity_mismatch",
    details,
  );
  const manifestIdentity = shardIdentity(
    manifestEntry,
    "manifest_invalid",
    details,
  );
  if (Boolean(documentIdentity) !== Boolean(manifestIdentity)
      || (documentIdentity
        && (documentIdentity.shardIndex !== manifestIdentity.shardIndex
          || documentIdentity.shardCount !== manifestIdentity.shardCount))) {
    throw new RegionLoaderError(
      "Regional package shard identity does not match the manifest",
      "package_identity_mismatch",
      {
        regionId,
        expectedShardIndex: manifestIdentity?.shardIndex ?? null,
        actualShardIndex: documentIdentity?.shardIndex ?? null,
      },
    );
  }
}

async function validatePackage(
  document,
  manifestEntry,
  requestedRegionId,
  schemaVersion,
  cryptoImpl,
) {
  if (!isPlainObject(document)) {
    throw packageInvalid("Regional package must be an object", requestedRegionId);
  }
  if (document.schemaVersion !== schemaVersion) {
    throw new RegionLoaderError(
      "Unsupported regional package schema version",
      "package_schema_mismatch",
      {
        regionId: requestedRegionId,
        expected: schemaVersion,
        actual: document.schemaVersion ?? null,
      },
    );
  }
  if (document.artifactType !== PACKAGE_ARTIFACT_TYPE || document.generated !== true) {
    throw packageInvalid("Regional package identity is invalid", requestedRegionId);
  }
  if (document.regionId !== requestedRegionId) {
    throw new RegionLoaderError(
      "Regional package does not match the requested region",
      "package_identity_mismatch",
      {
        regionId: requestedRegionId,
        actualRegionId: document.regionId ?? null,
      },
    );
  }
  validatePackageShardIdentity(document, manifestEntry, requestedRegionId);
  if (document.contentHash !== manifestEntry.contentHash) {
    throw new RegionLoaderError(
      "Regional package hash does not match its manifest entry",
      "package_hash_mismatch",
      {
        regionId: requestedRegionId,
        expected: manifestEntry.contentHash,
        actual: document.contentHash ?? null,
      },
    );
  }
  if (!Array.isArray(document.entities)) {
    throw packageInvalid("Regional package entities must be an array", requestedRegionId);
  }

  const jurisdictionIds = validateEntityIdentities(
    document.entities,
    requestedRegionId,
    schemaVersion,
  );
  const advertisedJurisdictions = validateJurisdictionIds(
    manifestEntry.jurisdictionIds,
    "manifest_invalid",
    "Manifest package jurisdictionIds",
    { regionId: requestedRegionId, requireSorted: true },
  );
  if (!sameStringArray(jurisdictionIds, advertisedJurisdictions)) {
    throw new RegionLoaderError(
      "Regional package jurisdictions do not match the manifest",
      "package_jurisdiction_mismatch",
      {
        regionId: requestedRegionId,
        expected: advertisedJurisdictions,
        actual: jurisdictionIds,
      },
    );
  }

  const packageCore = { ...document };
  delete packageCore.contentHash;
  const computedHash = await canonicalSha256(packageCore, cryptoImpl, requestedRegionId);
  if (computedHash !== manifestEntry.contentHash) {
    throw new RegionLoaderError(
      "Regional package content failed integrity verification",
      "package_hash_mismatch",
      {
        regionId: requestedRegionId,
        expected: manifestEntry.contentHash,
        actual: computedHash,
      },
    );
  }
}

function buildLogicalRegionPackage(regionId, documents, schemaVersion) {
  const entitiesById = new Map();
  const jurisdictionIds = new Set();

  for (const document of documents) {
    for (const entity of document.entities) {
      const prior = entitiesById.get(entity.id);
      if (prior && canonicalJson(prior) !== canonicalJson(entity)) {
        throw new RegionLoaderError(
          "Regional shards contain conflicting entities with the same ID",
          "package_entity_conflict",
          { regionId, entityId: entity.id },
        );
      }
      if (!prior) entitiesById.set(entity.id, entity);
      for (const jurisdictionId of entity.jurisdictionIds) {
        jurisdictionIds.add(jurisdictionId);
      }
    }
  }

  return {
    schemaVersion,
    artifactType: "nature-region-package-set",
    generated: true,
    regionId,
    shardCount: documents.length,
    contentHashes: documents.map((document) => document.contentHash),
    jurisdictionIds: [...jurisdictionIds].sort(),
    packages: documents,
    entities: [...entitiesById.values()].sort((left, right) =>
      left.id.localeCompare(right.id)),
  };
}

function validateEntityIdentities(entities, regionId, schemaVersion) {
  const entityIds = new Set();
  const jurisdictionIds = new Set();

  for (const [position, entity] of entities.entries()) {
    if (!isPlainObject(entity)
        || typeof entity.id !== "string"
        || !ENTITY_ID_PATTERN.test(entity.id)) {
      throw new RegionLoaderError(
        "Regional package contains an invalid entity ID",
        "package_entity_invalid",
        { regionId, position },
      );
    }
    if (entityIds.has(entity.id)) {
      throw new RegionLoaderError(
        "Regional package contains duplicate entity IDs",
        "package_entity_invalid",
        { regionId, entityId: entity.id },
      );
    }
    entityIds.add(entity.id);

    if (entity.schemaVersion !== schemaVersion) {
      throw new RegionLoaderError(
        "Regional package entity uses an unsupported schema version",
        "package_entity_invalid",
        {
          regionId,
          entityId: entity.id,
          expected: schemaVersion,
          actual: entity.schemaVersion ?? null,
        },
      );
    }

    const entityJurisdictions = validateJurisdictionIds(
      entity.jurisdictionIds,
      "package_entity_invalid",
      "Entity jurisdictionIds",
      { regionId, entityId: entity.id },
    );
    for (const jurisdictionId of entityJurisdictions) {
      jurisdictionIds.add(jurisdictionId);
    }

    if (Array.isArray(entity.deliveryRegions)
        && entity.deliveryRegions.length > 0
        && !entity.deliveryRegions.includes(regionId)) {
      throw new RegionLoaderError(
        "Regional package contains an entity assigned to another region",
        "package_identity_mismatch",
        { regionId, entityId: entity.id },
      );
    }
  }

  return [...jurisdictionIds].sort();
}

function validateJurisdictionIds(value, code, label, options = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RegionLoaderError(
      label + " must be a non-empty array",
      code,
      compactDetails(options),
    );
  }
  const seen = new Set();
  for (const jurisdictionId of value) {
    if (typeof jurisdictionId !== "string"
        || !JURISDICTION_ID_PATTERN.test(jurisdictionId)
        || seen.has(jurisdictionId)) {
      throw new RegionLoaderError(
        label + " contains an invalid or duplicate jurisdiction ID",
        code,
        compactDetails(options),
      );
    }
    seen.add(jurisdictionId);
  }
  const sorted = [...seen].sort();
  if (options.requireSorted && !sameStringArray(value, sorted)) {
    throw new RegionLoaderError(
      label + " must be sorted",
      code,
      compactDetails(options),
    );
  }
  return sorted;
}

function validateContentAddressedUrl(entry) {
  const path = entry.url.split(/[?#]/, 1)[0].replaceAll("\\", "/");
  const segments = path.split("/").filter(Boolean);
  const expectedFilename = entry.contentHash.slice("sha256:".length, 23) + ".json";
  if (segments.at(-1) !== expectedFilename || segments.at(-2) !== entry.regionId) {
    throw manifestInvalid(
      "Manifest package URL is not content-addressed for its region",
      { regionId: entry.regionId },
    );
  }
}

function validateManifestRegionId(regionId, position) {
  try {
    return normalizeRegionId(regionId);
  } catch (error) {
    throw manifestInvalid("Manifest package regionId is invalid", { position });
  }
}

function normalizeRegionId(regionId) {
  if (typeof regionId !== "string" || !REGION_ID_PATTERN.test(regionId)) {
    throw new RegionLoaderError(
      "Region ID must be a lowercase stable identifier",
      "invalid_region_id",
    );
  }
  return regionId;
}

async function canonicalSha256(value, cryptoImpl, context) {
  const details = typeof context === "string" ? { regionId: context } : context || {};
  if (typeof TextEncoder !== "function"
      || !cryptoImpl?.subtle
      || typeof cryptoImpl.subtle.digest !== "function") {
    throw new RegionLoaderError(
      "Web Crypto SHA-256 is unavailable",
      "hash_unavailable",
      details,
    );
  }

  let digest;
  try {
    digest = await cryptoImpl.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson(value)),
    );
  } catch (error) {
    throw new RegionLoaderError(
      "Unable to verify regional package integrity",
      "hash_failed",
      details,
      { cause: error },
    );
  }
  const hexadecimal = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return "sha256:" + hexadecimal;
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortCanonicalValue(value[key])]),
  );
}

function optionSignal(options) {
  const signal = isAbortSignal(options) ? options : options?.signal;
  if (signal == null) return null;
  if (!isAbortSignal(signal)) {
    throw new RegionLoaderError(
      "signal must be an AbortSignal",
      "invalid_signal",
    );
  }
  return signal;
}

function configuredPositiveLimit(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function viewportRequestLimits(
  options,
  defaultMaxCells,
  defaultMaxPackages,
  defaultMaxBytes,
) {
  if (isAbortSignal(options)) {
    return {
      maxCells: defaultMaxCells,
      maxPackages: defaultMaxPackages,
      maxBytes: defaultMaxBytes,
    };
  }
  const maxCells = perRequestPositiveLimit(
    options?.maxCells,
    defaultMaxCells,
    "maxCells",
  );
  const maxPackages = perRequestPositiveLimit(
    options?.maxPackages,
    defaultMaxPackages,
    "maxPackages",
  );
  const maxBytes = perRequestPositiveLimit(
    options?.maxBytes,
    defaultMaxBytes,
    "maxBytes",
  );
  return { maxCells, maxPackages, maxBytes };
}

function perRequestPositiveLimit(value, fallback, field) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RegionLoaderError(
      `${field} must be a positive safe integer`,
      "invalid_viewport_limit",
      { field },
    );
  }
  return value;
}

function isAbortSignal(value) {
  return Boolean(value)
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new RegionLoaderError(
      "Regional data loading was aborted",
      "aborted",
    );
  }
}

function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new RegionLoaderError(
      "Regional data loading was aborted",
      "aborted",
    ));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new RegionLoaderError(
        "Regional data loading was aborted",
        "aborted",
      ));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function manifestInvalid(message, details = {}) {
  return new RegionLoaderError(message, "manifest_invalid", details);
}

function packageInvalid(message, regionId, details = {}) {
  return new RegionLoaderError(
    message,
    "package_invalid",
    { regionId, ...details },
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameStringArray(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function compactDetails(options) {
  return Object.fromEntries(
    ["regionId", "entityId", "position"]
      .filter((key) => options[key] !== undefined)
      .map((key) => [key, options[key]]),
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

async function fetchJsonWithBytes(
  fetchImpl,
  url,
  kind,
  cache,
  expectedBytes,
  details = {},
) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new RegionLoaderError(
        "Spatial data loading was aborted",
        "aborted",
        details,
        { cause: error },
      );
    }
    throw new RegionLoaderError(
      "Unable to fetch nature " + kind,
      kind + "_fetch_failed",
      details,
      { cause: error },
    );
  }

  if (!response || response.ok !== true) {
    throw new RegionLoaderError(
      "Nature " + kind + " request failed",
      kind + "_fetch_failed",
      { ...details, status: Number(response?.status) || 0 },
    );
  }

  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    throw new RegionLoaderError(
      "Unable to read nature " + kind,
      kind + "_invalid_json",
      details,
      { cause: error },
    );
  }
  const actualBytes = utf8ByteLength(raw, kind, details);
  if (actualBytes !== expectedBytes) {
    throw new RegionLoaderError(
      "Nature " + kind + " byte length does not match the index",
      kind + "_bytes_mismatch",
      { ...details, expected: expectedBytes, actual: actualBytes },
    );
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new RegionLoaderError(
      "Nature " + kind + " is not valid JSON",
      kind + "_invalid_json",
      details,
      { cause: error },
    );
  }
}

function validateSpatialIndexReference(reference) {
  if (!isPlainObject(reference)) {
    throw manifestInvalid("Manifest spatialIndex must be an object");
  }
  validateExactKeys(
    reference,
    SPATIAL_INDEX_REFERENCE_KEYS,
    manifestInvalid,
    "Manifest spatialIndex",
  );
  validateSpatialZoom(reference.zoom, manifestInvalid, "Manifest spatialIndex zoom");
  if (typeof reference.url !== "string" || !reference.url) {
    throw manifestInvalid("Manifest spatialIndex URL is invalid");
  }
  if (typeof reference.contentHash !== "string"
      || !SHA256_PATTERN.test(reference.contentHash)) {
    throw manifestInvalid("Manifest spatialIndex hash is invalid");
  }
  validateSafeInteger(reference.bytes, 1, manifestInvalid, "Manifest spatialIndex bytes");
  validateSafeInteger(reference.cellCount, 0, manifestInvalid, "Manifest spatialIndex cellCount");
  validateSafeInteger(
    reference.packageCount,
    0,
    manifestInvalid,
    "Manifest spatialIndex packageCount",
  );
  validateSpatialIndexUrl(reference.url, reference.contentHash, manifestInvalid);
}

async function validateSpatialIndex(document, reference, schemaVersion, cryptoImpl) {
  const invalid = (message, details = {}) => spatialIndexInvalid(message, details);
  if (!isPlainObject(document)) {
    throw invalid("Spatial index must be an object");
  }
  validateExactKeys(document, SPATIAL_INDEX_DOCUMENT_KEYS, invalid, "Spatial index");
  if (document.schemaVersion !== schemaVersion) {
    throw new RegionLoaderError(
      "Unsupported spatial index schema version",
      "spatial_index_schema_mismatch",
      { expected: schemaVersion, actual: document.schemaVersion ?? null },
    );
  }
  if (document.artifactType !== SPATIAL_INDEX_ARTIFACT_TYPE
      || document.generated !== true) {
    throw invalid("Spatial index identity is invalid");
  }
  validateSpatialZoom(document.zoom, invalid, "Spatial index zoom");
  if (document.zoom !== reference.zoom) {
    throw invalid("Spatial index zoom does not match the manifest");
  }
  if (document.contentHash !== reference.contentHash) {
    throw new RegionLoaderError(
      "Spatial index hash does not match its manifest reference",
      "spatial_index_hash_mismatch",
      { expected: reference.contentHash, actual: document.contentHash ?? null },
    );
  }
  if (!Array.isArray(document.cells)) {
    throw invalid("Spatial index cells must be an array");
  }
  validateSafeInteger(document.cellCount, 0, invalid, "Spatial index cellCount");
  validateSafeInteger(document.packageCount, 0, invalid, "Spatial index packageCount");
  if (document.cellCount !== reference.cellCount
      || document.packageCount !== reference.packageCount) {
    throw invalid("Spatial index counts do not match the manifest");
  }

  const counts = validateSpatialIndexCells(document.cells, document.zoom);
  if (document.cellCount !== counts.cellCount
      || document.packageCount !== counts.packageCount) {
    throw invalid("Spatial index counts do not match its cells");
  }

  const core = { ...document };
  delete core.contentHash;
  const computedHash = await canonicalSha256(core, cryptoImpl, { artifact: "spatialIndex" });
  if (computedHash !== reference.contentHash) {
    throw new RegionLoaderError(
      "Spatial index content failed integrity verification",
      "spatial_index_hash_mismatch",
      { expected: reference.contentHash, actual: computedHash },
    );
  }
}

function validateSpatialIndexCells(cells, zoom) {
  const cellIds = new Set();
  const packageUrls = new Set();
  let previousCellId = null;
  let packageCount = 0;
  for (const [position, cell] of cells.entries()) {
    const invalid = (message, details = {}) => spatialIndexInvalid(
      message,
      { position, ...details },
    );
    if (!isPlainObject(cell)) {
      throw invalid("Spatial index cell entry must be an object");
    }
    validateExactKeys(cell, SPATIAL_CELL_INDEX_KEYS, invalid, "Spatial index cell");
    validateSpatialCellIdentity(cell, zoom, invalid);
    if (cellIds.has(cell.cellId)
        || (previousCellId !== null && previousCellId.localeCompare(cell.cellId) >= 0)) {
      throw invalid("Spatial index cells must have unique sorted cellIds", { cellId: cell.cellId });
    }
    cellIds.add(cell.cellId);
    previousCellId = cell.cellId;
    validateSafeInteger(cell.entityCount, 1, invalid, "Spatial cell entityCount");
    if (!Array.isArray(cell.packages) || cell.packages.length === 0) {
      throw invalid("Spatial cell packages must be a non-empty array", { cellId: cell.cellId });
    }
    const entityCount = validateSpatialPackageIndexEntries(cell, packageUrls);
    if (cell.entityCount !== entityCount) {
      throw invalid("Spatial cell entityCount does not match its packages", {
        cellId: cell.cellId,
      });
    }
    packageCount += cell.packages.length;
  }
  return { cellCount: cells.length, packageCount };
}

function validateSpatialPackageIndexEntries(cell, packageUrls) {
  let entityCount = 0;
  for (const [position, entry] of cell.packages.entries()) {
    const details = { cellId: cell.cellId, position };
    const invalid = (message, extra = {}) => spatialIndexInvalid(
      message,
      { ...details, ...extra },
    );
    if (!isPlainObject(entry)) {
      throw invalid("Spatial package index entry must be an object");
    }
    validateExactKeys(
      entry,
      SPATIAL_PACKAGE_INDEX_KEYS,
      invalid,
      "Spatial package index entry",
    );
    const identity = shardIdentity(entry, "spatial_index_invalid", details);
    if (!identity
        || identity.shardCount !== cell.packages.length
        || identity.shardIndex !== position) {
      throw invalid("Spatial package shards must be sorted, contiguous, and complete");
    }
    if (typeof entry.url !== "string" || !entry.url) {
      throw invalid("Spatial package URL is invalid");
    }
    if (typeof entry.contentHash !== "string" || !SHA256_PATTERN.test(entry.contentHash)) {
      throw invalid("Spatial package hash is invalid");
    }
    validateSafeInteger(entry.bytes, 1, invalid, "Spatial package bytes");
    validateSafeInteger(entry.entityCount, 1, invalid, "Spatial package entityCount");
    validateSpatialCellPackageUrl(cell, entry, invalid);
    if (packageUrls.has(entry.url)) {
      throw invalid("Spatial index contains a duplicate package URL");
    }
    packageUrls.add(entry.url);
    entityCount += entry.entityCount;
  }
  return entityCount;
}

async function validateSpatialCellPackage(
  document,
  cellEntry,
  packageEntry,
  schemaVersion,
  cryptoImpl,
) {
  const details = {
    cellId: cellEntry.cellId,
    shardIndex: packageEntry.shardIndex,
  };
  const invalid = (message, extra = {}) => spatialPackageInvalid(
    message,
    { ...details, ...extra },
  );
  if (!isPlainObject(document)) {
    throw invalid("Spatial cell package must be an object");
  }
  validateExactKeys(
    document,
    SPATIAL_CELL_PACKAGE_KEYS,
    invalid,
    "Spatial cell package",
  );
  if (document.schemaVersion !== schemaVersion) {
    throw new RegionLoaderError(
      "Unsupported spatial cell package schema version",
      "spatial_package_schema_mismatch",
      {
        ...details,
        expected: schemaVersion,
        actual: document.schemaVersion ?? null,
      },
    );
  }
  if (document.artifactType !== SPATIAL_CELL_PACKAGE_ARTIFACT_TYPE
      || document.generated !== true) {
    throw invalid("Spatial cell package identity is invalid");
  }
  validateSpatialCellIdentity(document, cellEntry.zoom, invalid);
  if (document.cellId !== cellEntry.cellId
      || document.x !== cellEntry.x
      || document.y !== cellEntry.y) {
    throw new RegionLoaderError(
      "Spatial cell package does not match its index cell",
      "spatial_package_identity_mismatch",
      {
        ...details,
        actualCellId: document.cellId ?? null,
      },
    );
  }
  const documentIdentity = shardIdentity(document, "spatial_package_invalid", details);
  if (!documentIdentity
      || documentIdentity.shardIndex !== packageEntry.shardIndex
      || documentIdentity.shardCount !== packageEntry.shardCount) {
    throw new RegionLoaderError(
      "Spatial cell package shard identity does not match the index",
      "spatial_package_identity_mismatch",
      details,
    );
  }
  if (document.contentHash !== packageEntry.contentHash) {
    throw new RegionLoaderError(
      "Spatial cell package hash does not match the index",
      "spatial_package_hash_mismatch",
      {
        ...details,
        expected: packageEntry.contentHash,
        actual: document.contentHash ?? null,
      },
    );
  }
  if (!Array.isArray(document.entities)
      || document.entities.length !== packageEntry.entityCount) {
    throw invalid("Spatial cell package entityCount does not match the index");
  }
  validateSpatialEntityIdentities(document.entities, cellEntry.cellId, schemaVersion);

  const core = { ...document };
  delete core.contentHash;
  const computedHash = await canonicalSha256(core, cryptoImpl, details);
  if (computedHash !== packageEntry.contentHash) {
    throw new RegionLoaderError(
      "Spatial cell package content failed integrity verification",
      "spatial_package_hash_mismatch",
      { ...details, expected: packageEntry.contentHash, actual: computedHash },
    );
  }
}

function validateSpatialEntityIdentities(entities, cellId, schemaVersion) {
  const entityIds = new Set();
  for (const [position, entity] of entities.entries()) {
    if (!isPlainObject(entity)
        || typeof entity.id !== "string"
        || !ENTITY_ID_PATTERN.test(entity.id)) {
      throw spatialPackageInvalid(
        "Spatial cell package contains an invalid entity ID",
        { cellId, position },
      );
    }
    if (entityIds.has(entity.id)) {
      throw spatialPackageInvalid(
        "Spatial cell package contains duplicate entity IDs",
        { cellId, entityId: entity.id },
      );
    }
    entityIds.add(entity.id);
    if (entity.schemaVersion !== schemaVersion) {
      throw spatialPackageInvalid(
        "Spatial cell package entity uses an unsupported schema version",
        { cellId, entityId: entity.id },
      );
    }
    validateJurisdictionIds(
      entity.jurisdictionIds,
      "spatial_package_invalid",
      "Spatial cell entity jurisdictionIds",
      { cellId, entityId: entity.id },
    );
  }
}

function buildLogicalSpatialCell(entry, documents, schemaVersion) {
  const entitiesById = new Map();
  for (const document of documents) {
    for (const entity of document.entities) {
      if (entitiesById.has(entity.id)) {
        throw spatialPackageInvalid(
          "Spatial cell shards contain duplicate entity IDs",
          { cellId: entry.cellId, entityId: entity.id },
        );
      }
      entitiesById.set(entity.id, entity);
    }
  }
  if (entitiesById.size !== entry.entityCount) {
    throw spatialPackageInvalid(
      "Spatial cell entityCount does not match its packages",
      { cellId: entry.cellId },
    );
  }
  return {
    schemaVersion,
    artifactType: "nature-spatial-cell-package-set",
    generated: true,
    cellId: entry.cellId,
    zoom: entry.zoom,
    x: entry.x,
    y: entry.y,
    shardCount: documents.length,
    entityCount: entitiesById.size,
    contentHashes: documents.map((document) => document.contentHash),
    packages: documents,
    entities: [...entitiesById.values()].sort((left, right) =>
      left.id.localeCompare(right.id)),
  };
}

function buildLogicalSpatialViewport(bounds, zoom, cells, schemaVersion, rawPackageBytes) {
  const entitiesById = new Map();
  const sourceCells = new Map();
  for (const cell of cells) {
    for (const entity of cell.entities) {
      const prior = entitiesById.get(entity.id);
      if (prior && canonicalJson(prior) !== canonicalJson(entity)) {
        throw new RegionLoaderError(
          "Spatial cells contain conflicting entities with the same ID",
          "spatial_entity_conflict",
          {
            entityId: entity.id,
            firstCellId: sourceCells.get(entity.id),
            secondCellId: cell.cellId,
          },
        );
      }
      if (!prior) {
        entitiesById.set(entity.id, entity);
        sourceCells.set(entity.id, cell.cellId);
      }
    }
  }
  return {
    schemaVersion,
    artifactType: "nature-spatial-viewport-package-set",
    generated: true,
    zoom,
    bounds: [...bounds],
    cellCount: cells.length,
    packageCount: cells.reduce((total, cell) => total + cell.shardCount, 0),
    rawPackageBytes,
    cellIds: cells.map((cell) => cell.cellId),
    cells,
    entities: [...entitiesById.values()].sort((left, right) =>
      left.id.localeCompare(right.id)),
  };
}

function validateViewportBounds(bounds) {
  if (!Array.isArray(bounds)
      || bounds.length !== 4
      || bounds.some((value) => !Number.isFinite(value))) {
    throw new RegionLoaderError(
      "Viewport bounds must be [west, south, east, north] finite numbers",
      "invalid_viewport_bounds",
    );
  }
  const [west, south, east, north] = bounds;
  if (west < -180
      || west > 180
      || east < -180
      || east > 180
      || south < -90
      || south > 90
      || north < -90
      || north > 90
      || south > north) {
    throw new RegionLoaderError(
      "Viewport bounds are outside longitude/latitude limits",
      "invalid_viewport_bounds",
    );
  }
  return [west, south, east, north];
}

function selectSpatialCells(cells, bounds, zoom) {
  const [west, south, east, north] = bounds;
  const tileCount = 2 ** zoom;
  const westX = longitudeToTileX(west, zoom);
  const eastX = longitudeToTileX(east, zoom);
  const xRanges = west <= east
    ? [[westX, eastX]]
    : [[westX, tileCount - 1], [0, eastX]];
  const minimumY = latitudeToTileY(north, zoom);
  const maximumY = latitudeToTileY(south, zoom);
  return cells.filter((cell) =>
    cell.y >= minimumY
      && cell.y <= maximumY
      && xRanges.some(([minimumX, maximumX]) =>
        cell.x >= minimumX && cell.x <= maximumX));
}

function longitudeToTileX(longitude, zoom) {
  const tileCount = 2 ** zoom;
  if (longitude === 180) return tileCount - 1;
  return Math.max(
    0,
    Math.min(tileCount - 1, Math.floor(((longitude + 180) / 360) * tileCount)),
  );
}

function latitudeToTileY(latitude, zoom) {
  const tileCount = 2 ** zoom;
  const clamped = Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude),
  );
  const radians = clamped * Math.PI / 180;
  const normalized = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
  return Math.max(0, Math.min(tileCount - 1, Math.floor(normalized * tileCount)));
}

function validateSpatialCellIdentity(value, expectedZoom, errorFactory) {
  validateSpatialZoom(value.zoom, errorFactory, "Spatial cell zoom");
  if (value.zoom !== expectedZoom) {
    throw errorFactory("Spatial cell zoom does not match its index");
  }
  const maximum = 2 ** value.zoom;
  if (!Number.isSafeInteger(value.x)
      || !Number.isSafeInteger(value.y)
      || value.x < 0
      || value.y < 0
      || value.x >= maximum
      || value.y >= maximum) {
    throw errorFactory("Spatial cell coordinates are invalid");
  }
  const expectedCellId = `${value.zoom}/${value.x}/${value.y}`;
  if (value.cellId !== expectedCellId) {
    throw errorFactory("Spatial cellId does not match zoom/x/y", {
      cellId: value.cellId ?? null,
    });
  }
  return expectedCellId;
}

function normalizeCellId(cellId) {
  if (typeof cellId !== "string") {
    throw new RegionLoaderError(
      "Spatial cell ID must be a stable z/x/y identifier",
      "invalid_spatial_cell_id",
    );
  }
  const parts = cellId.split("/");
  const value = parts.length === 3
    ? {
      cellId,
      zoom: Number(parts[0]),
      x: Number(parts[1]),
      y: Number(parts[2]),
    }
    : {};
  const errorFactory = (message) => new RegionLoaderError(
    message,
    "invalid_spatial_cell_id",
    { cellId },
  );
  validateSpatialCellIdentity(value, SPATIAL_INDEX_ZOOM, errorFactory);
  if (`${value.zoom}/${value.x}/${value.y}` !== cellId) {
    throw errorFactory("Spatial cell ID must use canonical decimal components");
  }
  return cellId;
}

function validateSpatialZoom(value, errorFactory, label) {
  if (value !== SPATIAL_INDEX_ZOOM) {
    throw errorFactory(`${label} must equal ${SPATIAL_INDEX_ZOOM}`);
  }
}

function validateSafeInteger(value, minimum, errorFactory, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw errorFactory(`${label} must be a safe integer of at least ${minimum}`);
  }
}

function validateExactKeys(value, expectedKeys, errorFactory, label) {
  const actualKeys = Object.keys(value).sort();
  if (!sameStringArray(actualKeys, expectedKeys)) {
    throw errorFactory(`${label} fields are invalid`);
  }
}

function validateSpatialIndexUrl(url, contentHash, errorFactory) {
  const expected = `assets/data/nature/spatial/index/${hashPrefix(contentHash)}.json`;
  if (url !== expected) {
    throw errorFactory("Manifest spatialIndex URL is not content-addressed");
  }
}

function validateSpatialCellPackageUrl(cell, entry, errorFactory) {
  const expected = `assets/data/nature/spatial/cells/${cell.zoom}/${cell.x}/${cell.y}/`
    + `${hashPrefix(entry.contentHash)}.json`;
  if (entry.url !== expected) {
    throw errorFactory("Spatial package URL is not content-addressed for its cell");
  }
}

function hashPrefix(contentHash) {
  return contentHash.slice("sha256:".length, "sha256:".length + 16);
}

function utf8ByteLength(value, kind, details) {
  if (typeof TextEncoder !== "function") {
    throw new RegionLoaderError(
      "UTF-8 byte length validation is unavailable",
      kind + "_bytes_unavailable",
      details,
    );
  }
  return new TextEncoder().encode(value).byteLength;
}

function spatialIndexInvalid(message, details = {}) {
  return new RegionLoaderError(message, "spatial_index_invalid", details);
}

function spatialPackageInvalid(message, details = {}) {
  return new RegionLoaderError(message, "spatial_package_invalid", details);
}
