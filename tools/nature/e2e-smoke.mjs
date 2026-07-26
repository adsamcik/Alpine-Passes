// Deterministic browser smoke test for manifest + visible-cell nature discovery.
//
// Starts an ephemeral static server, uses the repository's installed Playwright,
// and replaces only the remote basemap style with a valid empty style. All other
// external traffic is blocked so the checks never depend on live services.
//
// Invoke:
//   node tools/nature/e2e-smoke.mjs
//   node tools/nature/e2e-smoke.mjs --headed

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = resolve(REPO_ROOT, "assets/data/nature/manifest.v1.json");
const args = parseArgs(process.argv.slice(2));
const assertions = [];
const pageErrors = [];
const consoleErrors = [];
const natureRequests = [];
const externalRequests = [];
const routingRequests = [];
const EMPTY_STYLE = JSON.stringify({
  version: 8,
  name: "Itinera offline QA",
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {},
  layers: [],
});

function parseArgs(argv) {
  const parsed = { headed: false };
  for (const value of argv) {
    if (value === "--headed") parsed.headed = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function check(name, condition, detail = "") {
  const result = { name, ok: Boolean(condition), detail: String(detail || "") };
  assertions.push(result);
  console.log(`${result.ok ? "✓" : "✗"} ${name}${result.detail ? `  (${result.detail})` : ""}`);
}

function mimeType(pathname) {
  return {
    ".css": "text/css; charset=utf-8",
    ".gpx": "application/gpx+xml",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
  }[extname(pathname).toLowerCase()] || "application/octet-stream";
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function fixtureDistanceMeters(coordinates) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const [aLon, aLat] = coordinates[index - 1];
    const [bLon, bLat] = coordinates[index];
    const meanLatitude = (aLat + bLat) * Math.PI / 360;
    const dx = (bLon - aLon) * 111_320 * Math.cos(meanLatitude);
    const dy = (bLat - aLat) * 110_540;
    total += Math.hypot(dx, dy);
  }
  return Math.max(1, Math.round(total));
}

async function serveRoutingFixture(request, response, requestUrl) {
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" });
    response.end();
    return;
  }
  let payload;
  try {
    payload = await readRequestJson(request);
  } catch {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { code: "invalid_json", message: "Invalid JSON" } }));
    return;
  }
  routingRequests.push({ path: requestUrl.pathname, payload });
  const coordinates = payload.coordinates;
  let result;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    result = { error: { code: "invalid_request", message: "At least two coordinates are required" } };
  } else if (requestUrl.pathname.endsWith("/route")) {
    const distanceMeters = fixtureDistanceMeters(coordinates);
    result = {
      provider: "browser-smoke-fixture",
      routes: [{
        geometry: { type: "LineString", coordinates },
        distanceMeters,
        durationSeconds: Math.max(60, Math.round(distanceMeters / 14)),
      }],
    };
  } else if (requestUrl.pathname.endsWith("/matrix")) {
    const distancesMeters = coordinates.map((origin) => coordinates.map((destination) =>
      origin === destination ? 0 : fixtureDistanceMeters([origin, destination])));
    result = {
      provider: "browser-smoke-fixture",
      distancesMeters,
      durationsSeconds: distancesMeters.map((row) => row.map((distance) =>
        Math.round(distance / 14))),
    };
  } else {
    result = { error: { code: "not_found", message: "Routing endpoint not found" } };
  }
  const body = JSON.stringify(result);
  response.writeHead(result.error ? 400 : 200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function createLocalServer() {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname.startsWith("/api/routing/v1/")) {
        await serveRoutingFixture(request, response, requestUrl);
        return;
      }
      if (!["GET", "HEAD"].includes(request.method || "GET")) {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end();
        return;
      }
      const decoded = decodeURIComponent(requestUrl.pathname);
      const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
      let filePath = resolve(REPO_ROOT, requested);
      const outsideRoot = filePath !== REPO_ROOT
        && !filePath.startsWith(`${REPO_ROOT}${sep}`);
      if (outsideRoot) {
        response.writeHead(403);
        response.end();
        return;
      }

      let info;
      try {
        info = await stat(filePath);
      } catch {
        info = null;
      }
      if (info?.isDirectory()) {
        filePath = resolve(filePath, "index.html");
        try {
          info = await stat(filePath);
        } catch {
          info = null;
        }
      }
      if (!info?.isFile() && !extname(requested)) {
        filePath = resolve(REPO_ROOT, "index.html");
        info = await stat(filePath);
      }
      if (!info?.isFile()) {
        response.writeHead(404);
        response.end();
        return;
      }

      const body = await readFile(filePath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": mimeType(filePath),
        "Content-Length": body.byteLength,
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(String(error?.message || error));
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local server did not expose a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((accept, reject) =>
      server.close((error) => error ? reject(error) : accept())),
  };
}

async function loadFixture() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  if (!manifest.spatialIndex?.url) {
    throw new Error("Manifest has no spatial index URL");
  }
  const northAmericaEntries = manifest.packages.filter((entry) =>
    entry.regionId === "north-america");
  if (!northAmericaEntries.length) throw new Error("Manifest has no north-america regional package");
  const northAmericaDocuments = await Promise.all(northAmericaEntries.map(async (entry) => ({
    entry,
    document: JSON.parse(await readFile(resolve(REPO_ROOT, entry.url), "utf8")),
  })));
  const northAmericaEntities = northAmericaDocuments
    .flatMap(({ document }) => document.entities || []);
  const publishableRoute = northAmericaEntities.find((entity) =>
    entity.id === "route:us-ak-harding-icefield-out-and-back");
  const publishableAccess = northAmericaEntities.find((entity) =>
    entity.id === "access:us-ak-exit-glacier-trailhead");
  if (!publishableRoute || !publishableAccess) {
    throw new Error("North America package lacks the governed Harding route/access pair");
  }
  const publishableName = publishableRoute.names?.find((item) => item.kind === "primary")?.value
    || publishableRoute.names?.[0]?.value;
  if (!publishableName) throw new Error("Governed Harding route has no displayable name");
  return {
    manifest,
    spatialIndexPath: `/${manifest.spatialIndex.url}`,
    northAmericaPackagePaths: northAmericaEntries.map((entry) => `/${entry.url}`),
    publishableRoute: {
      id: publishableRoute.id,
      name: publishableName,
      accessId: publishableAccess.id,
      coordinateCount: publishableRoute.geometry?.coordinates?.length || 0,
      sourceNoticeCount: publishableRoute.exportMetadata?.sourceNotices?.length || 0,
    },
  };
}

async function sourceGeoJson(page, sourceId) {
  return page.evaluate((id) => {
    const source = window.ItineraApp?.map?.getSource?.(id);
    const serialized = source?.serialize?.();
    let data = source?._data ?? serialized?.data ?? null;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    return data;
  }, sourceId);
}

async function rawNatureRequestBytes(pathnames) {
  const natureRoot = resolve(REPO_ROOT, "assets/data/nature");
  const files = [];
  let total = 0;
  for (const pathname of [...new Set(pathnames)].sort()) {
    const decoded = decodeURIComponent(new URL(pathname, "http://localhost").pathname);
    const filePath = resolve(REPO_ROOT, decoded.replace(/^\/+/, ""));
    const outsideNatureRoot = filePath !== natureRoot
      && !filePath.startsWith(natureRoot + sep);
    if (outsideNatureRoot) throw new Error("Nature request escaped data root: " + pathname);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Nature request is not a file: " + pathname);
    total += info.size;
    files.push({ path: pathname, bytes: info.size });
  }
  return { total, files };
}

async function run() {
  const fixture = await loadFixture();
  const local = await createLocalServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: !args.headed });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();

    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      const url = request.url();
      const parsed = new URL(url);
      if (parsed.origin === local.baseUrl && parsed.pathname.startsWith("/assets/data/nature/")) {
        natureRequests.push(parsed.pathname);
      }
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const parsed = new URL(request.url());
      if (parsed.origin === local.baseUrl) {
        await route.continue();
        return;
      }
      externalRequests.push(parsed.href);
      if (parsed.hostname === "tiles.openfreemap.org"
          && parsed.pathname.startsWith("/styles/")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: EMPTY_STYLE,
        });
        return;
      }
      if (parsed.hostname === "tiles.openfreemap.org"
          && parsed.pathname.startsWith("/fonts/")) {
        await route.fulfill({
          status: 200,
          contentType: "application/x-protobuf",
          body: Buffer.alloc(0),
        });
        return;
      }
      await route.abort("blockedbyclient");
    });

    console.log(`Loading ${local.baseUrl}/index.html`);
    await page.goto(`${local.baseUrl}/index.html`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => {
      const status = window.ItineraNature?.getStatus?.();
      return status?.viewportState === "ready"
        && document.querySelectorAll(".discover-card-select").length === status.resultCount;
    }, null, { timeout: 20_000 });
    await page.waitForTimeout(250);

    const initialViewportState = await page.evaluate(() => {
      const status = window.ItineraNature.getStatus();
      const bounds = window.ItineraApp?.map?.getBounds?.();
      const cards = [...document.querySelectorAll(".discover-card-select")];
      const mapCount = document.querySelector("#discoverMapCount");
      const showMore = document.querySelector("#discoverShowMore");
      return {
        ...status,
        mapBounds: bounds
          ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
          : null,
        accessibleCardCount: cards.length,
        focusableCardCount: cards.filter((card) => !card.disabled && card.tabIndex >= 0).length,
        resultsTitle: document.querySelector("#discoverResultsTitle")?.textContent?.trim(),
        resultsLabelledBy: document.querySelector("#discoverResults")?.getAttribute("aria-labelledby"),
        resultsDescribedBy: document.querySelector("#discoverResults")?.getAttribute("aria-describedby"),
        countText: document.querySelector("#discoverCount")?.textContent?.trim(),
        mapCountText: mapCount?.textContent?.trim(),
        mapCountLoaded: Number(mapCount?.dataset.loaded),
        mapCountAvailable: Number(mapCount?.dataset.available),
        mapCountRendered: Number(mapCount?.dataset.rendered),
        mapCountCapped: Number(mapCount?.dataset.capped),
        showMoreVisible: Boolean(showMore && !showMore.hidden),
      };
    });
    check(
      "release viewport reaches ready with honest empty results and actual bounds",
      initialViewportState.viewportState === "ready"
        && initialViewportState.viewportEntityCount === 0
        && initialViewportState.viewportResultTotal === 0
        && initialViewportState.mapBounds?.length === 4
        && initialViewportState.mapBounds.every(Number.isFinite),
      JSON.stringify(initialViewportState),
    );

    check(
      "empty viewport preserves synchronized accessible result and map counts",
      initialViewportState.region == null
        && initialViewportState.entityCount === 0
        && initialViewportState.resultCount === 0
        && initialViewportState.accessibleCardCount === 0
        && initialViewportState.focusableCardCount === 0
        && initialViewportState.resultsTitle === "Visible map results"
        && initialViewportState.resultsLabelledBy === "discoverResultsTitle"
        && initialViewportState.resultsDescribedBy === "discoverCount discoverMapCount"
        && initialViewportState.countText === "0 visible results shown"
        && initialViewportState.showMoreVisible === false
        && initialViewportState.mapLoadedCount === 0
        && initialViewportState.mapAvailableCount === 0
        && initialViewportState.mapRenderedCount === 0
        && initialViewportState.mapCappedCount === 0
        && initialViewportState.mapCountText?.startsWith(
          "Map renders 0 of 0 filter-eligible loaded records; 0 visible-cell records are loaded",
        ),
      JSON.stringify(initialViewportState),
    );

    const initialTabState = await page.evaluate(() => ({
      discoverChecked: document.querySelector("#sidebarTabDiscover")?.checked,
      discoverSelected: document.querySelector('label[for="sidebarTabDiscover"]')?.getAttribute("aria-selected"),
      discoverVisible: !document.querySelector("#discoverPanel")?.hidden,
      planHidden: document.querySelector("#sidebarPanelPlan")?.hidden,
      browseHidden: document.querySelector("#sidebarPanelBrowse")?.hidden,
    }));
    check(
      "Discover is the default, selected sidebar tab",
      initialTabState.discoverChecked
        && initialTabState.discoverSelected === "true"
        && initialTabState.discoverVisible
        && initialTabState.planHidden
        && initialTabState.browseHidden,
      JSON.stringify(initialTabState),
    );

    const initialNaturePaths = [...new Set(natureRequests)];
    const initialNatureBytes = await rawNatureRequestBytes(initialNaturePaths);
    const initialNatureBudget = Number(fixture.manifest.budgets?.initialNatureDataBytes);
    check(
      "unique initial nature request raw bytes fit the manifest budget",
      Number.isFinite(initialNatureBudget)
        && initialNatureBudget > 0
        && initialNatureBytes.total <= initialNatureBudget,
      JSON.stringify({
        rawBytes: initialNatureBytes.total,
        budgetBytes: initialNatureBudget,
        mapBounds: initialViewportState.mapBounds,
        files: initialNatureBytes.files,
      }),
    );
    check(
      "initial nature request includes the manifest",
      initialNaturePaths.includes("/assets/data/nature/manifest.v1.json"),
      initialNaturePaths.join(", "),
    );
    check(
      "initial nature bootstrap fetches the manifest-advertised spatial index",
      initialNaturePaths.includes(fixture.spatialIndexPath),
      initialNaturePaths.join(", "),
    );
    const initialCellPaths = initialNaturePaths.filter((path) =>
      path.startsWith("/assets/data/nature/spatial/cells/"));
    check(
      "empty release viewport fetches no non-intersecting spatial cell package",
      initialCellPaths.length === 0,
      initialCellPaths.join(", "),
    );
    check(
      "initial nature bootstrap downloads no regional package before Explore",
      initialNaturePaths.every((path) => !path.startsWith("/assets/data/nature/packages/")),
      initialNaturePaths.join(", "),
    );

    const regionState = await page.evaluate(() => ({
      value: document.querySelector("#discoverRegion")?.value,
      label: document.querySelector("#discoverRegion option:checked")?.textContent,
      button: document.querySelector("#discoverLoadRegion")?.textContent,
    }));
    check(
      "release selector defaults to the only packaged region",
      regionState.value === "north-america"
        && /United States & Canada/.test(regionState.label || "")
        && regionState.button === "Load region"
        && fixture.manifest.packages.every((entry) => entry.regionId === "north-america"),
      JSON.stringify(regionState),
    );

    const requestCountBeforeNorthAmerica = natureRequests.length;
    await page.selectOption("#discoverRegion", "north-america");
    await page.locator("#discoverLoadRegion").click();
    await page.waitForFunction(() =>
      window.ItineraNature?.getStatus?.().region === "north-america"
      && window.ItineraNature.getStatus().entityCount > 0,
    null, { timeout: 20_000 });
    const northAmericaPackageRequests = [...new Set(
      natureRequests
        .slice(requestCountBeforeNorthAmerica)
        .filter((path) => path.startsWith("/assets/data/nature/packages/")),
    )].sort();
    check(
      "North America exploration loads only its advertised regional package set",
      JSON.stringify(northAmericaPackageRequests)
        === JSON.stringify([...fixture.northAmericaPackagePaths].sort()),
      northAmericaPackageRequests.join(", "),
    );

    await page.selectOption("#discoverActivity", "hiking");
    await page.fill("#discoverSearch", fixture.publishableRoute.name);
    await page.waitForFunction((routeName) =>
      [...document.querySelectorAll(".discover-card-title")]
        .some((card) => card.textContent === routeName),
    fixture.publishableRoute.name, { timeout: 10_000 });
    await page.getByRole("button", {
      name: `Show ${fixture.publishableRoute.name} details and geometry`,
      exact: true,
    }).click();
    await page.waitForFunction((routeName) =>
      document.querySelector(".discover-detail-title")?.textContent === routeName,
    fixture.publishableRoute.name, { timeout: 10_000 });

    const publishableDetail = await page.evaluate(() => {
      const action = (label) => {
        const button = [...document.querySelectorAll(".hike-action")]
          .find((candidate) => candidate.textContent?.trim() === label);
        return {
          exists: Boolean(button),
          ariaDisabled: button?.getAttribute("aria-disabled"),
          nativeDisabled: button?.disabled,
          tabIndex: button?.tabIndex,
        };
      };
      const facts = [...document.querySelectorAll(".hike-at-a-glance dd")]
        .map((node) => node.textContent?.trim());
      return {
        title: document.querySelector(".discover-detail-title")?.textContent?.trim(),
        summary: document.querySelector(".discover-detail-summary")?.textContent?.trim(),
        facts,
        confidence: document.querySelector(".hike-confidence")?.textContent?.trim(),
        geojson: action("Download GeoJSON"),
        gpx: action("Download GPX"),
        plan: action("Plan access + route"),
      };
    });
    const enabledAction = (action) => action.exists
      && action.ariaDisabled !== "true"
      && action.nativeDisabled === false
      && action.tabIndex >= 0;
    check(
      "governed Harding detail exposes readable official facts and enabled actions",
      publishableDetail.title === fixture.publishableRoute.name
        && /NPS/i.test(publishableDetail.summary || "")
        && /6–8 hours/.test(publishableDetail.summary || "")
        && /Verified/i.test(publishableDetail.confidence || "")
        && fixture.publishableRoute.coordinateCount === 5479
        && fixture.publishableRoute.sourceNoticeCount === 7
        && enabledAction(publishableDetail.geojson)
        && enabledAction(publishableDetail.gpx)
        && enabledAction(publishableDetail.plan),
      JSON.stringify(publishableDetail),
    );

    const geojsonDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download GeoJSON", exact: true }).click();
    const geojsonDownload = await geojsonDownloadPromise;
    const geojsonDownloadPath = await geojsonDownload.path();
    const downloadedGeoJson = JSON.parse(await readFile(geojsonDownloadPath, "utf8"));
    const downloadedGeoJsonFeature = downloadedGeoJson.features?.[0];
    check(
      "browser emits the complete Harding GeoJSON with exact source notices",
      geojsonDownload.suggestedFilename() === "harding-icefield-trail-out-and-back.geojson"
        && downloadedGeoJson.metadata?.routeId === fixture.publishableRoute.id
        && downloadedGeoJson.metadata?.exportSourceNotices?.status === "complete"
        && downloadedGeoJson.metadata?.exportSourceNotices?.notices?.length === 7
        && downloadedGeoJsonFeature?.geometry?.coordinates?.length === 5479,
      JSON.stringify({
        filename: geojsonDownload.suggestedFilename(),
        routeId: downloadedGeoJson.metadata?.routeId,
        notices: downloadedGeoJson.metadata?.exportSourceNotices?.notices?.length,
        coordinates: downloadedGeoJsonFeature?.geometry?.coordinates?.length,
      }),
    );

    const gpxDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download GPX", exact: true }).click();
    const gpxDownload = await gpxDownloadPromise;
    const gpxDownloadPath = await gpxDownload.path();
    const downloadedGpx = await readFile(gpxDownloadPath, "utf8");
    check(
      "browser emits the complete Harding GPX with public-domain provenance",
      gpxDownload.suggestedFilename() === "harding-icefield-trail-out-and-back.gpx"
        && (downloadedGpx.match(/<trkpt /g) || []).length === 5479
        && (downloadedGpx.match(/<itinera:source /g) || []).length === 7
        && /sourceRecordId="30488"/.test(downloadedGpx)
        && /US-PUBLIC-DOMAIN/.test(downloadedGpx)
        && /No protection is claimed in original U\.S\. Government works/.test(downloadedGpx),
      JSON.stringify({
        filename: gpxDownload.suggestedFilename(),
        trackpoints: (downloadedGpx.match(/<trkpt /g) || []).length,
        notices: (downloadedGpx.match(/<itinera:source /g) || []).length,
      }),
    );

    const routingRequestCountBeforePlan = routingRequests.length;
    await page.getByRole("button", { name: "Plan access + route", exact: true }).click();
    await page.waitForFunction(() =>
      /^(Route itinerary built\.|Planning refused)/
        .test(document.querySelector(".hike-action-status")?.textContent || ""),
    null, { timeout: 10_000 });
    const plannedJourney = await page.evaluate(() => ({
      status: document.querySelector(".hike-action-status")?.textContent,
      legs: [...document.querySelectorAll(".discover-itinerary-legs li")]
        .map((item) => item.textContent?.trim()),
      safety: document.querySelector(".discover-safety-note")?.textContent?.trim(),
    }));
    const planRoutingRequests = routingRequests.slice(routingRequestCountBeforePlan);
    check(
      "browser builds a drive-park-hike-return journey for the governed route",
      plannedJourney.status === "Route itinerary built."
        && plannedJourney.legs.some((leg) => /^Drive/i.test(leg || ""))
        && plannedJourney.legs.some((leg) => /^Park or transfer/i.test(leg || ""))
        && plannedJourney.legs.some((leg) => /^Hike/i.test(leg || ""))
        && planRoutingRequests.length === 2
        && planRoutingRequests.every((request) =>
          request.path.endsWith("/route") && request.payload.profile === "car"),
      JSON.stringify({ plannedJourney, planRoutingRequests }),
    );

    await page.evaluate(() => {
      const map = window.ItineraApp.map;
      map.setStyle({
        version: 8,
        name: "Itinera style-reload QA",
        glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
        sources: {},
        layers: [],
      });
    });
    await page.waitForTimeout(1_000);
    const reloadState = await page.evaluate(() => {
      const map = window.ItineraApp?.map;
      const style = map?.getStyle?.() || {};
      const layerIds = style.layers?.map((layer) => layer.id) || [];
      return {
        sourceIds: Object.keys(style.sources || {}),
        routeLayerCount: layerIds.filter((id) => id === "nature-discovery-route-lines").length,
        overviewLayerCount: layerIds.filter((id) => id === "nature-discovery-overview-route-lines").length,
        loaded: map?.loaded?.(),
      };
    });
    check(
      "style reload recreates each nature route layer exactly once",
      reloadState.routeLayerCount === 1 && reloadState.overviewLayerCount === 1,
      JSON.stringify(reloadState),
    );

    await page.locator('label[for="sidebarTabDiscover"]').focus();
    await page.keyboard.press("ArrowRight");
    const planTabState = await page.evaluate(() => ({
      activeId: document.activeElement?.getAttribute("for"),
      discoverSelected: document.querySelector('label[for="sidebarTabDiscover"]')?.getAttribute("aria-selected"),
      planSelected: document.querySelector('label[for="sidebarTabPlan"]')?.getAttribute("aria-selected"),
      planVisible: !document.querySelector("#sidebarPanelPlan")?.hidden,
    }));
    check(
      "arrow-key tab navigation selects and focuses Plan",
      planTabState.activeId === "sidebarTabPlan"
        && planTabState.discoverSelected === "false"
        && planTabState.planSelected === "true"
        && planTabState.planVisible,
      JSON.stringify(planTabState),
    );
    await page.keyboard.press("Home");
    const tabStops = await page.evaluate(() => ({
      activeId: document.activeElement?.getAttribute("for"),
      discoverSelected: document.querySelector('label[for="sidebarTabDiscover"]')?.getAttribute("aria-selected"),
      tabIndexes: [...document.querySelectorAll(".sidebar-tab")].map((node) => node.tabIndex),
    }));
    check(
      "Home returns focus to Discover with one tab stop",
      tabStops.activeId === "sidebarTabDiscover"
        && tabStops.discoverSelected === "true"
        && tabStops.tabIndexes.filter((value) => value === 0).length === 1
        && tabStops.tabIndexes.filter((value) => value === -1).length === 2,
      JSON.stringify(tabStops),
    );
    await page.keyboard.press("Tab");
    const focusAfterTab = await page.evaluate(() => ({
      id: document.activeElement?.id,
      tag: document.activeElement?.tagName,
    }));
    check(
      "Tab advances from the active sidebar tab into Discover controls",
      focusAfterTab.id === "discoverRegion",
      JSON.stringify(focusAfterTab),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const mobileOverflow = await page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      const panel = document.querySelector("#discoverPanel");
      const sidebar = document.querySelector(".app-sidebar");
      return {
        rootClient: root.clientWidth,
        rootScroll: root.scrollWidth,
        bodyClient: body.clientWidth,
        bodyScroll: body.scrollWidth,
        panelClient: panel?.clientWidth,
        panelScroll: panel?.scrollWidth,
        sidebarClient: sidebar?.clientWidth,
        sidebarScroll: sidebar?.scrollWidth,
      };
    });
    const within = (scroll, client) =>
      Number.isFinite(scroll) && Number.isFinite(client) && scroll <= client + 1;
    check(
      "390 px mobile viewport has no horizontal overflow",
      within(mobileOverflow.rootScroll, mobileOverflow.rootClient)
        && within(mobileOverflow.bodyScroll, mobileOverflow.bodyClient)
        && within(mobileOverflow.panelScroll, mobileOverflow.panelClient)
        && within(mobileOverflow.sidebarScroll, mobileOverflow.sidebarClient),
      JSON.stringify(mobileOverflow),
    );

    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
    const relevantConsoleErrors = consoleErrors.filter((message) =>
      !/favicon|ERR_BLOCKED_BY_CLIENT|Failed to load resource/i.test(message));
    check(
      "no application console errors",
      relevantConsoleErrors.length === 0,
      relevantConsoleErrors.join(" | "),
    );
    check(
      "remote dependencies were intercepted",
      externalRequests.every((url) => !url.startsWith(local.baseUrl)),
      `${externalRequests.length} external request(s) handled offline`,
    );

    await context.close();
  } finally {
    await browser?.close();
    await local.close();
  }

  const failed = assertions.filter((assertion) => !assertion.ok);
  console.log(`\n${assertions.length - failed.length}/${assertions.length} assertions passed.`);
  if (failed.length) {
    console.log("Failures:");
    for (const failure of failed) {
      console.log(`  - ${failure.name}${failure.detail ? `: ${failure.detail}` : ""}`);
    }
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error("Nature e2e smoke errored:", error);
  process.exitCode = 2;
});
