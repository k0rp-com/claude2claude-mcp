#!/usr/bin/env bash
# Persistent peer-mail listener. Designed to be wrapped by Claude Code's
# Monitor tool (persistent=true): each stdout line becomes a chat event,
# so Claude reacts the moment a new message lands — no Stop-event required.
#
# Emits ONE line per new inbox item. Peek mode: metadata only, bodies are
# NEVER streamed (they still come via /c2c-client:peer-inbox with the security frame).
#
# Compatible with macOS bash 3.2 — no associative arrays, no `readarray`.

# Intentionally NO `-e`: a single transient curl/jq failure must not kill
# the long-running stream. We handle errors inline instead.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

c2c::ensure_tools
c2c::ensure_identity

# Server caps wait at maxLongPollSeconds (default 30s). Stay a bit under.
WAIT=25
since=0
seen_pair=" "  # space-delimited ids we've already notified on this session
echo "👂 peer-mail listener armed (polls every ${WAIT}s; instant on new mail)"

emit_message() {
  jq -rc --unbuffered \
    '"📥 peer message — from=\(.from_name // .from_id) id=\(.id) thread=\(.thread_id) kind=\(.kind) at=\(.created_at)"' \
    <<<"$1"
}

emit_pair() {
  jq -rc --unbuffered \
    '"🔑 pair request — from=\(.from_name // "?") fp=\(.from_fingerprint) request_id=\(.id) expires=\(.expires_at)"' \
    <<<"$1"
}

max_int() { # bash-only, no external calls
  if [[ "$1" =~ ^[0-9]+$ ]] && [[ "$2" =~ ^[0-9]+$ ]] && (( $1 > $2 )); then echo "$1"; else echo "$2"; fi
}

while true; do
  resp="$(c2c::call GET "/v1/inbox?peek=1&since=$since&wait=$WAIT" 2>/dev/null)"
  rc=$?
  if (( rc != 0 )) || [[ -z "$resp" ]]; then
    sleep 3
    continue
  fi

  # Messages: peek returns unacked-since-`since`. Emit each, advance `since`.
  msg_rows="$(jq -c '.messages[]?' 2>/dev/null <<<"$resp")"
  if [[ -n "$msg_rows" ]]; then
    while IFS= read -r row; do
      [[ -z "$row" ]] && continue
      emit_message "$row"
      ts="$(jq -r '.created_at' <<<"$row" 2>/dev/null)"
      since="$(max_int "${ts:-0}" "$since")"
    done <<<"$msg_rows"
  fi

  # Pair requests: peek returns all pending — dedupe by id.
  pr_rows="$(jq -c '.pair_requests[]?' 2>/dev/null <<<"$resp")"
  if [[ -n "$pr_rows" ]]; then
    while IFS= read -r row; do
      [[ -z "$row" ]] && continue
      id="$(jq -r '.id' <<<"$row" 2>/dev/null)"
      [[ -z "$id" ]] && continue
      if [[ "$seen_pair" != *" $id "* ]]; then
        emit_pair "$row"
        seen_pair="$seen_pair$id "
      fi
    done <<<"$pr_rows"
  fi
done
