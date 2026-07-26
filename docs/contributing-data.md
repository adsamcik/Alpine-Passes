# Contributing nature data

## Before editing

Read these contracts first:

- [Nature-travel taxonomy](taxonomy/nature-travel-taxonomy.md)
- [Ingestion](ingestion.md)
- [Territorial scope](data/territorial-scope.md)
- [Coverage matrix](data/coverage-matrix.md)
- [Source policy](data/source-policy.md)
- [Licensing and attribution](data/licensing-and-attribution.md)
- `schemas/nature-domain.schema.json`
- `schemas/source-registry.schema.json`

A contribution adds evidence, not a blanket completeness claim. Unknown access, conditions, schedules, permits, attribution, and sensitivity remain explicit unknowns.

## Common local checks

Use Node 24.x, matching CI. From the repository root:

```sh
node --check tools/nature/build.mjs
node --check tools/nature/lib/legacy-adapter.mjs
node tools/nature/build.mjs
node --test tests/nature-*.test.mjs
npm test
git status --short
```

Review every changed generated report and package. Do not hand-edit `assets/data/nature/`; regenerate it.

## Workflow: add a country or territorial jurisdiction

1. **Define scope.** Add the inclusion/exclusion decision and edge cases to `docs/data/territorial-scope.md`. Decide how dependencies, overseas territories, disputed areas, cross-border parks/routes, Indigenous/Tribal authority, and unusual transport links are represented. Do not inherit mainland assumptions automatically.

2. **Add coverage dimensions.** In `data/jurisdictions/registry.v1.json`, add or reuse a `coverageProfiles` object containing every key listed in `dimensions`. Use only the exact `coverageStatuses` vocabulary. A newly researched source is normally `Source available but not yet ingested`; an unsupported dimension remains `Unknown` or `Structurally supported but unpopulated` as evidence warrants.

3. **Add a source profile.** Add or reuse a `sourceProfiles` entry listing the applicable registered source IDs. This is research linkage, not proof of an accepted snapshot.

4. **Add the jurisdiction row.** Supply a stable ID, display name, `kind`, `parentId`, boolean `inScope`, pessimistic authored `overallStatus`, `coverageProfile`, `sourceProfile`, legacy-inventory fields when applicable, and concrete `caveats`. Add `discoveryUrls` only as research aids. Add subdivision rows where the product scope requires them.

5. **Register exact sources.** Follow the source workflow below for each dataset. A portal name alone is insufficient.

6. **Choose delivery placement.** Canonical entities need explicit `deliveryRegions`. The current legacy mapping is hard-coded in `regionsForJurisdictions` in `tools/nature/lib/legacy-adapter.mjs`; a new region or jurisdiction rule requires a narrow mapping change and loader/package tests. Delivery partitions are operational and must not replace jurisdiction IDs.

7. **Implement the adapter.** Add a source-specific module below `tools/nature/` and register it in the default `adapters` list in `tools/nature/build.mjs`. There is no automatic plugin discovery. The adapter must return `adapterId`, canonical `records`, `redirects`, and `inventories`.

8. **Add fixtures and gates.** Cover local-script names, subdivision references, source IDs, axis order, boundaries, out-of-scope filtering, classifications, access unknowns, sensitive locations, routes/transport where relevant, duplicate IDs, and source failure isolation.

9. **Build and inspect.** Run the common checks. Inspect `coverage-report.v1.json` for the authored statuses and record counts, `quality-report.v1.json` for gaps, and `manifest.v1.json` for package size/bounds/attribution sources. Record counts must not upgrade status.

10. **Update governance docs.** Update the coverage matrix, source/licensing notes, third-party notices, operational refresh ownership, and performance results. Request local/legal review where access or reuse rules are jurisdiction-specific.

## Workflow: add a source

1. **Identify the exact product.** Record publisher, dataset/service name, stable product or release ID, documentation, endpoint, territorial scope, data themes, update cadence, historical availability, schema/version, and contact where available.

2. **Complete the legal gate.** Determine exact licence/version and URL, database rights, commercial/derivative/redistribution permission, attribution wording, share-alike, third-party exclusions, logos/marks, privacy, and sensitive-location restrictions. `unclear`, `restricted`, or `prohibited` content does not enter a redistributable package without approval.

3. **Add the registry entry.** In `data/sources/registry.v1.json`, fill every required field from `schemas/source-registry.schema.json`: identity/owner/authority, jurisdictions/themes/homepage, retrieval/snapshot policy, licence, cadence, authentication, rate limits, assumptions, gaps, failure behavior, last refresh, and redistribution. Secrets must always have `secretBrowserSafe: false`; failures must be isolated.

4. **Define acquisition and retention.** Prefer immutable bulk releases. For `retain_raw`, use the approved snapshot store and record checksum, size, retrieved time, request metadata, and upstream version. Large/licence-restricted raw snapshots should not be committed casually to Git. The repository does not yet define a production raw-object store, so that operational decision must be made before the first scheduled adapter.

5. **Implement normalization.** Create a source-specific adapter; do not add source-specific conditionals to unrelated adapters. Preserve source IDs, original classification, names, local grade, CRS conversion record, geometry, null semantics, and dates. Return the standard adapter contract and register it explicitly in `tools/nature/build.mjs`.

6. **Attach assertions.** Every entity has at least one `sourceAssertion`; important fields should use narrow JSON Pointer `fieldPath` values. Record `sourceId`, upstream record identity, evidence kind, verification state, confidence, retrieval/effective time, and notes. Preserve conflicts rather than flattening them.

7. **Apply source-specific safety.** Set legal access to `unknown` unless the source is competent for that fact. Expire dynamic data. Coarsen/redact/exclude sensitive locations before public, log, fixture, and debug output. Do not promote a map line to navigation-grade merely because it passes geometric validation.

8. **Test failure and drift.** Add fixtures for valid input, schema/CRS drift, missing IDs, malformed geometry, rate limiting, partial pages, duplicate records, out-of-scope features, licence metadata, and isolated source failure. Acquisition tests must not depend on a live shared endpoint.

9. **Generate attribution.** Update `THIRD_PARTY_DATA_NOTICES.md` and verify the manifest’s `attributionSourceIds`. Media requires per-file rights metadata; a general source credit is insufficient.

10. **Promote deliberately.** Run the common checks and review all reports. The builder enforces canonical validity and the per-shard raw-byte limit, but not lifecycle, criticality, last-known-good, freshness, licence, attribution completeness, or the other latency/count budgets, so reviewer sign-off remains required.

## Workflow: add or change a category

1. Write the user need and representative source values in a taxonomy change proposal or PR description. Check for an existing normalized category with the same meaning.
2. Add the stable lowercase `snake_case` key to [Nature-travel taxonomy](taxonomy/nature-travel-taxonomy.md), including parent group and boundary examples.
3. Preserve publisher values in `classifications[].original` and the publisher namespace in `.system`; map only `.normalized` to the Itinera key.
4. Update each relevant adapter mapping. Do not infer a category from a name when the source does not support it, and do not change `entityType` merely to create a filter.
5. Update search/discovery filters, labels/translations, icons, non-map result presentation, accessible names, and analytics dimensions where they exist.
6. Add positive, negative, multilingual, and ambiguous fixtures plus backward-compatibility mapping for deprecated keys.
7. Rebuild and check category counts for implausible jumps and jurisdiction/source bias.

If the change is actually a new activity, access mode, route nature, journey shape, hazard, amenity, or transport mode, update both `schemas/nature-domain.schema.json` and `assets/js/nature/domain.mjs`, then update routing/itinerary/UI contracts and tests. Those are versioned API changes, not simple taxonomy additions.

## Workflow: add a complete established route

Production routes should come from an approved source adapter. `data/seeds/nature-routes.v1.json` is reserved for explicit maintainer fixtures/migration examples and must remain visibly unverified unless supported by reviewed evidence.

1. **Establish identity and rights.** Choose a durable route/stage ID from the publisher’s identity, register the source, approve geometry redistribution, and record required attribution/transformation notices.

2. **Provide the common envelope.** Include `schemaVersion: "1.0.0"`, stable `id`, `entityType: "TrailRoute"`, all jurisdiction IDs, localized names, GeoJSON geometry, source assertions, quality, sensitivity, original source identity, and delivery region(s).

3. **Set route semantics.** For a named path, use `routeNature: "established"`, `geometryCompleteness: "complete"`, an explicit `navigationSuitability`, at least one valid activity, a journey shape, optional direction, and access with legal state/modes. “Complete” does not justify `navigationSuitability: true`.

   Downloadable geometry additionally requires `exportMetadata.sourceNotices`: exactly one closed, complete notice for every distinct `sourceAssertions[].sourceId`/`sourceRecordId` pair, with no unmatched notices. Each notice stores publisher, exact product, licence ID/version/URL, required attribution wording, source URL, and a transformation notice. Missing or incomplete notices disable both GeoJSON and GPX; GPX also requires verified current geometry provenance, an unmodified publish-safe line, and explicit navigation suitability.

4. **Supply the whole line.** Use longitude/latitude `LineString` or explained `MultiLineString`, including the intended route/stage endpoints and no fabricated straight-line gaps. A real ferry/cable discontinuity gets a separate connection; missing trail geometry does not.

5. **Preserve difficulty.** Store the authority’s `originalScale` and `originalGrade`. Add a normalized band only with a caveat appropriate to that source/jurisdiction.

6. **Model access separately.** Add each trailhead, parking/transfer point, station, pier, or pickup as an `AccessPoint` with explicit modes, legal state, stopping/parking facts, source assertion, quality, and sensitivity. Link IDs with `accessPointIds`. Default law, parking, and hours to unknown without current competent evidence.

7. **Model movement separately.** Add bus, rail, ferry, boat, gondola, funicular, cog railway, cable car, or pickup as `TransportConnection`, with endpoint IDs, direction, duration/schedule only when sourced, freshness/validity, and its own assertions. Link through `transportConnectionIds`. An unknown schedule must not be treated as a usable departure.

8. **Add constraints and safety.** Represent restrictions, permits, conditions, hazards, seasons, metrics, and support amenities with source/effective dates. Critical unknowns receive quality flags. Sensitive ecology/culture is coarsened, redacted, or excluded before packaging.

9. **Add itinerary fixtures.** Test loop/out-and-back/point-to-point behavior as applicable, driving/foot connectors, legal parking selection, transport return or different pickup, last-departure/closure refusal, source references, unchanged established geometry, and non-navigation-grade labeling.

10. **Validate and review visually.** Run the common checks, inspect route bounds and vertices in a GIS/map against the approved source, inspect package/report diffs, and have a second reviewer confirm identity, completeness meaning, access uncertainty, licence, and sensitivity. Automated continuity checks alone are insufficient.

## Pull request evidence

A data PR should state source product/version and retrieval time; checksum or request metadata; licence review and attribution; jurisdiction and category mappings; record/geometry counts; invalid/duplicate/out-of-scope findings; quality/coverage changes; package-size changes; sensitive-location handling; tests run; and known gaps. Avoid “complete,” “official,” “safe,” “open,” or “accessible” unless the precise field and evidence support the claim.
