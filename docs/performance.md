# Performance baseline, budgets, and measurement

## Interpretation

This document separates observed bytes from authored budgets. Filesystem and gzip sizes do not prove startup, interaction, memory, or field performance. The committed Node microbenchmark is useful engineering evidence, but it is not representative-device or browser evidence. Its recorded 4,019-entity indexed-search p95 is 54.547 ms and misses the observational 50 ms target; its deterministic 5,000-entity synthetic p95 is 48.310 ms. No current measurement demonstrates the 50 ms search p95 or 100 ms map-interaction p95 budgets on representative field devices.

The original repository baseline was inspected on 2026-07-25 at commit `5bd7636bbdca09bce6a5b36f5825cd7a331da9de`. Nature-package measurements below are a provisional pre-governance-rebuild snapshot from 2026-07-26. Its content hashes and byte totals are expected to change, so it is intentionally not identified as a release build.

## Legacy baseline bytes

| Artifact | Uncompressed bytes | `gzip -c` bytes | Notes |
| --- | ---: | ---: | --- |
| `assets/js/itinera.bundle.js` | 2,369,929 | 645,649 | Concatenates 15 sources, including all legacy regional arrays. |
| `assets/data/leisure-graph.v1.json` | 2,989,132 | 364,454 | Loaded by the WASM leisure planner when enabled. |
| `assets/wasm/leisure-core/leisure_core_bg.wasm` | 969,295 | 366,551 | WASM is already a binary; transfer compression gain depends on server/browser. |
| vendored `maplibre-gl.js` | 939,308 | 248,608 | Loaded by `index.html`. |
| vendored `maplibre-gl.css` | 69,422 | 10,038 | Loaded by `index.html`. |
| `assets/css/site.css` | 154,270 | 31,004 | Loaded by `index.html`. |

`assets/js/app.js` alone was 11,378 lines and 464,442 uncompressed bytes at the original baseline. Repository storage at that baseline was approximately 106.6 MB excluding `.git`, `target`, and `node_modules`; about 63.8 MB was under `assets/ui-icons/`. Repository storage is relevant to cloning and CI but is not equal to page transfer.

The current `index.html` loads `assets/js/nature/app.mjs` and its ES-module dependencies and presents Discover as the default tab. Nature data remains lazy: the loader fetches only `manifest.v1.json` during initialization and fetches a logical region only after explicit user activation. The JavaScript module graph, legacy bundle, map shell, CSS, and other page assets are therefore part of startup even though regional nature JSON is not. A representative browser startup/network profile has not yet been recorded.

## Provisional nature package measurements

The provisional snapshot contains 4,019 valid canonical records. That count is processed inventory, not verified geographic, thematic, access, or route completeness. The snapshot adds a content-addressed spatial index and fixed Web Mercator XYZ zoom-8 cell packages while retaining the regional packages used by the current UI.

| Artifact group | Objects | Raw filesystem bytes | Provisional observation |
| --- | ---: | ---: | --- |
| Manifest | 1 | 6,313 | Manifest-only startup remains within the 64,000-byte gate. |
| Spatial index | 1 | 49,200 | 164 populated cells and 164 package references; within the 2,000,000-byte gate. |
| Spatial cell packages | 164 | 15,216,554 | Largest package is 800,307 bytes; all pass the 1,000,000-byte gate. |
| Transitional regional packages | 10 | 15,031,749 | Largest shard is 2,498,752 bytes; the UI still explicitly loads this layout. |
| All generated nature artifacts | 181 | 30,610,673 | Includes both delivery layouts, manifest, index, reports, and redirects. |

The equal cell and package counts are a property of this corpus snapshot, not a format invariant: a cell can require multiple byte-bounded packages. Points appear once in the cell tree; line and polygon bounding boxes can copy an entity into multiple cells. Stable-ID deduplication prevents those copies from becoming distinct logical entities.

The regional and spatial package totals show a transitional near-doubling of static storage before reports and indexes. That is not the expected transfer for one viewport, but it affects repository/site-package size, upload and invalidation work, retained rollback objects, and CDN storage. Regional packages must not be removed until the spatial path is integrated, measured, and proven operationally recoverable.

High compression is likely because of repeated JSON field names and provenance, but current spatial artifacts have not been measured with the production CDN encoding. The browser still allocates decoded JSON, parsed objects, canonicalized JSON for hashing, and deep-frozen objects. Raw bytes therefore remain meaningful even when transfer compression looks favorable.

The existing `npm run benchmark:nature` record predates the spatial layout. It measures search and process memory, not spatial-index fetch, cell selection, request fan-out, cell hashing, least-recently-used cache behavior, or viewport rendering. A final governance rebuild and representative browser measurements must replace this provisional storage snapshot before release claims.

## Recorded Node microbenchmark

`data/benchmarks/nature-pipeline.v1.json` records 80 measured samples per corpus after three warm-up rounds, with a reused prebuilt search index and nearest-rank percentiles. It ran on Node 24.11.0/Windows x64 on a 13th Gen Intel Core i3-1315U with eight logical CPUs.

| Corpus | Entities | p50 | p95 | Maximum | 50 ms observational target |
| --- | ---: | ---: | ---: | ---: | --- |
| Recorded 4,019-entity corpus | 4,019 | 30.613 ms | 54.547 ms | 63.902 ms | Miss |
| Deterministic synthetic active region | 5,000 | 33.697 ms | 48.310 ms | 59.436 ms | Within target |

The recorded corpus result is the release-relevant warning: it misses the target on this machine. The synthetic result does not cancel that miss. Timing is observational and deliberately does not fail the build because runtime/hardware noise has not yet been bounded.

Process-memory snapshots are also observational. Loading the recorded corpus increased RSS by 64,823,296 bytes and used heap by 42,667,632 bytes from baseline; building its search index added 85,696,512 RSS bytes and 34,662,296 used-heap bytes from the loaded state. The total benchmark, after retaining both recorded and synthetic work, ended 226,357,248 RSS bytes and 138,161,200 used-heap bytes above baseline. These are V8 process snapshots without forced garbage collection, not browser peak/retained-heap results.

## Authored nature budgets

`tools/nature/build.mjs` writes these values into the manifest:

| Budget | Value | Current evidence |
| --- | ---: | --- |
| Manifest | 64,000 bytes | Provisional manifest is 6,313 bytes; builder enforces the gate. |
| Regional shard | 2,500,000 bytes | All 10 transitional shards pass; provisional largest is 2,498,752 bytes. |
| Spatial index | 2,000,000 bytes | Provisional content-addressed index is 49,200 bytes; builder enforces the gate. |
| Spatial cell package | 1,000,000 bytes | All 164 provisional packages pass; largest is 800,307 bytes. |
| Initial nature data | 64,000 bytes | The 6,313-byte provisional manifest is the only startup nature artifact; representative browser startup is unmeasured. |
| Search p95 | 50 ms | Recorded Node p95 54.547 ms misses; synthetic 5,000-entity p95 48.310 ms passes. Both are observational. |
| Map interaction p95 | 100 ms | Not measured. |
| Visible point features | 5,000 | UI helper caps at 5,000 and defaults to 500; field rendering performance is unmeasured. |
| Visible route features | 1,000 | UI helper caps at 1,000 and defaults to 180; field rendering performance is unmeasured. |

Manifest, initial nature data, regional-shard, spatial-index, and spatial-cell raw bytes are executable deterministic gates. The UI caps visible features, but latency, request count, total transfer, parsing, hashing, retained memory, and rendering are not enforced end to end. Representative browser benchmarks must close those gaps before field-performance claims.

## Likely hotspots

### Regional load and integrity

The current Discover UI calls `RegionalPackageLoader.loadRegion`, which fetches every shard for a requested logical region concurrently, parses each JSON document, recursively canonicalizes/sorts object keys to recompute SHA-256, merges/deduplicates entities, and recursively freezes the logical package set. During a large load this can hold several parsed shards, canonical strings, and the merged entity array concurrently. A successful logical region remains in the in-memory cache for the page lifetime.

Measure per-shard fetch/parse/hash, logical merge/freeze, cache hit, total-region time, and peak heap separately. Regional results provide the transition baseline against which spatial delivery must be compared.

### Spatial viewport load and integrity

The implemented `loadViewport` API lazily fetches the content-addressed z8 index, selects populated cells intersecting `[west, south, east, north]`, and fetches their package shards. It treats `west > east` as a dateline-crossing viewport, rejects requests above the default 64-cell or 128-package caps, validates exact bytes/hash/identity, deduplicates stable IDs, and retains up to 128 verified logical cells in a least-recently-used cache.

This path is not yet the UI default and has no representative-device measurements. Record index fetch/parse/hash, selected and fetched cell/package counts, cache hit/eviction, duplicate entity count, package fetch/parse/hash, logical merge/freeze, abort/retry, main-thread work, peak/retained heap, and pan-to-render latency. Compare cold, warm, adjacent, cross-border, and dateline viewports with explicit regional loading. Consider worker-side parsing/hashing or compact generated delivery fields only after measurement; any optimization must preserve descriptive canonical artifacts, deterministic verification, and evidence geometry.

### Search and discovery

`searchEntities` builds or scans one document per entity and sorts matches. Trigram sets improve fuzzy relevance but add allocation and memory. `rankDiscovery` scores and sorts every eligible entity. Cache search documents per loaded shard; debounce input; benchmark empty, prefix, multilingual/diacritic, category, and distance-filter queries. Do not reduce accessibility by delaying or withholding textual results that the map already shows.

### Map rendering

The legacy custom WebGL overlay, clustering, collision/deconfliction, labels, and DOM side panels share the main thread with JSON/search work. Benchmark pan, zoom, filter, selection, sidebar update, and route rendering at the authored point/line limits and above-limit refusal behavior. Count source features, rendered features, draw calls, buffer uploads, DOM nodes, long tasks, and dropped frames.

Routes need level-of-detail rendering for overview while retaining original geometry for detail/export. Never overwrite the evidence geometry with a display simplification.

### Build-time algorithms

Near-duplicate reporting compares pairs within same-type/same-primary-name point buckets and can become quadratic for a pathological bucket. Canonical JSON serialization and stable sorting are linear-to-log-linear in artifact size. Build benchmarks should include high-collision names, many cross-region records, long routes, and source failure cases.

### Legacy planner initialization

The WASM shim fetches and parses the leisure graph and initializes WASM on demand. Keep it lazy. Do not eagerly load all nature packages alongside graph/WASM. Measure cold and warm graph/WASM initialization, first plan, repeated plan, routing calls, and memory release/handle lifecycle.

## Spatial cells and transitional regional delivery

The builder retains deterministic regional shards with a 2,500,000-byte raw limit and now also builds a fixed z8 spatial layout. Points occupy one cell; lines and polygons occupy the cells of their minimal antimeridian-aware bounding box. An entity that would fan out to more than 4,096 cells fails the build. Spatial cells are independently byte-sharded at 1,000,000 bytes, and their separate content-addressed index is limited to 2,000,000 bytes.

The spatial layout provides fetch-only-intersecting behavior through the loader API. It preserves:

- stable canonical entity IDs and cross-shard references;
- jurisdiction and attribution aggregation;
- manifest integrity and content addressing;
- fetch-only-needed behavior and abort/retry semantics;
- deterministic package membership;
- cross-border route discoverability without loading the world;
- loader compatibility/versioning and deduplication.

The current UI still explicitly loads complete logical regions, so the new path is an API/scaling foundation rather than evidence of viewport-default product performance. Regional packages remain transitional and duplicate most delivery bytes. Measure request overhead, total transfer, parse/hash/merge cost, cache churn, memory, and interaction latency before switching the UI or retiring regional packages.

## Measurement protocol

Use a clean production-like static build served over HTTPS or localhost HTTP, not `file://`. Record commit, manifest `buildId`, browser/runtime, OS, CPU/memory class, viewport, network profile, cold/warm cache, loaded regions, entity/vertex counts, and routing provider fixture.

For each scenario:

1. warm up outside the recorded sample;
2. run enough repetitions to report median, p75, p95, maximum, and failure count;
3. record main-thread long tasks and peak/retained heap;
4. separate network, decode/parse, integrity, indexing, render, and interaction time;
5. use deterministic local routing fixtures for UI benchmarks, then separately measure real upstream SLOs;
6. include keyboard and screen-reader interaction paths, reduced motion, 200% zoom, and low-end/mobile hardware;
7. retain raw results as a versioned CI artifact.

Representative scenarios should include:

- shell first render without nature data;
- manifest load and failure/retry;
- smallest and largest region cold load as the transition baseline;
- cold/warm spatial-index load and index corruption/byte/hash refusal;
- one-cell, adjacent-cell, cross-border, empty, and `west > east` dateline viewports;
- viewport cap refusal at more than 64 cells or 128 packages and configurable lower limits;
- 128-cell least-recently-used eviction, repeated-pan cache hits, abort/retry, and cross-cell entity deduplication;
- search-as-you-type in local script, romanization, English, diacritics, and no-result cases;
- filters/ranking for famous and lesser-known places;
- pan/zoom/filter at 1k, 5k, and over-budget points plus 100, 1k, and over-budget lines;
- complete long route selection, five-section detail rendering, metadata-rich GeoJSON export, current-corpus GPX refusal, and mixed-mode itinerary rendering;
- WASM leisure planner cold/warm planning;
- routing success, no-route, timeout, and profile unavailable.

## Current CI and remaining performance gates

The current GitHub Actions test job runs the deterministic nature build, fails on generated nature-artifact drift, runs the full Node test suite, rebuilds/diffs the legacy bundle and HTML reference, and runs the deterministic production site packager. The builder enforces manifest, initial-nature-data, regional-shard, spatial-index, and spatial-cell raw-byte limits. The site packager validates its explicit runtime allowlist and referenced nature packages, enforces the 25 MiB hosting limit per file, and emits a hashed manifest.

CI does not currently run `npm run benchmark:nature`, a representative browser benchmark, or a deployment smoke against a real routing upstream. Remaining performance work is to:

1. report compressed bytes and largest entities/routes as CI diagnostics;
2. add stable browser search, load, map, and mixed-itinerary benchmarks with regression tolerances;
3. exercise the visible-feature limits and intentional over-limit behavior;
4. record parse/hash/freeze/index/render timings and peak/retained browser heap;
5. upload benchmark JSON and raw browser traces for review.

Do not make a slow shared routing service part of deterministic performance CI.

## Optimization order

1. Keep the wired UI behind its explicit regional-load boundary until the spatial path has representative correctness and performance evidence; avoid eager index or package loads.
2. Keep deterministic nature build/diff and site packaging green for both layouts while measuring their duplicate storage and deployment cost.
3. Benchmark and then integrate the existing viewport loader, including request caps, dateline behavior, cross-cell deduplication, and least-recently-used cache churn.
4. Cache/search-index only loaded entities, move expensive package integrity/index work off the main thread if measurements justify it, and add level-of-detail route rendering.
5. Split the legacy application/data bundle so data invalidation does not invalidate UI code.
6. Measure before minification/compact encoding; then choose changes by peak memory and user latency, not repository bytes alone.
7. Re-test accessibility and correctness after every rendering/indexing optimization.

## What is not yet known

No representative field-device/browser p95 results, Core Web Vitals, browser peak/retained heap, spatial index/cell parse/hash timings, request-overhead curve, 128-cell cache-hit/eviction ratio, pan-to-render distribution, WebGL map frame-time distribution, real routing SLO, CDN Brotli sizes, or representative integrated mixed-mode UI metrics are committed. The Node measurements and provisional filesystem bytes above do not fill those gaps. These omissions are release risks to close, not values to infer from the current code.
