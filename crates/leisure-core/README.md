# leisure-core

Pure-Rust core for the Itinera leisure-first planner. The crate ports the graph model, route search, tour optimizer, Phase 4 POI helpers, and browser-facing WASM API so the static web app can run the planner from checked-in assets.

The JavaScript façade at `assets\js\leisure\wasm-shim.js` is a thin UI/IO shim that loads the WASM artifact, fetches the graph, coordinates the OSRM HTTP call, threads telemetry, and exposes the `leisurePlanAuto` / `leisurePlanSelected` entry points consumed by `app.js`. All planner business logic — heuristics, DTO mapping, Phase 4 orchestration, route geometry, intent surfacing, plan finalization — lives in this crate.

## Module structure

- `src/types.rs` — canonical `Node`, `Edge`, `NodeKind`, `EdgeKind`, graph-data DTOs, and shared statistics.
- `src/graph.rs` — `LeisureGraph`, graph indexes, validators, edge canonicalization, and `EdgeStats`.
- `src/ears.rs` — `decompose_ears` and the iterative biconnected-component/ear-decomposition pipeline.
- `src/astar.rs` — `leisure_astar`, bidirectional A*, budget handling, and cost modes.
- `src/optimizer.rs` — ILS planner, JS-compatible `Mulberry32`, auto/selected/open plan entry points, and public plan results.
- `src/corridor.rs`, `src/lunch.rs`, `src/breaks.rs`, `src/intent.rs` — Phase 4 corridor detours, lunch zones, break suggestions, and intent-persona POI surfacing.
- `src/finalize.rs` — top-level `finalize_plan` that translates an optimizer `PlanResult` into the `FinalizedPlan` envelope consumed by the JS shim.
- `src/route_geom.rs` — path geometry, OSRM `RouteRequest` build, and `RouteFacts` merge.
- `src/tour_dto.rs`, `src/extras.rs`, `src/heuristics.rs`, `src/phase4_orchestrator.rs` — DTO mapping, scenic/break heuristics, Phase 4 composition.
- `src/wasm_api/` — `#[wasm_bindgen]` exports used by `assets\js\leisure\wasm-shim.js`, split across `mod.rs` (13 core planner exports), `finalize.rs`, `phase4.rs`, `route_geom.rs`, `tour_dto.rs`, and `heuristics.rs`.

## Public WASM API

Complex inputs and outputs cross the boundary as JS values serialized through `serde-wasm-bindgen`; graphs and ear decompositions are referenced by numeric handles.

- `wasm_load_graph(graphData)` — validates/indexes a leisure graph and returns a `u32` graph handle.
- `wasm_decompose_ears(graphHandle)` — computes ear decomposition for a graph, stores it, and returns the decomposition plus its `handle`.
- `wasm_leisure_plan_auto(graphHandle, earsHandle, options)` — builds an automatic closed-loop or endpoint-aware leisure tour.
- `wasm_leisure_plan_selected(graphHandle, earsHandle, mustVisit, options)` — plans a tour through explicit pass/POI ids.
- `wasm_leisure_plan_open(graphHandle, earsHandle, startId, endId, options)` — plans an open route from one graph node to another.
- `wasm_resolve_selected_stop_ids(graphHandle, selectedStops)` — resolves an array of UI-selected pass/POI descriptors to graph node ids.
- `wasm_build_route_requests(graphHandle, planResult, options)` — returns one OSRM `RouteRequest` per `[primary, ...alternatives]` for the shim's per-alternative OSRM call.
- `wasm_finalize_plan(graphHandle, planResult, routeFacts, options, advanced)` — composes the JS-shaped `FinalizedPlan` envelope (`UiPlanResult` flattened + `_routeAlternatives` + optional `error`). Accepts `null | RouteFacts | RouteFacts[]` in `routeFacts`.
- `wasm_phase4_outputs(graphHandle, tour, tourStops, options)` — runs Phase 4 (corridor / lunch / breaks / intent / overlays) for one alternative; used by the shim's lazy `ensurePhase4()` thunk.
- `wasm_infeasible_result(reason, options, advanced)` — emits the canonical infeasibility envelope so shape ownership stays Rust-side.
- `wasm_suggest_corridor(graphHandle, tour, options)` — scores along-route POIs for auto-inclusion and drawer suggestions.
- `wasm_find_lunch_area(graphHandle, tour, options)` — finds lunch-zone candidates for the current tour and persona policy.
- `wasm_suggest_breaks(graphHandle, tour, options)` — suggests rest/photo/food breaks along a tour.
- `wasm_infer_intent(entities, options)` — infers an intent/persona distribution from selected stops, themes, history, and trip context.
- `wasm_surface_intent_pois(tour, candidates, intent, options)` — ranks explicit POI candidates into primary and serendipity surfaces.
- `leisure_core_version()` — returns the crate version string (for example, `"0.1.0"`) for cache-busting and diagnostics.
- `wasm_free_graph(handle)` — releases a graph handle. The slot is tombstoned and the handle becomes invalid. Returns `true` if the handle was valid; `false` if already freed or out of range. Use when reloading graph data in a long-lived SPA.
- `wasm_free_ears(handle)` — releases an ear-decomposition handle with the same semantics as `wasm_free_graph`.

## Handle lifecycle

Graphs and ear decompositions are stored in thread-local pools; callers receive `u32` handles. Pass those handles back to planner/search/Phase 4 calls instead of re-sending the full graph.

Use `wasm_free_graph` and `wasm_free_ears` to release the underlying memory. The shim still keeps a single long-lived graph and ears handle for the page, but consumers reloading graph data can free first.

## Reproducible toolchain

The Rust dependency versions for WASM glue are pinned in `Cargo.toml` and must match the CLI used to regenerate artifacts.

```bash
# Tools needed:
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
cargo install wasm-bindgen-cli --version 0.2.118
npm install --no-save binaryen   # provides wasm-opt

# Build checked-in WASM artifacts:
npm run build:wasm
```

Do not use a newer `wasm-bindgen-cli` unless the Rust dependency pin and generated glue are updated together.

## Native build and tests

Native tests are faster than a WASM rebuild and only need the normal Rust toolchain:

```bash
cargo test --package leisure-core --tests
```

`npm test` runs `verify-wasm-hash` then the Node test suite covering the WASM shim (`tests/leisure-wasm-shim.test.js`, including a real-graph smoke test against `assets/data/leisure-graph.v1.json`) and other JS tooling. Run `npm run build:wasm` first if the checked-in artifacts are not current.

For a quick compile check after dependency changes:

```bash
cargo build --package leisure-core
```

## Size budget

WASM artifacts must stay within the static-asset budget:

- Raw `leisure_core_bg.wasm`: ≤ 1,000,000 bytes (≈ 977 KB).
- Brotli-compressed `.wasm`: ≤ 300,000 bytes (≈ 293 KB).
- Current baseline: 968,624 bytes raw / 278,375 bytes brotli (~946 KB raw / ~272 KB brotli).

The checked-in leisure graph (`assets\data\leisure-graph.v1.json`) is ~2.85 MB raw (2,989,132 bytes). It is served as a static JSON asset and should be gzip/brotli compressed at the edge; typical wire size is ~0.7-0.9 MB.

`npm run build:wasm` runs the post-build size check; if that check is unavailable in a local environment, verify the raw and brotli sizes manually before committing regenerated artifacts.

## Production Deployment

### MIME types

The static host MUST serve `.wasm` files with `Content-Type: application/wasm`. Modern CDNs (GitHub Pages, Cloudflare, Netlify, Vercel) do this by default. If you self-host:

- Apache: add `AddType application/wasm .wasm` to `.htaccess`.
- nginx: add `application/wasm wasm;` to `mime.types`.

The shim has a fallback path (`WebAssembly.instantiate` instead of `instantiateStreaming`) for hosts that get this wrong, but it is slower.

### Cache-Control

The WASM artifact and JS glue are version-coupled (wasm-bindgen ABI is not stable across versions). Serve them with **either**:

- `Cache-Control: public, max-age=300, must-revalidate` (short cache + revalidation), **or**
- Content-hashed filenames (for example, `leisure_core_bg.<sha256>.wasm`) with `Cache-Control: public, max-age=31536000, immutable`.

Currently the artifacts use static filenames, so the short-cache approach is recommended. GitHub Pages default is 10-minute caching, which is acceptable.

The graph JSON (`assets\data\leisure-graph.v1.json`) can be cached longer (1 hour to 1 day) because the schema is versioned in the filename (`v1`).

### CDN cache-bust caveats

The `?v=<hash>` query string on the WASM URL relies on the CDN keying its
cache by full URL (including query string). This works by default on:

- GitHub Pages (default behavior)
- Cloudflare (default behavior)
- Fastly, CloudFront, Netlify, Vercel (default behavior)

⚠️ Misconfigurations to avoid:
- Cloudflare's "Ignore Query String" option on Cache Level (defeats cache-bust)
- Some corporate proxies strip query strings on static assets
- Aggressive CDN edge caches with very long TTLs (the hash only helps after
  the TTL expires or on a hard reload)

If your hosting platform doesn't include query strings in cache keys, you'll
need to either content-hash the filename itself OR keep `Cache-Control:
max-age` very short on the WASM file.

### Compression

The graph JSON is ~2.85 MB uncompressed. Edge gzip/brotli compression typically reduces this to ~0.7-0.9 MB. Ensure your host's compression is enabled for `application/json` (default on GitHub Pages).

The WASM binary is 968,624 bytes raw / 278,375 bytes brotli (~946 KB raw / ~272 KB brotli). `wasm-opt` strips unused symbols; further size optimization is dominated by the embedded ear / corridor / lunch / break / intent code and the migrated UI translation layer (heuristics / tour DTO / extras / route geometry / Phase 4 orchestration / finalize).

### Browser support

Requires:

- WebAssembly (Chrome 57+, Firefox 52+, Safari 11+, Edge 79+)
- Dynamic `import()` (Chrome 63+, Firefox 67+, Safari 11+, Edge 79+; iOS Safari 14+ recommended for reliable dynamic import of glue JS)
- `localStorage` (universal)

Edge cases:

- `file://` protocol: `fetch` of relative URLs may be blocked. The shim shows the WASM-unavailable banner gracefully.
- Strict CSP: add `'wasm-unsafe-eval'` to `script-src` (or `default-src`).
- Private browsing in some browsers: `localStorage` may throw on read; the flag check handles this with try/catch.

### Monitoring

The shim emits structured telemetry via `CustomEvent`. Listen on `window` for:

- `leisure-wasm-error` — failure events (stage, errorName, errorMessage, timestamp)
- `leisure-wasm-event` — success events (plan-completed, wasm-ready)

Wire these to your team's telemetry pipeline (Sentry, Datadog, etc.) if available. The shim does NOT send beacons by default — it is opt-in via your listener.

### Build reproducibility

Pin in CI:

- `cargo install wasm-bindgen-cli --version 0.2.118` (matches the Cargo dependency pin)
- `wasm-pack` (any 0.x.y version)
- `binaryen` via `npm install --no-save binaryen` (provides `wasm-opt`)

Do not mix wasm-bindgen CLI and crate versions; the generated JS glue and `.wasm` ABI are version-coupled.

## Determinism

Planner output must be reproducible for the same graph, options, and seed.

- Output-affecting map/set iteration uses `BTreeMap`/`BTreeSet` or explicit sorting.
- `Mulberry32` matches the JavaScript PRNG byte-for-byte for seeded planning.
- Unseeded planning derives a fallback seed from graph/options instead of wall-clock entropy.
- `nearest_nodes` and other tie-prone selection paths use stable sorted tie-breakers.

## Deliberate divergences from JS

- Advanced-mode pool construction sorts must-visit candidates by id for input-order independence. The JS reference preserves user-input order, but Rust makes output reproducible regardless of how a UI client serializes must-visit ids.
- Perturbation can force a double-bridge kick after `max_no_improvement` non-improving iterations. This Rust-specific extension improves escape behavior while preserving seeded determinism.
- Unseeded planning uses a graph-derived fallback seed instead of wall-clock entropy so repeated runs over the same graph remain reproducible.

## JS parity notes

- Corridor detour math now matches the JS implementation, including route-time deltas and per-mode detour thresholds.
- Break suggestions preserve JS segment-merging behavior so nearby rest opportunities are not duplicated.
- Intent persona weights and tag derivation match the JS scoring model for surfaced POIs.
- JSON is still deserialized by serde before validation, so structurally malformed JSON may fail before validation can enumerate every JavaScript-style top-level error.
