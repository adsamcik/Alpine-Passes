const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function sha256File(relPath) {
  return crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(repoRoot, relPath)))
    .digest("hex");
}

function pngSize(relPath) {
  const bytes = fs.readFileSync(path.join(repoRoot, relPath));
  assert.equal(bytes.toString("ascii", 1, 4), "PNG", `${relPath} is not a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function parseUiIconIds(appSource) {
  const match = appSource.match(/const UI_ICON_IDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, "Missing UI_ICON_IDS");
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

test("v2 image-generated icon system covers the complete runtime atlas", () => {
  const manifest = JSON.parse(read("assets/ui-icons/icon-manifest.v2.json"));
  const report = JSON.parse(read("assets/ui-icons/icon-quality-report.v2.json"));
  const uiIconIds = parseUiIconIds(read("assets/js/app.js"));
  const icons = manifest.icons;

  assert.equal(manifest.version, 2);
  assert.equal(manifest.style, "itinera-alpine-contour-enamel");
  assert.deepEqual(manifest.atlas, { columns: 5, rows: 13, cellSize: 128 });
  assert.equal(icons.length, 63);
  assert.deepEqual(icons.map((icon) => icon.index), Array.from({ length: 63 }, (_, index) => index));
  assert.equal(new Set(icons.map((icon) => icon.id)).size, icons.length);
  assert.deepEqual(
    icons.map((icon) => icon.id).sort(),
    [...uiIconIds].sort(),
    "manifest must cover every runtime icon exactly once"
  );

  const sourceSheetNames = [...new Set(icons.map((icon) => icon.sheet))].sort();
  assert.equal(sourceSheetNames.length, 8);
  for (const stage of ["source", "transparent"]) {
    const directory = path.join(repoRoot, `assets/ui-icons/imagegen-v2/${stage}`);
    const files = fs.readdirSync(directory).filter((name) => name.endsWith(".png")).sort();
    assert.deepEqual(files, sourceSheetNames, `${stage} must contain exactly the eight manifested sheets`);
    for (const fileName of files) {
      assert.deepEqual(pngSize(`assets/ui-icons/imagegen-v2/${stage}/${fileName}`), [1718, 916]);
    }
  }

  assert.equal(report.manifestVersion, manifest.version);
  assert.equal(report.style, manifest.style);
  assert.equal(report.icons.length, icons.length);
  assert.deepEqual(report.icons.map((icon) => icon.id), icons.map((icon) => icon.id));
  assert.deepEqual(
    pngSize(report.atlas.path),
    [manifest.atlas.columns * manifest.atlas.cellSize, manifest.atlas.rows * manifest.atlas.cellSize]
  );
  assert.equal(sha256File(report.atlas.path), report.atlas.sha256, "atlas report hash is stale");

  for (const sheetName of sourceSheetNames) {
    const relPath = `assets/ui-icons/imagegen-v2/transparent/${sheetName}`;
    assert.equal(sha256File(relPath), report.sourceHashes[sheetName], `${sheetName} report hash is stale`);
  }

  const normalizedFiles = fs.readdirSync(path.join(repoRoot, "assets/ui-icons/normalized-png"))
    .filter((name) => name.endsWith(".png"))
    .sort();
  assert.equal(normalizedFiles.length, 63);

  for (const icon of report.icons) {
    const fileName = `${String(icon.index).padStart(2, "0")}-${icon.id}.png`;
    const relPath = `assets/ui-icons/normalized-png/${fileName}`;
    assert.ok(normalizedFiles.includes(fileName), `${icon.id} normalized cell is missing`);
    assert.deepEqual(pngSize(relPath), [128, 128]);
    assert.equal(sha256File(relPath), icon.fileSha256, `${icon.id} generated-cell hash is stale`);
    assert.equal(icon.sourceEdgePixels, 0, `${icon.id} touches its detected source crop edge`);
    assert.ok(Math.min(...icon.sourceMargins) >= 16, `${icon.id} source crop lacks safe padding`);
    assert.equal(icon.chromaPixels, 0, `${icon.id} retains chroma-key pixels`);
    assert.ok(icon.coverage128 >= 0.08 && icon.coverage128 <= 0.62, `${icon.id} optical coverage drifted`);
    for (const size of ["12", "16", "24"]) {
      assert.ok(icon.tiny[size].visiblePixels >= 8, `${icon.id} disappears at ${size}px`);
      assert.ok(icon.tiny[size].opaquePixels >= 8, `${icon.id} lacks a solid silhouette at ${size}px`);
    }
  }

  assert.deepEqual(pngSize("assets/ui-icons/reserve/brand-compass-trail.png"), [128, 128]);
  assert.deepEqual(pngSize("docs/design/icon-system-v2-preview.png"), [1120, 1976]);
});
