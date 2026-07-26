# ADR-005: Fixed spatial cells provide bounded viewport delivery

- Status: Accepted
- Date: 2026-07-26
- Decision scope: generated nature-package partitioning and browser delivery

## Context

The content-addressed regional packages in [ADR-001](adr-001-hybrid-regional-packaging.md) bound the size of each JSON document, but selecting a logical region still downloads every shard in that region and retains all of its entities. That is useful as a migration boundary, but it does not scale transfer, parsing, integrity work, or memory to a map viewport.

Viewport delivery needs deterministic membership, stable URLs, bounded requests, dateline behavior, and the same fail-closed integrity properties as regional delivery. It must not imply that package presence proves geographic coverage or that a route duplicated across cells has multiple canonical identities.

## Decision

The builder emits a second, spatial delivery layout using fixed Web Mercator XYZ cells at zoom 8. Cell IDs are `8/x/y`.

- A point belongs to exactly one cell.
- A line or polygon belongs to every cell in its minimal bounding box. Longitude coverage uses the smaller antimeridian-aware interval, so a geometry near the dateline does not fan out across the world.
- The build fails when one entity would occupy more than 4,096 cells. This is a protection against pathological geometry or an inappropriate delivery representation, not a reason to silently omit cells.
- Membership duplicates complete canonical entities; it does not clip or simplify their evidence geometry. Consumers deduplicate by stable entity ID and reject conflicting values for one ID.

Each cell is deterministically split into one or more content-addressed packages with a raw-byte budget of 1,000,000 bytes per package. The build fails if a package or a single entity cannot fit that budget.

A separate content-addressed spatial index lists the populated cells and their package references. The manifest references that index by URL, expected byte count, SHA-256 hash, zoom, cell count, and package count. The spatial-index raw-byte budget is 2,000,000 bytes. Keeping the index separate preserves a small manifest-only bootstrap while allowing the index and cell objects to use immutable caching.

The browser loader validates advertised URL shape, exact decoded response bytes, canonical SHA-256, schema and artifact type, zoom, cell identity, shard identity/count, and index/package counts. Missing, malformed, mismatched, or conflicting content fails closed and is not accepted into the cache.

`loadViewport([west, south, east, north])` selects intersecting populated cells. `west > east` explicitly represents a viewport that crosses the dateline. By default, one call may select at most 64 cells and 128 packages; callers can supply positive per-request overrides, but production increases require explicit performance and capacity review. A request over either active limit is rejected before cell packages are fetched. Successfully verified logical cells are retained in a 128-cell least-recently-used cache, and duplicate in-flight cell requests are shared.

## Transition

Regional packages remain generated as the compatibility/fallback delivery path during migration. The current Discover UI still loads a logical region only after explicit user activation; it does not call `loadViewport` as its default map-data path. Spatial cells are therefore an implemented loader API and scaling foundation, not a claim that the current UI already performs viewport-default delivery.

Both layouts temporarily duplicate canonical entity payloads, and lines or polygons may also appear in more than one spatial cell. Release storage, upload time, CDN footprint, decoded bytes, request overhead, cache behavior, and retained browser memory must be measured before choosing a removal date for regional packages or changing the UI default.

## Consequences

- A viewport-capable consumer can fetch only populated cells intersecting its bounds without downloading a complete logical region.
- Fixed zoom and deterministic bounding-box membership make artifacts reproducible and cacheable.
- Cross-cell and cross-layout duplication is intentional and must be deduplicated by canonical entity ID.
- Bounding-box assignment can include cells the geometry does not actually intersect; it trades some duplication for a simple, stable index.
- Very large geometries must be redesigned or handled by a reviewed future partition rather than bypassing the 4,096-cell guard.
- A separately fetched index adds one request and still needs representative browser and field-device performance evidence.

See [Ingestion](../ingestion.md), [Performance](../performance.md), and [Operations](../operations.md) for build, measurement, deployment, and rollback requirements.
