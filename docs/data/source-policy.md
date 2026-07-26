# Data source policy

The source registry is
[`data/sources/registry.v1.json`](../../data/sources/registry.v1.json), validated
against
[`schemas/source-registry.schema.json`](../../schemas/source-registry.schema.json).

## Source versus catalogue

A catalogue or geoportal is a discovery aid. It is not an approved product
source unless the registry also identifies:

- the exact dataset/service and publisher;
- retrieval endpoint and format;
- stable release or snapshot strategy;
- licence URL, attribution, commercial/derivative/redistribution posture, and
  third-party exclusions;
- schema assumptions and known gaps;
- authentication, rate limits, update cadence, and failure behaviour.

INSPIRE, CKAN, DCAT, ArcGIS Hub, WMS/WFS, GeoJSON, GTFS, NeTEx, SIRI, and
DATEX II describe discovery, transport, or format. None is a reuse licence.

## Authority order

Use evidence at field level, not a destructive one-source-wins merge. Default
preference is:

1. current law, regulation, official restriction, or operating notice;
2. authoritative land, park, transport, rescue, road, or mapping agency;
3. official national/regional/local open-data product;
4. established openly licensed geodata aggregation;
5. OpenStreetMap or another structured community source;
6. maintained route organisation or official tourism source;
7. manual curation.

The most authoritative source is not automatically the freshest or most
detailed. Preserve conflicting assertions, observation and validity times,
authority, and confidence so the decision can be audited.

## Source lifecycle

Operational metadata should track these states separately from jurisdiction
coverage:

- `candidate`
- `reviewed`
- `approved`
- `adapter_ready`
- `snapshot_validated`
- `published`
- `blocked`
- `retired`

“Source available but not yet ingested” normally corresponds to a reviewed or
approved exact source with no accepted published snapshot. It is not a synonym
for `published`.

## Acceptance gate

Before a source can contribute to a production package:

1. Resolve the exact publisher, product, version, endpoint, and terms.
2. Confirm commercial use, derivatives, redistribution, attribution,
   share-alike, database rights, and third-party exceptions.
3. Acquire an immutable raw snapshot or retain the required content hash,
   request parameters, response metadata, and retrieval time.
4. Validate format, CRS/axis order, geometry, stable IDs, encoding,
   localization, null semantics, classifications, and effective dates.
5. Measure subdivision presence, out-of-scope records, duplicates, topology,
   line continuity, source-identifier completeness, and known omissions.
6. Map fields without discarding the publisher’s original classification.
7. Apply sensitive-location coarsening, redaction, or exclusion before public
   packaging.
8. Produce licence/attribution notices and a coverage evidence report.
9. Obtain reviewer approval before promotion.

## Routes and access

Keep these independent:

- route identity and ordered line geometry;
- physical trail/road segments;
- legal access by mode and date;
- permits, opening schedules, fees, and booking;
- closures and restrictions;
- difficulty and hazards;
- accessibility;
- transport connections and service validity.

A route line is not permission. A protected-area boundary is not permission.
A Scotland access right is not a promoted-route guarantee. A USFS MVUM
designation is not proof a road is physically passable. A transit stop is not
proof a useful service operates at the requested time.

Difficulty systems must preserve the original authority scale and edition.
Japan’s prefectural and park systems must not be represented as exact universal
equivalents.

## Dynamic and safety-critical data

Conditions, closures, weather, avalanche, fire, flood, tide, volcano, permits,
prices, and transport service must store:

- source and source record;
- issued, observed, retrieved, valid-from, valid-until, and expiry times;
- affected geometry or authority area;
- official/community status;
- original classification and normalized display classification;
- stale/failure behavior.

Expired data cannot be labeled current. For safety-critical sources, failure
must produce `unknown`/unavailable state rather than serving a stale bulletin
as current. Community observations such as Regobs remain visibly distinct from
official forecasts.

## Failure isolation

Every adapter writes into a source-specific staging area. A source failure must
not roll back or corrupt other sources. Publication consumes only accepted
snapshots.

`serveLastKnownGood` means a dated snapshot may remain available; it does not
authorize showing time-sensitive facts as current. The UI and API must expose
freshness.

## OpenStreetMap

Use versioned PBF/replication sources for bulk work. Do not depend on public
tiles, Nominatim, Overpass, or other community production endpoints as a free
backend.

Keep OSM-derived databases and provenance identifiable enough to meet ODbL
attribution and share-alike duties. OSM is a valuable fallback and topology
source, not an authoritative declaration of legal/current access.

## Manual and legacy sources

`legacy-alps-osm`, `legacy-curated-pois`, `legacy-scenic-drives`, and
`manual-seed-routes` are isolated migration inputs. They do not establish
verified coverage.

Promote an individual legacy feature only after:

- source facts and geometry are separated;
- authoritative identifiers and current access evidence are attached;
- text/media rights are reviewed;
- full route geometry replaces point-only hiking representation where
  applicable;
- provenance and quality assertions are complete.

## Sensitive locations

Never increase the precision of a source-obscured coordinate. Authority
instructions can require publication, coarsening, redaction, or exclusion.
Sensitive ecological, Indigenous, cultural/sacred, archaeological, private,
and safety-related data is processed before public export, including logs and
debug artifacts.
