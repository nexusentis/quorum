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

# Auto-install deps on first run
if [ ! -d "$DIR/node_modules" ]; then
  npm install --prefix "$DIR" --silent >&2
fi

TSX="$DIR/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "tsx not found at $TSX — run npm install first" >&2
  exit 1
fi

exec "$TSX" "$DIR/src/$1"
