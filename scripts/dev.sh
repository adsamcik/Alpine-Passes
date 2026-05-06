#!/usr/bin/env bash
# Starts the Alpine Passes local dev server.
# Thin wrapper around tools/dev_server.py — forwards all arguments.
#
# Usage:
#   ./scripts/dev.sh
#   ./scripts/dev.sh --port 9000
#   ./scripts/dev.sh --no-open
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/tools/dev_server.py"

python_bin=""
for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1; then
        python_bin="$candidate"
        break
    fi
done

if [ -z "$python_bin" ]; then
    echo "Python 3 is required but was not found on PATH." >&2
    exit 1
fi

cd "$repo_root"
exec "$python_bin" "$script" "$@"
