#!/usr/bin/env bash
# /peer-config — configure mediator url + token without going through /plugin enable.
# Writes $C2C_DIR/config.json (mode 600). Ignored if userConfig form / C2C_* env already set.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
c2c::ensure_tools

usage() {
  cat <<'EOF'
Usage:
  /peer-config <url> <token>   set mediator url + registration token (overwrites)
  /peer-config show            show resolved config + where each value came from
  /peer-config clear           delete config file

Resolution order (higher wins):
  userConfig form (/plugin enable)  >  C2C_* env  >  config file  >  default
EOF
}

source_of() {
  local key="$1" opt_var="__c2c_opt_${1}" env_var="__c2c_env_${1}"
  if [[ -n "${!opt_var:-}" ]]; then
    echo "userConfig form"
  elif [[ -n "${!env_var:-}" ]]; then
    echo "C2C_* env"
  elif [[ -r "$C2C_CONFIG_FILE" ]] && jq -e --arg k "$key" '(.[$k] // "") != ""' "$C2C_CONFIG_FILE" >/dev/null 2>&1; then
    echo "config file"
  else
    echo "default"
  fi
}

cmd_show() {
  local tok_display='<not set>'
  if [[ -n "${C2C_MEDIATOR_TOKEN:-}" ]]; then tok_display='[REDACTED, set]'; fi
  echo "url:                    ${C2C_URL:-<not set>}   [$(source_of url)]"
  echo "mediator_token:         ${tok_display}   [$(source_of mediator_token)]"
  echo "stop_hook_wait_seconds: ${C2C_WAIT}   [$(source_of stop_hook_wait_seconds)]"
  echo "auto_inject_on_stop:    ${C2C_AUTO_INJECT}   [$(source_of auto_inject_on_stop)]"
  echo "config file:            $C2C_CONFIG_FILE $( [[ -f "$C2C_CONFIG_FILE" ]] && echo '(exists)' || echo '(absent)' )"
}

cmd_clear() {
  if [[ ! -f "$C2C_CONFIG_FILE" ]]; then
    echo "(no config file at $C2C_CONFIG_FILE — nothing to clear)"
    return 0
  fi
  rm -f "$C2C_CONFIG_FILE"
  echo "✅ removed $C2C_CONFIG_FILE"
  if [[ -n "${CLAUDE_PLUGIN_OPTION_url:-}" || -n "${C2C_URL:-}" ]]; then
    echo "   Note: url/token may still be provided by env or userConfig form — run '/peer-config show' to verify."
  fi
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

cmd_set() {
  local url tok
  url="$(trim "$1")"
  tok="$(trim "$2")"

  if [[ -z "$url" || -z "$tok" ]]; then
    echo "ERROR: url and token must both be non-empty" >&2; exit 1
  fi
  if ! [[ "$url" =~ ^https?://[^[:space:]]+$ ]]; then
    echo "ERROR: url must start with http:// or https://" >&2; exit 1
  fi
  if [[ "$tok" =~ [[:space:]] ]]; then
    echo "ERROR: mediator_token must not contain whitespace" >&2; exit 1
  fi
  url="${url%/}"

  mkdir -p "$C2C_DIR"; chmod 700 "$C2C_DIR" 2>/dev/null || true

  local keep='{}'
  if [[ -r "$C2C_CONFIG_FILE" ]]; then
    keep="$(jq '{stop_hook_wait_seconds, auto_inject_on_stop} | with_entries(select(.value != null and .value != ""))' "$C2C_CONFIG_FILE" 2>/dev/null || echo '{}')"
  fi
  local tmp; tmp="$(mktemp)"
  jq -n --arg url "$url" --arg tok "$tok" --argjson keep "$keep" \
    '{url:$url, mediator_token:$tok} + $keep' > "$tmp"
  mv "$tmp" "$C2C_CONFIG_FILE"
  chmod 600 "$C2C_CONFIG_FILE" 2>/dev/null || true

  echo "✅ wrote $C2C_CONFIG_FILE"
  echo "   url:            $url"
  echo "   mediator_token: [REDACTED, ${#tok} chars]"
  if [[ -n "${CLAUDE_PLUGIN_OPTION_url:-}" && "${CLAUDE_PLUGIN_OPTION_url:-}" != "$url" ]]; then
    echo "   ⚠️  userConfig form has a different 'url' set — it will take precedence."
    echo "      Run '/peer-config show' to see what actually resolves."
  fi
  echo
  echo "Next: /peer-name <short-name>   (this registers the machine)"
}

case "${1:-}" in
  ""|-h|--help|help) usage ;;
  show)              cmd_show ;;
  clear)             cmd_clear ;;
  *)
    if [[ $# -lt 2 ]]; then usage; exit 1; fi
    cmd_set "$1" "$2"
    ;;
esac
