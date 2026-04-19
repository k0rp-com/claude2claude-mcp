#!/usr/bin/env bash
# Send a message to a paired peer by name (or fingerprint, or id).
# Usage: send.sh <name> <message...>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
c2c::require_config
c2c::require_name

# The slash-command harness substitutes $ARGUMENTS textually into the bash
# invocation; we receive it as a single quoted arg to avoid metacharacter
# injection. Re-parse into peer + body without eval (word-split only).
if [[ $# -eq 1 ]]; then
  IFS=$' \t' read -r PEER MSG <<<"$1"
  [[ -z "${PEER:-}" || -z "${MSG:-}" ]] && { echo "Usage: peer-send <peer-name> <message>" >&2; exit 1; }
elif [[ $# -ge 2 ]]; then
  PEER="$1"; shift
  MSG="$*"
else
  echo "Usage: peer-send <peer-name> <message>" >&2
  exit 1
fi

ID="$(c2c::resolve_name "$PEER")"
if [[ -z "$ID" ]]; then
  bash "$SCRIPT_DIR/list.sh" >/dev/null 2>&1 || true
  ID="$(c2c::resolve_name "$PEER")"
fi
if [[ -z "$ID" ]]; then
  echo "ERROR: no peer named '$PEER'. Run /c2c-client:peer-list to see your peers." >&2
  exit 1
fi

payload="$(jq -nc --arg to "$ID" --arg b "$MSG" '{to_id:$to, kind:"request", body:$b}')"
resp="$(c2c::call POST /v1/messages "$payload")" || exit 1

echo "$resp" | jq -r '.message |
  "✉️  sent to \(.to_id)
   id:     \(.id)
   thread: \(.thread_id)"'
