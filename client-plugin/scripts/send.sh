#!/usr/bin/env bash
# Send a message to a paired peer by name (or fingerprint, or id).
#
# Usage:
#   send.sh <peer-name> <message...>
#   send.sh <peer-name> --file PATH | -f PATH
#   send.sh <peer-name> --stdin     | -            (reads message from stdin)
#
# The --file / --stdin paths exist so the caller doesn't have to shell-quote
# bodies that contain (, ), $, `, ", ', or newlines — the slash-command
# harness substitutes $ARGUMENTS textually into bash, which makes long /
# special-character messages painful otherwise (in zsh, unquoted "(foo)" even
# fails parsing with "invalid mode specification").
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

USAGE='Usage: peer-send <peer-name> <message>
       peer-send <peer-name> --file <path>
       peer-send <peer-name> --stdin   (or "-", with message piped on stdin)'

c2c::parse_recipient_and_body "$USAGE" "$@"
PEER="$RECIPIENT"; MSG="$BODY"

# Dry-parse mode: skip identity/network checks and just print what we parsed.
# Used by tests/client/parse_args.test.sh — no other production caller sets it.
if [[ "${C2C_DRY_PARSE:-}" == "1" ]]; then
  printf 'PEER=%s\nBODY=%s\n' "$PEER" "$MSG"
  exit 0
fi

c2c::require_config
c2c::require_name

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
