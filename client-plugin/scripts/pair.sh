#!/usr/bin/env bash
# Initiate pairing with another machine identified by its fingerprint.
# Usage: pair.sh <fingerprint-of-other-machine>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
c2c::require_config
c2c::require_name

if [[ $# -lt 1 ]]; then
  echo "Usage: peer-pair <other-fingerprint>" >&2
  echo "       (4-4-4 hex, e.g. 8410-6521-b45f — get from /c2c-client:peer-id on the other machine)" >&2
  exit 1
fi

FP="$1"
if ! [[ "$FP" =~ ^[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}$ ]]; then
  echo "ERROR: fingerprint must be 4-4-4 hex, e.g. 8410-6521-b45f" >&2
  exit 1
fi
FP_LC="$(echo "$FP" | tr 'A-F' 'a-f')"

# Look up target id.
lookup="$(c2c::call GET "/v1/lookup?fingerprint=$FP_LC")" || exit 1
TARGET_ID="$(echo "$lookup" | jq -r .machine.id)"
TARGET_NAME="$(echo "$lookup" | jq -r .machine.name)"

# Initiate pair request.
payload="$(jq -nc --arg id "$TARGET_ID" '{to_id:$id}')"
resp="$(c2c::call POST /v1/pair-request "$payload")" || exit 1

CODE="$(echo "$resp" | jq -r .code)"
EXPIRES_MS="$(echo "$resp" | jq -r .pair_request.expires_at)"
NOW_MS="$(c2c::now_ms)"
TTL_S=$(( (EXPIRES_MS - NOW_MS) / 1000 ))

cat <<EOF
🔑 Pair request sent to '$TARGET_NAME' ($FP_LC).

   Code:  $CODE
   Tell the user of '$TARGET_NAME' to run:
       /c2c-client:peer-confirm $CODE

   The code is valid for $TTL_S seconds.
   After they confirm, run:  /c2c-client:peer-list   (will show the new pairing).
EOF
