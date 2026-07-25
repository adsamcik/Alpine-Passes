# Coverage matrix

Assessment date: 2026-07-25.

The machine-readable authority for jurisdiction scope and status is
[`data/jurisdictions/registry.v1.json`](../../data/jurisdictions/registry.v1.json).
The source inventory is
[`data/sources/registry.v1.json`](../../data/sources/registry.v1.json).

## Current conclusion

No jurisdiction is currently classified as **Verified broad coverage** or
**Verified partial coverage**.

The existing Austria, France, Ireland, Italy, Japan, Switzerland, and United
Kingdom inventories are useful migration inputs, but their coverage remains
**Unknown**. They do not have sufficiently complete item-level publisher,
licence, attribution, source identifier, geometry, legal-access, freshness, and
coverage evidence. A count test or a successful import is not coverage
verification.

Reviewed authoritative source availability is recorded as **Source available
but not yet ingested**. This is intentionally not a claim that the application
contains that source.

## Required status values

Every effective jurisdiction profile gives one of these exact values for every
coverage dimension:

1. **Verified broad coverage** — accepted published snapshots represent every
   required first-level subdivision and critical theme, and provenance,
   licence, geometry, freshness, and coverage gates pass. “Broad” is not
   “complete”; known gaps remain documented.
2. **Verified partial coverage** — published data passes the same legal and
   technical gates, but measured geographic or thematic gaps remain.
3. **Source available but not yet ingested** — the exact publisher, product,
   retrieval route, and likely reuse terms were reviewed, but there is no
   accepted application snapshot.
4. **Structurally supported but unpopulated** — a jurisdiction/schema slot
   exists, but there is no approved source.
5. **Unknown** — source research, rights, completeness, freshness, or legacy
   provenance has not been verified.
6. **Excluded, with reason** — an explicit scope, legal, licensing, safety, or
   sensitive-location exclusion is recorded.

`coverageProfiles[coverageProfile]` in the registry is the complete effective
per-dimension status object. There is no implicit parent inheritance.
`overallStatus` is deliberately pessimistic and must not be derived from raw
record counts.

## Matrix inventory

| Required scope | Explicit rows | Current overall result |
|---|---:|---|
| EU Member States | 27 | All Unknown |
| EU outermost regions | 9 | All Unknown; authoritative baseline sources are available but un-ingested |
| UK nations | 4 | All Unknown |
| United States | 50 states + District of Columbia | All Unknown |
| Canada | 10 provinces + 3 territories | All Unknown |
| Japan | 47 JIS prefectures | All Unknown |
| Norway | Mainland, Svalbard, Jan Mayen | All Unknown |
| Switzerland | Confederation + 26 cantons | All Unknown |

Territories outside the requested scope have explicit exclusion rows rather
than being silently dropped. See
[`territorial-scope.md`](territorial-scope.md).

## Coverage dimensions

The matrix assesses:

- protected areas;
- natural features;
- established trail routes;
- trail network;
- access points;
- scenic roads;
- transport connections;
- dynamic conditions;
- names and localization;
- accessibility;
- licensing and provenance;
- sensitive-location controls.

These dimensions are independent. For example, a jurisdiction can have an
authoritative protected-area source while its trail access, closures,
accessibility, or transport remain Unknown.

## Scotland depth

Scotland is its own `GB-SCT` jurisdiction rather than an attribute on a generic
UK record.

| Dimension | Initial matrix status | Evidence posture |
|---|---|---|
| Protected areas | Source available but not yet ingested | NatureScot and JNCC exact products still need accepted snapshots |
| Established routes | Source available but not yet ingested | Core Paths and route-custodian sources are not yet published by the application |
| Trail network | Source available but not yet ingested | Core Paths are a baseline, not every place where responsible access may be exercised |
| Access points | Source available but not yet ingested | Parking, trailheads, ferry ports, stations, and stops need geometry and operating validation |
| Transport | Source available but not yet ingested | NaPTAN/Traveline/rail/ferry/cable sources need schedule, validity, and accessibility QA |
| Dynamic conditions | Source available but not yet ingested | Traffic Scotland is registered; SAIS remains link-only until reuse terms are approved |
| Scenic roads | Unknown | No approved authoritative Scotland-wide scenic-drive definition |
| Sensitive locations | Unknown | Ecological and culturally sensitive publication controls are not yet validated |

Scotland’s responsible-access regime is not a routing permission flag. The
Land Reform (Scotland) Act framework has statutory exceptions; access
authorities, protected-area rules, temporary restrictions, land management,
hazards, and responsible behaviour remain relevant.

## Evidence required to promote a dimension

Promotion to a verified status requires a reproducible evidence report that
records:

- source registry IDs, exact release/service version, retrieval time, and raw
  snapshot hashes;
- source licence and attribution review date;
- records and geometry types by required subdivision and authority;
- route identity, line continuity, topology, direction, and out-of-jurisdiction
  error rates;
- duplicates and conflicting source assertions;
- legal access, mode, permit, and restriction evidence distinct from physical
  geometry;
- freshness and expiry for conditions, closures, schedules, and prices;
- accessibility-field completeness and unknown rates;
- sensitive-location suppression/coarsening results;
- quantified known gaps and a reviewer decision.

An adapter being present, a source endpoint returning `200`, or a large feature
count does not satisfy these gates.

## Roll-up rule

Country and regional roll-ups must stay **Unknown** until a reviewed release
defines its critical dimensions. A roll-up cannot be **Verified broad
coverage** when a required subdivision or critical dimension is below
**Verified partial coverage**. Excluded territory does not count as a gap when
the exclusion is explicit and in scope policy.

