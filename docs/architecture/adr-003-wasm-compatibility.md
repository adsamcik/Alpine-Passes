# ADR-003: Preserve the Rust/WASM leisure planner behind a compatibility seam

- Status: Accepted
- Date: 2026-07-26
- Decision scope: migration of the existing route optimizer

## Context

`crates/leisure-core` is a substantial, tested Rust optimizer compiled to WebAssembly. It consumes the existing leisure graph and supports the current scenic-driving planner. Rewriting it while also replacing data ingestion, routing, discovery, and itinerary semantics would combine unrelated risks and remove a known working path.

The new canonical nature model, however, represents established trails, access points, transport, restrictions, and provenance that the old compact graph does not understand.

## Decision

Retain `leisure-core`, its committed WASM artifact, the JS shim, graph builder, tests, content hash, and current user-visible behavior during migration. Treat the JS shim and planner DTO as the compatibility seam.

The new system may adapt canonical records into the existing graph only when the mapping is loss-aware and reversible through stable IDs/redirects. Fields that the graph cannot represent—legal access, source assertions, sensitive-location action, route geometry, permits, hazards, live conditions, and transport schedules—remain outside the optimizer and must still be enforced by the itinerary/application layer.

Mixed-mode nature itinerary composition initially remains ordinary JavaScript around:

- immutable canonical established-route geometry;
- the routing gateway for generated connectors;
- explicit access points and transport connections;
- blocking access, condition, restriction, and sensitivity checks.

Do not expose raw canonical packages directly to Rust merely to avoid defining a versioned DTO. Any future WASM nature-planning API requires a versioned request/response contract, deterministic fixtures, JS/WASM parity tests, memory and latency budgets, and a safe unsupported-version response.

## Compatibility rules

1. Existing legacy IDs continue through generated redirects until callers and saved state have migrated.
2. Existing bundle-relative dynamic import paths remain valid.
3. A WASM or graph load failure produces a clear unavailable/degraded state; it must not silently substitute straight-line or unsafe routing.
4. `npm test` continues to verify the committed WASM hash; Rust changes also run format, build, tests, a deterministic WASM rebuild workflow, and size checks.
5. Established route geometry is never simplified into the leisure graph and then returned as if it were the source route.
6. Removal of the compatibility adapter requires usage evidence, a saved-state migration, and an ADR update.

## Consequences

This choice reduces migration risk and preserves a tested optimizer, but temporarily maintains two planning representations: the leisure graph for legacy scenic driving and canonical entities/legs for nature travel. The application layer must label them clearly and avoid accidental cross-use.

The committed baseline WASM is 969,295 bytes and the leisure graph is 2,989,132 bytes uncompressed. Preserving them is not a waiver from startup, memory, or cache budgets. New nature payloads must not be eagerly loaded merely because the old graph is already loaded.

## Alternatives considered

- Rewrite the optimizer immediately: rejected because it would discard working behavior and obscure whether regressions came from algorithms, data, or UI migration.
- Put all itinerary composition in Rust immediately: deferred until canonical contracts and provider capabilities stabilize.
- Freeze the old planner permanently: rejected; the seam exists to permit incremental replacement, not to make legacy assumptions permanent.
