#!/usr/bin/env bash
# Shared helpers: identity (ed25519), signing, contacts file, signed HTTP calls.
set -euo pipefail

# Config resolution order (highest → lowest priority):
#   1. CLAUDE_PLUGIN_OPTION_<key>  — userConfig form (Claude Code harness, /plugin enable)
#   2. C2C_<KEY> env               — explicit shell export
#   3. $C2C_DIR/config.json        — written by /c2c-client:peer-config
#   4. hard-coded default          — for optional fields only
# Capture pristine env state so /c2c-client:peer-config show can attribute each value
# to its source (userConfig form vs. explicit C2C_* env vs. file vs. default).
__c2c_opt_url="${CLAUDE_PLUGIN_OPTION_url:-}"
__c2c_opt_mediator_token="${CLAUDE_PLUGIN_OPTION_mediator_token:-}"
__c2c_opt_stop_hook_wait_seconds="${CLAUDE_PLUGIN_OPTION_stop_hook_wait_seconds:-}"
__c2c_opt_auto_inject_on_stop="${CLAUDE_PLUGIN_OPTION_auto_inject_on_stop:-}"
__c2c_env_url="${C2C_URL:-}"
__c2c_env_mediator_token="${C2C_MEDIATOR_TOKEN:-}"
__c2c_env_stop_hook_wait_seconds="${C2C_WAIT:-}"
__c2c_env_auto_inject_on_stop="${C2C_AUTO_INJECT:-}"

C2C_URL="${__c2c_opt_url:-$__c2c_env_url}"
C2C_MEDIATOR_TOKEN="${__c2c_opt_mediator_token:-$__c2c_env_mediator_token}"
C2C_WAIT="${__c2c_opt_stop_hook_wait_seconds:-$__c2c_env_stop_hook_wait_seconds}"
C2C_AUTO_INJECT="${__c2c_opt_auto_inject_on_stop:-$__c2c_env_auto_inject_on_stop}"

C2C_DIR="${C2C_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/c2c-client}"
C2C_IDENTITY_FILE="$C2C_DIR/identity.json"
C2C_PRIVKEY_FILE="$C2C_DIR/private_key.pem"
C2C_PUBKEY_FILE="$C2C_DIR/public_key.pem"
C2C_CONTACTS_FILE="$C2C_DIR/contacts.json"
C2C_NAME_FILE="$C2C_DIR/name.txt"
C2C_CONFIG_FILE="$C2C_DIR/config.json"

# Fill unset fields from $C2C_CONFIG_FILE. Never overrides values already set
# via userConfig form / C2C_* env.
c2c::_fill_from_config_file() {
  [[ -r "$C2C_CONFIG_FILE" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  local parsed
  if ! parsed=$(jq -r '[
      .url // "",
      .mediator_token // "",
      (.stop_hook_wait_seconds // "" | tostring),
      (.auto_inject_on_stop // "" | tostring)
    ] | @tsv' "$C2C_CONFIG_FILE" 2>/dev/null); then
    echo "WARN: $C2C_CONFIG_FILE is not valid JSON — ignoring." >&2
    return 0
  fi
  local url tok wait auto
  IFS=$'\t' read -r url tok wait auto <<< "$parsed"
  if [[ -z "$C2C_URL"            && -n "$url"  ]]; then C2C_URL="$url"; fi
  if [[ -z "$C2C_MEDIATOR_TOKEN" && -n "$tok"  ]]; then C2C_MEDIATOR_TOKEN="$tok"; fi
  if [[ -z "$C2C_WAIT"           && -n "$wait" ]]; then C2C_WAIT="$wait"; fi
  if [[ -z "$C2C_AUTO_INJECT"    && -n "$auto" ]]; then C2C_AUTO_INJECT="$auto"; fi
}
c2c::_fill_from_config_file

# Defaults for optional fields (applied last so any upstream source wins).
: "${C2C_WAIT:=10}"
: "${C2C_AUTO_INJECT:=false}"

c2c::ensure_tools() {
  for tool in curl jq openssl; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: c2c-client requires '$tool'." >&2; exit 1; }
  done
}

# Current time in ms as a bare integer.
# GNU date supports `%3N`; BSD/macOS doesn't and leaks `%3N` literal into the
# output, which then breaks jq --argjson. Fall back to python3/perl/seconds.
c2c::now_ms() {
  local t
  t="$(date +%s%3N 2>/dev/null)"
  if [[ "$t" =~ ^[0-9]{13,}$ ]]; then printf '%s' "$t"; return 0; fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time()*1000))' && return 0
  fi
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%d\n", int(time()*1000)' && return 0
  fi
  printf '%s000' "$(date +%s)"
}

c2c::generate_uuid_v4() {
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr 'A-Z' 'a-z'; return; fi
  if [[ -r /proc/sys/kernel/random/uuid ]]; then cat /proc/sys/kernel/random/uuid; return; fi
  local hex; hex="$(head -c 16 /dev/urandom | xxd -p -c 32)"
  printf '%s-%s-4%s-%s-%s\n' \
    "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" \
    "$(printf '%x' $(( 0x${hex:16:2} & 0x3f | 0x80 )))${hex:18:2}" \
    "${hex:20:12}"
}

c2c::ensure_identity() {
  if [[ -f "$C2C_IDENTITY_FILE" && -f "$C2C_PRIVKEY_FILE" && -f "$C2C_PUBKEY_FILE" ]]; then
    C2C_MACHINE_ID="$(jq -r .id "$C2C_IDENTITY_FILE")"
    return
  fi
  mkdir -p "$C2C_DIR"; chmod 700 "$C2C_DIR" 2>/dev/null || true
  C2C_MACHINE_ID="$(c2c::generate_uuid_v4)"
  openssl genpkey -algorithm Ed25519 -out "$C2C_PRIVKEY_FILE" 2>/dev/null
  chmod 600 "$C2C_PRIVKEY_FILE" 2>/dev/null || true
  openssl pkey -in "$C2C_PRIVKEY_FILE" -pubout -out "$C2C_PUBKEY_FILE" 2>/dev/null
  chmod 644 "$C2C_PUBKEY_FILE" 2>/dev/null || true
  jq -n --arg id "$C2C_MACHINE_ID" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{id:$id, created_at:$ts}' > "$C2C_IDENTITY_FILE"
  chmod 600 "$C2C_IDENTITY_FILE" 2>/dev/null || true
}

c2c::name() {
  if [[ -f "$C2C_NAME_FILE" ]]; then cat "$C2C_NAME_FILE"; fi
}

c2c::valid_name() {
  # 1-32 code points; any Unicode letter/digit, plus . _ - (no whitespace, no emoji).
  local n="$1"
  [[ -n "$n" ]] || return 1
  printf '%s' "$n" | jq -Rse '. | test("^[\\p{L}\\p{N}._-]{1,32}$")' 2>/dev/null | grep -qx 'true'
}

c2c::set_name() {
  local n="$1"
  if ! c2c::valid_name "$n"; then
    echo "ERROR: name must be 1-32 chars: letters (any script), digits, or . _ -" >&2; return 1
  fi
  printf '%s' "$n" > "$C2C_NAME_FILE"
  chmod 600 "$C2C_NAME_FILE" 2>/dev/null || true
}

c2c::require_config() {
  c2c::ensure_tools
  if [[ -z "$C2C_URL" ]]; then
    cat <<'EOF' >&2
ERROR: c2c-client url is not set. Configure it via EITHER path:
  • /c2c-client:peer-config <url> <token>                 (writes ~/.config/c2c-client/config.json)
  • /plugin → Installed → c2c-client → Enable  (fills the userConfig form)
EOF
    exit 1
  fi
  c2c::ensure_identity
}

c2c::require_name() {
  if [[ -z "$(c2c::name || true)" ]]; then
    cat <<EOF >&2
ERROR: this machine has no name yet.
Pick a short name (alphanumeric, dash, underscore, dot — up to 32 chars) so peers can address you, e.g.:
  /c2c-client:peer-name laptop
EOF
    exit 1
  fi
}

# Pure SHA-256 hex of stdin (used in canonicalization).
c2c::sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else openssl dgst -sha256 -binary | xxd -p -c 32 | tr -d '\n'; fi
}

# Sign arbitrary bytes (stdin) with our private key. Output: base64 (no newlines).
# openssl pkeyutl -rawin requires a real file (cannot stat a pipe), so we
# materialize stdin into a tempfile first.
c2c::sign_b64() {
  local tmp; tmp="$(mktemp)"
  cat > "$tmp"
  openssl pkeyutl -sign -inkey "$C2C_PRIVKEY_FILE" -rawin -in "$tmp" 2>/dev/null | base64 -w0
  rm -f "$tmp"
}

# c2c::canonical METHOD PATH TS NONCE BODY
c2c::canonical() {
  local method="$1" path="$2" ts="$3" nonce="$4" body="$5"
  local body_hash; body_hash="$(printf '%s' "$body" | c2c::sha256_hex)"
  printf '%s\n%s\n%s\n%s\n%s' "$method" "$path" "$ts" "$nonce" "$body_hash"
}

# c2c::call METHOD PATH [JSON_BODY]
c2c::call() {
  local method="$1" path="$2" body="${3:-}"
  local url="${C2C_URL%/}${path}"
  local ts nonce sig
  ts="$(c2c::now_ms)"
  nonce="$(head -c 16 /dev/urandom | xxd -p -c 32)"
  sig="$(c2c::canonical "$method" "$path" "$ts" "$nonce" "$body" | c2c::sign_b64)"

  local tmp; tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  local -a curl_args=(
    -sS -X "$method"
    -H "X-Machine-ID: ${C2C_MACHINE_ID}"
    -H "X-Timestamp: ${ts}"
    -H "X-Nonce: ${nonce}"
    -H "X-Signature: ${sig}"
    -o "$tmp" -w '%{http_code}' --max-time 60
  )
  if [[ -n "$body" ]]; then
    curl_args+=(-H 'Content-Type: application/json' --data-binary "$body")
  fi

  local code; code="$(curl "${curl_args[@]}" "$url")" || { echo "ERROR: curl failed reaching $url" >&2; return 2; }

  if [[ "$code" == "401" ]]; then
    local err; err="$(jq -r '.error // ""' "$tmp" 2>/dev/null || echo "")"
    if [[ "$err" == *"unknown machine"* ]]; then
      echo "" >&2
      echo "🆕 This machine isn't registered with the mediator yet." >&2
      echo "   Run: /c2c-client:peer-name <pick-a-short-name>" >&2
      echo "   That will register and you can pair right after." >&2
      echo "" >&2
      return 1
    fi
  fi
  if [[ "$code" -ge 400 ]]; then
    echo "ERROR: HTTP $code from $method $path" >&2
    cat "$tmp" >&2; echo >&2
    return 1
  fi
  cat "$tmp"
}

# Register self with the mediator (used during /c2c-client:peer-name on first run).
c2c::register() {
  local name="$1"
  if [[ -z "$C2C_MEDIATOR_TOKEN" ]]; then
    cat <<'EOF' >&2
ERROR: mediator_token is not set. Configure it via EITHER path:
  • /c2c-client:peer-config <url> <token>
  • /plugin → Installed → c2c-client → Enable  (fills the userConfig form)
EOF
    return 1
  fi
  local pubkey ts nonce sigbody sig payload
  pubkey="$(cat "$C2C_PUBKEY_FILE")"
  ts="$(c2c::now_ms)"
  nonce="$(head -c 16 /dev/urandom | xxd -p -c 32)"
  payload="$(jq -nc --arg id "$C2C_MACHINE_ID" --arg name "$name" --arg pk "$pubkey" --argjson ts "$ts" --arg n "$nonce" \
    '{id:$id, name:$name, public_key_pem:$pk, ts:$ts, nonce:$n}')"
  sig="$(c2c::canonical POST /v1/register "$ts" "$nonce" "$payload" | c2c::sign_b64)"
  local full; full="$(jq -nc --argjson p "$payload" --arg s "$sig" '$p + {signature:$s}')"

  local tmp; tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  local code
  code="$(curl -sS -X POST -o "$tmp" -w '%{http_code}' --max-time 30 \
    -H "Authorization: Bearer ${C2C_MEDIATOR_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "$full" "${C2C_URL%/}/v1/register")" || { echo "ERROR: registration failed" >&2; return 2; }

  if [[ "$code" -ge 400 ]]; then
    echo "ERROR: registration HTTP $code" >&2; cat "$tmp" >&2; echo >&2; return 1
  fi
  cat "$tmp"
}

# Contacts file: array of { id, name, fingerprint, paired_at }
c2c::contacts_load() {
  if [[ -f "$C2C_CONTACTS_FILE" ]]; then cat "$C2C_CONTACTS_FILE"; else echo '[]'; fi
}

c2c::contacts_save() {
  mkdir -p "$C2C_DIR"
  cat > "$C2C_CONTACTS_FILE"
  chmod 600 "$C2C_CONTACTS_FILE" 2>/dev/null || true
}

# Resolve a name (or fingerprint) to an id from local contacts.
c2c::resolve_name() {
  local query="$1"
  c2c::contacts_load | jq -r --arg q "$query" '
    map(select(.name == $q or .fingerprint == $q or .id == $q)) | .[0].id // empty'
}

c2c::add_contact() {
  local id="$1" name="$2" fp="$3"
  local contacts; contacts="$(c2c::contacts_load)"
  echo "$contacts" | jq --arg id "$id" --arg name "$name" --arg fp "$fp" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    'map(select(.id != $id)) + [{id:$id, name:$name, fingerprint:$fp, paired_at:$ts}]' \
    | c2c::contacts_save
}

c2c::remove_contact() {
  local id="$1"
  c2c::contacts_load | jq --arg id "$id" 'map(select(.id != $id))' | c2c::contacts_save
}
