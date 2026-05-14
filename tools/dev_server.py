#!/usr/bin/env python3
"""Local development server for the Itinera static app.

Serves the repository root over HTTP with no-cache headers so edits to
JS/CSS/HTML show up on reload without bumping the `?v=` query string.

Examples:
    python tools/dev_server.py
    python tools/dev_server.py --port 9000
    python tools/dev_server.py --no-open
"""

from __future__ import annotations

import argparse
import http.server
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """Static file handler that forces revalidation on every request."""

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt: str, *args: object) -> None:  # noqa: A003 - parent signature
        sys.stderr.write("[dev-server] " + (fmt % args) + "\n")


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def _handler_factory(directory: Path):
    def build(*args, **kwargs):
        return NoCacheHandler(*args, directory=str(directory), **kwargs)
    return build


def main() -> int:
    parser = argparse.ArgumentParser(description="Itinera local dev server")
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on (default: 8765)")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically")
    parser.add_argument("--path", default="/index.html", help="Initial path to open (default: /index.html)")
    args = parser.parse_args()

    handler = _handler_factory(REPO_ROOT)

    try:
        httpd = ReusableTCPServer((args.host, args.port), handler)
    except OSError as exc:
        print(f"[dev-server] Cannot bind {args.host}:{args.port} — {exc}", file=sys.stderr)
        return 1

    url = f"http://{args.host}:{args.port}{args.path}"
    print(f"[dev-server] Serving {REPO_ROOT}")
    print(f"[dev-server] Listening at {url}")
    print("[dev-server] No-cache headers active. Press Ctrl+C to stop.")

    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[dev-server] Shutting down…")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
