#!/usr/bin/env bash
# Reply to a specific incoming message.
#
# Usage:
#   reply.sh <message_id> <body...>
#   reply.sh <message_id> --file PATH | -f PATH
#   reply.sh <message_id> --stdin     | -            (reads body from stdin)
#
# See send.sh for why --file / --stdin exist (shell-quoting hell for long
# bodies with parentheses, quotes, $, backticks, newlines).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

USAGE='Usage: peer-reply <message_id> <body>
       peer-reply <message_id> --file <path>
       peer-reply <message_id> --stdin   (or "-", with body piped on stdin)'

c2c::parse_recipient_and_body "$USAGE" "$@"
RID="$RECIPIENT"

if [[ "${C2C_DRY_PARSE:-}" == "1" ]]; then
  printf 'RID=%s\nBODY=%s\n' "$RID" "$BODY"
  exit 0
fi

c2c::require_config
c2c::require_name

payload="$(jq -nc --arg id "$RID" --arg b "$BODY" '{reply_to:$id, body:$b}')"
resp="$(c2c::call POST /v1/reply "$payload")" || exit 1

echo "$resp" | jq -r '.message |
  "↩️  replied to \(.reply_to)
   id:     \(.id)
   thread: \(.thread_id)"'
