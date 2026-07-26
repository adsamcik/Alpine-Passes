# Itinera / Alpine Passes

Itinera is a MapLibre nature-travel discovery and trip-planning application that retains its original mountain-pass, scenic-drive, and curated-sight planner. The default Discover experience now uses a provenance-aware canonical model, viewport-loaded spatial cells, evidence-aware ranking, complete route geometries where governed data exists, and explicit mixed-mode itinerary legs.

## Preview and safety boundary

`index.html` exposes the nature experience as its default Discover tab. The nature-data bootstrap loads the small manifest, then map attachment loads its content-addressed spatial index and only populated cells intersecting the visible viewport. A user may explicitly activate **Explore region** to search all advertised records in one delivery partition; viewport failure never starts that larger load automatically. Textual and map results share one eligible record set, expose access/evidence/uncertainty, draw route and access geometry, and refuse unsupported itinerary or download operations instead of silently filling gaps. The legacy Plan and Browse experiences remain available during migration.

The generated public nature inventory is not a claim of complete country or category coverage. Across 206 jurisdiction registry entries, current overall statuses remain authored as 190 **Unknown** and 16 **Excluded, with reason**; none is **Verified broad coverage** or **Verified partial coverage**. One exact hash-pinned six-segment NPS snapshot emits the verified Harding Icefield route plus its access point. The default build processes 4,019 candidate records but withholds all 4,017 records that reference an unapproved source. Scotland has researched source leads and a dedicated jurisdiction model, but no approved public nature record. Conditions, permits, schedules, parking rules, and legal access can change and must be checked with current local authorities.

Production car, foot, and hiking connectors require separately configured first-party routing upstreams; none are configured by the repository. The public OSRM demo is restricted to explicit local/non-production use. Timed transit/ferry/cable legs fail closed unless exact current verified schedule, geometry, endpoint, timezone, and provenance data support them. There is no scheduled nature refresh and no field safety certification.

## Quick start

Prerequisites: Node.js 24.x and Python 3. Rust/WASM tooling is needed only when rebuilding the leisure core.

```sh
python tools/dev_server.py --no-open
```

Open `http://127.0.0.1:8765/index.html`.

Build the canonical nature artifacts, legacy JS bundle, and deterministic production package:

```sh
npm run build
```

Run focused nature and full Node tests:

```sh
npm run test:nature
npm test
```

Run the observational Node benchmark separately:

```sh
npm run benchmark:nature
```

For Rust/WASM changes, also run:

```sh
cargo fmt --package leisure-core -- --check
cargo build --package leisure-core
cargo test --package leisure-core --tests
npm run verify:wasm-hash
npm run check:wasm-size
```

The current deterministic public nature build is `502fbdf646728ce8`: two valid NPS records, zero invalid records or adapter failures, one 236,785-byte North America regional package, and one 236,806-byte fixed zoom-8 cell package. The manifest is 1,374 bytes and the spatial index is 514 bytes. Three adapters still process 3,992 legacy records, two NPS outputs, and 25 non-superseded seeds so migration drift is measurable; the release gate withholds 4,017 records for source-rights review and strips all 1,436 uncleared media items. All 313 legacy price-cache records match exactly, but none enters the public nature packages.

The public sensitivity report processes and publishes the two governed NPS records without coarsening. The rights gate runs before public sensitivity delivery, so the 4,017 candidates are not silently treated as sensitivity-approved. A non-release preview can be built only with `node tools/nature/build.mjs --include-unapproved-previews`; it marks its exact source notice `releaseEligible: false` and must not be promoted.

`npm run build:site` packages an explicit runtime allowlist into `dist/client`, copies the Fetch-compatible worker to `dist/server/index.js`, validates local HTML/CSS/manifest references including the exact source-release notice and the 25 MiB per-file hosting limit, and writes a deterministic hashed `dist/build-manifest.json`. CI rebuilds and diffs nature artifacts and the legacy bundle, runs the full Node/Rust checks, and exercises this site packager. These are build-quality and delivery results, not coverage, safety, whole-site licence clearance, accessibility, representative-browser performance, or field certification. The retained legacy bundle lies outside the generated nature source-release notice and needs separate clearance or exclusion before a public promotion.

The deterministic release Chromium smoke passes 22 assertions. It covers the 1,888-byte manifest-plus-index load for an empty Alpine viewport, refusal to fetch a non-intersecting cell, synchronized accessible map/text results, the readable Harding detail, safe GeoJSON/GPX export, a verified mixed-mode journey, keyboard behavior, 390 px reflow, exact layer restoration after a style reload, and zero page/console errors. It is not a representative-device performance or assistive-technology conformance result.

## Documentation

- [Baseline architecture audit](docs/architecture/baseline-audit.md)
- [Coverage matrix](docs/data/coverage-matrix.md)
- [Nature-travel taxonomy](docs/taxonomy/nature-travel-taxonomy.md)
- [Ingestion and delivery](docs/ingestion.md)
- [Contributing data](docs/contributing-data.md)
- [Licensing and attribution](docs/data/licensing-and-attribution.md)
- [Operations and release runbook](docs/operations.md)
- [Performance baseline and budgets](docs/performance.md)
- [Territorial scope](docs/data/territorial-scope.md)
- [Data source policy](docs/data/source-policy.md)
