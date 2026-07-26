import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPTIONAL_RUNTIME_FILES,
  REQUIRED_RUNTIME_FILES,
  SITES_MAX_FILE_BYTES,
  SOURCE_RELEASE_NOTICE_RUNTIME_PATH,
  buildSite,
  extractHtmlRuntimeAssetPaths,
  validateHtmlReferences,
  validateNatureSourceReleaseNoticeReference,
} from "../tools/build-site.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let sandboxRoot;
let firstDist;
let secondDist;
let firstResult;

before(async () => {
  sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "itinera-site-build-"));
  firstDist = path.join(sandboxRoot, "first");
  secondDist = path.join(sandboxRoot, "second");
  [firstResult] = await Promise.all([
    buildSite({ repoRoot: REPO_ROOT, distRoot: firstDist }),
    buildSite({ repoRoot: REPO_ROOT, distRoot: secondDist }),
  ]);
});

after(async () => {
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

test("site package contains only the explicit client runtime allowlist", async () => {
  const clientFiles = await listFiles(path.join(firstDist, "client"));
  const clientSet = new Set(clientFiles);
  for (const filename of REQUIRED_RUNTIME_FILES) {
    assert.ok(clientSet.has(filename), `missing required runtime file: ${filename}`);
  }
  for (const filename of OPTIONAL_RUNTIME_FILES) {
    if (await exists(path.join(REPO_ROOT, filename))) {
      assert.ok(clientSet.has(filename), `missing optional runtime file: ${filename}`);
    }
  }
  for (const filename of clientFiles) {
    const allowed = REQUIRED_RUNTIME_FILES.includes(filename)
      || OPTIONAL_RUNTIME_FILES.includes(filename)
      || (filename.startsWith("assets/js/nature/") && filename.endsWith(".mjs"))
      || (filename.startsWith("assets/data/nature/packages/") && filename.endsWith(".json"))
      || (filename.startsWith("assets/data/nature/spatial/") && filename.endsWith(".json"));
    assert.ok(allowed, `unexpected client runtime file: ${filename}`);
  }
});

test("site package includes the manifest-referenced source release notice", async () => {
  const manifest = JSON.parse(await readFile(
    path.join(REPO_ROOT, "assets", "data", "nature", "manifest.v1.json"),
    "utf8",
  ));
  const reference = manifest.sourceReleaseNotice;
  assert.equal(reference.url, SOURCE_RELEASE_NOTICE_RUNTIME_PATH);
  assert.ok(REQUIRED_RUNTIME_FILES.includes(SOURCE_RELEASE_NOTICE_RUNTIME_PATH));

  const [sourceBytes, packagedBytes] = await Promise.all([
    readFile(path.join(REPO_ROOT, ...SOURCE_RELEASE_NOTICE_RUNTIME_PATH.split("/"))),
    readFile(
      path.join(firstDist, "client", ...SOURCE_RELEASE_NOTICE_RUNTIME_PATH.split("/")),
    ),
  ]);
  assert.deepEqual(packagedBytes, sourceBytes);

  const descriptor = firstResult.manifest.files.find(
    (entry) => entry.path === `client/${SOURCE_RELEASE_NOTICE_RUNTIME_PATH}`,
  );
  assert.ok(descriptor, "source release notice is absent from the site build manifest");
  assert.equal(descriptor.bytes, reference.bytes);
  assert.equal(
    descriptor.sha256,
    createHash("sha256").update(sourceBytes).digest("hex"),
  );
});

test("site package excludes design sources and unbundled country arrays", async () => {
  const clientFiles = await listFiles(path.join(firstDist, "client"));
  const forbiddenPatterns = [
    /(?:^|\/)imagegen\//,
    /(?:^|\/)normalized-png\//,
    /(?:^|\/)svg\//,
    /(?:^|\/)alpine-ui-icons-source\.png$/,
    /(?:^|\/)app-icon-source\.png$/,
    /^assets\/js\/(?:app|passes-data|japan-passes|uk-ireland-passes)\.js$/,
    /^assets\/js\/(?:japan|uk-ireland)-scenic-drives\.js$/,
    /^assets\/js\/(?:swiss|french|italy|austrian|japan|uk|irish)-pois\.js$/,
    /^assets\/js\/(?:passes-cams|pass-icons)\.js$/,
    /assets\/wasm\/leisure-core\/(?:README|package|.*\.d\.ts)/,
  ];
  for (const filename of clientFiles) {
    assert.equal(
      forbiddenPatterns.some((pattern) => pattern.test(filename)),
      false,
      `design/source file leaked into dist: ${filename}`,
    );
  }
  assert.deepEqual(
    clientFiles.filter((filename) => filename.startsWith("assets/ui-icons/")),
    ["assets/ui-icons/alpine-ui-icons.png"],
  );
  assert.deepEqual(
    clientFiles.filter((filename) => filename.startsWith("assets/pass-icon-sheets/")),
    [
      "assets/pass-icon-sheets/top-50-icon-sprite-01.png",
      "assets/pass-icon-sheets/top-50-icon-sprite-02.png",
      "assets/pass-icon-sheets/top-50-sprite-01.png",
      "assets/pass-icon-sheets/top-50-sprite-02.png",
    ],
  );
});

test("Worker entry is copied byte-for-byte to the Sites server contract", async () => {
  const [source, packaged] = await Promise.all([
    readFile(path.join(REPO_ROOT, "server", "routing-worker.mjs")),
    readFile(path.join(firstDist, "server", "index.js")),
  ]);
  assert.deepEqual(packaged, source);
  assert.match(packaged.toString("utf8"), /export default createRoutingWorker\(\);/);
});

test("build manifest is complete, size-bounded, hashed, and deterministic", async () => {
  const [firstBytes, secondBytes] = await Promise.all([
    readFile(path.join(firstDist, "build-manifest.json")),
    readFile(path.join(secondDist, "build-manifest.json")),
  ]);
  assert.deepEqual(firstBytes, secondBytes);
  const manifest = JSON.parse(firstBytes);
  assert.equal(manifest.buildId, firstResult.buildId);
  assert.equal(manifest.sitesStaticAssetMaxBytes, SITES_MAX_FILE_BYTES);
  assert.equal(manifest.fileCount, manifest.files.length);
  assert.equal(manifest.totalBytes, manifest.files.reduce((sum, item) => sum + item.bytes, 0));
  assert.equal(Object.hasOwn(manifest, "generatedAt"), false);
  assert.deepEqual(
    manifest.files.map((item) => item.path),
    manifest.files.map((item) => item.path).toSorted(),
  );
  for (const item of manifest.files) {
    const bytes = await readFile(path.join(firstDist, ...item.path.split("/")));
    assert.equal(item.bytes, bytes.byteLength, item.path);
    assert.ok(item.bytes <= SITES_MAX_FILE_BYTES, item.path);
    assert.equal(item.sha256, createHash("sha256").update(bytes).digest("hex"), item.path);
  }
});

test("site package contains exactly the manifest-referenced spatial artifacts", async () => {
  const manifest = JSON.parse(await readFile(
    path.join(REPO_ROOT, "assets", "data", "nature", "manifest.v1.json"),
    "utf8",
  ));
  const spatialIndex = JSON.parse(await readFile(
    path.join(REPO_ROOT, ...manifest.spatialIndex.url.split("/")),
    "utf8",
  ));
  const expected = [
    manifest.spatialIndex.url,
    ...spatialIndex.cells.flatMap((cell) => cell.packages.map((entry) => entry.url)),
  ].toSorted();
  const clientFiles = await listFiles(path.join(firstDist, "client"));
  assert.deepEqual(
    clientFiles.filter((filename) => filename.startsWith("assets/data/nature/spatial/")),
    expected,
  );
  assert.equal(spatialIndex.contentHash, manifest.spatialIndex.contentHash);
  assert.equal(spatialIndex.cellCount, manifest.spatialIndex.cellCount);
  assert.equal(spatialIndex.packageCount, manifest.spatialIndex.packageCount);
});

test("source release notice validation rejects missing or mismatched artifacts", async (t) => {
  const manifest = JSON.parse(await readFile(
    path.join(REPO_ROOT, "assets", "data", "nature", "manifest.v1.json"),
    "utf8",
  ));
  const runtimeFiles = new Set(REQUIRED_RUNTIME_FILES);
  await validateNatureSourceReleaseNoticeReference(REPO_ROOT, runtimeFiles, manifest);

  await t.test("missing manifest reference", async () => {
    const candidate = structuredClone(manifest);
    delete candidate.sourceReleaseNotice;
    await assert.rejects(
      validateNatureSourceReleaseNoticeReference(REPO_ROOT, runtimeFiles, candidate),
      /must reference a source release notice/,
    );
  });

  await t.test("missing notice file", async () => {
    const missingRoot = path.join(sandboxRoot, "missing-source-release-notice");
    await mkdir(missingRoot, { recursive: true });
    await assert.rejects(
      validateNatureSourceReleaseNoticeReference(missingRoot, runtimeFiles, manifest),
      /Missing required runtime asset: assets\/data\/nature\/source-release-notice\.v1\.json/,
    );
  });

  await t.test("notice outside the runtime allowlist", async () => {
    const allowlist = new Set(
      REQUIRED_RUNTIME_FILES.filter((entry) => entry !== SOURCE_RELEASE_NOTICE_RUNTIME_PATH),
    );
    await assert.rejects(
      validateNatureSourceReleaseNoticeReference(REPO_ROOT, allowlist, manifest),
      /outside the runtime allowlist/,
    );
  });

  await t.test("wrong notice URL", async () => {
    const candidate = structuredClone(manifest);
    candidate.sourceReleaseNotice.url = "assets/data/nature/quality-report.v1.json";
    await assert.rejects(
      validateNatureSourceReleaseNoticeReference(REPO_ROOT, runtimeFiles, candidate),
      /must resolve to assets\/data\/nature\/source-release-notice\.v1\.json/,
    );
  });

  for (const [name, update, pattern] of [
    ["byte count", (reference) => { reference.bytes += 1; }, /byte count is invalid/],
    ["content hash", (reference) => {
      reference.contentHash = `sha256:${"0".repeat(64)}`;
    }, /identity or declared counts are invalid/],
    ["source count", (reference) => { reference.sourceCount += 1; }, /declared counts/],
    ["media count", (reference) => { reference.mediaCount += 1; }, /declared counts/],
    ["release eligibility", (reference) => {
      reference.releaseEligible = false;
    }, /not eligible for production release/],
  ]) {
    await t.test(`mismatched ${name}`, async () => {
      const candidate = structuredClone(manifest);
      update(candidate.sourceReleaseNotice);
      await assert.rejects(
        validateNatureSourceReleaseNoticeReference(REPO_ROOT, runtimeFiles, candidate),
        pattern,
      );
    });
  }

  await t.test("tampered canonical payload", async () => {
    const fixtureRoot = path.join(sandboxRoot, "tampered-source-release-notice");
    const notice = JSON.parse(await readFile(
      path.join(REPO_ROOT, ...SOURCE_RELEASE_NOTICE_RUNTIME_PATH.split("/")),
      "utf8",
    ));
    notice.scope += " Tampered without updating the stored content hash.";
    const serialized = Buffer.from(`${JSON.stringify(notice)}\n`);
    const fixturePath = path.join(
      fixtureRoot,
      ...SOURCE_RELEASE_NOTICE_RUNTIME_PATH.split("/"),
    );
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, serialized);
    const candidate = structuredClone(manifest);
    candidate.sourceReleaseNotice.bytes = serialized.byteLength;
    await assert.rejects(
      validateNatureSourceReleaseNoticeReference(fixtureRoot, runtimeFiles, candidate),
      /failed content-hash validation/,
    );
  });
});

test("every local HTML asset reference resolves inside dist/client", async () => {
  const html = await readFile(path.join(firstDist, "client", "index.html"), "utf8");
  const references = extractHtmlRuntimeAssetPaths(html);
  assert.ok(references.includes("assets/js/itinera.bundle.js"));
  assert.deepEqual(
    extractHtmlRuntimeAssetPaths(
      '<meta property="og:image" content="__ITINERA_ORIGIN__/assets/og-itinera-nature.png">',
    ),
    ["assets/og-itinera-nature.png"],
  );
  for (const reference of references) {
    await access(path.join(firstDist, "client", ...reference.split("/")));
  }
});

test("tokenized social metadata fails closed when its optional image is absent", async () => {
  const fixtureRoot = path.join(sandboxRoot, "missing-social-image");
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(
    path.join(fixtureRoot, "index.html"),
    '<meta property="og:image" content="__ITINERA_ORIGIN__/assets/og-itinera-nature.png">',
    "utf8",
  );
  await assert.rejects(
    validateHtmlReferences(fixtureRoot, new Set()),
    /outside the allowlist: assets\/og-itinera-nature\.png/,
  );
});

async function listFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const next = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
