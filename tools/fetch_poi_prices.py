#!/usr/bin/env python3
"""Refresh the cached POI starting-prices JSON.

Reads the POI list from ``assets/js/swiss-pois.js`` and the cached prices
from ``assets/data/poi-prices.json``. For every cache entry tagged
``source_kind: "wikidata"`` the script attempts to refresh the value from
Wikidata's price property (P2284). Entries tagged ``source_kind: "manual"``
are NEVER overwritten — they are the human-curated baseline.

Critical safety guarantees (preserve persistent fallback data):

* If parsing the POI source file fails, the script aborts without writing.
* Per-POI fetch failures are caught and reported; the existing cache entry
  is preserved.
* If the network is fully unreachable and zero entries succeed, no entries
  are dropped — the script always rewrites the JSON with the *merged*
  state (existing + any successes), never a wiped-out version.
* Output is sorted alphabetically by POI name and uses stable indentation
  so commits to the cache produce minimal, reviewable diffs.

Run locally:

    python tools/fetch_poi_prices.py

CI:

    .github/workflows/refresh-poi-prices.yml schedules a weekly run and
    commits the refreshed JSON if anything changed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
POI_SOURCE = REPO_ROOT / "assets" / "js" / "swiss-pois.js"
CACHE_FILE = REPO_ROOT / "assets" / "data" / "poi-prices.json"

USER_AGENT = (
    "AlpinePasses-PriceRefresher/1.0 "
    "(+https://github.com/adsamcik/Alpine-Passes; price cache refresher)"
)

# Wikidata QID for the Swiss franc (P2284 price unit). Only CHF claims are
# accepted to avoid stale FX conversions polluting the cache.
WIKIDATA_QID_CHF = "Q4916"

# Network retry / rate-limit settings.
HTTP_TIMEOUT_SEC = 15
INTER_REQUEST_DELAY_SEC = 0.4  # be polite to Wikidata


# ────────────────────────── POI source parsing ──────────────────────────
def parse_poi_source(text: str) -> list[dict[str, Any]]:
    """Extract POI dicts from the ``swiss-pois.js`` file.

    The file declares ``const SWISS_POIS = [ {...}, {...}, ... ];`` where
    each object literal is JSON-compatible. Rather than a full JS parse,
    we slice the array body and feed it to ``json.loads`` after stripping
    trailing commas. This is robust to whitespace and quoting changes
    that don't break JSON compatibility.
    """
    start = text.find("const SWISS_POIS")
    if start < 0:
        raise ValueError("Could not find `const SWISS_POIS` in source file")
    bracket_open = text.find("[", start)
    if bracket_open < 0:
        raise ValueError("Could not find array opener after SWISS_POIS")

    depth = 0
    end = -1
    in_string = False
    escape = False
    for i in range(bracket_open, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end < 0:
        raise ValueError("Unterminated SWISS_POIS array")

    body = text[bracket_open : end + 1]
    body = re.sub(r",(\s*[\]}])", r"\1", body)
    return json.loads(body)


# ─────────────────────────── cache I/O ────────────────────────────────
def load_cache() -> dict[str, Any]:
    if not CACHE_FILE.exists():
        return {
            "schema_version": 1,
            "currency": "CHF",
            "last_refreshed_at": None,
            "entries": {},
        }
    return json.loads(CACHE_FILE.read_text(encoding="utf-8"))


def write_cache(cache: dict[str, Any]) -> None:
    cache.setdefault("schema_version", 1)
    cache.setdefault("currency", "CHF")
    cache["last_refreshed_at"] = (
        dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )
    entries = cache.get("entries", {})
    sorted_entries = {k: entries[k] for k in sorted(entries.keys(), key=str.casefold)}
    cache["entries"] = sorted_entries

    text = json.dumps(cache, indent=2, ensure_ascii=False, sort_keys=False)
    CACHE_FILE.write_text(text + "\n", encoding="utf-8")


# ───────────────────────── Wikidata fetch ────────────────────────────
def http_get_json(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status} for {url}")
        return json.loads(resp.read().decode("utf-8"))


def resolve_wikidata_qid(wiki_lang: str, wiki_title: str) -> str | None:
    """Resolve a Wikipedia article to its Wikidata QID via pageprops."""
    if not wiki_title:
        return None
    api = (
        f"https://{wiki_lang}.wikipedia.org/w/api.php"
        f"?action=query&prop=pageprops&format=json&redirects=1"
        f"&titles={urllib.parse.quote(wiki_title)}"
    )
    data = http_get_json(api)
    pages = data.get("query", {}).get("pages", {})
    for _, page in pages.items():
        qid = page.get("pageprops", {}).get("wikibase_item")
        if qid:
            return qid
    return None


def fetch_wikidata_price_chf(qid: str) -> tuple[float, str] | None:
    """Return (amount, source_url) for P2284 in CHF, or None.

    Only CHF-denominated price claims are accepted. Other currencies are
    intentionally ignored to avoid stale FX conversions in the cache.
    """
    api = (
        f"https://www.wikidata.org/w/api.php"
        f"?action=wbgetclaims&format=json&entity={urllib.parse.quote(qid)}&property=P2284"
    )
    data = http_get_json(api)
    claims = data.get("claims", {}).get("P2284") or []
    for claim in claims:
        ms = claim.get("mainsnak", {})
        if ms.get("snaktype") != "value":
            continue
        dv = ms.get("datavalue", {}).get("value", {})
        unit_url = str(dv.get("unit", ""))
        unit_qid = unit_url.rsplit("/", 1)[-1] if unit_url else ""
        if unit_qid != WIKIDATA_QID_CHF:  # CHF only
            continue
        amount_str = str(dv.get("amount", "")).lstrip("+")
        try:
            amount = float(amount_str)
        except ValueError:
            continue
        if amount <= 0:
            continue
        source_url = f"https://www.wikidata.org/wiki/{qid}#P2284"
        return amount, source_url
    return None


# ─────────────────────────── main loop ────────────────────────────────
def refresh(*, dry_run: bool = False) -> int:
    if not POI_SOURCE.exists():
        print(f"[refresh] POI source not found: {POI_SOURCE}", file=sys.stderr)
        return 1

    text = POI_SOURCE.read_text(encoding="utf-8")
    try:
        pois = parse_poi_source(text)
    except Exception as e:
        print(f"[refresh] Parse failure (cache untouched): {e}", file=sys.stderr)
        return 2

    if not pois:
        print("[refresh] No POIs parsed (cache untouched). Aborting.", file=sys.stderr)
        return 3

    cache = load_cache()
    entries = cache.setdefault("entries", {})

    by_name = {p.get("n"): p for p in pois if p.get("n")}

    stats = {"updated": 0, "preserved_manual": 0, "preserved_failure": 0, "skipped_no_entry": 0}

    for name, entry in list(entries.items()):
        kind = entry.get("source_kind")
        if kind != "wikidata":
            stats["preserved_manual"] += 1
            continue

        poi = by_name.get(name)
        if not poi:
            print(f"[refresh] Cache entry for unknown POI: {name!r}", file=sys.stderr)
            continue

        wiki_lang = poi.get("wl") or "en"
        wiki_title = poi.get("wt") or ""

        try:
            qid = resolve_wikidata_qid(wiki_lang, wiki_title)
            time.sleep(INTER_REQUEST_DELAY_SEC)
            if not qid:
                stats["preserved_failure"] += 1
                continue
            res = fetch_wikidata_price_chf(qid)
            time.sleep(INTER_REQUEST_DELAY_SEC)
            if not res:
                stats["preserved_failure"] += 1
                continue
            amount, source_url = res
            entry["kind"] = "paid"
            entry["from_adult_chf"] = round(amount, 2)
            entry["source_url"] = source_url
            entry["source_kind"] = "wikidata"
            entry["verified_at"] = dt.date.today().isoformat()
            entry.setdefault("as_of", str(dt.date.today().year))
            stats["updated"] += 1
        except Exception as e:
            print(f"[refresh] Wikidata fetch failed for {name!r}: {e}", file=sys.stderr)
            stats["preserved_failure"] += 1

    print(
        "[refresh] Done — updated={updated} preserved_manual={preserved_manual} "
        "preserved_failure={preserved_failure}".format(**stats)
    )

    if dry_run:
        print("[refresh] Dry-run: cache file not written.")
        return 0

    write_cache(cache)
    print(f"[refresh] Wrote {CACHE_FILE.relative_to(REPO_ROOT)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run the refresh logic but do not write the cache file.",
    )
    args = parser.parse_args(argv)
    return refresh(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
