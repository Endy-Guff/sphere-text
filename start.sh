#!/usr/bin/env bash
set -euo pipefail
PORT="${1:-8765}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Sphere Typography: http://localhost:${PORT}"
exec python3 -m http.server "$PORT" --directory "$DIR"
