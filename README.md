# Itinera / Alpine Passes

Itinera is a MapLibre nature-travel discovery and trip-planning application that retains its original mountain-pass, scenic-drive, and curated-sight planner. The default Discover experience now uses a provenance-aware canonical model, explicitly loaded regional packages, evidence-aware ranking, complete route geometries where established data exists, and mixed-mode itinerary composition.

## Preview and safety boundary

`index.html` now exposes the nature experience as its default Discover tab. Startup loads only the small nature manifest; a regional package is fetched after the user activates **Explore region**. Results have a textual alternative to the map, expose access/evidence/uncertainty, draw route and access geometry, and refuse unsafe or unsupported itinerary/GPX operations instead of silently filling gaps. The legacy Plan and Browse experiences remain available during migration.

The generated inventory is not a claim of complete country or category coverage. Across 206 registry entries, current overall statuses remain authored as 190 **Unknown** and 16 **Excluded, with reason**; a non-zero record count never upgrades one. No broad official-source ingestion has been approved or implemented. Most migrated access facts remain unknown, and the maintainer seed routes are generalized and unverified; eight are explicitly not navigation-grade. Conditions, permits, schedules, parking rules, and legal access can change and must be checked with current local authorities.

Production car, foot, and hiking connectors require separately configured first-party routing upstreams; none are configured by the repository. The public OSRM demo is restricted to explicit local/non-production use, and the worker is not a transit timetable planner. There is no scheduled nature refresh and no field safety certification.

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

The current deterministic nature build is `2413863cfdeb500c`: 4,019 valid records, zero invalid records or adapter failures, 10 regional shards, a 6,026-byte manifest, and a largest shard of 2,498,351 bytes against a 2,500,000-byte limit. The quality report still records 3,701 records with unknown legal access, 1,436 with missing attribution, six near-duplicate candidates, eight complete established route geometries, and 30 scenic-route overview geometries. All 313 legacy price-cache records matched exactly.

The sensitivity delivery report currently publishes all 4,019 records and withholds or coarsens none, while 2,202 records retain the `sensitivity_not_assessed` flag. That is a transparent inventory state, not evidence that all locations passed ecological or cultural sensitivity review.

`npm run build:site` packages an explicit runtime allowlist into `dist/client`, copies the Fetch-compatible worker to `dist/server/index.js`, validates all local HTML/CSS/manifest references and the 25 MiB per-file hosting limit, and writes a deterministic hashed `dist/build-manifest.json`. CI rebuilds and diffs nature artifacts and the legacy bundle, runs the full Node/Rust checks, and exercises this site packager. These are build-quality and delivery results, not coverage, safety, licence, accessibility, representative-browser performance, or field certification.

The final local verification run passed all 193 Node tests and all 18 nature Playwright smoke scenarios. The browser smoke covers manifest-only startup, explicit Scotland loading, filters, route selection, GPX safety, keyboard behavior, 390 px reflow, exact layer restoration after a style reload, and zero page/console errors. It is not a representative-device performance or assistive-technology conformance result.

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
