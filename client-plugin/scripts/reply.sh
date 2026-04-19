#!/usr/bin/env bash
# Reply to a specific incoming message.
# Usage: reply.sh <message_id> <body...>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
c2c::require_config
c2c::require_name

# Harness-safe argument parsing — see send.sh for rationale.
if [[ $# -eq 1 ]]; then
  IFS=$' \t' read -r RID BODY <<<"$1"
  [[ -z "${RID:-}" || -z "${BODY:-}" ]] && { echo "Usage: peer-reply <message_id> <body>" >&2; exit 1; }
elif [[ $# -ge 2 ]]; then
  RID="$1"; shift
  BODY="$*"
else
  echo "Usage: peer-reply <message_id> <body>" >&2
  exit 1
fi

payload="$(jq -nc --arg id "$RID" --arg b "$BODY" '{reply_to:$id, body:$b}')"
resp="$(c2c::call POST /v1/reply "$payload")" || exit 1

echo "$resp" | jq -r '.message |
  "↩️  replied to \(.reply_to)
   id:     \(.id)
   thread: \(.thread_id)"'
