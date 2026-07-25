# Licensing and attribution

The repository’s MIT licence covers project-authored software and documentation.
It does not prove that every third-party fact, database selection, route
geometry, description, photograph, map, or live feed can be redistributed.

The source registry records the current legal posture. Legal review applies to
the exact product and version, not merely its publisher or portal.

## Legal dispositions

Delivery code should distinguish:

- `redistributable`
- `link_only`
- `display_only`
- `permission_required`
- `unknown`

The current source schema expresses the closely related values `allowed`,
`allowed_with_attribution`, `restricted`, `prohibited`, and `unclear`.

Unclear rights fail closed: metadata may remain in the research registry, but
the content does not enter a redistributable public package.

## Common licence families

| Family | Product treatment |
|---|---|
| ODbL 1.0 | Attribute OpenStreetMap; preserve database/produced-work separation and satisfy database share-alike where triggered |
| CC0 / U.S. public domain | Attribution may not be legally required, but publisher, release, record ID, and retrieval metadata remain required for provenance; third-party content is excluded |
| CC BY 4.0 | Preserve creator/publisher, title where supplied, source URL, licence/version, and transformation notice |
| UK OGL 3.0 | Use the prescribed publisher attribution; do not imply endorsement; third-party rights, logos, and excluded IP remain outside the licence |
| Open Government Licence Canada | Attribute the information provider; exclude personal information, third-party rights, marks/logos, and other unlicensed IP |
| Japan Public Data Licence 1.0 | Attribute the source and identify edited/processed content; inspect third-party and API exceptions; GSI products can also involve Survey Act requirements |
| NLOD 2.0 | Attribute the Norwegian publisher and exact product; retain database/source notices and per-product exceptions |
| Swiss OGD/FSDI | Cite the exact federal/cantonal source, observe per-dataset restrictions and service fair use, and prefer bulk snapshots |
| Per-file media licences | Store licence/version, author, source page, attribution text, modification, and share-alike obligation for every asset |

## Important source-specific rules

### OpenStreetMap

The database is ODbL. A visible “© OpenStreetMap contributors” notice is
necessary but may not be sufficient for redistributed database derivatives.
The build must retain an OSM-specific lineage and document how share-alike
obligations are met.

### Wikidata

Structured data is CC0. Retain entity and statement provenance even though
legal attribution is not mandatory. A Wikidata statement is not automatically
verified or authoritative.

### Wikimedia Commons

Commons has no single media licence. Resolve and persist rights per file.
Hotlinking a `Special:FilePath` or thumbnail URL does not discharge attribution,
licence, share-alike, privacy, or personality-right obligations.

### EEA and INSPIRE

EEA products are generally made available under ODC-BY or similar terms unless
metadata says otherwise; national/third-party conditions can still apply.

INSPIRE publication, WMS view access, or catalog discovery is not a licence.
Approve the underlying product and its reuse terms.

### U.S. government data

Many federal employee works are public domain domestically, but this does not
automatically cover state, local, Tribal, contractor, foreign, trademarked, or
third-party material. Government-hosted media can retain third-party copyright.

### UK legal and map records

Only products explicitly released under OGL are treated as OGL. Paid Ordnance
Survey products are not OS OpenData. Great Britain products do not imply
Northern Ireland coverage.

An English or Welsh public-rights-of-way download can be an advisory snapshot;
the relevant authority’s definitive map/statement and legal orders remain the
legal record.

### Japan

Apply source and edited-data notices. Do not blanket-license the entire MLIT
National Land Numerical Information portal: each product carries its own
licence generation and exceptions.

### Norway

Kartverket, Naturbase, NVE, and NPRA products commonly use NLOD, but exact
product terms still control. Turrutebasen has distributed contributors and
requires owner-level attribution/completeness tracking.

### Switzerland

SwitzerlandMobility’s open route geometry does not make its descriptions,
photographs, maps, or partner point data open. SLF bulletin data is separately
CC BY 4.0. Swiss public transport exports have their own terms and operational
limitations.

### Blocked/link-only sources

- Protected Planet/WDPA is blocked from a redistributable commercial product
  without separate permission because its terms restrict commercial use and
  redistribution.
- Scottish Avalanche Information Service begins link-only because no approved
  automated redistribution licence was established.
- Commercial guide sites, route descriptions, mountain-weather sites, bothy
  collections, and operator pages must not be scraped merely because they are
  publicly viewable.

## Attribution generation

Every published entity keeps field-level source assertions. The package build
must derive:

- a compact in-product attribution panel;
- route/place/media-specific credits;
- API source metadata;
- downloadable dataset notices;
- `THIRD_PARTY_DATA_NOTICES.md`.

Attribution records include source ID, publisher, product/release, licence
name/version and URL, required wording, transformation notice, retrieved date,
and source record ID. Deduplicate notices for display without discarding
feature-level traceability.

## Review and change control

Store a terms-review date. A changed endpoint, publisher, product identifier,
licence, authentication scheme, or redistribution term blocks the next refresh
until reviewed. Previously accepted snapshots remain governed by the terms
applicable to their acquisition and must remain identifiable.

