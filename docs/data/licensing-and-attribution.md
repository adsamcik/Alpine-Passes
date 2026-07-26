# Licensing and attribution

The repository’s MIT licence covers project-authored software and documentation.
It does not prove that every third-party fact, database selection, route
geometry, description, photograph, map, or live feed can be redistributed.

The source registry records the current legal posture. Legal review applies to
the exact product and version, not merely its publisher or portal.

This is an engineering release policy, not a substitute for advice on a disputed
or novel use. It intentionally fails closed when the rights basis is unclear.

## Current release scope

The exact machine-readable notice for the public nature packages is
`assets/data/nature/source-release-notice.v1.json`, hash-bound by
`manifest.v1.json`. Build `502fbdf646728ce8` names only
`nps-public-trails`, contains two records and no media, and has
`releaseEligible: true`. The default builder processes 4,019 candidates but
withholds 4,017 records that reference non-approved sources and removes 1,436
uncleared media items before packaging.

That notice covers the generated nature delivery only. The retained legacy
JavaScript bundle contains separate migration material and must be cleared
source by source or excluded before public promotion. A non-release
`--include-unapproved-previews` build has `releaseEligible: false`.

## Primary authorities and product implications

- The [MIT licence](https://opensource.org/license/mit) grants rights in the
  copyright holder's software and associated documentation. It does not
  relicense third-party databases, facts, descriptions, geometry, maps, feeds,
  or media merely because they are stored beside the code.
- The EU [Database Directive
  96/9/EC](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:01996L0009-20190606)
  protects an original selection/arrangement and separately protects a
  qualifying maker's investment against extraction or re-utilisation of a
  substantial part and repeated systematic extraction of insubstantial parts.
  The 15-year database-right term can restart after substantial new investment.
- The EU [Open Data
  Directive](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32019L1024)
  is not a blanket licence for everything visible on a public portal. It
  excludes third-party-IP documents and preserves applicable privacy, access,
  and reuse conditions. The [European Data Portal
  FAQ](https://data.europa.eu/en/faq) confirms that its catalogue also harvests
  datasets carrying noncommercial licences.
- Current UK [copyright and database-right
  guidance](https://www.nationalarchives.gov.uk/terms-and-conditions/copyright/copyright-and-related-rights/)
  and the [Copyright and Rights in Databases Regulations
  1997](https://www.legislation.gov.uk/uksi/1997/3032/contents) require a
  database-right review for bulk or systematic extraction. UK copyright is
  automatic for original writing, web content, databases, and
  [photography](https://www.gov.uk/copyright).
- In the United States, the Copyright Office confirms that copyright does not
  protect facts, though it can protect their expression and a creative
  compilation ([FAQ](https://www.copyright.gov/help/faq/faq-protect.html),
  [Circular 33](https://www.copyright.gov/circs/circ33.pdf)). A bare fact may
  therefore be restated, but website/API terms and global distribution still
  require review.
- [17 USC 105](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title17-section105)
  generally removes US copyright protection from a US Government work, and
  [17 USC 101](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title17-section101)
  defines that term as official-duty work prepared by a federal officer or
  employee. Do not extend that posture to contractors, transferred works,
  state/local/Tribal material, marks, third-party content, or protection
  outside the United States without an exact agency basis.
- Online photographs remain separate works. The US Copyright Office's
  [Circular 42](https://copyright.gov/circs/circ42.pdf) describes the
  photographer's protected creative choices; the UK IPO's [digital image
  notice](https://www.gov.uk/government/publications/copyright-notice-digital-images-photographs-and-the-internet/copyright-notice-digital-images-photographs-and-the-internet)
  explains that missing copyright notices and public web display do not grant
  copying rights.

## Government and community licences

These licences are compatible with a zero-paid-rights product only when the
exact dataset, service response, or file states that the licence applies and
all exceptions have been checked:

- [UK Open Government Licence
  3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/):
  commercial copying, adaptation, and distribution with attribution; personal
  data, unlicensed third-party rights, logos/marks, and other listed material
  are excluded. [Scottish Government Crown
  copyright](https://www.gov.scot/crown-copyright/) follows OGL for covered
  material but calls out third-party photographs and separately hosted media.
- [Open Government Licence - Canada
  2.0](https://open.canada.ca/en/open-government-licence-canada): commercial
  copying, modification, and distribution with attribution; personal
  information, unlicensed third-party rights, official symbols, and other IP
  are excluded. Preserve the version in force when the information was
  accessed.
- Japan [Public Data Licence
  1.0](https://www.digital.go.jp/en/resources/open_data/public_data_license_v1.0):
  commercial copying and modification with source and edit notices, subject to
  alternate-item terms, third-party/portrait/publicity rights, API-provider
  terms, and specific laws. GSI states that some survey-result reuse can still
  require a [Survey Act
  procedure](https://www.gsi.go.jp/ENGLISH/page_e30236.html).
- Norway [NLOD
  2.0](https://data.norge.no/nlod/en/2.0): no-fee worldwide copying,
  modification, and distribution for any purpose with attribution and change
  notices; personal, confidential, unlicensed third-party, and other-IP
  material is excluded and mistakenly released excluded information must stop
  being used and be erased. Kartverket's [product
  terms](https://www.kartverket.no/en/api-and-data/terms-of-use) also identify
  restricted service layers and external sources.
- Switzerland's [national portal use
  symbols](https://opendata.swiss/en/terms-of-use) vary per dataset and include
  commercial-use-with-permission variants, so portal presence is not approval.
  [swisstopo OGD
  terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices)
  permit commercial processing and redistribution of covered geodata with a
  mandatory source notice, while excessive service use can be restricted.
- [OpenStreetMap](https://www.openstreetmap.org/copyright) data is ODbL 1.0.
  Review the OSMF [legal
  FAQ](https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ) and the
  [ODbL legal text](https://opendatacommons.org/licenses/odbl/1-0/) for
  attribution, derivative-database share-alike, and machine-readable offer
  duties. Data rights do not turn OSMF services into a free production backend:
  the official [tile](https://operations.osmfoundation.org/policies/tiles/)
  and [Nominatim](https://operations.osmfoundation.org/policies/nominatim/)
  policies restrict bulk/offline/systematic use.

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
the underlying copied data, text, exact third-party geometry, and media do not
enter a redistributable public package. The default build withholds records
that reference `lead_only` or `link_only` sources; it does not infer that
minimal metadata is independently authored and rights-safe.

An explicit non-release preview may expose candidate material for local
migration review, but its generated notice is not release eligible.
Project-authored material can be covered by the user-confirmed repository MIT
licence only to the extent the project owns it; third-party-derived fields and
media retain their own terms. A lead is not a verified quality, access, or
safety recommendation.

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
applicable to their acquisition and must remain identifiable. Follow the
[source terms and takedown runbook](../operations/source-terms-and-takedown.md)
for a changed term, rights complaint, accidental publication, quarantine,
purge, downstream notification, and controlled reinstatement.
