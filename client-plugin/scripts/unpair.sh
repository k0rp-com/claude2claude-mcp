#!/usr/bin/env bash
# Remove a paired peer.
# Usage: unpair.sh <name | fingerprint | id>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
c2c::require_config
c2c::require_name

if [[ $# -lt 1 ]]; then
  echo "Usage: peer-unpair <name|fingerprint|id>" >&2
  exit 1
fi
QUERY="$1"
ID="$(c2c::resolve_name "$QUERY")"
if [[ -z "$ID" ]]; then
  # Try refreshing contacts then retry.
  bash "$SCRIPT_DIR/list.sh" >/dev/null 2>&1 || true
  ID="$(c2c::resolve_name "$QUERY")"
fi
if [[ -z "$ID" ]]; then
  echo "ERROR: no contact matches '$QUERY'. Run /peer-list to see your peers." >&2
  exit 1
fi

c2c::call DELETE "/v1/pairings/$ID" >/dev/null || exit 1
c2c::remove_contact "$ID"
echo "✅ unpaired '$QUERY'"
