#!/usr/bin/env bash
# Example: health check + diagnostics
set -euo pipefail

echo "== /health =="
curl -sS http://127.0.0.1:4098/health
echo
echo
echo "== /diagnostics (text dashboard) =="
curl -sS -H "Accept: text/plain" http://127.0.0.1:4098/diagnostics
