#!/usr/bin/env bash
# Set or change this machine's display name. Required before any other op.
# Usage: name.sh <new-name>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

if [[ $# -lt 1 ]]; then
  cur="$(c2c::name || true)"
  echo "Usage: peer-name <new-name>"
  echo "current name: ${cur:-<not set>}"
  exit 1
fi

c2c::require_config
NEW="$1"
if ! [[ "$NEW" =~ ^[A-Za-z0-9._-]{1,32}$ ]]; then
  echo "ERROR: name must be 1-32 chars, allowed: A-Za-z0-9._-" >&2
  exit 1
fi

CUR="$(c2c::name || true)"
if [[ -z "$CUR" ]]; then
  # First time — register with the mediator.
  echo "Registering this machine with the mediator as '$NEW'…"
  resp="$(c2c::register "$NEW")" || exit 1
  c2c::set_name "$NEW"
  echo "$resp" | jq -r '.machine | "✅ registered
   name:        \(.name)
   id:          \(.id)
   fingerprint: \(.fingerprint)

👉 To pair with another machine:
   • Get the OTHER machine fingerprint via /peer-id on it
   • Then on this machine run: /peer-pair <other-fingerprint>"'
else
  # Rename — update server.
  payload="$(jq -nc --arg n "$NEW" '{name:$n}')"
  resp="$(c2c::call POST /v1/me/name "$payload")" || exit 1
  c2c::set_name "$NEW"
  echo "$resp" | jq -r '.machine | "✅ renamed: \(.name) (id=\(.id))"'
fi
