# Operations and release runbook

## Operational boundary

The repository currently contains three deployable concerns:

1. the legacy static application (`index.html`, CSS, vendored MapLibre, concatenated JS, leisure graph, and WASM);
2. generated static nature artifacts (`assets/data/nature/`), including transitional regional packages plus a spatial index and spatial-cell packages;
3. an optional same-origin routing worker (`server/routing-worker.mjs`) with separately configured car, foot, and hiking upstreams.

The nature domain, discovery, itinerary, routing, and region-loader modules are implemented as ES modules and imported by `index.html`. Discover is the default sidebar tab: initialization loads only the manifest, explicit activation loads the selected logical region, and textual results, geometry, evidence, uncertainty, retry, and itinerary/refusal states coexist with the retained legacy Plan and Browse tabs.

The loader also implements fixed Web Mercator XYZ zoom-8 viewport delivery, but the UI does not call it as the default data path yet. Regional loading remains the compatibility/fallback path during transition. The current generated corpus is processed inventory, not verified geographic, thematic, access, or route completeness.

The repository now has a deterministic production site-packaging workflow. `npm run build:site` creates `dist/client`, copies the Fetch-compatible worker to `dist/server/index.js`, and emits `dist/build-manifest.json`; CI rebuilds/diffs canonical nature artifacts and the legacy bundle, runs Rust/Node/WASM checks, and exercises the site packager. Hosting promotion, credentials, routing-upstream configuration, edge controls, and production monitoring remain deployment responsibilities. There is still no scheduled nature-ingestion workflow.

## Runtime requirements

### Static origin

Serve the repository artifacts over HTTPS with correct MIME types:

- `.mjs` and `.js`: JavaScript;
- `.wasm`: `application/wasm`;
- `.json`: `application/json`;
- map/font/image assets: their specific types.

The origin must support normal byte-efficient compression for text/JSON. Do not transform content-addressed package bytes at rest; HTTP gzip or Brotli transfer encoding is safe because the loader hashes the decoded response document, not compressed transport bytes.

### Routing worker

Deploy `server/routing-worker.mjs` in a Fetch API-compatible worker runtime. If it also fronts static content, bind `env.ASSETS.fetch`. Route API requests must remain same-origin unless a reviewed CORS design is added.

The browser gateway only selects production routing when the document supplies a non-empty endpoint, for example:

```html
<meta name="itinera-routing-api" content="/api/routing/v1">
```

Without that metadata on a public hostname, `createBrowserRoutingGateway()` returns `null` and itinerary planning must show routing unavailable. On localhost only, it may construct the explicitly restricted demo adapter.

## Routing configuration

Configure each enabled profile independently. Supported environment keys are:

| Profile | Base URL | Optional upstream profile | Optional server secret |
| --- | --- | --- | --- |
| Car | `ROUTING_CAR_BASE_URL` or `ROUTING_CAR_UPSTREAM_URL` | `ROUTING_CAR_UPSTREAM_PROFILE` | `ROUTING_CAR_AUTHORIZATION` or `ROUTING_CAR_API_KEY` |
| Foot | `ROUTING_FOOT_BASE_URL` or `ROUTING_FOOT_UPSTREAM_URL` | `ROUTING_FOOT_UPSTREAM_PROFILE` | `ROUTING_FOOT_AUTHORIZATION` or `ROUTING_FOOT_API_KEY` |
| Hiking | `ROUTING_HIKING_BASE_URL` or `ROUTING_HIKING_UPSTREAM_URL` | `ROUTING_HIKING_UPSTREAM_PROFILE` | `ROUTING_HIKING_AUTHORIZATION` or `ROUTING_HIKING_API_KEY` |

Optional `<PROFILE>_PROVIDER_ID` values appear in responses. `<PROFILE>_TIMEOUT_MS` or global `ROUTING_TIMEOUT_MS` is clamped to 100–20,000 ms; default is 8,000 ms.

Use HTTPS upstreams in production. Insecure upstreams require both an explicit opt-in and a named non-production environment. The public OSRM demonstration host similarly requires `ROUTING_ALLOW_PUBLIC_OSRM_DEMO=true` and `ROUTING_ENVIRONMENT`/`ENVIRONMENT` set to `dev`, `development`, `local`, `test`, `demo`, or `preview`. Never set that exception in production.

The worker does not implement authentication for end users, per-user quotas, or edge rate limiting. Configure abuse prevention at the hosting edge before public exposure. Do not forward arbitrary browser headers to the routing upstream.

## Build and verification

Use Node 24.x, matching CI. A normal data/application release from a clean checkout is:

```sh
npm run build:nature
npm run test:nature
npm test
npm run build:bundle
git diff --exit-code -- assets/js/itinera.bundle.js index.html
npm run build:site
```

Run `npm run benchmark:nature` to refresh the observational benchmark record. Its timing/memory results do not pass or fail CI; review regressions and hardware/runtime differences explicitly.

If Rust, the WASM shim, or graph contracts changed, also run:

```sh
cargo fmt --package leisure-core -- --check
cargo build --package leisure-core
cargo test --package leisure-core --tests
npm run verify:wasm-hash
npm run check:wasm-size
```

Rebuilding WASM additionally requires the pinned Rust/WASM toolchain and Binaryen described in the CI workflows. Do not rebuild it opportunistically during an unrelated data release.

A nature build is not releasable until a reviewer inspects:

- `assets/data/nature/ingestion-report.v1.json` for adapter failures and inventory drift;
- `quality-report.v1.json` for invalid records, critical unknowns, duplicates, attribution, geometry, and access flags;
- `coverage-report.v1.json` for unchanged evidence-based statuses and caveats;
- `sensitivity-report.v1.json` for publication/coarsening/withholding outcomes without exposing restricted geometry;
- `manifest.v1.json` for regional shard indexes/counts, the content-addressed spatial-index reference, URLs, exact bytes, hashes, bounds, counts, and budgets;
- the referenced spatial index and representative cell packages for zoom/cell/package identity, byte/hash closure, and the 64-cell/128-package request assumptions;
- `legacy-id-redirects.v1.json` for unexpected identity churn;
- `THIRD_PARTY_DATA_NOTICES.md` and feature/media attribution.

The current builder fails if the manifest, initial nature-data artifact, deterministic regional shard, spatial index, spatial cell package, or one entity exceeds its applicable raw-byte budget. It also fails spatial fanout above 4,096 cells, invalid canonical records, invalid sensitivity policy, and broken delivered-reference closure. It does not turn missing attribution, unknown access, stale facts, unclear redistribution, or researched-but-unapproved sources into favorable facts. An approved `lead_only` source permits only independently authored minimal lead metadata, never copied source text, geometry, or media. Promotion must fail closed on those policy gates even when the command exits zero.

## Deterministic site package

`tools/build-site.mjs` packages only an explicit runtime allowlist plus the `.mjs` nature-module tree and content-addressed regional, spatial-index, and spatial-cell package trees. It rejects missing references, path escapes, symlinks, unexpected tree extensions, manifest URLs outside the package directory, and any file larger than the 25 MiB Sites static-asset limit. Design sources, unbundled country arrays, tests, raw data registries, and documentation are intentionally excluded from `dist/client`.

Every packaged payload file receives a byte count and SHA-256 entry in a canonical, timestamp-free `dist/build-manifest.json`; the manifest excludes itself to avoid a recursive self-hash. Identical inputs produce identical package bytes and build ID. `server/routing-worker.mjs` is copied byte-for-byte to the `dist/server/index.js` runtime contract. The worker fronts `env.ASSETS` for static content, replaces the social-metadata origin token in HTML at request time, and adds `nosniff`, `no-referrer`, frame denial, and restrictive camera/microphone permissions headers to HTML responses.

## Static release order and caching

Publish into a versioned release directory or use a host with atomic deployment promotion. The required order inside a non-atomic object store is:

1. upload all newly referenced content-addressed regional and spatial-cell packages;
2. upload the newly referenced content-addressed spatial index, reports, redirects, application bundle, graph, WASM, and other immutable/versioned artifacts;
3. verify hashes and smoke-test the staged origin;
4. publish the new manifest;
5. publish/revalidate HTML last.

Do not delete older content-addressed regional packages, spatial indexes, or cell packages during promotion. A client can hold the previous manifest or spatial index while requesting one of its objects. The local builder removes old generated package trees, so a naïve mirror with “delete extraneous files” can break those clients. Retain all referenced objects through the rollback/cache horizon or deploy each release atomically.

Regional and spatial layouts intentionally duplicate delivery payloads during transition. Include both trees in storage, upload, invalidation, backup, and CDN capacity planning; see [Performance](performance.md) for the provisional footprint and measurement gaps.

Recommended HTTP cache policy:

| Asset | Cache behavior |
| --- | --- |
| `index.html` | no-cache or short TTL with revalidation |
| `manifest.v1.json` and current reports | no-cache/short TTL with revalidation |
| content-addressed regional and spatial-cell packages | long-lived immutable |
| content-addressed spatial index | long-lived immutable |
| content-hashed bundle/WASM references | long-lived for the exact version; coordinate with HTML/shim |
| stable-name leisure graph | revalidate and release in lockstep with its consumer |
| routing responses and errors | `no-store` (already emitted by worker) |

The loader requests the manifest with `no-cache`. The current UI then fetches all shards advertised for an explicitly requested logical region with `force-cache`, verifies them, and caches only the successful merged region in memory. One failed or corrupt regional shard rejects the logical region without caching it, so a later request can retry.

For API consumers, `loadViewport([west, south, east, north])` lazily fetches the manifest-referenced zoom-8 spatial index and only populated intersecting cells with `force-cache`; `west > east` denotes a dateline-crossing viewport. Before accepting an index or cell package, the loader strictly validates URL shape, advertised decoded byte count, canonical SHA-256, schema/artifact identity, zoom, cell identity, shard identity/count, and index/package counts. Defaults reject a request above 64 cells or 128 packages before package fetch. Successfully verified logical cells use a 128-cell least-recently-used in-memory cache; failed or corrupt content is not cached. This API is available for scaling and staged testing, but it is not the UI's default loading path yet.

## Hike detail and download gate

For every `TrailRoute` selected in a staged release, verify that the detail view presents five readable sections:

1. At a glance;
2. Route character;
3. Getting there;
4. Safety & conditions;
5. Data confidence.

Missing route facts must remain explicit unknowns, including distance/ascent/descent/duration, difficulty, terrain, season, hazards, current conditions, and legal access. Absence of a hazard or condition record must not be rendered as safe or clear.

GeoJSON is available only for a valid route `LineString` or `MultiLineString`. Its payload must retain the route geometry and label geometry representation/completeness, navigation suitability, source-assertion provenance, and the safety disclaimer. GPX has the stricter gate: valid line geometry, `geometryCompleteness: "complete"`, and `navigationSuitability: true` are all required. All 38 current `TrailRoute` records are unverified and navigation-unsuitable, so GPX must remain unavailable for every current route.

Neither an available GeoJSON file, complete geometry, a rendered map line, itinerary formation, nor automated validation is field-safety certification. The UI and exported files must continue to tell users to verify current access, closures, hazards, weather, and local guidance before departure.

## Deployment smoke checks

Before traffic promotion, verify from the staged HTTPS origin:

1. HTML, MapLibre, CSS, bundle, graph, WASM, manifest, spatial index, one spatial-cell package, and one small/one large regional package return 200 with correct MIME and compression.
2. Manifest, spatial-index, regional-package, and cell-package references have the required hash-prefix URL shape; spatial responses pass exact decoded-byte, SHA-256, and artifact/zoom/cell/shard identity validation.
3. Direct loader checks cover one-cell, adjacent-cell, empty, and `west > east` dateline viewports, cross-cell entity deduplication, abort/retry, the 64-cell/128-package refusal, and 128-cell least-recently-used eviction. These checks exercise the API; they do not claim the UI uses it by default.
4. The legacy planner loads and the WASM graph initializes without `leisure-wasm-error`.
5. Discover initializes with only the manifest; only an explicitly requested region loads, and failure, abort, retry, unknown access, non-navigation-grade, and attribution states are visible.
6. A route detail exposes all five sections and explicit unknowns; valid line geometry can download metadata-rich GeoJSON, while every current route refuses GPX as navigation-unsuitable.
7. Each configured routing profile returns its own provider/profile, and an unconfigured profile returns structured `profile_unavailable` rather than falling back.
8. Bad content type, oversized body, unknown field/profile, upstream timeout, rate limit, and malformed upstream response produce the documented bounded error.
9. Direct production browser requests to `router.project-osrm.org` are absent from the migrated flow.
10. Keyboard-only and screen-reader smoke paths can discover a place, inspect hike details/download explanations, read uncertainty/attribution, form or refuse an itinerary, and recover focus after errors without relying on the map.

`tools/leisure/e2e-smoke.mjs` covers the legacy planner and `tools/nature/e2e-smoke.mjs` defines the nature discovery/mixed-mode browser smoke. Run both against the staged production package when their Playwright runtime is available; do not substitute Node DOM tests for the staged browser check.

An earlier 18-scenario nature smoke recorded on 2026-07-26 covered manifest-only startup, explicit Scotland-only package activation, filtering, route selection, GPX safety refusal, keyboard tab behavior, 390 px overflow checks, exact nature-layer restoration after a map-style reload, and zero page/console errors. It predates the spatial-loader and expanded hike-detail checks above. Re-run all current gates; historical functional regression results are not representative-device performance, Core Web Vitals, screen-reader, or field-safety certification.

## Monitoring and telemetry

Instrument at the hosting/worker boundary; the current worker returns request IDs but does not emit a complete monitoring pipeline.

Track, by release and routing profile:

- static 4xx/5xx plus manifest, spatial-index, regional-package, and cell-package fetch/integrity errors;
- bytes, request count, download, JSON parse, hash, freeze, and search latency separated by regional versus spatial delivery;
- viewport selected/fetched cell and package counts, cap refusals, dateline requests, cross-cell duplicates, and 128-cell cache hits/evictions;
- routing request volume, response class/error code, upstream latency, timeout, rate limit, no-route, and profile-unavailable counts;
- adapter status, source snapshot age, record/count drift, validation/duplicate/quality flags;
- coverage status changes as reviewed events, never inferred metrics;
- WASM/graph initialization failure, planner failure, and memory/long-task observations;
- accessibility error announcements and user-visible degraded-mode frequency.

Route coordinates and precise nature locations can be sensitive personal/ecological data. Do not put full request bodies, URLs containing coordinates, authorization, API keys, or redacted/excluded source features in standard logs. Define minimal fields, access control, retention, deletion, and incident review before enabling request logs.

## Data refresh

No scheduled nature refresh exists today. Until source-specific acquisition is implemented, builds reproduce checked-in legacy arrays and manual fixtures only.

For each future source, document owner, approved snapshot location, cadence, expected lag, freshness/expiry behavior, last-known-good policy, licence review date, and escalation contact. Dynamic safety/transport sources need much shorter and source-specific validity than places or boundaries.

A source failure must remain isolated. However:

- if every adapter fails, the builder refuses replacement;
- if a blocking source fails, production promotion must stop even though the current builder can still finish from another adapter;
- last-known-good data remains dated and must not be displayed as current when expired;
- unknown safety/access/schedule state degrades or blocks itinerary formation; it never defaults open.

## Incident response and degraded modes

| Failure | Required user/system behavior |
| --- | --- |
| Manifest unavailable/invalid | Keep legacy/static shell available; show nature data unavailable and retry. Do not guess package URLs. |
| Regional package missing/hash mismatch | Reject it, do not cache the merged region, show that region unavailable, record release/hash IDs, and retry after manifest revalidation. |
| Spatial index missing/byte/hash/identity mismatch | Reject viewport delivery and do not guess cell URLs. The explicit regional compatibility path may remain available only if its own manifest references validate. |
| Spatial cell missing/byte/hash/identity mismatch | Reject the affected viewport result without caching partial data; record index/cell/package identities and retry only after revalidation. Regional browsing may remain available independently. |
| Viewport exceeds cell/package cap | Fetch no cell packages; require a smaller viewport/lower scope or an explicitly reviewed higher positive limit. Never return a silently partial viewport. |
| Hike export-gate regression | Disable the affected export. In particular, any GPX availability in the current 38-route corpus is a release blocker; GeoJSON must not ship without representation, provenance, navigation, and safety metadata. |
| One routing profile unavailable | Disable only legs needing that profile; keep established route browsing. Never substitute another profile silently. |
| Routing timeout/rate limit | Show retryable state and provider-neutral message; honor `Retry-After` at the edge/client when implemented. |
| Stale/failed condition source | Mark condition unknown/unavailable and block safety-sensitive recommendation according to policy. |
| Attribution/licence regression | Withdraw affected records/media/package; do not hide only the attribution UI. |
| Sensitive-location exposure | Remove public object and caches where possible, preserve restricted audit evidence, rotate release, notify governance owner, and review logs/derivatives. |
| WASM/graph mismatch | Disable the legacy leisure planner with an explicit message; do not compute an unverified fallback route. |

## Rollback and recovery

Record the static release ID, nature manifest `buildId`, regional package object list, spatial-index identity, spatial-cell package object list, bundle hash, WASM hash, graph checksum, worker version/config (excluding secrets), source snapshot IDs, and terms-review versions for every promotion.

Rollback by atomically restoring the prior HTML/manifest/application release and compatible routing worker configuration. Keep prior content-addressed regional packages, spatial indexes, cell packages, and accepted raw snapshots through the documented recovery window. After rollback, verify regional and viewport loader integrity, legacy redirects, WASM/graph compatibility, routing profile isolation, hike export gates, and attribution.

Backups must protect source snapshots and review evidence according to licence and sensitivity constraints. Public packages are reproducible outputs, not substitutes for governed raw evidence.

## Security and accessibility release gates

Apply a reviewed Content Security Policy at the origin. The legacy app currently contacts map tile/style, weather, geocoding, Wikipedia, image, and routing hosts; inventory these explicitly before tightening `connect-src`/`img-src`. Avoid `unsafe-eval`, restrict framing, use `nosniff`, a strict referrer policy, HTTPS/HSTS, and dependency/source integrity practices appropriate to same-origin vendored assets.

A release is not complete from map rendering alone. Test native control labels, keyboard order, visible focus, dialogs/panels, live-region messages, error recovery, 200% zoom/reflow, contrast, reduced motion, pointer target size, non-map result/itinerary parity, geometry descriptions, and uncertainty/attribution wording with representative assistive technology. Sensitive or unavailable map data must have an equivalent textual explanation.
