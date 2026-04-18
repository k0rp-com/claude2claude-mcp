#!/usr/bin/env bash
# /c2c-client:peer-config — configure mediator url + token without going through /plugin enable.
# Writes $C2C_DIR/config.json (mode 600). Ignored if userConfig form / C2C_* env already set.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
c2c::ensure_tools

usage() {
  cat <<'EOF'
Usage:
  /c2c-client:peer-config <url> <token>        set mediator url + registration token (overwrites both)
  /c2c-client:peer-config <key> <value>        set a single key (see keys below)
  /c2c-client:peer-config show                 show resolved config + where each value came from
  /c2c-client:peer-config clear                delete config file

Keys:
  url                     http(s):// base of mediator
  mediator_token          registration token (whitespace-free)
  stop_hook_wait_seconds  integer, default 10
  auto_inject_on_stop     true | false, default false

Resolution order (higher wins):
  userConfig form (/plugin enable)  >  C2C_* env  >  config file  >  default

Note: if a key is set via userConfig form or C2C_* env, writing here has no effect
until that upstream source is cleared. `show` tells you which source wins.
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
    echo "   Note: url/token may still be provided by env or userConfig form — run '/c2c-client:peer-config show' to verify."
  fi
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

_write_config() {
  local json="$1"
  mkdir -p "$C2C_DIR"; chmod 700 "$C2C_DIR" 2>/dev/null || true
  local tmp; tmp="$(mktemp)"
  printf '%s' "$json" > "$tmp"
  mv "$tmp" "$C2C_CONFIG_FILE"
  chmod 600 "$C2C_CONFIG_FILE" 2>/dev/null || true
}

_existing_config() {
  if [[ -r "$C2C_CONFIG_FILE" ]]; then
    jq '.' "$C2C_CONFIG_FILE" 2>/dev/null || echo '{}'
  else
    echo '{}'
  fi
}

_warn_if_upstream_wins() {
  # Use common.sh's pristine capture (__c2c_opt_* / __c2c_env_*) — raw
  # CLAUDE_PLUGIN_OPTION_* / C2C_* may have been populated by common.sh itself
  # with defaults, which would give false positives.
  local key="$1"
  local opt_var="__c2c_opt_${key}"
  local env_var="__c2c_env_${key}"
  if [[ -n "${!opt_var:-}" ]]; then
    echo "   ⚠️  userConfig form sets '$key' — it overrides the config file." >&2
    echo "      Clear it via /plugin → c2c-client → Configure, or run '/c2c-client:peer-config show'." >&2
  elif [[ -n "${!env_var:-}" ]]; then
    echo "   ⚠️  an env var sets '$key' — it overrides the config file." >&2
  fi
}

cmd_set_url_token() {
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

  local existing; existing="$(_existing_config)"
  local keep; keep="$(echo "$existing" | jq '{stop_hook_wait_seconds, auto_inject_on_stop} | with_entries(select(.value != null and .value != ""))')"
  local json; json="$(jq -n --arg url "$url" --arg tok "$tok" --argjson keep "$keep" \
    '{url:$url, mediator_token:$tok} + $keep')"
  _write_config "$json"

  echo "✅ wrote $C2C_CONFIG_FILE"
  echo "   url:            $url"
  echo "   mediator_token: [REDACTED, ${#tok} chars]"
  _warn_if_upstream_wins url
  _warn_if_upstream_wins mediator_token
  echo
  echo "Next: /c2c-client:peer-name <short-name>   (this registers the machine)"
}

cmd_set_single() {
  local key="$1" val; val="$(trim "$2")"
  if [[ -z "$val" ]]; then echo "ERROR: value must be non-empty" >&2; exit 1; fi

  case "$key" in
    url)
      if ! [[ "$val" =~ ^https?://[^[:space:]]+$ ]]; then
        echo "ERROR: url must start with http:// or https://" >&2; exit 1
      fi
      val="${val%/}"
      ;;
    mediator_token)
      if [[ "$val" =~ [[:space:]] ]]; then
        echo "ERROR: mediator_token must not contain whitespace" >&2; exit 1
      fi
      ;;
    stop_hook_wait_seconds)
      if ! [[ "$val" =~ ^[0-9]+$ ]] || [[ "$val" -lt 1 ]]; then
        echo "ERROR: stop_hook_wait_seconds must be a positive integer" >&2; exit 1
      fi
      ;;
    auto_inject_on_stop)
      case "$val" in
        true|false) ;;
        *) echo "ERROR: auto_inject_on_stop must be 'true' or 'false'" >&2; exit 1 ;;
      esac
      ;;
    *)
      echo "ERROR: unknown key '$key'. Valid keys: url, mediator_token, stop_hook_wait_seconds, auto_inject_on_stop" >&2
      exit 1
      ;;
  esac

  local existing; existing="$(_existing_config)"
  local json; json="$(echo "$existing" | jq --arg k "$key" --arg v "$val" '. + {($k):$v}')"
  _write_config "$json"

  local display="$val"
  [[ "$key" == "mediator_token" ]] && display="[REDACTED, ${#val} chars]"
  echo "✅ $C2C_CONFIG_FILE: $key = $display"
  _warn_if_upstream_wins "$key"
}

known_key() {
  case "$1" in
    url|mediator_token|stop_hook_wait_seconds|auto_inject_on_stop) return 0 ;;
    *) return 1 ;;
  esac
}

case "${1:-}" in
  ""|-h|--help|help) usage ;;
  show)              cmd_show ;;
  clear)             cmd_clear ;;
  *)
    if [[ $# -lt 2 ]]; then usage; exit 1; fi
    if known_key "$1"; then
      cmd_set_single "$1" "$2"
    else
      cmd_set_url_token "$1" "$2"
    fi
    ;;
esac
