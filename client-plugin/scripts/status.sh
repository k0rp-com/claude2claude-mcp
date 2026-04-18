#!/usr/bin/env bash
# Show config + identity + connectivity + inbox preview.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

c2c::ensure_tools
echo "url:           ${C2C_URL:-<not set>}"
echo "mediator_token: $( [[ -n "${C2C_MEDIATOR_TOKEN:-}" ]] && echo '[REDACTED, set]' || echo '<not set>' )"
echo "identity dir:  $C2C_DIR"

if [[ -z "${C2C_URL:-}" ]]; then
  echo
  echo "❌ url not configured. Use EITHER:"
  echo "   • /c2c-client:peer-config <url> <token>"
  echo "   • /plugin → Installed → c2c-client → Enable  (fills the userConfig form)"
  exit 1
fi

c2c::ensure_identity
echo "machine_id:    $C2C_MACHINE_ID"
echo "name:          $(c2c::name || echo '<not set — run /c2c-client:peer-name <name>>')"

echo
echo "🌐 GET ${C2C_URL%/}/health"
if h=$(curl -sS --max-time 5 "${C2C_URL%/}/health" 2>&1); then
  echo "$h" | jq . 2>/dev/null || echo "$h"
else
  echo "❌ unreachable"; exit 2
fi

# If we have a name, we're registered; show /v1/me + inbox peek.
if [[ -n "$(c2c::name || true)" ]]; then
  echo
  echo "/v1/me:"
  c2c::call GET /v1/me 2>/dev/null | jq '.machine | {id, name, fingerprint, last_seen_at}' 2>/dev/null \
    || echo "  (could not fetch — re-register with /c2c-client:peer-name <name>)"
  echo
  echo "📥 inbox preview:"
  c2c::call GET '/v1/inbox?peek=1' 2>/dev/null \
    | jq '{messages: (.messages | length), pair_requests: (.pair_requests | length), pair_request_from: [.pair_requests[].from_name]}' \
    || echo "  (n/a)"
fi
