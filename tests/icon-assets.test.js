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

function loadPoiData() {
  const files = [
    ["assets/js/swiss-pois.js", "SWISS_POIS"],
    ["assets/js/french-pois.js", "FRENCH_POIS"],
    ["assets/js/italy-pois.js", "ITALY_POIS"],
    ["assets/js/austrian-pois.js", "AUSTRIAN_POIS"],
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
  ];
}

function assetIds(relDir, ext) {
  return new Set(
    fs.readdirSync(path.join(repoRoot, relDir))
      .filter((name) => name.endsWith(ext))
      .map((name) => name.replace(/^\d+-/, "").replace(new RegExp(`${ext}$`), ""))
  );
}

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
