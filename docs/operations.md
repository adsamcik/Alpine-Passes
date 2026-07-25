# Operations and release runbook

## Operational boundary

The repository currently contains three deployable concerns:

1. the legacy static application (`index.html`, CSS, vendored MapLibre, concatenated JS, leisure graph, and WASM);
2. generated static nature artifacts (`assets/data/nature/`);
3. an optional same-origin routing worker (`server/routing-worker.mjs`) with separately configured car, foot, and hiking upstreams.

The nature domain, discovery, itinerary, routing, and region-loader modules are implemented as ES modules and imported by `index.html`. Discover is the default sidebar tab: initialization loads only the manifest, explicit activation loads the selected logical region, and textual results, geometry, evidence, uncertainty, retry, and itinerary/refusal states coexist with the retained legacy Plan and Browse tabs.

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
- `manifest.v1.json` for shard indexes/counts, URLs, bounds, jurisdiction/source lists, counts, and budgets;
- `legacy-id-redirects.v1.json` for unexpected identity churn;
- `THIRD_PARTY_DATA_NOTICES.md` and feature/media attribution.

The current builder fails if the manifest, initial nature-data artifact, deterministic regional shard, or one entity exceeds its raw package budget. It also fails invalid canonical records, invalid sensitivity policy, and broken delivered-reference closure. It does not turn missing attribution, unknown access, stale facts, unclear redistribution, or researched-but-unapproved sources into favorable facts. Promotion must fail closed on those policy gates even when the command exits zero.

## Deterministic site package

`tools/build-site.mjs` packages only an explicit runtime allowlist plus the `.mjs` nature-module tree and content-addressed nature-package tree. It rejects missing references, path escapes, symlinks, unexpected tree extensions, manifest URLs outside the package directory, and any file larger than the 25 MiB Sites static-asset limit. Design sources, unbundled country arrays, tests, raw data registries, and documentation are intentionally excluded from `dist/client`.

Every packaged file receives a byte count and SHA-256 entry in a canonical, timestamp-free `dist/build-manifest.json`; identical inputs produce identical package bytes and build ID. `server/routing-worker.mjs` is copied byte-for-byte to the `dist/server/index.js` runtime contract. The worker fronts `env.ASSETS` for static content, replaces the social-metadata origin token in HTML at request time, and adds `nosniff`, `no-referrer`, frame denial, and restrictive camera/microphone permissions headers to HTML responses.

## Static release order and caching

Publish into a versioned release directory or use a host with atomic deployment promotion. The required order inside a non-atomic object store is:

1. upload all newly referenced content-addressed regional packages;
2. upload reports, redirects, application bundle, graph, WASM, and other immutable/versioned artifacts;
3. verify hashes and smoke-test the staged origin;
4. publish the new manifest;
5. publish/revalidate HTML last.

Do not delete older content-addressed package files during promotion. A client can hold the previous manifest while requesting one of its packages. The local builder removes the old package directory, so a naïve mirror with “delete extraneous files” can break those clients. Retain packages through the rollback/cache horizon or deploy each release atomically.

Recommended HTTP cache policy:

| Asset | Cache behavior |
| --- | --- |
| `index.html` | no-cache or short TTL with revalidation |
| `manifest.v1.json` and current reports | no-cache/short TTL with revalidation |
| content-addressed regional packages | long-lived immutable |
| content-hashed bundle/WASM references | long-lived for the exact version; coordinate with HTML/shim |
| stable-name leisure graph | revalidate and release in lockstep with its consumer |
| routing responses and errors | `no-store` (already emitted by worker) |

The region loader requests the manifest with `no-cache`, fetches all shards advertised for a requested logical region with `force-cache`, verifies them, and caches only the successful merged package set in memory. One failed or corrupt shard rejects the logical region without caching it, so a later request can retry.

## Deployment smoke checks

Before traffic promotion, verify from the staged HTTPS origin:

1. HTML, MapLibre, CSS, bundle, graph, WASM, manifest, and one small/one large regional package return 200 with correct MIME and compression.
2. The advertised package URL contains the hash prefix and its payload passes browser loader SHA-256 verification.
3. The legacy planner loads and the WASM graph initializes without `leisure-wasm-error`.
4. Discover initializes with only the manifest; only an explicitly requested region loads, and failure, abort, retry, unknown access, non-navigation-grade, and attribution states are visible.
5. Each configured routing profile returns its own provider/profile, and an unconfigured profile returns structured `profile_unavailable` rather than falling back.
6. Bad content type, oversized body, unknown field/profile, upstream timeout, rate limit, and malformed upstream response produce the documented bounded error.
7. Direct production browser requests to `router.project-osrm.org` are absent from the migrated flow.
8. Keyboard-only and screen-reader smoke paths can discover a place, read uncertainty/attribution, form or refuse an itinerary, and recover focus after errors without relying on the map.

`tools/leisure/e2e-smoke.mjs` covers the legacy planner and `tools/nature/e2e-smoke.mjs` defines the nature discovery/mixed-mode browser smoke. Run both against the staged production package when their Playwright runtime is available; do not substitute Node DOM tests for the staged browser check.

On 2026-07-26, the nature smoke passed all 18 scenarios: manifest-only startup, explicit Scotland-only package activation, filtering, route selection, GPX safety refusal, keyboard tab behavior, 390 px overflow checks, exact nature-layer restoration after a map-style reload, and zero page/console errors. The full Node run passed all 193 tests. This is a functional regression result, not representative-device performance, Core Web Vitals, screen-reader, or field-safety certification.

## Monitoring and telemetry

Instrument at the hosting/worker boundary; the current worker returns request IDs but does not emit a complete monitoring pipeline.

Track, by release and routing profile:

- static 4xx/5xx, manifest/package fetch and integrity errors;
- package bytes, download, JSON parse, hash, freeze, and search latency;
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
| Package missing/hash mismatch | Reject it, do not cache it, show affected region unavailable, record release/hash IDs, and retry after manifest revalidation. |
| One routing profile unavailable | Disable only legs needing that profile; keep established route browsing. Never substitute another profile silently. |
| Routing timeout/rate limit | Show retryable state and provider-neutral message; honor `Retry-After` at the edge/client when implemented. |
| Stale/failed condition source | Mark condition unknown/unavailable and block safety-sensitive recommendation according to policy. |
| Attribution/licence regression | Withdraw affected records/media/package; do not hide only the attribution UI. |
| Sensitive-location exposure | Remove public object and caches where possible, preserve restricted audit evidence, rotate release, notify governance owner, and review logs/derivatives. |
| WASM/graph mismatch | Disable the legacy leisure planner with an explicit message; do not compute an unverified fallback route. |

## Rollback and recovery

Record the static release ID, nature manifest `buildId`, package object list, bundle hash, WASM hash, graph checksum, worker version/config (excluding secrets), source snapshot IDs, and terms-review versions for every promotion.

Rollback by atomically restoring the prior HTML/manifest/application release and compatible routing worker configuration. Keep prior content-addressed packages and accepted raw snapshots through the documented recovery window. After rollback, verify loader integrity, legacy redirects, WASM/graph compatibility, routing profile isolation, and attribution.

Backups must protect source snapshots and review evidence according to licence and sensitivity constraints. Public packages are reproducible outputs, not substitutes for governed raw evidence.

## Security and accessibility release gates

Apply a reviewed Content Security Policy at the origin. The legacy app currently contacts map tile/style, weather, geocoding, Wikipedia, image, and routing hosts; inventory these explicitly before tightening `connect-src`/`img-src`. Avoid `unsafe-eval`, restrict framing, use `nosniff`, a strict referrer policy, HTTPS/HSTS, and dependency/source integrity practices appropriate to same-origin vendored assets.

A release is not complete from map rendering alone. Test native control labels, keyboard order, visible focus, dialogs/panels, live-region messages, error recovery, 200% zoom/reflow, contrast, reduced motion, pointer target size, non-map result/itinerary parity, geometry descriptions, and uncertainty/attribution wording with representative assistive technology. Sensitive or unavailable map data must have an equivalent textual explanation.
