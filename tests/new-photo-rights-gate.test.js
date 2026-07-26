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

const PHOTO_URL = "https://images.example.test/photo.jpg";
const SHA256 = "1f".repeat(32);
const approvedRights = {
  reviewStatus: "approved",
  reviewedAssetUrl: PHOTO_URL,
  assetUrlImmutable: true,
  creator: "Example Creator",
  sourcePageUrl: "https://commons.example.test/file-page",
  licenceId: "CC BY",
  licenceVersion: "4.0",
  licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  attributionText: "Example image © Example Creator",
  reviewedAt: "2026-07-26",
  modificationStatement: "Unmodified; metadata normalized only.",
  shareAlike: false,
  display: true,
  commercialUse: true,
  redistribution: true,
  derivatives: true,
};

function render(rights, url = PHOTO_URL) {
  return renderLegacyPhoto([{
    url,
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
    "reviewedAssetUrl", "creator", "sourcePageUrl", "licenceId", "licenceVersion",
    "licenceUrl", "attributionText", "reviewedAt", "modificationStatement",
    "shareAlike",
  ]) {
    const incomplete = { ...approvedRights };
    delete incomplete[field];
    assert.equal(hasApprovedPhotoRights(incomplete, PHOTO_URL), false, `missing ${field} must fail closed`);
    assert.doesNotMatch(render(incomplete), /<img\b/i);
  }

  for (const permission of ["display", "commercialUse", "redistribution", "derivatives"]) {
    assert.equal(hasApprovedPhotoRights({ ...approvedRights, [permission]: false }, PHOTO_URL), false);
  }
  assert.equal(
    hasApprovedPhotoRights({ ...approvedRights, reviewedAt: "not-a-date" }, PHOTO_URL),
    false,
  );
  assert.equal(photoImageUrl("../private/photo.jpg"), "");
  assert.equal(photoImageUrl("/assets/photo.jpg"), "");
  assert.equal(photoImageUrl("assets/photo.jpg"), "assets/photo.jpg");
  assert.equal(photoImageUrl("./assets/photo.jpg"), "assets/photo.jpg");
});

test("only approved, fully rights-cleared media renders with adjacent attribution links", () => {
  assert.equal(hasApprovedPhotoRights(approvedRights, PHOTO_URL), true);
  const html = render(approvedRights);
  assert.match(html, /<img\b/);
  assert.match(html, /Example &lt;summit&gt;/);
  assert.match(html, /Example image © Example Creator/);
  assert.match(html, /Creator: Example Creator/);
  assert.match(html, /https:\/\/commons\.example\.test\/file-page/);
  assert.match(html, /https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(html, /CC BY 4\.0/);
  assert.match(html, /Modification: Unmodified; metadata normalized only\./);
  assert.match(html, /Share alike: not required/);
  assert.match(html, /reviewed asset/);
  assert.match(html, /Immutable reviewed asset URL/);
  assert.match(render({ ...approvedRights, shareAlike: true }), /Share alike: required/);

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
  assert.equal(hasApprovedPhotoRights(equivalent, PHOTO_URL), true);
});

test("rights review is bound to the exact displayed asset by immutable URL or SHA-256", () => {
  assert.equal(hasApprovedPhotoRights(approvedRights), false);
  assert.equal(
    hasApprovedPhotoRights(approvedRights, "https://images.example.test/different.jpg"),
    false,
  );
  assert.doesNotMatch(
    render(approvedRights, "https://images.example.test/different.jpg"),
    /<img\b/i,
  );

  const hashed = {
    ...approvedRights,
    assetUrlImmutable: false,
    assetSha256: `sha256:${SHA256}`,
  };
  assert.equal(hasApprovedPhotoRights(hashed, PHOTO_URL), true);
  assert.match(render(hashed), new RegExp(`Asset SHA-256: ${SHA256}`));
  assert.equal(
    hasApprovedPhotoRights({ ...hashed, assetSha256: "sha256:not-a-hash" }, PHOTO_URL),
    false,
  );
  assert.equal(
    hasApprovedPhotoRights({ ...approvedRights, assetUrlImmutable: false }, PHOTO_URL),
    false,
  );
});

test("local assets are canonicalized beneath assets and require a strong content hash", () => {
  for (const unsafe of [
    "assets/../private.jpg",
    "assets/%2e%2e/private.jpg",
    "assets/%252e%252e/private.jpg",
    "assets/photos/../../private.jpg",
    "assets//photo.jpg",
    "assets/photo.jpg?replace=1",
    "assets/photos%2f..%2fprivate.jpg",
  ]) {
    assert.equal(photoImageUrl(unsafe), "", unsafe);
  }

  const localUrl = "assets/photos/reviewed.jpg";
  const localRights = {
    ...approvedRights,
    reviewedAssetUrl: "./assets/photos/reviewed.jpg",
    assetUrlImmutable: true,
  };
  assert.equal(hasApprovedPhotoRights(localRights, localUrl), false);
  assert.equal(hasApprovedPhotoRights({ ...localRights, assetSha256: SHA256 }, localUrl), true);
  assert.match(render({ ...localRights, assetSha256: SHA256 }, localUrl), /<img\b/);
});
