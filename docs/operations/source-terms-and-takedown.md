# Source terms review and takedown

This runbook covers a changed licence/API term, a rights complaint, accidental
publication from a blocked or discovery-only source, and media whose file-level
rights cannot be demonstrated. Safety corrections follow the same urgent
quarantine path, but do not replace the separate incident and stale-data rules.

## Scheduled terms review

For every ingest or runtime refresh:

1. Resolve the registered exact product, endpoint, licence version, and terms
   URL. A catalogue entry is not the product.
2. Compare the current terms and applicability statement with the reviewed
   snapshot. A publisher, endpoint, authentication, automation, caching,
   retention, redistribution, commercial-use, derivative, attribution,
   share-alike, or third-party exception change pauses refresh.
3. Confirm `publicationDisposition: approved` and that `approvedUses` contains
   the planned fact, bulk, geometry, media, runtime, or dynamic-status use.
4. Confirm the source still has no paid or subscription rights dependency and
   no noncommercial, no-derivatives, display-only, no-cache, or
   no-redistribution restriction.
5. Record reviewer, review time, exact release/version, retrieved time, and an
   immutable terms/evidence snapshot hash in the operational source record.
6. Resume only after the changed terms have an explicit accepted disposition.
   Previously accepted snapshots remain identifiable under the terms that
   applied when acquired; they are not silently refreshed under new terms.

Robots rules, a free API key, or continued technical access never substitutes
for this review.

## Intake and immediate response

Publish a monitored rights and safety contact. A report should request the
source ID, entity/media ID, claimant or authority, affected URL, asserted right
or safety issue, and supporting evidence, but an incomplete report does not
block urgent quarantine.

On a credible report:

1. Create an incident ID and timestamp the report.
2. Resolve every affected public artifact through source assertions, source
   record IDs, media IDs, and generated package manifests.
3. Set the source or item to quarantined/blocked in the operational control
   plane, stop scheduled refreshes, and disable runtime fetching.
4. Remove the affected item from public packages, search indexes, caches, CDN,
   offline exports, and media storage. Rebuild deterministic manifests and
   verify the old content-addressed URLs are no longer referenced.
5. Preserve the minimum evidence required for audit in restricted storage. Do
   not leave disputed media or sensitive coordinates in public logs, fixtures,
   debug artifacts, or repository history.
6. Notify known downstream/export consumers with incident ID, affected IDs,
   last valid build, removal time, and replacement guidance.

## Decision and reinstatement

Record the reviewed terms or ownership evidence, applicable jurisdiction,
decision maker, scope, rationale, notices owed, purge verification, and any
communications. Outcomes are `reinstate`, `replace_with_approved_source`,
`link_only`, or `blocked`.

Reinstatement requires the same build gates as a new source: exact approved
product, required `approvedUses`, accepted no-fee rights, current attribution,
per-file media rights where applicable, provenance, and a clean deterministic
rebuild. Do not reuse an old URL merely because the complaint was withdrawn.

## Verification checklist

- No blocked source ID occurs in a public assertion, manifest, package, search
  document, media asset, cache, or offline export.
- Discovery-only evidence remains unverified and cannot be the sole basis for a
  verified assertion.
- Media has an approved `media` source use plus creator, source page, exact
  licence/version, attribution, and modification record for that file.
- Generated third-party notices and in-product attribution match the rebuilt
  records.
- The incident record contains purge evidence and downstream notification
  status.
