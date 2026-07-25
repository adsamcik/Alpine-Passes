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
- fetch every advertised shard for only the requested logical region through `RegionalPackageLoader`, validate contiguous shard identity and each document, reject conflicting duplicate IDs, and cache one immutable merged package set;
- retain static hosting for the UI, manifest, packages, attribution, and reports;
- use a same-origin dynamic worker only for routing and other future secret-bearing or live operations.

The initial region IDs are delivery partitions, not political or coverage claims. Jurisdiction semantics remain in `data/jurisdictions/registry.v1.json` and in each entity’s `jurisdictionIds`.

## Consequences

Data and UI can be released independently, and a browser does not need every region before discovery begins. Content-addressed shard URLs are immutable cache keys. A changed shard produces a new URL while unchanged objects remain cacheable.

The manifest is the consistency boundary. A release must publish packages before the manifest that advertises them, and rollback must restore a compatible manifest plus its referenced immutable objects. `tools/nature/build.mjs` stages locally, but its final file-by-file copy is not a cross-filesystem atomic deployment; the hosting release process must provide atomic release promotion.

Cross-border records may appear in more than one delivery region when `deliveryRegions` requires it. The current deterministic sharding is byte-bounded, not viewport-aware: loading a region fetches all of its shards concurrently and merges them. Further spatial/index sharding may therefore be needed for total transfer and retained-memory scale even though individual files fit the budget.

The loader requires Web Crypto SHA-256. It fails closed with a typed error if integrity verification is unavailable; the product must render a retry/degraded state instead of using unverified bytes.

## Current gate status

The manifest authors a 64,000-byte manifest/initial-nature-data budget and a 2,500,000-byte uncompressed shard budget. The builder hard-fails when the manifest, a shard, or one indivisible entity cannot fit the applicable limit. Deterministic build `2413863cfdeb500c` produced a 6,026-byte manifest and 10 shards; the largest is 2,498,351 bytes. EU/Alps is split into four shards and Japan into two. All 4,019 records validated, both adapters succeeded, and all 313 legacy price-cache entries matched. The raw file gates are green, but total-region transfer, parse, integrity, merge, retained memory, and representative browser latency remain unproven.

## Alternatives considered

- One global JSON or JS bundle: rejected because startup, parse, invalidation, and memory scale with total coverage.
- Runtime calls directly to all source APIs: rejected because sources have incompatible licences, rate limits, availability, schemas, and secret requirements, and results would not be reproducible.
- A mandatory database/API for all discovery: deferred because it raises operational cost and removes the static degraded mode before it is needed.
- One file per entity: rejected because request count, cache metadata, and listing/discovery overhead become excessive.

## Follow-up rules

Any partition change must preserve stable entity IDs, source assertions, redirects, attribution, contiguous shard identity, and deterministic membership. Add initial-load, total-region transfer, parse, merge, memory, and viewport interaction measurements to CI before widening coverage. Never derive a coverage status from package existence or entity count.
