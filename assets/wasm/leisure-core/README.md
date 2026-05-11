# leisure-core

Pure-Rust core for the Alpine Passes leisure-first planner. The crate ports the graph model, route search, tour optimizer, Phase 4 POI helpers, and browser-facing WASM API so the static web app can run the planner from checked-in assets.

The JavaScript planner in `assets\js\leisure\` remains the integration shim and parity reference until the production cutover is complete.

## Module structure

- `src/types.rs` — canonical `Node`, `Edge`, `NodeKind`, `EdgeKind`, graph-data DTOs, and shared statistics.
- `src/graph.rs` — `LeisureGraph`, graph indexes, validators, edge canonicalization, and `EdgeStats`.
- `src/ears.rs` — `decompose_ears` and the iterative biconnected-component/ear-decomposition pipeline.
- `src/astar.rs` — `leisure_astar`, bidirectional A*, budget handling, and cost modes.
- `src/optimizer.rs` — ILS planner, JS-compatible `Mulberry32`, auto/selected/open plan entry points, and public plan results.
- `src/corridor.rs`, `src/lunch.rs`, `src/breaks.rs`, `src/intent.rs` — Phase 4 corridor detours, lunch zones, break suggestions, and intent-persona POI surfacing.
- `src/wasm_api.rs` — `#[wasm_bindgen]` exports used by `assets\js\leisure\wasm-shim.js`.

## Public WASM API

Complex inputs and outputs cross the boundary as JS values serialized through `serde-wasm-bindgen`; graphs and ear decompositions are referenced by numeric handles.

- `wasm_load_graph(graphData)` — validates/indexes a leisure graph and returns a `u32` graph handle.
- `wasm_decompose_ears(graphHandle)` — computes ear decomposition for a graph, stores it, and returns the decomposition plus its `handle`.
- `wasm_leisure_plan_auto(graphHandle, earsHandle, options)` — builds an automatic closed-loop or endpoint-aware leisure tour.
- `wasm_leisure_plan_selected(graphHandle, earsHandle, mustVisit, options)` — plans a tour through explicit pass/POI ids.
- `wasm_leisure_plan_open(graphHandle, earsHandle, startId, endId, options)` — plans an open route from one graph node to another.
- `wasm_leisure_astar(graphHandle, from, to, options)` — runs budget-aware leisure/distance/duration A* and returns path, edge, and cost details.
- `wasm_suggest_corridor(graphHandle, tour, options)` — scores along-route POIs for auto-inclusion and drawer suggestions.
- `wasm_find_lunch_area(graphHandle, tour, options)` — finds lunch-zone candidates for the current tour and persona policy.
- `wasm_suggest_breaks(graphHandle, tour, options)` — suggests rest/photo/food breaks along a tour.
- `wasm_infer_intent(entities, options)` — infers an intent/persona distribution from selected stops, themes, history, and trip context.
- `wasm_surface_intent_pois(tour, candidates, intent, options)` — ranks explicit POI candidates into primary and serendipity surfaces.
- `wasm_tags_from_entity(entity)` — maps a selected entity into intent tags.
- `wasm_tags_from_target(target)` — maps a target descriptor into intent tags.
- `leisure_core_version()` — returns the crate version string (for example, `"0.1.0"`) for cache-busting and diagnostics.
- `validateGraphJson(payload)` — validates a graph payload without loading it into a handle. Returns `undefined` when valid and throws an error string when invalid.
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
cargo install wasm-bindgen-cli --version 0.2.121
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

`npm test` exercises the legacy `assets\js\leisure\index.js` path and the WASM shim parity tests. Run `npm run build:wasm` first if the checked-in artifacts are not current.

For a quick compile check after dependency changes:

```bash
cargo build --package leisure-core
```

## Size budget

WASM artifacts must stay within the static-asset budget:

- Raw `leisure_core_bg.wasm`: ≤ 850 KB.
- Brotli-compressed `.wasm`: ≤ 250 KB.
- Current baseline: 807 KB raw / 234 KB brotli.

`npm run build:wasm` runs the post-build size check; if that check is unavailable in a local environment, verify the raw and brotli sizes manually before committing regenerated artifacts.

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
