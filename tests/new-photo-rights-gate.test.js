const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const appSource = readFileSync("assets/js/app.js", "utf8");
const gateStart = appSource.indexOf("/* PHOTO_RIGHTS_GATE_START");
const gateEndMarker = "/* PHOTO_RIGHTS_GATE_END */";
const gateEnd = appSource.indexOf(gateEndMarker, gateStart);
assert.ok(gateStart >= 0 && gateEnd > gateStart, "photo rights gate source block must be present");
const gateSource = appSource.slice(gateStart, gateEnd + gateEndMarker.length);
const context = {
  URL,
  escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  },
};
vm.createContext(context);
vm.runInContext(`${gateSource}
this.photoGate = { photoImageUrl, normalizePhotoRights, hasApprovedPhotoRights, renderLegacyPhoto };`, context);
const {
  photoImageUrl, normalizePhotoRights, hasApprovedPhotoRights, renderLegacyPhoto,
} = context.photoGate;

const approvedRights = {
  reviewStatus: "approved",
  creator: "Example Creator",
  sourcePageUrl: "https://commons.example.test/file-page",
  licenceId: "CC BY 4.0",
  licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  attributionText: "Example image © Example Creator",
  reviewedAt: "2026-07-26",
  display: true,
  commercialUse: true,
  redistribution: true,
  derivatives: true,
};

function render(rights) {
  return renderLegacyPhoto([{
    url: "https://images.example.test/photo.jpg",
    photoRights: rights,
  }], "Example <summit>");
}

test("legacy pass and POI records normalize optional per-file rights metadata", () => {
  assert.equal(
    (appSource.match(/photoRights: normalizePhotoRights\(d\.photoRights \?\? d\.pr\)/g) || []).length,
    2,
  );
  assert.match(appSource, /wiki\?\.photoRights/);
  assert.doesNotMatch(appSource, /p\.bestPhoto \|\| wiki\?\.thumb/);
  assert.doesNotMatch(appSource, /const img = poi\.bestPhoto\s*\?/);
});

test("unknown or incomplete media is fail-closed and renders a neutral placeholder", () => {
  for (const rights of [null, {}, { ...approvedRights, reviewStatus: "pending" }]) {
    const html = render(rights);
    assert.doesNotMatch(html, /<img\b/i);
    assert.match(html, /per-file rights review pending/i);
  }

  for (const field of [
    "creator", "sourcePageUrl", "licenceId", "licenceUrl", "attributionText", "reviewedAt",
  ]) {
    const incomplete = { ...approvedRights };
    delete incomplete[field];
    assert.equal(hasApprovedPhotoRights(incomplete), false, `missing ${field} must fail closed`);
    assert.doesNotMatch(render(incomplete), /<img\b/i);
  }

  for (const permission of ["display", "commercialUse", "redistribution", "derivatives"]) {
    assert.equal(hasApprovedPhotoRights({ ...approvedRights, [permission]: false }), false);
  }
  assert.equal(
    hasApprovedPhotoRights({ ...approvedRights, reviewedAt: "not-a-date" }),
    false,
  );
  assert.equal(photoImageUrl("../private/photo.jpg"), "");
  assert.equal(photoImageUrl("/assets/photo.jpg"), "");
  assert.equal(photoImageUrl("assets/photo.jpg"), "assets/photo.jpg");
  assert.equal(photoImageUrl("./assets/photo.jpg"), "./assets/photo.jpg");
});

test("only approved, fully rights-cleared media renders with adjacent attribution links", () => {
  assert.equal(hasApprovedPhotoRights(approvedRights), true);
  const html = render(approvedRights);
  assert.match(html, /<img\b/);
  assert.match(html, /Example &lt;summit&gt;/);
  assert.match(html, /Example image © Example Creator/);
  assert.match(html, /Creator: Example Creator/);
  assert.match(html, /https:\/\/commons\.example\.test\/file-page/);
  assert.match(html, /https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(html, /CC BY 4\.0/);

  const equivalent = normalizePhotoRights({
    ...approvedRights,
    display: undefined,
    commercialUse: undefined,
    redistribution: undefined,
    derivatives: undefined,
    permissions: {
      display: true, commercial: true, redistribute: true, derivatives: true,
    },
  });
  assert.equal(hasApprovedPhotoRights(equivalent), true);
});
