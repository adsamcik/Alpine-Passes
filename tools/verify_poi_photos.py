"""Spot-check Wikimedia Commons hero photo URLs for curated POIs.

Curated datasets may contain `bp` URLs gathered during research. This script
HEAD-checks every configured URL and reports failures.

Usage:
    python tools/verify_poi_photos.py [--country IT|CH|FR|AT|GB|IE|all] [--limit N]

Exit code: 0 if all URLs resolve (HTTP 200/302), 1 if any fail.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
POI_FILES = {
    "CH": (REPO_ROOT / "assets/js/swiss-pois.js",   "SWISS_POIS"),
    "FR": (REPO_ROOT / "assets/js/french-pois.js",  "FRENCH_POIS"),
    "IT": (REPO_ROOT / "assets/js/italy-pois.js",   "ITALY_POIS"),
    "AT": (REPO_ROOT / "assets/js/austrian-pois.js","AUSTRIAN_POIS"),
    "GB": (REPO_ROOT / "assets/js/uk-pois.js",      "UK_POIS"),
    "IE": (REPO_ROOT / "assets/js/irish-pois.js",   "IRISH_POIS"),
}
USER_AGENT = (
    "AlpinePasses-PhotoVerifier/1.0 "
    "(+https://github.com/adsamcik/Alpine-Passes; URL liveness check)"
)
TIMEOUT = 10.0
WORKERS = 2  # Wikimedia rate-limits aggressively; keep parallelism low.
INTER_REQUEST_DELAY = 0.25  # seconds between requests per worker


def parse_pois(path: Path, const_name: str) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    needle = f"const {const_name}"
    start = text.find(needle)
    bo = text.find("[", start)
    depth, end, in_str, esc = 0, -1, False, False
    for i in range(bo, len(text)):
        ch = text[i]
        if in_str:
            if esc: esc = False
            elif ch == "\\": esc = True
            elif ch == '"': in_str = False
            continue
        if ch == '"': in_str = True
        elif ch == "[": depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0: end = i; break
    body = text[bo:end+1]
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    body = re.sub(r",(\s*[\]}])", r"\1", body)
    return json.loads(body)


def head_check(url: str, retries: int = 3) -> tuple[int, str]:
    """Return (status_code, final_url). 0 indicates network error.

    Wikimedia frequently returns 429 (rate-limit) and occasionally 405
    (Method Not Allowed) on HEAD. We retry 429 with exponential backoff,
    and fall back to a tiny GET range request on 405.
    """
    for attempt in range(retries):
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.status, r.geturl()
        except urllib.error.HTTPError as e:
            if e.code == 405:
                # Wikimedia sometimes 405s on HEAD — try a tiny GET.
                try:
                    req2 = urllib.request.Request(
                        url,
                        headers={"User-Agent": USER_AGENT, "Range": "bytes=0-15"},
                    )
                    with urllib.request.urlopen(req2, timeout=TIMEOUT) as r:
                        return r.status, r.geturl()
                except Exception as e2:
                    return getattr(e2, "code", 0), str(e2)[:80]
            if e.code == 429 and attempt < retries - 1:
                # Polite backoff: 2s, 4s, 8s
                time.sleep(2 ** (attempt + 1))
                continue
            return e.code, str(e)[:80]
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            return 0, str(e)[:80]
    return 0, "exhausted retries"


def head_check_with_throttle(url: str) -> tuple[int, str]:
    """Sleep then HEAD-check (one delay per call to bound aggregate QPS)."""
    time.sleep(INTER_REQUEST_DELAY)
    return head_check(url)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--country", default="IT", choices=["CH","FR","IT","AT","all"])
    parser.add_argument("--limit", type=int, default=0, help="0 = no limit")
    parser.add_argument("--full", action="store_true", help="Equivalent to --limit 0")
    args = parser.parse_args()

    countries = list(POI_FILES.keys()) if args.country == "all" else [args.country]
    pois = []
    for cc in countries:
        path, name = POI_FILES[cc]
        if not path.exists():
            print(f"[verify] {cc}: {path.name} not found, skipping", file=sys.stderr)
            continue
        batch = parse_pois(path, name)
        print(f"[verify] {cc}: {len(batch)} POIs in {path.name}")
        pois.extend((cc, p) for p in batch)

    limit = 0 if args.full else args.limit
    if limit > 0:
        # deterministic sample: every Nth so coverage spans the whole list
        step = max(1, len(pois) // limit)
        pois = pois[::step][:limit]
        print(f"[verify] Sampling {len(pois)} POIs (every {step}th)")

    failures: list[tuple[str, str, str, int, str]] = []  # cc, name, url, status, msg
    redirects: list[tuple[str, str, str, str]] = []

    print(f"[verify] HEAD-checking {len(pois)} URLs with {WORKERS} workers (~{INTER_REQUEST_DELAY}s/req throttle) ...")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(head_check_with_throttle, p["bp"]): (cc, p) for cc, p in pois if p.get("bp")}
        for i, fut in enumerate(as_completed(futs), 1):
            cc, p = futs[fut]
            status, info = fut.result()
            url = p["bp"]
            if status == 200:
                if info != url:  # final URL differs (redirect followed)
                    redirects.append((cc, p["n"], url, info))
            else:
                failures.append((cc, p["n"], url, status, info))
                print(f"  [{i}/{len(futs)}] FAIL {status} — {cc} | {p['n']}: {info}")
    dt = time.time() - t0

    print(f"\n[verify] Done in {dt:.1f}s. Checked {len(futs)} URLs.")
    print(f"[verify] Failures: {len(failures)}, redirects: {len(redirects)}, ok: {len(futs) - len(failures)}")

    if failures:
        print(f"\n=== Failures ({len(failures)}) ===")
        for cc, name, url, status, msg in failures:
            print(f"  [{cc}] {name}")
            print(f"      url: {url}")
            print(f"      {status}: {msg}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
