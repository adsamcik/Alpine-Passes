# Territorial scope

This document states what geographic names such as “EU”, “United Kingdom”,
“United States”, “Norway”, and “Switzerland” mean for data extraction and
coverage reporting. The explicit machine-readable rows are in
[`data/jurisdictions/registry.v1.json`](../../data/jurisdictions/registry.v1.json).

## Included scope

### European Union

All 27 Member States have explicit jurisdiction rows.

The nine outermost regions are integral EU territory and require explicit
jurisdiction rows and separate operational scopes:

- France: Guadeloupe, French Guiana, Martinique, Mayotte, Réunion, and the
  French part of Saint-Martin;
- Portugal: Azores and Madeira;
- Spain: Canary Islands.

Åland is included under Finland with an autonomous, Swedish-language
jurisdiction row and operational scope. Ceuta and Melilla are included under
Spain with their own jurisdiction rows.

Cyprus is included, but records must state authority/control context. EU law is
suspended in the area where the Republic of Cyprus does not exercise effective
control; the system must not merge conflicting access or operating assertions
into an apparently uniform national rule.

### United Kingdom

England, Scotland, Wales, and Northern Ireland are included separately.
Great Britain-only sources must not be reported as Northern Ireland coverage.

### United States

The scope is exactly the 50 states and District of Columbia. State, federal,
Tribal, territorial, county, municipal, and private authority must remain
distinguishable in provenance and access decisions.

### Canada

All ten provinces and all three territories are included. Federal,
provincial/territorial, Indigenous, park, municipal, and private authority must
remain distinguishable. A land boundary or mapped line is not permission to
travel.

### Japan

All 47 JIS prefectures are included, including their administratively included
remote islands. Prefectures, municipalities, park authorities, transport
operators, and national agencies are separate source tiers.

### Norway

Mainland Norway, Svalbard, and Jan Mayen have separate jurisdiction rows and
operational scopes.
Svalbard and Jan Mayen must not inherit mainland right-to-roam, logistics, or
safety assumptions.

### Switzerland

Switzerland and all 26 cantons are included. German, French, Italian, and
Romansh source forms must be preserved where supplied.

## Explicit exclusions

| Excluded area | Reason |
|---|---|
| Faroe Islands and Greenland | Not part of the EU and not otherwise requested |
| EU-associated Overseas Countries and Territories | Associated with EU states but not EU territory |
| Jersey, Guernsey/Alderney/Sark, Isle of Man | Crown Dependencies, not part of the United Kingdom |
| UK Overseas Territories | Not part of the United Kingdom and not separately requested |
| Puerto Rico, U.S. Virgin Islands, Guam, Northern Mariana Islands, American Samoa, U.S. Minor Outlying Islands | Requested U.S. scope is 50 states plus DC |
| Bouvet Island and Norwegian Antarctic dependencies | Outside the requested practical Norway nature-travel scope |
| Liechtenstein | Separate sovereign state; can appear in Swiss cross-border products but was not requested |

Extractors must apply these exclusions to cross-border or federal source
imports. The presence of a feature in PAD-US, GNIS, swissNAMES3D, an OSM
extract, or another broad source does not silently expand product scope.

## Current public release state

The current public release contains one narrowly governed Alaska NPS pilot.
That pilot does not establish `Verified broad coverage` for Alaska, the United
States, or any other jurisdiction. No jurisdiction in the current public
release has `Verified broad coverage`.

Scotland has explicit jurisdiction, taxonomy, access-regime, transport, and
safety structure, but the governed public release is `Structurally supported
but unpopulated`. Scope rows describe inclusion and operational policy; they do
not claim that public records, routes, access facts, or transport schedules are
populated.

## Special operational scopes

The following areas require separate configuration even though they are
included:

- every EU outermost region;
- Åland, Ceuta, and Melilla;
- Alaska and Hawaii;
- Canadian northern territories;
- Tokyo’s Izu and Ogasawara islands;
- Japanese archipelagic prefectures and active-volcano regions;
- Svalbard and Jan Mayen;
- multilingual and high-alpine Swiss cantons;
- Scotland’s islands, ferries, access regime, avalanche areas, and remote
  transport.

A special operational scope can carry its own boundary, languages, authority
sources, transport modes, risk vocabulary, cache TTLs, sensitive-location
policy, and failure behaviour.

## Boundary policy

Use an authoritative versioned administrative boundary for extraction and
store its source/version. Never use the data feature’s own country tag as the
only jurisdiction test. Cross-border trails and protected areas should retain
all intersected jurisdictions and source assertions rather than being clipped
into unrelated duplicate identities.

Maritime, disputed, jointly managed, and controlled-area features require an
explicit authority assertion. The application must not present its scope
geometry as a legal position on sovereignty, navigation rights, or access.
