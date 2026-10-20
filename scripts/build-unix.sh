#!/bin/sh
set -eu

node_bin=${NODE:-node}
if ! command -v "$node_bin" >/dev/null 2>&1; then
  echo "Node.js 22.12.0 or newer is required (not found: $node_bin)." >&2
  exit 1
fi

node_version=$("$node_bin" -p 'process.versions.node' 2>/dev/null || true)
node_major=${node_version%%.*}
node_minor=${node_version#*.}
node_minor=${node_minor%%.*}
case "$node_major:$node_minor" in
  *[!0-9:]*|:*|*:) node_major=0; node_minor=0 ;;
esac
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 12 ]; }; then
  echo "Node.js 22.12.0 or newer is required (found: ${node_version:-unknown})." >&2
  exit 1
fi

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec "$node_bin" "$script_dir/build-app.mjs" "$@"
