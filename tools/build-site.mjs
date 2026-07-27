#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SITES_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const ORIGIN_METADATA_TOKEN = "__ITINERA_ORIGIN__";
export const SOURCE_RELEASE_NOTICE_RUNTIME_PATH =
  "assets/data/nature/source-release-notice.v1.json";

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(MODULE_PATH), "..");

export const REQUIRED_RUNTIME_FILES = Object.freeze([
  "index.html",
  "favicon.ico",
  "assets/favicon-32.png",
  "assets/favicon-512.png",
  "assets/apple-touch-icon.png",
  "assets/css/site.css",
  "assets/css/nature-hike-detail.css",
  "assets/vendor/maplibre/5.6.1/maplibre-gl.css",
  "assets/vendor/maplibre/5.6.1/maplibre-gl.js",
  "assets/js/itinera.bundle.js",
  "assets/js/leisure/wasm-shim.js",
  "assets/wasm/leisure-core/leisure_core.js",
  "assets/wasm/leisure-core/leisure_core_bg.wasm",
  "assets/data/leisure-graph.v1.json",
  "assets/data/poi-prices.json",
  "assets/data/nature/manifest.v1.json",
  "assets/data/nature/quality-report.v1.json",
  "assets/data/nature/coverage-report.v1.json",
  "assets/data/nature/sensitivity-report.v1.json",
  "assets/data/nature/ingestion-report.v1.json",
  "assets/data/nature/legacy-id-redirects.v1.json",
  SOURCE_RELEASE_NOTICE_RUNTIME_PATH,
  "assets/ui-icons/alpine-ui-icons.png",
  "assets/pass-icon-sheets/top-50-icon-sprite-01.png",
  "assets/pass-icon-sheets/top-50-icon-sprite-02.png",
  "assets/pass-icon-sheets/top-50-sprite-01.png",
  "assets/pass-icon-sheets/top-50-sprite-02.png",
]);

export const OPTIONAL_RUNTIME_FILES = Object.freeze([
  "assets/og-itinera-nature.png",
]);

const RUNTIME_TREES = Object.freeze([
  {
    root: "assets/js/nature",
    extension: ".mjs",
  },
  {
    root: "assets/data/nature/packages",
    extension: ".json",
  },
  {
    root: "assets/data/nature/spatial",
    extension: ".json",
  },
]);

const HTML_ASSET_EXTENSION =
  /\.(?:avif|css|gif|ico|jpe?g|js|json|mjs|png|svg|wasm|webp|woff2?|xml)$/i;
const LOCAL_PROTOCOL_PATTERN = /^(?:data|javascript|mailto|tel):/i;

export async function buildSite(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
  const distRoot = path.resolve(options.distRoot || path.join(repoRoot, "dist"));
  assertSafeDistRoot(repoRoot, distRoot);

  const runtimeFiles = new Set(REQUIRED_RUNTIME_FILES);
  for (const tree of RUNTIME_TREES) {
    const treeFiles = await listRuntimeTree(repoRoot, tree);
    if (!treeFiles.length) {
      throw new Error(`Runtime tree is empty: ${tree.root}`);
    }
    for (const filename of treeFiles) runtimeFiles.add(filename);
  }
  for (const filename of OPTIONAL_RUNTIME_FILES) {
    if (await isRegularFile(path.join(repoRoot, filename))) runtimeFiles.add(filename);
  }

  const sortedRuntimeFiles = [...runtimeFiles].sort(comparePaths);
  await validateRuntimeFiles(repoRoot, sortedRuntimeFiles);
  await validateHtmlReferences(repoRoot, runtimeFiles);
  await validateCssReferences(repoRoot, runtimeFiles);
  await validateNatureManifestReferences(repoRoot, runtimeFiles);

  const serverSource = path.join(repoRoot, "server", "routing-worker.mjs");
  await assertRuntimeFile(serverSource, "server/routing-worker.mjs");

  const stagingRoot = `${distRoot}.staging`;
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(path.join(stagingRoot, "client"), { recursive: true });
  await mkdir(path.join(stagingRoot, "server"), { recursive: true });

  try {
    const files = [];
    for (const relativePath of sortedRuntimeFiles) {
      const source = path.join(repoRoot, relativePath);
      const destinationRelative = toPosixPath(path.join("client", relativePath));
      const destination = path.join(stagingRoot, destinationRelative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      files.push(await fileDescriptor(destination, destinationRelative));
    }

    const workerRelative = "server/index.js";
    const workerDestination = path.join(stagingRoot, workerRelative);
    await copyFile(serverSource, workerDestination);
    files.push(await fileDescriptor(workerDestination, workerRelative));
    files.sort((left, right) => comparePaths(left.path, right.path));

    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const buildId = hashManifestEntries(files).slice(0, 16);
    const manifest = {
      schemaVersion: "1.0.0",
      artifactType: "itinera-site-build-manifest",
      buildId,
      sitesStaticAssetMaxBytes: SITES_MAX_FILE_BYTES,
      manifestPath: "build-manifest.json",
      fileCount: files.length,
      totalBytes,
      files,
    };
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
    assertSizeWithinLimit("build-manifest.json", manifestBytes.byteLength);
    await writeFile(path.join(stagingRoot, "build-manifest.json"), manifestBytes);

    await rm(distRoot, { recursive: true, force: true });
    await rename(stagingRoot, distRoot);

    const largestFile = files.reduce(
      (largest, file) => (file.bytes > largest.bytes ? file : largest),
      { path: "", bytes: 0, sha256: "" },
    );
    return Object.freeze({
      distRoot,
      buildId,
      fileCount: files.length,
      totalBytes,
      largestFile,
      manifest,
    });
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function extractHtmlRuntimeAssetPaths(html) {
  const paths = new Set();
  const tagPattern = /<[^>]+>/g;
  for (const tag of html.match(tagPattern) || []) {
    const attributePattern = /\b(src|href|poster|content)\s*=\s*(["'])(.*?)\2/gi;
    for (const match of tag.matchAll(attributePattern)) {
      const attribute = match[1].toLowerCase();
      const value = decodeHtmlAttribute(match[3].trim());
      if (attribute === "content" && !looksLikeAssetReference(value)) continue;
      const normalized = normalizeLocalAssetReference(
        value,
        { requireAssetExtension: attribute === "content" },
      );
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths].sort(comparePaths);
}

export function extractCssRuntimeAssetPaths(css, stylesheetPath = "assets/css/site.css") {
  const paths = new Set();
  const pattern = /url\(\s*(?:(["'])(.*?)\1|([^\)"'\s][^\)]*))\s*\)/gi;
  for (const match of css.matchAll(pattern)) {
    const value = (match[2] ?? match[3] ?? "").trim();
    if (!value || LOCAL_PROTOCOL_PATTERN.test(value) || value.startsWith("#")) continue;
    if (/^(?:https?:)?\/\//i.test(value)) continue;
    const withoutQuery = value.split(/[?#]/, 1)[0];
    const normalized = normalizeRepositoryPath(
      path.posix.join(path.posix.dirname(stylesheetPath), withoutQuery),
      `CSS asset reference ${value}`,
    );
    paths.add(normalized);
  }
  return [...paths].sort(comparePaths);
}

export async function validateHtmlReferences(repoRoot, runtimeFiles) {
  const html = await readFile(path.join(repoRoot, "index.html"), "utf8");
  for (const reference of extractHtmlRuntimeAssetPaths(html)) {
    if (!runtimeFiles.has(reference)) {
      throw new Error(`index.html references a runtime asset outside the allowlist: ${reference}`);
    }
    await assertRuntimeFile(path.join(repoRoot, reference), reference);
  }
}

async function validateCssReferences(repoRoot, runtimeFiles) {
  const stylesheet = "assets/css/site.css";
  const css = await readFile(path.join(repoRoot, stylesheet), "utf8");
  for (const reference of extractCssRuntimeAssetPaths(css, stylesheet)) {
    if (!runtimeFiles.has(reference)) {
      throw new Error(`${stylesheet} references a runtime asset outside the allowlist: ${reference}`);
    }
    await assertRuntimeFile(path.join(repoRoot, reference), reference);
  }
}

async function validateNatureManifestReferences(repoRoot, runtimeFiles) {
  const manifestPath = "assets/data/nature/manifest.v1.json";
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(repoRoot, manifestPath), "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse ${manifestPath}: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error(`${manifestPath} must advertise at least one regional package`);
  }
  await validateNatureSourceReleaseNoticeReference(repoRoot, runtimeFiles, manifest);
  for (const entry of manifest.packages) {
    if (typeof entry?.url !== "string" || !entry.url) {
      throw new Error(`${manifestPath} contains a package without a URL`);
    }
    const manifestUrl = entry.url.split(/[?#]/, 1)[0];
    const repositoryUrl = manifestUrl.startsWith("assets/data/nature/")
      ? manifestUrl
      : path.posix.join("assets/data/nature", manifestUrl);
    const relativePath = normalizeRepositoryPath(
      repositoryUrl,
      `Nature package URL ${entry.url}`,
    );
    if (!relativePath.startsWith("assets/data/nature/packages/")) {
      throw new Error(`${manifestPath} package escapes the package directory: ${entry.url}`);
    }
    if (!runtimeFiles.has(relativePath)) {
      throw new Error(`${manifestPath} references a missing runtime package: ${relativePath}`);
    }
    await assertRuntimeFile(path.join(repoRoot, relativePath), relativePath);
  }

  const spatialReference = manifest.spatialIndex;
  if (!spatialReference || typeof spatialReference !== "object") {
    throw new Error(`${manifestPath} must reference a spatial index`);
  }
  for (const field of ["url", "contentHash", "bytes", "zoom", "cellCount", "packageCount"]) {
    if (!Object.hasOwn(spatialReference, field)) {
      throw new Error(`${manifestPath} spatial index reference is missing ${field}`);
    }
  }
  const spatialIndexPath = normalizeNatureRuntimeUrl(
    spatialReference.url,
    "Nature spatial index URL",
  );
  if (!spatialIndexPath.startsWith("assets/data/nature/spatial/index/")) {
    throw new Error(`${manifestPath} spatial index escapes its index directory`);
  }
  const expectedIndexFilename = spatialReference.contentHash
    ?.slice("sha256:".length, "sha256:".length + 16) + ".json";
  if (!/^sha256:[a-f0-9]{64}$/.test(spatialReference.contentHash)
      || path.posix.basename(spatialIndexPath) !== expectedIndexFilename) {
    throw new Error(`${manifestPath} spatial index URL is not content-addressed`);
  }
  if (!runtimeFiles.has(spatialIndexPath)) {
    throw new Error(`${manifestPath} references a missing spatial index: ${spatialIndexPath}`);
  }
  const spatialIndexBytes = await readFile(path.join(repoRoot, spatialIndexPath));
  if (!Number.isSafeInteger(spatialReference.bytes)
      || spatialReference.bytes !== spatialIndexBytes.byteLength) {
    throw new Error(`${manifestPath} spatial index byte count is invalid`);
  }
  let spatialIndex;
  try {
    spatialIndex = JSON.parse(spatialIndexBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to parse ${spatialIndexPath}: ${error.message}`, { cause: error });
  }
  if (spatialIndex.schemaVersion !== manifest.schemaVersion
      || spatialIndex.artifactType !== "nature-spatial-index"
      || spatialIndex.generated !== true
      || spatialIndex.zoom !== spatialReference.zoom
      || spatialIndex.cellCount !== spatialReference.cellCount
      || spatialIndex.packageCount !== spatialReference.packageCount
      || spatialIndex.contentHash !== spatialReference.contentHash
      || !Array.isArray(spatialIndex.cells)
      || spatialIndex.cells.length !== spatialReference.cellCount) {
    throw new Error(`${spatialIndexPath} identity or declared counts are invalid`);
  }
  const spatialIndexCore = { ...spatialIndex };
  delete spatialIndexCore.contentHash;
  const computedSpatialIndexHash = "sha256:"
    + createHash("sha256").update(canonicalJson(spatialIndexCore)).digest("hex");
  if (computedSpatialIndexHash !== spatialReference.contentHash) {
    throw new Error(`${spatialIndexPath} failed content-hash validation`);
  }

  const referencedSpatialFiles = new Set([spatialIndexPath]);
  let packageCount = 0;
  let previousCellId = null;
  for (const cell of spatialIndex.cells) {
    const expectedCellId = `${cell.zoom}/${cell.x}/${cell.y}`;
    if (cell.zoom !== spatialIndex.zoom
        || cell.cellId !== expectedCellId
        || (previousCellId !== null && previousCellId.localeCompare(cell.cellId) >= 0)
        || !Array.isArray(cell.packages)
        || cell.packages.length === 0
        || cell.entityCount !== cell.packages.reduce(
          (sum, entry) => sum + Number(entry?.entityCount || 0),
          0,
        )) {
      throw new Error(`${spatialIndexPath} contains an invalid spatial cell entry`);
    }
    previousCellId = cell.cellId;
    for (const [shardIndex, entry] of cell.packages.entries()) {
      packageCount += 1;
      const relativePath = normalizeNatureRuntimeUrl(
        entry?.url,
        `Nature spatial cell URL ${entry?.url}`,
      );
      const expectedFilename = entry?.contentHash
        ?.slice("sha256:".length, "sha256:".length + 16) + ".json";
      const expectedPath = `assets/data/nature/spatial/cells/${cell.zoom}/${cell.x}/${cell.y}/${expectedFilename}`;
      if (!/^sha256:[a-f0-9]{64}$/.test(entry?.contentHash)
          || relativePath !== expectedPath
          || entry.shardIndex !== shardIndex
          || entry.shardCount !== cell.packages.length) {
        throw new Error(`${spatialIndexPath} contains an invalid cell package descriptor`);
      }
      if (!runtimeFiles.has(relativePath)) {
        throw new Error(`${spatialIndexPath} references a missing cell package: ${relativePath}`);
      }
      const cellBytes = await readFile(path.join(repoRoot, relativePath));
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== cellBytes.byteLength) {
        throw new Error(`${relativePath} byte count does not match its spatial index entry`);
      }
      let document;
      try {
        document = JSON.parse(cellBytes.toString("utf8"));
      } catch (error) {
        throw new Error(`Unable to parse ${relativePath}: ${error.message}`, { cause: error });
      }
      if (document.schemaVersion !== manifest.schemaVersion
          || document.artifactType !== "nature-spatial-cell-package"
          || document.generated !== true
          || document.cellId !== cell.cellId
          || document.zoom !== cell.zoom
          || document.x !== cell.x
          || document.y !== cell.y
          || document.shardIndex !== entry.shardIndex
          || document.shardCount !== entry.shardCount
          || document.contentHash !== entry.contentHash
          || !Array.isArray(document.entities)
          || document.entities.length !== entry.entityCount) {
        throw new Error(`${relativePath} identity does not match its spatial index entry`);
      }
      const cellCore = { ...document };
      delete cellCore.contentHash;
      const computedCellHash = "sha256:"
        + createHash("sha256").update(canonicalJson(cellCore)).digest("hex");
      if (computedCellHash !== entry.contentHash) {
        throw new Error(`${relativePath} failed content-hash validation`);
      }
      referencedSpatialFiles.add(relativePath);
    }
  }
  if (packageCount !== spatialReference.packageCount) {
    throw new Error(`${spatialIndexPath} package count does not match its manifest reference`);
  }
  for (const runtimePath of runtimeFiles) {
    if (runtimePath.startsWith("assets/data/nature/spatial/")
        && !referencedSpatialFiles.has(runtimePath)) {
      throw new Error(`Unreferenced spatial runtime artifact: ${runtimePath}`);
    }
  }
}

export async function validateNatureSourceReleaseNoticeReference(
  repoRoot,
  runtimeFiles,
  manifest,
) {
  const manifestPath = "assets/data/nature/manifest.v1.json";
  const reference = manifest?.sourceReleaseNotice;
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error(`${manifestPath} must reference a source release notice`);
  }
  for (const field of [
    "url",
    "contentHash",
    "bytes",
    "sourceCount",
    "releaseEligible",
    "mediaCount",
  ]) {
    if (!Object.hasOwn(reference, field)) {
      throw new Error(`${manifestPath} source release notice reference is missing ${field}`);
    }
  }

  const noticePath = normalizeNatureRuntimeUrl(
    reference.url,
    "Nature source release notice URL",
  );
  if (noticePath !== SOURCE_RELEASE_NOTICE_RUNTIME_PATH) {
    throw new Error(
      `${manifestPath} source release notice must resolve to `
      + SOURCE_RELEASE_NOTICE_RUNTIME_PATH,
    );
  }
  if (!runtimeFiles.has(noticePath)) {
    throw new Error(
      `${manifestPath} references a source release notice outside the runtime allowlist`,
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(reference.contentHash)) {
    throw new Error(`${manifestPath} source release notice content hash is invalid`);
  }
  if (!Number.isSafeInteger(reference.bytes) || reference.bytes <= 0) {
    throw new Error(`${manifestPath} source release notice byte count is invalid`);
  }
  if (!Number.isSafeInteger(reference.sourceCount) || reference.sourceCount < 0) {
    throw new Error(`${manifestPath} source release notice source count is invalid`);
  }
  if (!Number.isSafeInteger(reference.mediaCount) || reference.mediaCount < 0) {
    throw new Error(`${manifestPath} source release notice media count is invalid`);
  }
  if (reference.releaseEligible !== true) {
    throw new Error(`${manifestPath} source release notice is not eligible for production release`);
  }

  await assertRuntimeFile(path.join(repoRoot, noticePath), noticePath);
  const noticeBytes = await readFile(path.join(repoRoot, noticePath));
  if (noticeBytes.byteLength !== reference.bytes) {
    throw new Error(`${manifestPath} source release notice byte count is invalid`);
  }

  let notice;
  try {
    notice = JSON.parse(noticeBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to parse ${noticePath}: ${error.message}`, { cause: error });
  }
  if (notice.schemaVersion !== manifest.schemaVersion
      || notice.artifactType !== "nature-source-release-notice"
      || notice.generated !== true
      || notice.releaseEligible !== reference.releaseEligible
      || notice.contentHash !== reference.contentHash
      || !Number.isSafeInteger(notice.recordCount)
      || notice.recordCount < 0
      || typeof notice.scope !== "string"
      || !notice.scope.trim()
      || !Array.isArray(notice.sources)
      || notice.sources.length !== reference.sourceCount
      || !Array.isArray(notice.media)
      || notice.media.length !== reference.mediaCount) {
    throw new Error(`${noticePath} identity or declared counts are invalid`);
  }

  const noticeCore = { ...notice };
  delete noticeCore.contentHash;
  const computedHash = "sha256:"
    + createHash("sha256").update(canonicalJson(noticeCore)).digest("hex");
  if (computedHash !== reference.contentHash) {
    throw new Error(`${noticePath} failed content-hash validation`);
  }
}

function normalizeNatureRuntimeUrl(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is invalid`);
  const manifestUrl = value.split(/[?#]/, 1)[0];
  const repositoryUrl = manifestUrl.startsWith("assets/data/nature/")
    ? manifestUrl
    : path.posix.join("assets/data/nature", manifestUrl);
  return normalizeRepositoryPath(repositoryUrl, label);
}

async function validateRuntimeFiles(repoRoot, runtimeFiles) {
  for (const relativePath of runtimeFiles) {
    const normalized = normalizeRepositoryPath(relativePath, `Runtime path ${relativePath}`);
    if (normalized !== relativePath) {
      throw new Error(`Runtime path is not normalized: ${relativePath}`);
    }
    await assertRuntimeFile(path.join(repoRoot, relativePath), relativePath);
  }
}

async function listRuntimeTree(repoRoot, tree) {
  const absoluteRoot = path.join(repoRoot, tree.root);
  const files = [];
  await walk(absoluteRoot, tree.root, files, tree.extension);
  return files.sort(comparePaths);
}

async function walk(directory, relativeDirectory, files, extension) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Missing runtime tree: ${relativeDirectory}`, { cause: error });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = toPosixPath(path.join(relativeDirectory, entry.name));
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are forbidden in runtime trees: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await walk(absolutePath, relativePath, files, extension);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported runtime tree entry: ${relativePath}`);
    }
    if (path.extname(entry.name).toLowerCase() !== extension) {
      throw new Error(`Unexpected file in runtime tree: ${relativePath}`);
    }
    files.push(relativePath);
  }
}

async function assertRuntimeFile(filename, label) {
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    throw new Error(`Missing required runtime asset: ${label}`, { cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Runtime asset must be a regular non-symlink file: ${label}`);
  }
  assertSizeWithinLimit(label, info.size);
}

async function isRegularFile(filename) {
  try {
    const info = await lstat(filename);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertSizeWithinLimit(label, bytes) {
  if (bytes > SITES_MAX_FILE_BYTES) {
    throw new Error(
      `${label} is ${bytes} bytes, above the Sites static asset limit `
      + `of ${SITES_MAX_FILE_BYTES} bytes`,
    );
  }
}

async function fileDescriptor(filename, relativePath) {
  const bytes = await readFile(filename);
  assertSizeWithinLimit(relativePath, bytes.byteLength);
  return {
    path: toPosixPath(relativePath),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function hashManifestEntries(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
  }
  return hash.digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort(comparePaths).map((key) => [key, sortValue(value[key])]),
  );
}

function looksLikeAssetReference(value) {
  const withoutOriginToken = value.startsWith(`${ORIGIN_METADATA_TOKEN}/`)
    ? value.slice(ORIGIN_METADATA_TOKEN.length)
    : value;
  const withoutQuery = withoutOriginToken.split(/[?#]/, 1)[0];
  return HTML_ASSET_EXTENSION.test(withoutQuery);
}

function normalizeLocalAssetReference(value, options = {}) {
  if (
    !value
    || value.startsWith("#")
    || LOCAL_PROTOCOL_PATTERN.test(value)
    || /^(?:https?:)?\/\//i.test(value)
  ) {
    return null;
  }
  let localValue = value;
  if (localValue.startsWith(`${ORIGIN_METADATA_TOKEN}/`)) {
    localValue = localValue.slice(ORIGIN_METADATA_TOKEN.length + 1);
  } else if (localValue.startsWith("/")) {
    localValue = localValue.slice(1);
  }
  localValue = localValue.split(/[?#]/, 1)[0];
  if (
    !localValue
    || (options.requireAssetExtension && !HTML_ASSET_EXTENSION.test(localValue))
  ) return null;
  return normalizeRepositoryPath(localValue, `HTML asset reference ${value}`);
}

function normalizeRepositoryPath(value, label) {
  let decoded;
  try {
    decoded = decodeURIComponent(value.replaceAll("\\", "/"));
  } catch (error) {
    throw new Error(`${label} contains invalid URL encoding`, { cause: error });
  }
  const normalized = path.posix.normalize(decoded).replace(/^\.\//, "");
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`${label} escapes the repository root`);
  }
  return normalized;
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&#x26;", "&");
}

function assertSafeDistRoot(repoRoot, distRoot) {
  const filesystemRoot = path.parse(distRoot).root;
  if (
    distRoot === filesystemRoot
    || distRoot === repoRoot
    || repoRoot.startsWith(`${distRoot}${path.sep}`)
  ) {
    throw new Error(`Unsafe dist root: ${distRoot}`);
  }
}

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

async function main() {
  const result = await buildSite();
  const largest = result.largestFile;
  console.log(
    `Site package: ${result.fileCount} files, ${result.totalBytes.toLocaleString("en-US")} bytes, `
    + `largest ${largest.path} (${largest.bytes.toLocaleString("en-US")} bytes), `
    + `build ${result.buildId}`,
  );
}

if (path.resolve(process.argv[1] || "") === MODULE_PATH) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
