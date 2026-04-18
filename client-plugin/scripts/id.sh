#!/usr/bin/env bash
# Show this machine's id, name, and fingerprint.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
c2c::require_config

NAME="$(c2c::name || true)"
if [[ -z "$NAME" ]]; then
  echo "name:        <not set — run /c2c-client:peer-name <name> first>"
  echo "machine_id:  $C2C_MACHINE_ID"
  exit 0
fi

# Pull canonical record (and fingerprint) from server.
resp="$(c2c::call GET /v1/me 2>/dev/null || echo '{}')"
fp="$(echo "$resp" | jq -r '.machine.fingerprint // empty')"

echo "name:        $NAME"
echo "machine_id:  $C2C_MACHINE_ID"
if [[ -n "$fp" ]]; then
  echo "fingerprint: $fp"
  echo
  echo "👉 Give this fingerprint to the OTHER machine to pair:"
  echo "   /c2c-client:peer-pair $fp"
else
  echo "fingerprint: <unknown — server unreachable or not registered yet>"
fi
