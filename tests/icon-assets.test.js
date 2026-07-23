const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function parseStringMap(source, constName) {
  const match = source.match(new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\};`));
  assert.ok(match, `Missing ${constName}`);
  return Object.fromEntries(
    [...match[1].matchAll(/"([^"]+)":\s+"([^"]+)"/g)].map((m) => [m[1], m[2]])
  );
}

function parseStringSet(source, constName) {
  const match = source.match(new RegExp(`const ${constName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `Missing ${constName}`);
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

function parseNumberConst(source, constName) {
  const match = source.match(new RegExp(`const ${constName} = (\\d+);`));
  assert.ok(match, `Missing ${constName}`);
  return Number(match[1]);
}

function parseAtlasCells(source) {
  const match = source.match(/const UI_ATLAS_CELLS = \{([\s\S]*?)\};/);
  assert.ok(match, "Missing UI_ATLAS_CELLS");
  return Object.fromEntries(
    [...match[1].matchAll(/"([^"]+)":\s+\[(\d+),\s+(\d+)\]/g)]
      .map((m) => [m[1], [Number(m[2]), Number(m[3])]])
  );
}

function loadPoiData() {
  const files = [
    ["assets/js/swiss-pois.js", "SWISS_POIS"],
    ["assets/js/french-pois.js", "FRENCH_POIS"],
    ["assets/js/italy-pois.js", "ITALY_POIS"],
    ["assets/js/austrian-pois.js", "AUSTRIAN_POIS"],
    ["assets/js/japan-pois.js", "JAPAN_POIS"],
    ["assets/js/uk-pois.js", "UK_POIS"],
    ["assets/js/irish-pois.js", "IRISH_POIS"],
  ];
  const sandbox = {};
  for (const [relPath, globalName] of files) {
    vm.runInNewContext(`${read(relPath)}\nglobalThis.${globalName} = ${globalName};`, sandbox, {
      filename: relPath,
    });
  }
  return [
    ...(sandbox.SWISS_POIS || []),
    ...(sandbox.FRENCH_POIS || []),
    ...(sandbox.ITALY_POIS || []),
    ...(sandbox.AUSTRIAN_POIS || []),
    ...(sandbox.JAPAN_POIS || []),
    ...(sandbox.UK_POIS || []),
    ...(sandbox.IRISH_POIS || []),
  ];
}

function assetIds(relDir, ext) {
  return new Set(
    fs.readdirSync(path.join(repoRoot, relDir))
      .filter((name) => name.endsWith(ext))
      .map((name) => name.replace(/^\d+-/, "").replace(new RegExp(`${ext}$`), ""))
  );
}

function pngSize(relPath) {
  const bytes = fs.readFileSync(path.join(repoRoot, relPath));
  assert.equal(bytes.toString("ascii", 1, 4), "PNG", `${relPath} is not a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function icoSizes(relPath) {
  const bytes = fs.readFileSync(path.join(repoRoot, relPath));
  assert.equal(bytes.readUInt16LE(0), 0, `${relPath} has invalid ICO reserved field`);
  assert.equal(bytes.readUInt16LE(2), 1, `${relPath} is not an icon file`);
  const count = bytes.readUInt16LE(4);
  const sizes = new Set();
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16;
    const width = bytes[offset] || 256;
    const height = bytes[offset + 1] || 256;
    sizes.add(`${width}x${height}`);
  }
  return sizes;
}

test("app icon family has generated browser-ready variants", () => {
  const expectedPngSizes = {
    "assets/app-icon-source.png": [1024, 1024],
    "assets/favicon-512.png": [512, 512],
    "assets/favicon-32.png": [32, 32],
    "assets/apple-touch-icon.png": [180, 180],
  };

  for (const [relPath, expected] of Object.entries(expectedPngSizes)) {
    assert.deepEqual(pngSize(relPath), expected, `${relPath} should be ${expected.join("x")}`);
  }

  const sizes = icoSizes("favicon.ico");
  for (const size of ["16x16", "32x32", "48x48", "64x64", "128x128", "256x256"]) {
    assert.ok(sizes.has(size), `favicon.ico missing ${size}`);
  }
});

test("every used POI category has its own generated UI icon asset", () => {
  const appSource = read("assets/js/app.js");
  const cssSource = read("assets/css/site.css");
  const categoryIconMap = parseStringMap(appSource, "POI_CATEGORY_ICON");
  const uiIconIds = parseStringSet(appSource, "UI_ICON_IDS");
  const cssIconIds = new Set([...cssSource.matchAll(/\.ui-icon-([a-z0-9-]+)\s*\{/g)].map((m) => m[1]));
  const pngIconIds = assetIds("assets/ui-icons/normalized-png", ".png");

  const usedCategories = new Set(loadPoiData().map((poi) => poi.cat).filter(Boolean));
  for (const category of usedCategories) {
    const expectedIconId = `poi-${category}`;
    assert.equal(categoryIconMap[category], expectedIconId, `${category} should not reuse another POI icon`);
    assert.ok(uiIconIds.has(expectedIconId), `${expectedIconId} missing from UI_ICON_IDS`);
    assert.ok(cssIconIds.has(expectedIconId), `${expectedIconId} missing CSS sprite class`);
    assert.ok(pngIconIds.has(expectedIconId), `${expectedIconId} missing normalized PNG`);
  }

  assert.deepEqual([...cssIconIds].filter((id) => !pngIconIds.has(id)), []);
});

test("every declared in-app UI icon is wired across CSS, PNG, and WebGL atlas", () => {
  const appSource = read("assets/js/app.js");
  const cssSource = read("assets/css/site.css");
  const uiIconIds = parseStringSet(appSource, "UI_ICON_IDS");
  const cssIconIds = new Set([...cssSource.matchAll(/\.ui-icon-([a-z0-9-]+)\s*\{/g)].map((m) => m[1]));
  const pngIconIds = assetIds("assets/ui-icons/normalized-png", ".png");
  const atlasCells = parseAtlasCells(appSource);
  const atlasCols = parseNumberConst(appSource, "ITINERA_GL_UI_ATLAS_COLS");
  const atlasRows = parseNumberConst(appSource, "ITINERA_GL_UI_ATLAS_ROWS");

  assert.deepEqual(
    pngSize("assets/ui-icons/alpine-ui-icons.png"),
    [atlasCols * 128, atlasRows * 128],
    "runtime UI sprite dimensions should match the WebGL atlas constants"
  );

  for (const iconId of uiIconIds) {
    assert.ok(cssIconIds.has(iconId), `${iconId} missing CSS sprite class`);
    assert.ok(pngIconIds.has(iconId), `${iconId} missing normalized PNG`);
    assert.ok(atlasCells[iconId], `${iconId} missing WebGL atlas cell`);
    const [col, row] = atlasCells[iconId];
    assert.ok(col >= 0 && col < atlasCols, `${iconId} atlas col ${col} outside ${atlasCols} columns`);
    assert.ok(row >= 0 && row < atlasRows, `${iconId} atlas row ${row} outside ${atlasRows} rows`);
  }
});

test("runtime text marks are backed by generated UI icon assets", () => {
  const appSource = read("assets/js/app.js");
  const cssSource = read("assets/css/site.css");
  const uiIconIds = parseStringSet(appSource, "UI_ICON_IDS");
  const cssIconIds = new Set([...cssSource.matchAll(/\.ui-icon-([a-z0-9-]+)\s*\{/g)].map((m) => m[1]));
  const pngIconIds = assetIds("assets/ui-icons/normalized-png", ".png");
  const requiredMarkIds = [
    "layer-survey", "layer-plan", "layer-explore",
    "weather-sunny", "weather-partly-cloudy", "weather-cloudy", "weather-fog", "weather-rain",
    "weather-snow", "weather-showers", "weather-storm", "weather-wind",
    "break-coffee", "break-restroom", "break-viewpoint",
    "utility-parking", "utility-warning", "utility-external-link", "utility-lock", "utility-unlock",
    "utility-star", "utility-check", "utility-add", "utility-close", "utility-more", "utility-calendar",
  ];

  for (const iconId of requiredMarkIds) {
    assert.ok(uiIconIds.has(iconId), `${iconId} missing from UI_ICON_IDS`);
    assert.ok(cssIconIds.has(iconId), `${iconId} missing CSS sprite class`);
    assert.ok(pngIconIds.has(iconId), `${iconId} missing generated PNG asset`);
  }

  const legacyMarkChars = String.fromCodePoint(
    0x00d7, 0x2713, 0x2197, 0x1f17f, 0x26a0, 0x1f512, 0x1f513,
    0x1f4f9, 0x2600, 0x1f324, 0x26c5, 0x1f32b, 0x1f327, 0x2744,
    0x1f326, 0x26c8, 0x2615, 0x1f6bb, 0x1f4f7, 0x2605, 0x2606,
    0x22ef, 0x21ba
  );
  const legacyMarkPattern = new RegExp(`[${legacyMarkChars}]`, "gu");
  for (const relPath of ["assets/js/app.js", "index.html", "assets/css/site.css"]) {
    const matches = [...read(relPath).matchAll(legacyMarkPattern)]
      .map((match) => `U+${match[0].codePointAt(0).toString(16).toUpperCase()}`);
    assert.deepEqual(matches, [], `${relPath} still contains legacy text icon marks`);
  }
});

test("generated UI icon sprite cells are non-placeholder artwork", () => {
  for (const fileName of fs.readdirSync(path.join(repoRoot, "assets/ui-icons/normalized-png"))) {
    if (!fileName.endsWith(".png")) continue;
    const relPath = path.join("assets/ui-icons/normalized-png", fileName);
    assert.deepEqual(pngSize(relPath), [128, 128], `${fileName} should be a 128x128 sprite cell`);
    const bytes = fs.statSync(path.join(repoRoot, relPath)).size;
    assert.ok(bytes >= 2_000, `${fileName} is too small for the generated-art icon set (${bytes} bytes)`);
  }
});

test("every notable pass has generated scenic and symbol icons", () => {
  const passIconSandbox = { window: {} };
  vm.runInNewContext(read("assets/js/pass-icons.js"), passIconSandbox, { filename: "assets/js/pass-icons.js" });

  const rawPassesMatch = read("assets/js/passes-data.js").match(/const ALPS_RAW = (.*);\s*$/s);
  assert.ok(rawPassesMatch, "Could not parse ALPS_RAW");
  const rawPasses = JSON.parse(rawPassesMatch[1]);
  const notablePasses = rawPasses.filter((pass) => pass.cf !== "l" && (pass.sc || 0) >= 0.7);
  const scenicAssets = passIconSandbox.window.PASS_ICON_ASSETS || {};
  const symbolAssets = passIconSandbox.window.PASS_SYMBOL_ASSETS || {};

  assert.equal(Object.keys(scenicAssets).length, notablePasses.length);
  for (const pass of notablePasses) {
    const key = `${pass.n}|${pass.e}`;
    assert.ok(scenicAssets[key], `${key} missing scenic icon asset`);
    assert.ok(symbolAssets[key], `${key} missing symbol icon asset`);
    assert.ok(fs.existsSync(path.join(repoRoot, scenicAssets[key].sheet)), `${key} scenic sheet missing`);
    assert.ok(fs.existsSync(path.join(repoRoot, symbolAssets[key].sheet)), `${key} symbol sheet missing`);
  }
});
