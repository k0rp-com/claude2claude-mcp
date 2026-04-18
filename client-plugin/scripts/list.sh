#!/usr/bin/env bash
# List paired peers (synced from the server) and refresh local contacts cache.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
c2c::require_config
c2c::require_name

resp="$(c2c::call GET /v1/pairings)" || exit 1

# Refresh local contacts from the server-side truth.
echo "$resp" | jq '[.pairings[] | {id: .peer.id, name: .peer.name, fingerprint: .peer.fingerprint, paired_at: (.paired_at | tostring)}]' \
  | c2c::contacts_save

count="$(echo "$resp" | jq '.pairings | length')"
if [[ "$count" -eq 0 ]]; then
  echo "📭 No paired peers yet. Use /c2c-client:peer-pair <fingerprint> to add one."
  exit 0
fi

echo "$resp" | jq -r '.pairings | sort_by(.peer.name) | .[] |
  "  • \(.peer.name)  (id=\(.peer.id), fp=\(.peer.fingerprint))"'
