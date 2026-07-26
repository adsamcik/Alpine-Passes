# Nature-travel taxonomy

## Purpose and status

This taxonomy is the product vocabulary for discovery, maps, ingestion, and itinerary planning. It separates **what something is**, **what a visitor can do**, **how a journey is shaped**, and **what evidence governs access and safety**.

The canonical schema and executable validator implement the entity and route primitives described below. The broader normalized category vocabulary is intentionally carried in `classifications`; it is a governed target vocabulary, not evidence that every category or jurisdiction is populated. Unknown and unpopulated are valid states.

## Canonical entity families

The schema supports these entity types:

| Family | Entity types | Purpose |
| --- | --- | --- |
| Discoverable geography | `Place`, `NaturalFeature`, `ProtectedArea` | Named destinations, physical nature features, and legally/administratively designated areas. |
| Established route structure | `TrailRoute`, `RouteStage`, `RouteVariant`, `TrailSegment` | Named routes, ordered stages, alternatives, and physical line segments. |
| Access and movement | `AccessPoint`, `TransportConnection` | Trailheads, parking/transfers, stations/landings, and linked ferry/bus/rail/cable/pickup movement. |
| Visitor support | `Amenity` | Huts, bothies, shelters, water, toilets, visitor centres, campsites, and other support features. |
| Time-dependent governance | `Condition`, `Restriction`, `PermitRequirement`, `OpeningSchedule`, `Price` | Current or scheduled state, legal/operational limits, booking/quota, hours, and cost. |
| Safety | `Hazard` | Exposure, snow, glacier, tide, wildlife, remoteness, navigation, and other hazard evidence. |
| Evidence and presentation | `MediaAsset`, `LocalizedName`, `Source`, `SourceAssertion`, `Geometry`, `QualityAssessment` | Traceable names, media, provenance, geometry, and uncertainty. |
| Territorial authority | `Jurisdiction` | Country, nation, state/province, prefecture, protected-area authority, Indigenous/Tribal, municipal, or unusual scope. |

Entity type is deliberately coarse. Do not add a new entity type for every user-facing category.

## Normalized discovery categories

Each classification has:

- `system`: the publisher or taxonomy namespace;
- `original`: the unmodified source classification;
- `normalized`: the stable Itinera discovery key.

Preserve all three. A normalized value never overwrites a source designation. Recommended normalized groups are:

| Group | Example normalized keys |
| --- | --- |
| Mountains and geology | `mountain`, `mountain_pass`, `volcano`, `caldera`, `canyon`, `gorge`, `cliff`, `cave`, `karst`, `rock_formation`, `natural_arch`, `glacier`, `icefield`, `geothermal_feature`, `desert`, `dune` |
| Inland water | `waterfall`, `lake`, `river`, `spring`, `wetland`, `marsh`, `reservoir` |
| Coast and islands | `beach`, `cove`, `coastline`, `headland`, `sea_cliff`, `island`, `fjord`, `sea_stack`, `tide_feature` |
| Habitats and seasonal nature | `forest`, `ancient_woodland`, `moorland`, `heath`, `meadow`, `wildflower_site`, `autumn_foliage`, `wildlife_observation_area`, `dark_sky_site` |
| Designated landscapes | `national_park`, `nature_reserve`, `protected_landscape`, `wilderness_area`, `geopark`, `marine_protected_area`, `natura_2000_site` |
| Views and experiences | `viewpoint`, `panorama`, `scenic_corridor`, `nature_interpretation_site` |
| Route experiences | `walking_route`, `hiking_route`, `long_distance_trail`, `scenic_drive`, `accessible_nature_route`, `winter_route`, `via_ferrata_route` |

This list can grow through review. Keys use lowercase `snake_case`, are singular where practical, and describe the feature rather than marketing language. “Hidden gem,” “must-see,” and “Instagrammable” are not categories.

Some records legitimately carry multiple classifications. A protected waterfall can be both `NaturalFeature` and classified as `waterfall`, while its enclosing `ProtectedArea` remains a separate entity connected by relationship data. Do not collapse an area boundary, a named feature, and a route into one record.

## Activities are not categories

`TrailRoute.activities` currently permits:

- `walking`
- `hiking`
- `scrambling`
- `via_ferrata`
- `snowshoe`
- `winter_walking`
- `scenic_driving`
- `accessible_nature`

Activities express intended use; they do not prove permission or suitability. Access modes are separately expressed as `car`, `foot`, `hiking`, `transit`, `ferry`, `cable_transport`, or `bicycle`. A hiking route may require a car access point and a ferry connection without becoming a driving or ferry route.

A new activity or access mode is a schema/API change. It requires validator, schema, adapter, discovery, itinerary, UI, accessibility-copy, and test updates. A new classification normally does not require a new entity type.

## Route semantics

A route is described along independent axes:

| Axis | Values | Meaning |
| --- | --- | --- |
| Nature | `established`, `generated`, `scenic_drive` | Source-backed named line, request-time routing result, or a driving experience. |
| Geometry completeness | `complete`, `partial`, `overview_only` | Extent represented, not positional accuracy or legal status. |
| Navigation suitability | boolean | Explicit publication decision; never inferred from line presence. |
| Journey shape | `loop`, `out_and_back`, `point_to_point`, `network`, `stage` | Visitor movement pattern. |
| Direction | `both`, `forward`, `reverse`, `one_way` | Directional constraint or recommendation. |

Established routes require complete line geometry. Scenic-drive overviews and generated legs do not masquerade as established trails. See [ADR-004](../architecture/adr-004-established-route-geometry.md).

Stages, variants, and segments remain separate concepts:

- a stage is an ordered subdivision of a named route;
- a variant is an alternative, approach, excursion, seasonal, accessible, or emergency option;
- a segment is a physical trail portion with surface/class/visibility attributes.

## Mixed-mode itinerary semantics

A mixed-mode itinerary composes evidence-bearing legs and connectors; it is not
a new route nature and does not change the identity of an established route.
Composition is allowed only when the established route geometry and every
required access or transport endpoint are current and verified, and current
competent evidence establishes legal use for the intended mode.

Every transfer between driving, parking/access, transport, and hiking requires
an explicit walking connector. Geographic proximity, a shared name, or a map
intersection is not a connector. A timed bus, rail, ferry, boat, cable, or
pickup leg additionally requires an exact IANA time zone, applicable service
calendar/date, a current sourced schedule, and exact usable departure times.

The endpoint chain must prove either return to the vehicle, a verified
different pickup, or an explicitly supported terminal endpoint. Point-to-point
plans must check last departures, closures, missed-connection margins, and
stranding risk. Unknown, stale, conflicting, or missing geometry, legality,
endpoints, connectors, schedule, departure, or return evidence causes refusal.
Generated drive, foot, or hiking geometry never substitutes for, repairs, or
overwrites an established route line.

## Difficulty and hazards

Difficulty retains `originalScale` and `originalGrade`. `normalizedBand`—`easy`, `moderate`, `strenuous`, `technical`, `expert`, or `unknown`—is for broad filtering only and requires a `normalizationCaveat` when equivalence could be misunderstood. Japanese, Swiss, Scottish, Norwegian, North American, and other grading systems are not exact universal conversions.

Hazards are independent entities or references, with kind and severity. Current kinds cover exposure, scrambling, assisted terrain, river crossing, snow, glacier, rockfall, tide, wildlife, heat, remoteness, and navigation. Absence of a hazard record does not mean no hazard exists.

## Access, restrictions, and support

Legal access is one of `legal`, `restricted`, `private`, or `unknown`. Default to `unknown` without current evidence. Model the following separately:

- route access by mode;
- trailhead or parking legality and stopping rules;
- private land and statutory access rights;
- seasonal/time-window/dog/one-way/permit/quota/environmental/safety restrictions;
- openings, fees, reservations, and permit requirements;
- bus, rail, ferry, boat, cable, gondola, funicular, cog railway, or pickup connections;
- shelters, huts, bothies, campsites, water, toilets, food, and emergency support.

A nearby car park, mapped path, protected-area boundary, or transit stop is not proof of usable access.

## Names and localization

Every entity has at least one localized name and a `primary` name. Name kinds are `primary`, `official`, `alternate`, `translated`, `romanized`, and `historic`. Language is a BCP 47 tag or `und`.

Store local-script endonyms and official romanization when available; add English as a translation, not a replacement. Normalized search removes case, diacritics, punctuation, and spacing differences for matching and duplicate detection, but the displayed source spelling is preserved. Do not add aliases that normalize to the same language/name pair.

Territorial and Indigenous naming disputes require multiple source assertions and neutral presentation rather than destructive selection.

## Famous and lesser-known discovery

Prominence is a ranking dimension, not a truth or category. The discovery model evaluates distinctiveness, regional uniqueness, evidence quality, lower visitor prominence, route compatibility, seasonal suitability, access fit, and itinerary variety.

A less-known place is eligible for “hidden” discovery only when evidence, distinctiveness, and access quality clear the configured gates. Obscurity alone is not merit. Unknown legal access reduces score; private access, sensitive redaction/exclusion, and unsuitable technical requirements can exclude a result. The UI must expose reasons and uncertainty, not just a scalar score.

Popularity signals can reproduce geographic and cultural bias. Review ranking outcomes by jurisdiction, language, rurality, disability access, source authority, and feature type. Do not suppress locally important or accessible experiences merely because they have fewer online mentions.

## Provenance, quality, and sensitivity

Every entity requires source assertions, a quality assessment, and a sensitivity action.

Evidence kinds range from `verified_official` through community, curated, derived, inference, estimate, unknown, stale, and needs-physical-verification. Verification is separately `verified`, `partially_verified`, `unverified`, `conflicting`, or `expired`. Confidence is a bounded assessment, not probability of safety.

Sensitivity action is `publish`, `coarsen`, `redact`, or `exclude`. Ecological, cultural/sacred, archaeological, Indigenous, private, and safety-sensitive locations are reviewed before public packaging. Never reconstruct precision that a source intentionally withheld.

## Taxonomy change control

A taxonomy change must document the user need, source examples across at least two relevant jurisdictions when possible, mapping from existing values, collision/deprecation behavior, labels and translations, icon/rendering impact, accessibility copy, discovery behavior, and test fixtures. Deprecate normalized keys through aliases/migrations; do not silently reinterpret previously published values.
