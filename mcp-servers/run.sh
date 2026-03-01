#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

# Whitelist of allowed server entry points (exact match)
case "${1:-}" in
  codex-server.ts|copilot-server.ts|cursor-server.ts|gemini-server.ts|quorum-server.ts|cli.ts) ;;
  *)
    echo "Usage: run.sh <server>" >&2
    echo "Allowed: codex-server.ts copilot-server.ts cursor-server.ts gemini-server.ts quorum-server.ts cli.ts" >&2
    exit 1
    ;;
esac

# Auto-install deps (or repair broken node_modules).
# Multiple servers launch concurrently — use mkdir as an atomic lock
# so only one instance runs npm install while the others wait.
TSX="$DIR/node_modules/.bin/tsx"
LOCKDIR="$DIR/.install-lock"

if ! "$TSX" --version >/dev/null 2>&1; then
  if mkdir "$LOCKDIR" 2>/dev/null; then
    # We acquired the lock — run install
    trap 'rm -rf "$LOCKDIR"' EXIT
    rm -rf "$DIR/node_modules"
    npm install --prefix "$DIR" --silent >&2
    rm -rf "$LOCKDIR"
    trap - EXIT
  else
    # Another process is installing — wait for it to finish
    while [ -d "$LOCKDIR" ]; do
      sleep 0.2
    done
  fi
fi

if ! "$TSX" --version >/dev/null 2>&1; then
  echo "tsx broken after npm install" >&2
  exit 1
fi

exec "$TSX" "$DIR/src/$1"
