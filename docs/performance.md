# Performance baseline, budgets, and measurement

## Interpretation

This document separates observed bytes from authored budgets. Filesystem and gzip sizes do not prove startup, interaction, memory, or field performance. The committed Node microbenchmark is useful engineering evidence, but it is not representative-device or browser evidence. Its current-corpus indexed-search p95 is 54.547 ms and misses the observational 50 ms target; its deterministic 5,000-entity synthetic p95 is 48.310 ms. No current measurement demonstrates the 50 ms search p95 or 100 ms map-interaction p95 budgets on representative field devices.

The original repository baseline was inspected on 2026-07-25 at commit `5bd7636bbdca09bce6a5b36f5825cd7a331da9de`. Nature-package measurements below describe deterministic build `2413863cfdeb500c`, generated on 2026-07-26.

## Legacy baseline bytes

| Artifact | Uncompressed bytes | `gzip -c` bytes | Notes |
| --- | ---: | ---: | --- |
| `assets/js/itinera.bundle.js` | 2,369,929 | 645,649 | Concatenates 15 sources, including all legacy regional arrays. |
| `assets/data/leisure-graph.v1.json` | 2,989,132 | 364,454 | Loaded by the WASM leisure planner when enabled. |
| `assets/wasm/leisure-core/leisure_core_bg.wasm` | 969,295 | 366,551 | WASM is already a binary; transfer compression gain depends on server/browser. |
| vendored `maplibre-gl.js` | 939,308 | 248,608 | Loaded by `index.html`. |
| vendored `maplibre-gl.css` | 69,422 | 10,038 | Loaded by `index.html`. |
| `assets/css/site.css` | 154,270 | 31,004 | Loaded by `index.html`. |

`assets/js/app.js` alone is 11,378 lines and 464,442 uncompressed bytes. Repository storage is approximately 106.6 MB for the current working tree excluding `.git`, `target`, and `node_modules`; about 63.8 MB is under `assets/ui-icons/`. Repository storage is relevant to cloning and CI but is not equal to page transfer.

The current `index.html` loads `assets/js/nature/app.mjs` and its ES-module dependencies and presents Discover as the default tab. Nature data remains lazy: the loader fetches only `manifest.v1.json` during initialization and fetches a logical region only after explicit user activation. The JavaScript module graph, legacy bundle, map shell, CSS, and other page assets are therefore part of startup even though regional nature JSON is not. A representative browser startup/network profile has not yet been recorded.

## Nature package measurements

Build `2413863cfdeb500c` contains 4,019 valid records and 10 shard entries. The manifest is 6,026 bytes uncompressed and 1,715 bytes using the committed Node level-9 gzip measurement. Both adapters succeeded. The price migration matched all 313 cache records, with no unmatched keys.

The quality report has zero invalid records, six near-duplicate candidates, 3,701 records with unknown legal access, and 1,436 with missing attribution. The sensitivity delivery report publishes all 4,019 records and withholds/coarsens none, but 2,202 records retain `sensitivity_not_assessed`; zero withheld is not evidence of completed sensitivity review.

| Logical region | Shards | Entities | Total raw bytes | Largest shard | Total gzip level-9 bytes | Per-shard 2.5 MB gate |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| EU/Alps | 4 | 2,413 | 8,023,760 | 2,498,351 | 607,447 | Pass |
| Japan | 2 | 1,050 | 4,466,990 | 2,498,119 | 378,683 | Pass |
| North America | 1 | 4 | 6,682 | 6,682 | 1,683 | Pass |
| Norway | 1 | 4 | 5,921 | 5,921 | 1,547 | Pass |
| Switzerland | 1 | 305 | 1,382,757 | 1,382,757 | 104,832 | Pass |
| UK/Ireland | 1 | 243 | 787,764 | 787,764 | 59,778 | Pass |

The package sum is 14,673,874 uncompressed bytes and 1,153,970 gzip bytes. All generated nature reports, manifest, redirects, and packages occupy 14,986,415 filesystem bytes.

Every individual shard passes the enforced raw limit, but selecting EU/Alps still fetches four shards totalling about 8.02 MB decoded JSON; selecting Japan fetches two totalling about 4.47 MB. Byte sharding controls per-document size and permits concurrent integrity checks. It does not yet reduce total logical-region transfer or retained entities.

High compression reflects repeated JSON field names and provenance, but the browser still allocates decoded JSON, parsed objects, canonicalized JSON for hashing, and deep-frozen object graphs. The uncompressed totals therefore remain meaningful even when network transfer looks modest.

The committed measurements are reproducible with:

```sh
npm run benchmark:nature
```

The benchmark uses Node `zlib` gzip level 9. It is not a substitute for measuring the production CDN encoding; Brotli was not measured.

## Recorded Node microbenchmark

`data/benchmarks/nature-pipeline.v1.json` records 80 measured samples per corpus after three warm-up rounds, with a reused prebuilt search index and nearest-rank percentiles. It ran on Node 24.11.0/Windows x64 on a 13th Gen Intel Core i3-1315U with eight logical CPUs.

| Corpus | Entities | p50 | p95 | Maximum | 50 ms observational target |
| --- | ---: | ---: | ---: | ---: | --- |
| Current build | 4,019 | 30.613 ms | 54.547 ms | 63.902 ms | Miss |
| Deterministic synthetic active region | 5,000 | 33.697 ms | 48.310 ms | 59.436 ms | Within target |

The current result is the release-relevant warning: it misses the target on this machine. The synthetic result does not cancel that miss. Timing is observational and deliberately does not fail the build because runtime/hardware noise has not yet been bounded.

Process-memory snapshots are also observational. Loading the current corpus increased RSS by 64,823,296 bytes and used heap by 42,667,632 bytes from baseline; building its index added 85,696,512 RSS bytes and 34,662,296 used-heap bytes from the loaded state. The total benchmark, after retaining both current and synthetic work, ended 226,357,248 RSS bytes and 138,161,200 used-heap bytes above baseline. These are V8 process snapshots without forced garbage collection, not browser peak/retained-heap results.

## Authored nature budgets

`tools/nature/build.mjs` writes these values into the manifest:

| Budget | Value | Current evidence |
| --- | ---: | --- |
| Manifest | 64,000 bytes | 6,026 bytes; builder enforces the gate. |
| Regional shard | 2,500,000 bytes | All 10 shards pass; largest is 2,498,351 bytes. Builder enforces this limit. |
| Initial nature data | 64,000 bytes | 6,026-byte manifest only; builder/benchmark enforce this artifact gate, but representative browser startup is unmeasured. |
| Search p95 | 50 ms | Current Node p95 54.547 ms misses; synthetic 5,000-entity p95 48.310 ms passes. Both are observational. |
| Map interaction p95 | 100 ms | Not measured. |
| Visible point features | 5,000 | UI helper caps at 5,000 and defaults to 500; field rendering performance is unmeasured. |
| Visible route features | 1,000 | UI helper caps at 1,000 and defaults to 180; field rendering performance is unmeasured. |

Manifest, initial nature data, and regional-shard raw bytes are executable deterministic gates. The UI caps visible features, but latency, total-region transfer, parsing, hashing, retained memory, and rendering are not enforced end to end. Representative browser benchmarks must close those gaps before field-performance claims.

## Likely hotspots

### Regional load and integrity

`RegionalPackageLoader` fetches every shard for a requested logical region concurrently, parses each JSON document, recursively canonicalizes/sorts object keys to recompute SHA-256, merges/deduplicates entities, and recursively freezes the logical package set. During a large load this can hold several parsed shards, canonical strings, and the merged entity array concurrently. A successful logical region remains in the in-memory cache for the page lifetime.

Measure per-shard fetch/parse/hash, logical merge/freeze, cache hit, total-region time, and peak heap separately. Consider worker-side parsing/hashing, viewport/query-aware shards, compact generated delivery fields, or an integrity format that does not require reserializing multi-megabyte objects on the main thread. Any compact format must preserve the descriptive canonical source artifacts and deterministic verification.

### Search and discovery

`searchEntities` builds or scans one document per entity and sorts matches. Trigram sets improve fuzzy relevance but add allocation and memory. `rankDiscovery` scores and sorts every eligible entity. Cache search documents per loaded shard; debounce input; benchmark empty, prefix, multilingual/diacritic, category, and distance-filter queries. Do not reduce accessibility by delaying or withholding textual results that the map already shows.

### Map rendering

The legacy custom WebGL overlay, clustering, collision/deconfliction, labels, and DOM side panels share the main thread with JSON/search work. Benchmark pan, zoom, filter, selection, sidebar update, and route rendering at the authored point/line limits and above-limit refusal behavior. Count source features, rendered features, draw calls, buffer uploads, DOM nodes, long tasks, and dropped frames.

Routes need level-of-detail rendering for overview while retaining original geometry for detail/export. Never overwrite the evidence geometry with a display simplification.

### Build-time algorithms

Near-duplicate reporting compares pairs within same-type/same-primary-name point buckets and can become quadratic for a pathological bucket. Canonical JSON serialization and stable sorting are linear-to-log-linear in artifact size. Build benchmarks should include high-collision names, many cross-region records, long routes, and source failure cases.

### Legacy planner initialization

The WASM shim fetches and parses the leisure graph and initializes WASM on demand. Keep it lazy. Do not eagerly load all nature packages alongside graph/WASM. Measure cold and warm graph/WASM initialization, first plan, repeated plan, routing calls, and memory release/handle lifecycle.

## Current byte sharding and next scaling gate

The builder sorts each logical region by stable entity ID and deterministically packs the largest prefixes that fit 2,500,000 raw bytes. Each file declares contiguous zero-based `shardIndex`/`shardCount`, and the build fails if even one entity cannot fit. The loader validates all advertised identities and hashes, fetches all shards concurrently, rejects conflicting duplicate IDs, and returns one logical package set.

This makes the per-file gate green, but it is not viewport/query sharding. A further partition evolution must preserve:

- stable canonical entity IDs and cross-shard references;
- jurisdiction and attribution aggregation;
- manifest integrity and content addressing;
- fetch-only-needed behavior and abort/retry semantics;
- deterministic package membership;
- cross-border route discoverability without loading the world;
- loader compatibility/versioning and deduplication.

Potential next-level partition keys are logical delivery region plus stable spatial cells, with small indexes and dedicated route shards where necessary. Do not shard solely by source if a viewport/query would then require every source package. Measure request overhead against total transfer, parse, merge, and memory savings.

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
- smallest and largest region cold load;
- two adjacent/cross-border shards and entity deduplication;
- search-as-you-type in local script, romanization, English, diacritics, and no-result cases;
- filters/ranking for famous and lesser-known places;
- pan/zoom/filter at 1k, 5k, and over-budget points plus 100, 1k, and over-budget lines;
- complete long route selection and mixed-mode itinerary rendering;
- WASM leisure planner cold/warm planning;
- routing success, no-route, timeout, and profile unavailable.

## Current CI and remaining performance gates

The current GitHub Actions test job runs the deterministic nature build, fails on generated nature-artifact drift, runs the full Node test suite, rebuilds/diffs the legacy bundle and HTML reference, and runs the deterministic production site packager. The builder enforces manifest, initial-nature-data, and per-shard raw-byte limits. The site packager validates its explicit runtime allowlist and referenced nature packages, enforces the 25 MiB hosting limit per file, and emits a hashed manifest.

CI does not currently run `npm run benchmark:nature`, a representative browser benchmark, or a deployment smoke against a real routing upstream. Remaining performance work is to:

1. report compressed bytes and largest entities/routes as CI diagnostics;
2. add stable browser search, load, map, and mixed-itinerary benchmarks with regression tolerances;
3. exercise the visible-feature limits and intentional over-limit behavior;
4. record parse/hash/freeze/index/render timings and peak/retained browser heap;
5. upload benchmark JSON and raw browser traces for review.

Do not make a slow shared routing service part of deterministic performance CI.

## Optimization order

1. Keep the wired nature flow behind its explicit regional-load boundary; avoid eager package loads.
2. Keep deterministic nature build/diff and site packaging green; evolve byte shards toward viewport/query-aware loading based on measurements.
3. Cache/search-index only loaded entities and move expensive package integrity/index work off the main thread if measurements justify it.
4. Add viewport-aware spatial indexing and level-of-detail route rendering.
5. Split the legacy application/data bundle so data invalidation does not invalidate UI code.
6. Measure before minification/compact encoding; then choose changes by peak memory and user latency, not repository bytes alone.
7. Re-test accessibility and correctness after every rendering/indexing optimization.

## What is not yet known

No representative field-device/browser p95 results, Core Web Vitals, browser peak/retained heap, JSON parse/hash timings, WebGL map frame-time distribution, real routing SLO, CDN Brotli sizes, cache-hit ratio, or representative integrated mixed-mode UI metrics are committed. The Node measurements above do not fill those gaps. These omissions are release risks to close, not values to infer from the current code.
