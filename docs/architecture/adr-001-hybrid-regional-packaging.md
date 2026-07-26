# ADR-001: Hybrid regional delivery packages

- Status: Accepted
- Date: 2026-07-26
- Decision scope: nature data ingestion and browser delivery

## Context

The baseline embeds curated geographic arrays in a 2.37 MB uncompressed JavaScript bundle and separately loads a 2.99 MB leisure graph. Expanding this pattern across the EU, United States, Canada, United Kingdom, Switzerland, Japan, and Norway would couple application releases to data releases and make initial parse/memory cost grow with the total inventory.

The platform must remain deployable on static hosting for discovery while also supporting dynamic, secret-bearing routing services. A single all-world payload and a required application server are both poor fits.

## Decision

Use a hybrid boundary:

- build canonical entities offline from isolated adapters;
- publish a small, versioned manifest at `assets/data/nature/manifest.v1.json`;
- group records by explicit `deliveryRegions`, sort by stable ID, and deterministically shard each region below `assets/data/nature/packages/<region>/` so every content-addressed JSON document fits the raw-byte budget;
- retain those regional shards for explicitly requested search across all advertised records in one selected delivery partition and as an independently validated, user-activated compatibility fallback: when activated, `RegionalPackageLoader` fetches every advertised shard, validates contiguous shard identity and each document, rejects conflicting duplicate IDs, and caches one immutable merged package set; viewport failure never triggers this download automatically;
- use the fixed spatial-cell layout accepted in [ADR-005](adr-005-spatial-cell-delivery.md) as the active visible-map path, without treating regional package existence or spatial-cell population as coverage evidence;
- retain static hosting for the UI, manifest, packages, attribution, and reports;
- use a same-origin dynamic worker only for routing and other future secret-bearing or live operations.

The initial region IDs are delivery partitions, not political or coverage claims. Jurisdiction semantics remain in `data/jurisdictions/registry.v1.json` and in each entity’s `jurisdictionIds`.

## Consequences

Data and UI can be released independently, and a browser does not need every region before discovery begins. Content-addressed shard URLs are immutable cache keys. A changed shard produces a new URL while unchanged objects remain cacheable.

The manifest is the consistency boundary. A release must publish packages before the manifest that advertises them, and rollback must restore a compatible manifest plus its referenced immutable objects. `tools/nature/build.mjs` stages locally, but its final file-by-file copy is not a cross-filesystem atomic deployment; the hosting release process must provide atomic release promotion.

Cross-border records may appear in more than one delivery region when `deliveryRegions` requires it. Regional sharding is intentionally byte-bounded rather than viewport-aware: explicit retrieval fetches and merges every advertised shard in that selected delivery partition. The active fixed-cell path handles visible-map bounds separately, while the regional representation remains available for search across all advertised partition records and user-activated compatibility use.

The loader requires Web Crypto SHA-256. It fails closed with a typed error if integrity verification is unavailable; the product must render a retry/degraded state instead of using unverified bytes.

## Current gate status

The manifest authors separate 64,000-byte manifest, 10,064,000-byte
initial-nature-data, and 2,500,000-byte uncompressed regional-shard budgets.
The initial deterministic raw upper bound is 8,001,888 bytes: the 1,374-byte
manifest, the 514-byte spatial index, and at most 8,000,000 advertised bytes of
viewport cell packages. Current governed build `502fbdf646728ce8` has one
236,785-byte North America regional shard containing the two approved NPS
records. All three adapters process 4,019 candidate records, but the release
gate withholds the 4,017 records referencing non-approved sources before
packaging. The deterministic raw gates are green; selected-partition transfer,
parse, integrity, retained memory, and representative browser latency at future
scale remain unproven. Spatial measurements are recorded in [ADR-005](adr-005-spatial-cell-delivery.md) and [Performance](../performance.md).

## Alternatives considered

- One global JSON or JS bundle: rejected because startup, parse, invalidation, and memory scale with total coverage.
- Runtime calls directly to all source APIs: rejected because sources have incompatible licences, rate limits, availability, schemas, and secret requirements, and results would not be reproducible.
- A mandatory database/API for all discovery: deferred because it raises operational cost and removes the static degraded mode before it is needed.
- One file per entity: rejected because request count, cache metadata, and listing/discovery overhead become excessive.

## Follow-up rules

Any partition change must preserve stable entity IDs, source assertions, redirects, attribution, contiguous shard identity, and deterministic membership. Keep the explicit selected-delivery-partition retrieval contract covered while measuring initial viewport load, total-region transfer, parse, merge, memory, and viewport interaction in CI before widening coverage. Never derive a coverage status from package existence or entity count.
