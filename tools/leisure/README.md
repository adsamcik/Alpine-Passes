# Leisure graph build pipeline

Build the Phase 0 leisure-first planner graph with:

```powershell
node .\tools\leisure\build-leisure-graph.mjs
```

The builder reads `assets/js/passes-data.js`, `assets/js/*-pois.js`, `tools/leisure/junctions.json`, and reusable caches in `validation/cache/`, then writes `assets/data/leisure-graph.v1.json`.

Useful flags:

```powershell
node .\tools\leisure\build-leisure-graph.mjs --limit-n=80
node .\tools\leisure\build-leisure-graph.mjs --no-cache
```

Warm cache runs should complete in under 2 minutes. A cold run can take about 30 minutes because public OSRM, Overpass, and Open-Meteo calls are throttled, retried, and cached.

Pass IDs in the output are stable slugs derived from pass names, with a short hash appended on collisions. Public API caches still reuse the legacy ordinal cache keys internally so normal rebuilds do not re-fetch OSRM/Overpass data.

production builds should use a self-hosted OSRM CH; public OSRM is rate-limited and ToS-restricted; this script throttles to 1 RPS but is unsuitable for daily CI.

To grow beyond the current 300-node cap, raise `DEFAULT_LIMIT_N` or pass a larger `--limit-n`, then check `stats.gzipBytes`. Cold OSRM cost grows as `ceil(N/50)^2` table requests at 1 RPS, and Overpass cost grows linearly with selected passes. The build fails before writing the asset if gzip output exceeds 6 MB; reduce the cap or connector density if that happens.

Connector pruning is leisure-first: after the 300 km/finite-OSRM candidate gate, the builder keeps the 12 lowest-`leisureCost` neighbors rather than the 12 geographically closest so Phase 0 planners prefer scenic, lower-stress links.

Pass scenic weights use z-normalized pass/scenic features. POI connector scenic weights intentionally keep a bounded linear source-score/theme proxy because the POI source files do not include pass-style summit, glacier, or openness features.

Each pass is emitted as a top-level `kind: "pass"` node plus synthetic routing nodes: `<passId>:A` and `<passId>:B` as `kind: "pass-base"`, and `<passId>:S` as `kind: "pass-summit"`. Pass climbs are directed edges for both sides; descent edges keep the same distance as climbs but use a documented 0.85 duration/leisure-cost factor. Out-and-back visits are represented as direct `pass-out-and-back` self-loop edges (`A→A` and `B→B`) whose duration and leisure cost are forced to be strictly higher than traversing to the other side. Connector edges include `source: "osrm"` or `"fallback"` provenance.

Calibration is defined in `tools/leisure/calibration-truth.json`. The build gate checks the Spearman and hero-quartile thresholds from that file, reasserts the out-and-back invariant, verifies all edge endpoints resolve to real nodes, verifies edge cost fields are finite, and writes `assets/data/leisure-graph.v1.json` only after every gate passes.
