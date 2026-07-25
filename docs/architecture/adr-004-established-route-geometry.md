# ADR-004: Established route geometry is a distinct evidence-bearing asset

- Status: Accepted
- Date: 2026-07-26
- Decision scope: trails, walking routes, scenic drives, and itinerary legs

## Context

A destination point cannot describe a hike. Conversely, a routing engine’s generated line is not evidence that a named trail exists, is lawful, is open, or follows an official alignment. Legacy scenic-drive waypoint strings add a third case: useful overviews that may be too sparse for navigation.

Without explicit semantics, these geometries are easy to substitute for one another and can create a safety-critical misrepresentation.

## Decision

Every canonical `TrailRoute` declares all of the following:

- `routeNature`: `established`, `generated`, or `scenic_drive`;
- `geometryCompleteness`: `complete`, `partial`, or `overview_only`;
- `navigationSuitability`: explicit boolean;
- `journeyShape`: `loop`, `out_and_back`, `point_to_point`, `network`, or `stage`;
- at least one activity and an explicit access object.

An `established` route is accepted only with `geometryCompleteness: "complete"` and a `LineString` or `MultiLineString`. The validator also rejects consecutive vertices more than 50 km apart by default for complete established routes. This gap heuristic does not apply to legacy scenic-drive overviews or generated routing output.

“Complete” means that the record represents the entire intended named route or stage rather than a destination point or isolated excerpt. It does **not** mean survey-grade alignment, legal public access, current conditions, or suitability for navigation. Those claims require separate evidence. For example, the maintainer seed routes are intentionally generalized, unverified, marked `navigationSuitability: false`, and carry quality flags such as `not_navigation_grade` and `legal_access_unknown`.

Generated connector geometry belongs to an itinerary leg with `routeNature: "generated"`. It never overwrites the established geometry. Legacy scenic drives are migrated as `routeNature: "scenic_drive"`, `geometryCompleteness: "overview_only"`, and `navigationSuitability: false` until a qualified source supplies a suitable line.

## Geometry acceptance

A route contributor must provide:

1. source and record identity for the alignment;
2. licence/redistribution decision and required attribution;
3. coordinates in GeoJSON longitude/latitude order;
4. the whole named route/stage and its endpoints;
5. jurisdiction and delivery-region assignment;
6. original route grade plus any separately caveated normalized band;
7. access, conditions, restrictions, permits, hazards, and sensitivity as evidence or explicit unknowns;
8. a quality assessment date, confidence, verification status, and flags;
9. access-point and transport links as separate entities when applicable.

Validation is necessary but insufficient. Automated tests cannot prove that a polyline follows the path on the ground. Authoritative comparison or documented maintainer review is required before setting `navigationSuitability: true`.

## MultiLineString rule

A `MultiLineString` is appropriate only when discontinuity is real and explained—for example, a ferry or cable transfer represented by a linked `TransportConnection`, or separately managed route parts. It must not hide missing trail geometry. The current validator checks gaps inside each part but does not prove semantic continuity between parts; ingestion review owns that check.

## Consequences

The model can render named hikes as full lines, preserve their provenance, and compose them with driving, parking, walking connectors, transit, ferries, cable transport, or pickup. It also forces the product to surface when route alignment, access, or schedule evidence is absent.

The strict established-route rule means legacy hike points cannot be promoted by relabeling. They remain places/natural features with `route_geometry_missing` until a qualified route source is ingested.
