# ADR-002: Routing provider and trust boundary

- Status: Accepted
- Date: 2026-07-26
- Decision scope: generated car, walking, and hiking connectors

## Context

The legacy application calls the public OSRM demonstration service directly from browser code. That exposes the product to a third party’s capacity and policies, cannot protect credentials, and conflates driving route generation with established hiking-route content.

Walking, hiking, and driving profiles are not interchangeable. The planner must also distinguish stored route evidence from a route calculated for this request.

## Decision

Browser code depends on `RoutingGateway`, not on a vendor URL. The production provider is `SameOriginRoutingProvider`, normally rooted at `/api/routing/v1`. Its contract is:

- `POST /api/routing/v1/route` for a generated route;
- `POST /api/routing/v1/matrix` for distance/duration matrices;
- explicit profile values `car`, `foot`, and `hiking`;
- coordinates expressed as `[longitude, latitude]`;
- normalized route responses with GeoJSON `LineString`, metres, seconds, provider ID, and warnings.

`server/routing-worker.mjs` is the server-side trust boundary. Each profile has an independently configured OSRM-compatible upstream:

- `ROUTING_CAR_BASE_URL` or `ROUTING_CAR_UPSTREAM_URL`;
- `ROUTING_FOOT_BASE_URL` or `ROUTING_FOOT_UPSTREAM_URL`;
- `ROUTING_HIKING_BASE_URL` or `ROUTING_HIKING_UPSTREAM_URL`.

Each also supports a bounded provider ID, upstream-profile override, authorization/API-key secret, and timeout. Hiking never silently falls back to foot, and neither falls back to car.

The worker validates content type, allowed fields, coordinate bounds/counts, request and upstream body sizes, response geometry/matrix shape, timeouts, and profile configuration. It returns structured, request-ID-bearing, non-cacheable errors. Credentials are added server-side and are not accepted from or returned to the browser.

The current OSRM-compatible boundary rejects `avoid`, `constraints`, and time-dependent options with 422 because it cannot safely promise that they were honored. Capability growth must be explicit in provider metadata and tests.

## Demonstration provider policy

`LocalDemoOsrmProvider` is permitted only on a local hostname unless a caller explicitly opts into non-production use. The server worker permits `router.project-osrm.org` only when both an explicit flag is true and the environment is one of the named non-production environments. It is forbidden by default and in production.

The remaining direct `osrmTable` and `osrmRoute` functions in `assets/js/app.js` are legacy compatibility code, not the target production boundary. They must be migrated behind `installLegacyRoutingBridge` before the old path is removed.

## Stored routes versus generated routes

A routing response creates a generated connector or drive leg. It must not mutate or replace a canonical established `TrailRoute` geometry. Mixed itineraries keep established hike geometry and source assertion references intact, while generated legs retain the provider identity and warnings.

Transit, ferry, and cable records in the canonical model are evidence-bearing `TransportConnection` entities. The current routing worker is not a public-transport journey planner and does not make an unknown timetable operational.

## Consequences and limitations

The boundary allows provider replacement and keeps secrets off the client. It also creates a first-party availability, abuse, privacy, quota, and monitoring responsibility. Deployments need rate limiting at the edge, bounded logs, upstream terms review, request/latency/error metrics by profile, and a degraded UI when a profile is unavailable.

No current code proves that a configured upstream has suitable trail data, legal access, seasonal awareness, or outdoor safety. A mathematically returned hiking line is not an endorsement or an established route.
