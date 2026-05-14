// Playwright e2e smoke test for the leisure planner post-migration.
// Runs against the local dev server (tools/dev_server.py). Verifies:
//   1. App loads with leisure flag enabled (no JS errors)
//   2. WASM module + graph load without firing leisure-wasm-error
//   3. A real plan executes through the Rust pipeline and renders a tour
//   4. _routeAlternatives carry working ensurePhase4 thunks
//   5. The post-migration result shape (corridor.{autoInclude,suggestions,drawer}) is preserved
//
// Invoke: node tools/leisure/e2e-smoke.mjs --base http://127.0.0.1:8765
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.base ?? "http://127.0.0.1:8765";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") out.base = argv[++i];
    if (argv[i] === "--headed") out.headed = true;
  }
  return out;
}

const assertions = [];
function check(name, cond, detail) {
  assertions.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
}

async function run() {
  const browser = await chromium.launch({ headless: !args.headed });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const shimErrors = [];
  const shimEvents = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // Seed leisure flag BEFORE loading the page.
  await ctx.addInitScript(() => {
    try { localStorage.setItem("alpine.planner.leisure.v1", "1"); } catch {}
    window.__leisureWasmErrors = [];
    window.__leisureWasmEvents = [];
    window.addEventListener("leisure-wasm-error", (e) => window.__leisureWasmErrors.push(e.detail));
    window.addEventListener("leisure-wasm-event", (e) => window.__leisureWasmEvents.push(e.detail));
  });

  console.log(`Loading ${baseUrl}…`);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector("#planRun", { timeout: 15_000 });
  await page.waitForSelector("#planStart option:nth-child(2)", { timeout: 15_000 });

  // Sanity: leisure flag is sticky.
  const flag = await page.evaluate(() => localStorage.getItem("alpine.planner.leisure.v1"));
  check("localStorage flag persisted", flag === "1", flag);

  // Pick a known start from the dropdown (second option; first is the placeholder).
  const startId = await page.evaluate(() => {
    const sel = document.getElementById("planStart");
    if (!sel) return null;
    const target = sel.querySelector("option[value]:not([value=''])");
    if (!target) return null;
    sel.value = target.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return target.value;
  });
  check("start point selected", !!startId, startId);

  // Make sure the WASM module + graph are warmed before clicking Plan.
  // The shim preloads on flag enable but we'll give it a beat.
  await page.waitForTimeout(1500);

  // Trigger the plan.
  await page.click("#planRun");

  // Wait for the plan to finish: either a tour renders, or the banner shows, or an error appears.
  const planOutcome = await page.evaluate(async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const banner = document.getElementById("leisureWasmUnavailableBanner");
      if (banner) return { kind: "wasm-unavailable", message: banner.textContent };
      const result = document.getElementById("planResult");
      const text = result ? result.textContent : "";
      if (text && /\b(km|h|hours|hour|min)\b/i.test(text) && !text.includes("Planning…")) {
        return { kind: "rendered", text: text.slice(0, 200) };
      }
      if (text && /(error|failed|infeasible|pick a start)/i.test(text) && !text.includes("Planning…")) {
        return { kind: "error", text: text.slice(0, 200) };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { kind: "timeout" };
  });

  check(
    "plan rendered (not wasm-unavailable, not infeasible, not timeout)",
    planOutcome.kind === "rendered",
    `${planOutcome.kind}: ${planOutcome.text || planOutcome.message || ""}`,
  );

  // Pull shim events + errors out for inspection.
  const wasmErrors = await page.evaluate(() => window.__leisureWasmErrors ?? []);
  const wasmEvents = await page.evaluate(() => window.__leisureWasmEvents ?? []);
  shimErrors.push(...wasmErrors);
  shimEvents.push(...wasmEvents);

  // Reach into the leisure module and inspect the cached plan result for shape.
  const shapeCheck = await page.evaluate(async () => {
    const mod = await import("/assets/js/leisure/wasm-shim.js");
    if (!mod) return { error: "shim module not importable" };
    // Trigger a fresh plan we control, so we can inspect the result directly.
    const start = (() => {
      const sel = document.getElementById("planStart");
      const opt = sel?.querySelector("option[value]:not([value=''])");
      return opt?.value;
    })();
    if (!start) return { error: "no start option found in DOM" };
    const r = await mod.leisurePlanAuto({ start, targetMode: "distance", targetValue: 150 });
    return {
      hasIntent: !!r?.intent,
      hasCorridor: !!r?.corridor,
      corridorKeys: r?.corridor ? Object.keys(r.corridor).sort() : null,
      hasRouteAlternatives: Array.isArray(r?._routeAlternatives),
      altCount: Array.isArray(r?._routeAlternatives) ? r._routeAlternatives.length : 0,
      altHasEnsurePhase4: typeof r?._routeAlternatives?.[0]?.ensurePhase4 === "function",
      status: r?.status,
      hasTourStops: Array.isArray(r?.tourStops) && r.tourStops.length > 0,
      hasLatlngs: Array.isArray(r?._latlngs) && r._latlngs.length > 0,
      km: r?.km,
      totalH: r?.totalH,
      wasmUnavailable: !!r?.wasmUnavailable,
    };
  });

  check("shim plan result has intent", shapeCheck.hasIntent);
  check("shim plan result has corridor", shapeCheck.hasCorridor);
  check(
    "corridor reshaped for legacy app.js (autoInclude, suggestions, drawer)",
    shapeCheck.corridorKeys && shapeCheck.corridorKeys.includes("autoInclude") && shapeCheck.corridorKeys.includes("suggestions") && shapeCheck.corridorKeys.includes("drawer"),
    JSON.stringify(shapeCheck.corridorKeys),
  );
  check("plan returned non-infeasible status", shapeCheck.status !== "infeasible" && !shapeCheck.wasmUnavailable, `status=${shapeCheck.status}`);
  check("plan has tour stops", shapeCheck.hasTourStops);
  check("plan has lat/lng geometry", shapeCheck.hasLatlngs);
  check("plan has positive km", shapeCheck.km > 0, String(shapeCheck.km));
  check("plan has positive totalH", shapeCheck.totalH > 0, String(shapeCheck.totalH));
  check("_routeAlternatives is an array", shapeCheck.hasRouteAlternatives);
  check("alternatives have ensurePhase4 thunks", shapeCheck.altHasEnsurePhase4);

  // Exercise the lazy phase4 enrichment on alt[1] if it exists.
  const lazyCheck = await page.evaluate(async () => {
    const mod = await import("/assets/js/leisure/wasm-shim.js");
    const start = document.getElementById("planStart")?.querySelector("option[value]:not([value=''])")?.value;
    if (!start) return { skipped: "no start" };
    const r = await mod.leisurePlanAuto({ start, targetMode: "distance", targetValue: 150 });
    const alts = r?._routeAlternatives ?? [];
    if (alts.length < 2) return { skipped: `only ${alts.length} alternatives` };
    const target = alts[1];
    const before = { corridor: target.result?.corridor };
    const enriched = await target.ensurePhase4();
    const after = { corridor: enriched.result?.corridor };
    return { before, after, beforeHadCorridor: !!before.corridor, afterHadCorridor: !!after.corridor };
  });
  if (lazyCheck.skipped) {
    check("lazy alternative enrichment", true, `skipped: ${lazyCheck.skipped}`);
  } else {
    check(
      "lazy alternative enrichment populates corridor on click",
      lazyCheck.afterHadCorridor && lazyCheck.after.corridor && Object.keys(lazyCheck.after.corridor).length > 0,
      JSON.stringify(lazyCheck.after.corridor)?.slice(0, 100),
    );
  }

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  check("no leisure-wasm-error events", shimErrors.length === 0, JSON.stringify(shimErrors).slice(0, 200));
  check("plan-completed shim event emitted", shimEvents.some((e) => e?.name === "plan-completed"), JSON.stringify(shimEvents.map((e) => e?.name)));

  // Console errors filter: ignore leaflet/map-tile noise that is unrelated to leisure planner.
  const relevantConsole = consoleErrors.filter((e) => !/leaflet|tile|maptiler|favicon|net::ERR|404/i.test(e));
  check("no leisure-related console errors", relevantConsole.length === 0, relevantConsole.join(" | "));

  await browser.close();

  const failed = assertions.filter((a) => !a.ok);
  console.log(`\n${assertions.length - failed.length}/${assertions.length} assertions passed.`);
  if (failed.length) {
    console.log(`Failures:\n${failed.map((f) => `  - ${f.name}: ${f.detail ?? ""}`).join("\n")}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("e2e run errored:", err);
  process.exit(2);
});
