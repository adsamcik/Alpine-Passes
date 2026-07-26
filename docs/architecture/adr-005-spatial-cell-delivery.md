# ADR-005: Fixed spatial cells provide bounded viewport delivery

- Status: Accepted
- Date: 2026-07-26
- Decision scope: generated nature-package partitioning and browser delivery

## Context

The content-addressed regional packages in [ADR-001](adr-001-hybrid-regional-packaging.md) bound the size of each JSON document, but selecting a delivery partition still downloads every shard in that region and retains all of its entities. That is useful as a migration boundary, but it does not scale transfer, parsing, integrity work, or memory to a map viewport.

Viewport delivery needs deterministic membership, stable URLs, bounded requests, dateline behavior, and the same fail-closed integrity properties as regional delivery. It must not imply that package presence proves geographic coverage or that a route duplicated across cells has multiple canonical identities.

## Decision

The builder emits a second, spatial delivery layout using fixed Web Mercator XYZ cells at zoom 8. Cell IDs are `8/x/y`.

- A point belongs to exactly one cell.
- A line or polygon belongs to every cell in its minimal bounding box. Longitude coverage uses the smaller antimeridian-aware interval, so a geometry near the dateline does not fan out across the world.
- The build fails when one entity would occupy more than 4,096 cells. This is a protection against pathological geometry or an inappropriate delivery representation, not a reason to silently omit cells.
- Membership duplicates complete canonical entities; it does not clip or simplify their evidence geometry. Consumers deduplicate by stable entity ID and reject conflicting values for one ID.

Each cell is deterministically split into one or more content-addressed packages with a raw-byte budget of 1,000,000 bytes per package. The build fails if a package or a single entity cannot fit that budget.

A separate content-addressed spatial index lists the populated cells and their package references. The manifest references that index by URL, expected byte count, SHA-256 hash, zoom, cell count, and package count. The spatial-index raw-byte budget is 2,000,000 bytes. Keeping the index separate preserves a small manifest bootstrap before post-map spatial requests while allowing the index and cell objects to use immutable caching.

The browser loader validates advertised URL shape, exact decoded response bytes, canonical SHA-256, schema and artifact type, zoom, cell identity, shard identity/count, and index/package counts. Missing, malformed, mismatched, or conflicting content fails closed and is not accepted into the cache.

`loadViewport([west, south, east, north])` selects intersecting populated cells. `west > east` explicitly represents a viewport that crosses the dateline. By default, one call may select at most 64 cells, 128 packages, and 8,000,000 raw package bytes; the effective byte ceiling is never higher than the manifest `viewportRequestBytes` value. Callers can supply positive per-request limits, but production increases require explicit performance and capacity review. A request over any active limit is rejected before cell packages are fetched. Successfully verified logical cells are retained in a 128-cell least-recently-used cache. Duplicate in-flight cell requests share one job, and one caller abort does not cancel work still needed by another caller. A loader-wide scheduler starts at most six spatial-cell fetch jobs concurrently; queued jobs with no subscribers are removed and running orphaned jobs are aborted. Package shards within one cell job are fetched sequentially; failed or aborted jobs are not cached, so later requests can retry cleanly.

## Active browser integration and retained region path

Discover now calls `loadViewport` as its default visible-map data path. Map attachment schedules the initial request, each `moveend` schedules another after a short delay, and a superseded request is aborted; subscriber-aware cancellation removes its queued work and aborts only in-flight jobs that no other viewport still needs. Over-broad requests fail before cell-package fetch and prompt the user to zoom or choose a region; other viewport failures expose an unavailable state rather than silently accepting a partial result.

Regional packages remain generated for explicit search across all advertised records in a selected delivery partition and as an independently validated compatibility path. The current UI fetches them only after explicit user activation; viewport failure does not start a regional load automatically. Both layouts therefore duplicate canonical entity payloads, and lines or polygons may also appear in more than one spatial cell. Release storage, upload time, CDN footprint, decoded bytes, request overhead, cache behavior, and retained browser memory must be measured continuously. Regional removal would require a replacement for selected-delivery-partition search and compatibility use plus a separate decision; active viewport loading alone is not sufficient.

## Current gate status

Current governed build `502fbdf646728ce8` has a 514-byte spatial index
describing one populated cell and one package reference. Its one 236,806-byte
cell package passes the 1,000,000-byte gate. The generated nature tree contains
10 files totaling 651,524 raw bytes, including the retained regional package,
manifest, exact source-release notice, index, reports, and redirects. The
enforced initial raw upper bound is 8,001,888 bytes against a 10,064,000-byte
budget. The deterministic release Chromium smoke requested only the 1,374-byte
manifest and 514-byte index for its empty Alpine viewport: 1,888 unique raw
nature bytes and no non-intersecting cell. This is functional scope evidence,
not a universal transfer value or representative-device performance result.

## Consequences

- The active map consumer fetches only populated cells intersecting its bounds without downloading all advertised records in one selected delivery partition.
- Fixed zoom and deterministic bounding-box membership make artifacts reproducible and cacheable.
- Cross-cell and cross-layout duplication is intentional and must be deduplicated by canonical entity ID.
- Bounding-box assignment can include cells the geometry does not actually intersect; it trades some duplication for a simple, stable index.
- Very large geometries must be redesigned or handled by a reviewed future partition rather than bypassing the 4,096-cell guard.
- A separately fetched index adds one request and still needs representative browser and field-device performance evidence.

See [Ingestion](../ingestion.md), [Performance](../performance.md), and [Operations](../operations.md) for build, measurement, deployment, and rollback requirements.
