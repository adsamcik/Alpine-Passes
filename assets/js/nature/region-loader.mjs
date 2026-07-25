import { SCHEMA_VERSION } from "./domain.mjs";

export const DEFAULT_NATURE_MANIFEST_URL = "assets/data/nature/manifest.v1.json";
export const NATURE_PACKAGE_SCHEMA_VERSION = SCHEMA_VERSION;

const MANIFEST_ARTIFACT_TYPE = "nature-package-manifest";
const PACKAGE_ARTIFACT_TYPE = "nature-region-package";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REGION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/;
const JURISDICTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  }

  get manifestUrl() {
    return this.#manifestUrl;
  }

  get cachedRegionIds() {
    return [...this.#regionCache.keys()].sort();
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

async function canonicalSha256(value, cryptoImpl, regionId) {
  if (typeof TextEncoder !== "function"
      || !cryptoImpl?.subtle
      || typeof cryptoImpl.subtle.digest !== "function") {
    throw new RegionLoaderError(
      "Web Crypto SHA-256 is unavailable",
      "hash_unavailable",
      { regionId },
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
      { regionId },
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
