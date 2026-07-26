# Performance baseline, budgets, and measurement

## Interpretation

This document separates deterministic release bytes from observational timing. Filesystem and local gzip sizes do not prove startup, interaction, memory, or field performance. The current governed public nature build is `502fbdf646728ce8`: it delivers exactly two records, one complete governed route and its access point. It does not publish the candidate migration inventory.

The committed Node microbenchmark records a 0.034 ms indexed-search p95 for the two-record public release and a 21.037 ms p95 for a deterministic 5,000-entity synthetic region. Both are within the authored 50 ms observational target on the recorded Node environment. Neither result is a browser, representative-device, map, or end-to-end performance result. Map-interaction p95, browser heap, and Core Web Vitals remain unmeasured.

## Release scope

The default release withholds 4,017 unverified candidate records from public delivery. Governance also removed 1,436 media items whose source and per-file rights did not pass the publication gate. The public source-release notice names one approved source, zero media items, and two delivered entities. Candidate records remain migration/research inputs; their package sizes, route counts, and search timings are not public-release metrics.

The public route corpus contains one complete governed route. Performance statements below therefore describe release delivery mechanics and a very small public corpus, not geographic coverage, continental scale, route-network completeness, or field suitability.

## Original shell baseline

The original repository baseline was inspected on 2026-07-25 at commit `5bd7636bbdca09bce6a5b36f5825cd7a331da9de`. These values are retained only as pre-redesign shell context; they are not nature-release package measurements.

| Artifact | Uncompressed bytes | Local `gzip -c` bytes | Context |
| --- | ---: | ---: | --- |
| `assets/js/itinera.bundle.js` | 2,369,929 | 645,649 | Legacy concatenated application and regional arrays at the inspected baseline. |
| `assets/data/leisure-graph.v1.json` | 2,989,132 | 364,454 | Loaded lazily by the WASM leisure planner. |
| `assets/wasm/leisure-core/leisure_core_bg.wasm` | 969,295 | 366,551 | Committed optimized WebAssembly artifact. |
| Vendored `maplibre-gl.js` | 939,308 | 248,608 | Map engine loaded by the application shell. |
| Vendored `maplibre-gl.css` | 69,422 | 10,038 | Map engine stylesheet. |
| `assets/css/site.css` | 154,270 | 31,004 | Application stylesheet at the inspected baseline. |

The current shell still loads the legacy bundle, MapLibre, CSS, and the nature ES-module graph. Nature initialization fetches the manifest; map attachment then loads the content-addressed spatial index and only cell packages intersecting the visible viewport. A user can explicitly activate a delivery partition for partition-wide search. Viewport failure never starts that larger load automatically. A representative browser startup/network profile has not been recorded.

## Current governed release measurements

All values in this section refer to build `502fbdf646728ce8` and the checked-in release tree under `assets/data/nature/`.

| Artifact group | Objects | Raw bytes | Local gzip bytes | Release observation |
| --- | ---: | ---: | ---: | --- |
| Manifest | 1 | 1,374 | 746 | Within the 64,000-byte deterministic gate. |
| Spatial index | 1 | 514 | 331 | One populated z8 cell and one package reference. |
| Spatial cell packages | 1 | 236,806 | Not recorded | One byte-bounded package for the two public entities. |
| Retained regional packages | 1 | 236,785 | 76,966 | One North America shard for explicit partition search and compatibility use. |
| Entire generated nature tree | 10 | 651,524 | Not recorded as one transfer | Includes both delivery layouts, reports, redirects, and the source-release notice. |

The active index is `assets/data/nature/spatial/index/8a63b90488ae497c.json`. Its only cell, `8/21/74`, references `assets/data/nature/spatial/cells/8/21/74/c23aca411a385509.json`. The retained regional package is `assets/data/nature/packages/north-america/5ce8bb3b81dad269.json`.

The fixed initial nature-data components are the 1,374-byte manifest and 514-byte spatial index: 1,888 raw bytes, or 1,077 bytes under the benchmark's local gzip level-9 measurement. The deterministic upper bound is 8,001,888 raw bytes after adding the loader-enforced 8,000,000-byte viewport package ceiling. That remains below the 10,064,000-byte initial-nature-data budget.

The deterministic Chromium release smoke starts on an empty Alpine viewport. It requests only the manifest and spatial index, for exactly 1,888 unique raw nature bytes; no public cell intersects that viewport. This is a functional request-scope and byte-accounting result. It is not a populated-viewport result, compressed production transfer, latency distribution, representative-device p95, browser-heap measurement, or Core Web Vitals report.

Regional and spatial layouts intentionally duplicate the two public entities because they serve different product paths. This duplication is visible in repository/deployment storage, but it is not an instruction to download both layouts during normal viewport use. Local gzip does not predict CDN Brotli size, cache behavior, or transfer latency.

## Recorded Node microbenchmark

`data/benchmarks/nature-pipeline.v1.json` records 80 measured samples per corpus after three warm-up rounds. Search documents are indexed once and reused; percentiles use nearest-rank selection. The run used Node 24.11.0 on Windows x64, on a 13th Gen Intel Core i3-1315U with eight logical CPUs.

| Corpus | Entities | p50 | p95 | Maximum | 50 ms observational target |
| --- | ---: | ---: | ---: | ---: | --- |
| Governed public release | 2 | 0.021 ms | 0.034 ms | 0.638 ms | Within target; too small to establish scale |
| Deterministic synthetic active region | 5,000 | 11.713 ms | 21.037 ms | 35.301 ms | Within target on the recorded Node environment |

Timing is observational and does not fail the build. The synthetic fixture stresses multilingual searchable records but not complex route geometry, media decoding, vector-tile rendering, network transfer, map interaction, or routing. It is useful regression evidence, not proof of continental scalability.

Process-memory observations from the same report are:

| Transition | RSS delta | Used-heap delta | Interpretation |
| --- | ---: | ---: | --- |
| Load two-record public corpus from baseline | 2,068,480 bytes | 986,640 bytes | Includes file parsing and V8 allocator effects. |
| Build public search index after corpus load | 368,640 bytes | 115,048 bytes | Observational cost for two records. |
| Build 5,000-entity synthetic index | 99,491,840 bytes | 38,786,728 bytes | Does not include browser map or network work. |
| Final benchmark state from baseline | 107,425,792 bytes | 44,226,856 bytes | Retains benchmark work and includes allocator/GC noise. |

The benchmark does not force garbage collection. These values are Node/V8 process snapshots, not browser peak or retained heap, and they are not enforced budgets.

## Authored release budgets

`tools/nature/build.mjs` writes these values into the manifest and enforces the deterministic byte gates.

| Budget | Limit | Current governed-release evidence |
| --- | ---: | --- |
| Manifest | 64,000 bytes | 1,374 bytes; enforced. |
| Regional shard | 2,500,000 bytes | One 236,785-byte shard; enforced. |
| Spatial index | 2,000,000 bytes | 514 bytes; enforced. |
| Spatial cell package | 1,000,000 bytes | One 236,806-byte package; enforced. |
| Viewport cell request | 8,000,000 bytes | Loader refuses an advertised package set above this ceiling before cell fetch. |
| Initial nature data | 10,064,000 bytes | Enforced upper bound is 8,001,888 bytes: manifest + index + viewport ceiling. |
| Search p95 | 50 ms | Public Node p95 0.034 ms; synthetic 5,000-entity p95 21.037 ms. Observational only. |
| Map interaction p95 | 100 ms | Not measured. |
| Visible point features | 5,000 | UI helper defaults to 500 and caps at 5,000; rendering performance is unmeasured. |
| Visible route features | 1,000 | UI helper defaults to 180 and caps at 1,000; rendering performance is unmeasured. |

Manifest, regional-shard, spatial-index, spatial-cell, viewport-request, and initial-data raw bytes are deterministic gates. Search timing, map latency, request overhead, JSON parsing, hashing, freezing, retained memory, and rendering remain observational or unmeasured.

## Delivery mechanics and likely hotspots

### Regional load and integrity

When a user explicitly activates a delivery partition, `RegionalPackageLoader.loadRegion` fetches all advertised shards for that partition, validates exact bytes and content hashes, parses the documents, merges/deduplicates entities, and freezes the logical package set. The current release has one shard, so it does not exercise large-partition merge pressure. Measure per-shard fetch/parse/hash, total partition time, cache hit, and peak heap before extrapolating to many shards.

### Spatial viewport load and integrity

The default `loadViewport` path lazily fetches the content-addressed fixed Web Mercator z8 index, selects populated cells intersecting `[west, south, east, north]`, and fetches their package shards. It treats `west > east` as a dateline-crossing viewport and fails closed on byte, hash, schema, artifact, cell, or shard identity errors.

One viewport call defaults to at most 64 cells, 128 packages, and 8,000,000 advertised raw package bytes. The loader retains up to 128 verified logical cells in a least-recently-used cache. A loader-wide scheduler starts no more than six cell jobs at once. Duplicate callers share jobs; aborting one subscriber does not cancel work still needed by another. Queued jobs without subscribers are removed, running orphaned jobs are aborted, package shards within one cell job are fetched sequentially, and failed or aborted jobs are not cached.

The current one-cell release verifies these mechanics but does not create representative queue, fan-out, cache-churn, cross-border, or many-cell pressure. Record cold and warm index fetch/parse/hash, selected/fetched cells and packages, duplicate entity count, abort/retry behavior, cache hits/evictions, main-thread work, peak/retained heap, and pan-to-render latency on larger approved releases.

### Search, map, build, and WASM

Search builds or scans one document per loaded entity and sorts matches; ranking scores and sorts eligible entities. Keep indexes scoped to loaded data and benchmark empty, prefix, multilingual, diacritic, category, distance, and no-result queries.

Map rendering shares the main thread with JSON, integrity, search, DOM updates, the legacy overlay, and MapLibre. Benchmark pan, zoom, filter, selection, sidebar updates, and the one governed route at and beyond the authored visible-feature limits. Add level-of-detail rendering only as a display derivative; never replace evidence geometry used for detail or export.

Near-duplicate reporting can become quadratic inside a pathological same-name/type bucket. Canonical sorting and hashing also grow with package size. Build benchmarks need high-collision names, cross-region records, long routes, and isolated source failures.

The legacy WASM planner remains lazy. Measure cold/warm graph and WASM initialization, first and repeated planning, routing calls, and resource release independently from nature-package loading.

## Measurement protocol

Use a clean production-like build served over HTTPS or localhost HTTP, not `file://`. Record commit, nature `buildId`, browser/runtime, OS, CPU and memory class, viewport, network profile, cold/warm cache, loaded partition/cells, entity and vertex counts, and routing fixture or provider.

For each scenario:

1. warm up outside the recorded samples;
2. report median, p75, p95, maximum, and failures over enough repetitions;
3. record main-thread long tasks and peak/retained heap;
4. separate network, decode/parse, integrity, indexing, render, and interaction time;
5. use deterministic local routing fixtures for UI benchmarks, then measure configured upstream SLOs separately;
6. include keyboard and screen-reader paths, reduced motion, 200% zoom, and low-end/mobile hardware;
7. retain raw results as versioned CI artifacts.

Representative scenarios should include:

- shell first render before nature data;
- manifest/index load plus failure and retry;
- empty and populated cold/warm viewports;
- adjacent-cell, cross-border, and `west > east` dateline viewports;
- refusal above 64 cells, 128 packages, or 8,000,000 advertised package bytes;
- global six-job concurrency, shared-fetch abort isolation, orphan cancellation, 128-cell LRU eviction, repeated-pan cache hits, retry, and cross-cell deduplication;
- explicit smallest/largest partition activation as the compatibility baseline;
- multilingual search and no-result queries;
- discovery filtering/ranking for famous and well-supported quieter places;
- pan/zoom/filter at 1,000 and 5,000 points and 100 and 1,000 routes, plus over-limit refusal behavior;
- full governed-route selection, five-section detail rendering, GeoJSON/GPX export, and mixed-mode itinerary rendering with deterministic routing fixtures;
- WASM planner cold/warm runs;
- routing success, no-route, timeout, and profile unavailable.

## CI and remaining performance gates

CI rebuilds the deterministic nature artifacts, fails on drift, runs Node and Rust checks, rebuilds/diffs the legacy bundle, and exercises the deterministic site packager. The nature builder enforces release byte gates; the site packager validates its runtime allowlist, referenced public nature packages, per-file hosting limit, and hashed build manifest.

CI does not run `npm run benchmark:nature`, a repeated representative-browser benchmark, or a deployment smoke against a real routing upstream. Remaining work is to:

1. add stable browser startup, search, cell-load, map, export, and mixed-itinerary benchmarks with regression tolerances;
2. exercise populated viewports and visible-feature limits with approved large fixtures;
3. record request, parse, hash, freeze, index, render, and pan-to-render timings;
4. record browser peak/retained heap, long tasks, frame-time distributions, and Core Web Vitals;
5. measure CDN encoding/cache behavior and configured routing SLOs separately;
6. upload benchmark JSON and raw browser traces for review.

Do not make a slow shared routing service part of deterministic performance CI.

## Optimization order

1. Measure the active viewport path before tuning it; retain manifest-first loading, bounded cell requests, cancellation of superseded requests, and explicit over-broad refusal.
2. Keep both deterministic delivery layouts correct while measuring their duplicate storage and distinct product roles.
3. Benchmark populated viewport fan-out, integrity work, LRU churn, cross-cell deduplication, and pan-to-render latency.
4. Cache and index only loaded entities; move expensive integrity/index work off the main thread only when measurements justify it.
5. Add route display level of detail without changing governed evidence/export geometry.
6. Split the legacy application/data bundle so data changes do not invalidate all UI code.
7. Re-test accessibility and correctness after every rendering or indexing optimization.

## What is not yet known

No representative field-device/browser p95, startup/TTI distribution, Core Web Vitals, browser peak/retained heap, populated spatial-cell parse/hash timings, many-cell request-overhead curve, 128-cell cache hit ratio, pan-to-render distribution, WebGL frame-time distribution, real routing SLO, CDN Brotli result, ingestion-duration benchmark, or representative integrated mixed-mode metric is committed. The two-record Node result, 5,000-entity synthetic search fixture, deterministic raw-byte gates, and empty-Alpine functional smoke do not fill those gaps. These are release risks to measure, not values to infer.
