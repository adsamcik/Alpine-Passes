# Third-party data notices

Status date: 2026-07-25.

This is a registry-level notice for sources that may contribute to future
builds. It is not a claim that every listed source has been ingested or that
the current application has verified coverage. Release tooling should generate
a snapshot-specific notice containing only sources and media actually shipped.

## Current legacy data

The repository contains legacy Alpine pass, curated POI, scenic-drive, and
manual seed-route material. Its rights and provenance are mixed:

- OpenStreetMap-origin facts require ODbL compliance and attribution.
- Wikipedia/Wikidata references do not determine the rights of copied text,
  images, or other databases.
- Wikimedia Commons media rights are per file.
- Maintainer-authored material can be covered by the repository licence, but
  upstream geometry, facts, and media retain their own conditions.

These legacy collections remain **Unknown** for coverage and are not approved
as authoritative source snapshots.

## Registered source notices

### OpenStreetMap

Contains information from OpenStreetMap, which is made available under the
[Open Database License](https://www.openstreetmap.org/copyright).

Attribution: **© OpenStreetMap contributors**.

### Wikidata

Wikidata structured data is available under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Entity and
statement identifiers are retained for provenance.

### Wikimedia Commons

Media is governed by the licence shown on each file page. Author, source,
licence/version, attribution, modification, and share-alike requirements must
be recorded and displayed per asset.

### European Environment Agency

Natura 2000 and other EEA products use the
[EEA data policy](https://www.eea.europa.eu/en/datahub/eea-data-policy), normally
ODC-BY or similar unless exact release metadata states otherwise. Attribute the
EEA and contributing national authorities as specified by the release.

### United States federal sources

Registered sources include USGS PAD-US, GNIS, National Digital Trails, U.S.
Forest Service Enterprise Data, and the National Park Service API. Federal
public-domain or CC0 status applies only where the exact product states it;
third-party, state, local, Tribal, contractor, trademark, and media rights are
not waived.

Suggested provenance credit: **U.S. Geological Survey** and/or the named
federal and contributing authority.

### Government of Canada

Registered sources include CPCAD, CGNDB, Open Maps, and GEO.ca. Products
explicitly under the
[Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada)
require information-provider attribution and exclude personal information,
third-party rights, marks/logos, and other unlicensed IP.

### United Kingdom

Products explicitly released under the
[Open Government Licence 3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)
require the named publisher’s attribution and must not imply endorsement.
Registered families include OS OpenData, JNCC, NaPTAN, Scotland Core Paths,
DataMapWales products, OpenDataNI, and devolved agency data.

Traffic Scotland feeds carry feed-specific registration, attribution, and
reuse conditions. Scottish Avalanche Information Service content is link-only
until automated reuse terms are approved.

### Japan

GSI, MLIT, MOE, and JMA products can use the
[Japan Public Data Licence 1.0](https://www.digital.go.jp/en/resources/open_data/public_data_license_v1.0)
or product-specific terms. Attribute the exact authority and product and state
when content has been edited. Third-party exceptions and GSI Survey Act
requirements remain applicable.

### Norway

Kartverket, Naturbase, NVE, and NPRA products commonly use the
[Norwegian Licence for Open Government Data 2.0](https://data.norge.no/nlod/en/2.0).
Attribute the exact publisher/product. Turrutebasen also requires preservation
of its distributed route custodian.

### Switzerland

swisstopo products use Swiss federal OGD/FSDI terms and require exact source
citation. SwitzerlandMobility open route geometry requires:
**Federal Roads Office, canton, SwitzerlandMobility Foundation**.
Descriptions, photographs, maps, and partner point data have separate rights.

SLF avalanche data is available under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) with attribution to
the **WSL Institute for Snow and Avalanche Research SLF**.

Swiss public-transport exports require the current platform/operator
attribution and terms.

## Prohibited pending permission

[Protected Planet / WDPA](https://www.protectedplanet.net/en/legal) is not an
approved redistributable source for this product. Commercial use and
redistribution are restricted without separate permission; national open
protected-area sources take precedence.

## Release requirement

Before distribution, generate notices from the exact accepted source snapshots
and media manifests. If the generated notice and the shipped artifacts differ,
the release fails.
