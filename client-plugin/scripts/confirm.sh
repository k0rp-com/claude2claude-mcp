#!/usr/bin/env bash
# Accept an incoming pair request by entering the code shown on the other side.
# Usage: confirm.sh <4-digit-code>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
c2c::require_config
c2c::require_name

# Harness-safe: if called with a single quoted $ARGUMENTS, re-split into tokens
# via word-split only (no eval).
if [[ $# -eq 1 && "$1" == *[[:space:]]* ]]; then
  read -ra _a <<<"$1"
  set -- "${_a[@]}"
fi
if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "Usage: peer-confirm <6-digit code> [request_id]" >&2
  exit 1
fi
CODE="$1"
if ! [[ "$CODE" =~ ^[0-9]{6}$ ]]; then
  echo "ERROR: code must be exactly 6 digits" >&2
  exit 1
fi

# Find a pending incoming pair request. If multiple, ask user to be specific by id.
pending="$(c2c::call GET /v1/pair-requests)" || exit 1
count="$(echo "$pending" | jq '.pair_requests | length')"
if [[ "$count" -eq 0 ]]; then
  echo "📭 No pending pair requests for you." >&2
  exit 1
fi

if [[ "$count" -gt 1 ]]; then
  echo "Multiple pending pair requests:" >&2
  echo "$pending" | jq -r '.pair_requests[] | "  request_id=\(.id)  from=\(.from_name) (\(.from_fingerprint))"' >&2
  echo "Specify by adding the request_id at the end:" >&2
  echo "  /c2c-client:peer-confirm <code> <request_id>" >&2
  if [[ $# -lt 2 ]]; then exit 1; fi
  REQ_ID="$2"
else
  REQ_ID="$(echo "$pending" | jq -r '.pair_requests[0].id')"
fi

payload="$(jq -nc --arg rid "$REQ_ID" --arg c "$CODE" '{request_id:$rid, code:$c}')"
resp="$(c2c::call POST /v1/pair-confirm "$payload")" || exit 1

PEER_ID="$(echo "$resp" | jq -r .pairing.peer.id)"
PEER_NAME="$(echo "$resp" | jq -r .pairing.peer.name)"
PEER_FP="$(echo "$resp" | jq -r .pairing.peer.fingerprint)"
c2c::add_contact "$PEER_ID" "$PEER_NAME" "$PEER_FP"

echo "✅ paired with '$PEER_NAME' ($PEER_FP)"
echo "   You can now: /c2c-client:peer-send $PEER_NAME <message>"
