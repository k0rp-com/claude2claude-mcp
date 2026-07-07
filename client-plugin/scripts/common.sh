#!/usr/bin/env bash
# Shared helpers: identity (ed25519), signing, contacts file, signed HTTP calls.
set -euo pipefail

# Config resolution order (highest → lowest priority):
#   1. CLAUDE_PLUGIN_OPTION_<key>  — userConfig form (Claude Code harness, /plugin enable)
#   2. C2C_<KEY> env               — explicit shell export
#   3. config.json                — written by /c2c-client:peer-config; lives in the
#                                    global dir (shared by all projects), or under
#                                    $C2C_DIR when C2C_DIR is explicitly overridden
#   4. hard-coded default          — for optional fields only
# Capture pristine env state so /c2c-client:peer-config show can attribute each value
# to its source (userConfig form vs. explicit C2C_* env vs. file vs. default).
__c2c_opt_url="${CLAUDE_PLUGIN_OPTION_url:-}"
__c2c_opt_mediator_token="${CLAUDE_PLUGIN_OPTION_mediator_token:-}"
__c2c_opt_stop_hook_wait_seconds="${CLAUDE_PLUGIN_OPTION_stop_hook_wait_seconds:-}"
__c2c_env_url="${C2C_URL:-}"
__c2c_env_mediator_token="${C2C_MEDIATOR_TOKEN:-}"
__c2c_env_stop_hook_wait_seconds="${C2C_WAIT:-}"

C2C_URL="${__c2c_opt_url:-$__c2c_env_url}"
C2C_MEDIATOR_TOKEN="${__c2c_opt_mediator_token:-$__c2c_env_mediator_token}"
C2C_WAIT="${__c2c_opt_stop_hook_wait_seconds:-$__c2c_env_stop_hook_wait_seconds}"

# Identity dir + file paths are resolved by c2c::_resolve_dirs (called at the
# bottom of this file, after c2c::sha256_hex is defined — the per-project slug
# hashes the project path). By default each project gets its OWN identity dir;
# the mediator config.json (url/token) stays global and shared. An explicit
# C2C_DIR env overrides everything.

# Fill unset fields from $C2C_CONFIG_FILE. Never overrides values already set
# via userConfig form / C2C_* env.
c2c::_fill_from_config_file() {
  [[ -r "$C2C_CONFIG_FILE" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  # Read each field separately; tab-joined @tsv + `read` collapses empty
  # middle fields because tab is whitespace-IFS in bash.
  jq -e . "$C2C_CONFIG_FILE" >/dev/null 2>&1 || {
    echo "WARN: $C2C_CONFIG_FILE is not valid JSON — ignoring." >&2
    return 0
  }
  local url tok wait
  url="$(jq -r '.url // ""' "$C2C_CONFIG_FILE")"
  tok="$(jq -r '.mediator_token // ""' "$C2C_CONFIG_FILE")"
  wait="$(jq -r '.stop_hook_wait_seconds // "" | tostring' "$C2C_CONFIG_FILE")"
  if [[ -z "$C2C_URL"            && -n "$url"  ]]; then C2C_URL="$url"; fi
  if [[ -z "$C2C_MEDIATOR_TOKEN" && -n "$tok"  ]]; then C2C_MEDIATOR_TOKEN="$tok"; fi
  if [[ -z "$C2C_WAIT"           && -n "$wait" ]]; then C2C_WAIT="$wait"; fi
}

# Derive a stable, filesystem-safe directory name for a project path.
# Same path (modulo trailing slash / symlinks) → same slug; different paths →
# different slugs even when they share a basename. Human-readable prefix +
# a hash of the canonical absolute path for uniqueness.
c2c::project_slug() {
  local root="${1:-}" abs base hash
  [[ -n "$root" ]] || root="$PWD"
  # Canonicalize so /p, /p/ and a symlinked /p all map to one key.
  abs="$(cd "$root" 2>/dev/null && pwd -P)" || abs=""
  [[ -n "$abs" ]] || abs="$root"
  base="$(basename -- "$abs")"
  # tr -c replaces EVERY byte outside the allow-set (incl. '/', NUL, newline)
  # with '_', so the slug is always a single safe path segment — no traversal.
  base="$(printf '%s' "$base" | LC_ALL=C tr -c 'A-Za-z0-9._-' '_')"
  base="${base:0:24}"
  # 64-bit hash slice: collision-resistant enough that a deliberate slug
  # collision (identity reuse) is 2^64 work, while keeping dir names short.
  hash="$(printf '%s' "$abs" | c2c::sha256_hex)"
  printf '%s-%s' "$base" "${hash:0:16}"
}

# Resolve C2C_DIR + all identity file paths. Two modes:
#   • explicit C2C_DIR env set → use it verbatim for identity AND config
#     (back-compat / power users / test isolation).
#   • otherwise → per-project identity dir under <global>/projects/<slug>,
#     while config.json stays in the shared <global> dir (mediator url/token
#     are machine-global, not per-project).
c2c::_resolve_dirs() {
  local global_dir="${XDG_CONFIG_HOME:-$HOME/.config}/c2c-client"
  C2C_GLOBAL_DIR="$global_dir"
  if [[ -n "${C2C_DIR:-}" ]]; then
    C2C_PROJECT_ROOT=''
    C2C_CONFIG_FILE="$C2C_DIR/config.json"
  else
    C2C_PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
    # Harden the shared tree on every code path (not only on an explicit
    # peer-config write): the global dir holds config.json + all per-project
    # identities, so keep it and projects/ owner-only (700). Otherwise
    # `mkdir -p` leaves them at umask (typically 755), leaking project slugs
    # to other local users on a shared host.
    mkdir -p "$global_dir/projects" 2>/dev/null || true
    chmod 700 "$global_dir" "$global_dir/projects" 2>/dev/null || true
    C2C_DIR="$global_dir/projects/$(c2c::project_slug "$C2C_PROJECT_ROOT")"
    C2C_CONFIG_FILE="$global_dir/config.json"
  fi
  C2C_IDENTITY_FILE="$C2C_DIR/identity.json"
  C2C_PRIVKEY_FILE="$C2C_DIR/private_key.pem"
  C2C_PUBKEY_FILE="$C2C_DIR/public_key.pem"
  C2C_CONTACTS_FILE="$C2C_DIR/contacts.json"
  C2C_NAME_FILE="$C2C_DIR/name.txt"
}

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

# Ensure the ed25519 key pair exists on disk. Does NOT fetch or create the
# machine id — that is assigned by the server at registration and persisted
# in $C2C_IDENTITY_FILE by c2c::register.
c2c::ensure_keys() {
  if [[ -f "$C2C_PRIVKEY_FILE" && -f "$C2C_PUBKEY_FILE" ]]; then return; fi
  mkdir -p "$C2C_DIR"; chmod 700 "$C2C_DIR" 2>/dev/null || true
  openssl genpkey -algorithm Ed25519 -out "$C2C_PRIVKEY_FILE" 2>/dev/null
  chmod 600 "$C2C_PRIVKEY_FILE" 2>/dev/null || true
  openssl pkey -in "$C2C_PRIVKEY_FILE" -pubout -out "$C2C_PUBKEY_FILE" 2>/dev/null
  chmod 644 "$C2C_PUBKEY_FILE" 2>/dev/null || true
}

# Ensure we have a fully registered identity (keys + server-assigned id).
# Callers that need to make authenticated calls MUST succeed here before
# signing any request — X-Machine-ID is read from the identity file.
c2c::ensure_identity() {
  c2c::ensure_keys
  if [[ -f "$C2C_IDENTITY_FILE" ]]; then
    C2C_MACHINE_ID="$(jq -r .id "$C2C_IDENTITY_FILE" 2>/dev/null || echo '')"
    if [[ -n "$C2C_MACHINE_ID" && "$C2C_MACHINE_ID" != "null" ]]; then return; fi
  fi
  cat <<'EOF' >&2
ERROR: this machine has no registered identity yet.
   Run: /c2c-client:peer-name <pick-a-short-name>
   That will register with the mediator and persist the server-assigned id.
EOF
  exit 1
}

# Write the server-assigned id to the identity file. Only c2c::register
# should call this. Mode 0600 because the file pins our machine identity.
c2c::_persist_identity() {
  local id="$1"
  mkdir -p "$C2C_DIR"
  jq -n --arg id "$id" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{id:$id, created_at:$ts}' > "$C2C_IDENTITY_FILE"
  chmod 600 "$C2C_IDENTITY_FILE" 2>/dev/null || true
  C2C_MACHINE_ID="$id"
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
  c2c::ensure_keys
  # Load the server-assigned id if we already have one — otherwise C2C_MACHINE_ID
  # stays empty and c2c::call will prompt the user to run /c2c-client:peer-name.
  if [[ -f "$C2C_IDENTITY_FILE" ]]; then
    C2C_MACHINE_ID="$(jq -r .id "$C2C_IDENTITY_FILE" 2>/dev/null || echo '')"
    # Use if/then/fi (not `[[ ]] && X=`): when the [[ ]] is false, `&&` returns
    # 1; as the last statement of the enclosing `if` it makes c2c::require_config
    # itself return 1, and `set -e` in callers (send.sh, list.sh, …) then kills
    # the script silently with no diagnostic.
    if [[ "$C2C_MACHINE_ID" == "null" ]]; then C2C_MACHINE_ID=''; fi
  fi
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
  if [[ -z "${C2C_MACHINE_ID:-}" ]]; then
    cat <<'EOF' >&2

🆕 This machine isn't registered with the mediator yet.
   Run: /c2c-client:peer-name <pick-a-short-name>
   That will register and you can pair right after.
EOF
    return 1
  fi
  local url="${C2C_URL%/}${path}"
  local ts nonce sig
  ts="$(c2c::now_ms)"
  nonce="$(head -c 16 /dev/urandom | xxd -p -c 32)"
  sig="$(c2c::canonical "$method" "$path" "$ts" "$nonce" "$body" | c2c::sign_b64)"

  local tmp hdrs; tmp="$(mktemp)"; hdrs="$(mktemp)"
  trap 'rm -f "$tmp" "$hdrs"' RETURN
  local -a curl_args=(
    -sS -X "$method"
    -H "X-Machine-ID: ${C2C_MACHINE_ID}"
    -H "X-Timestamp: ${ts}"
    -H "X-Nonce: ${nonce}"
    -H "X-Signature: ${sig}"
    -D "$hdrs"
    -o "$tmp" -w '%{http_code}' --max-time 60
  )
  if [[ -n "$body" ]]; then
    curl_args+=(-H 'Content-Type: application/json' --data-binary "$body")
  fi

  local code; code="$(curl "${curl_args[@]}" "$url")" || { echo "ERROR: curl failed reaching $url" >&2; return 2; }

  if [[ "$code" == "401" ]]; then
    # The server now returns a generic 'unauthenticated' body and puts the
    # reason in X-C2C-Auth-Reason so the body reveals nothing to outsiders.
    # We surface a helpful hint to the local user only.
    local reason; reason="$(grep -i '^X-C2C-Auth-Reason:' "$hdrs" 2>/dev/null | awk '{print tolower($2)}' | tr -d '\r\n ')"
    if [[ "$reason" == "unregistered" ]]; then
      cat <<'EOF' >&2

🆕 This machine's identity is no longer known to the mediator.
   The server may have been reset. Re-register with:
     /c2c-client:peer-name <your-name>
EOF
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
# The server DERIVES the machine id from the pubkey — we no longer choose our own
# id. Canonicalization signs the exact bytes we POST, with `signature` blanked
# out, so the server verifies against the same rawBody it receives.
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
  c2c::ensure_keys
  local pubkey ts nonce sig full_unsigned full_for_sig full
  pubkey="$(cat "$C2C_PUBKEY_FILE")"
  ts="$(c2c::now_ms)"
  nonce="$(head -c 16 /dev/urandom | xxd -p -c 32)"
  # Build the final body (keys in a fixed order) with an empty signature
  # field, sign its bytes, then substitute the real signature. The server
  # verifies over `{...everything..., "signature":""}` and thus checks the
  # actual bytes on the wire (H-1).
  full_for_sig="$(jq -nc --arg name "$name" --arg pk "$pubkey" --argjson ts "$ts" --arg n "$nonce" \
    '{name:$name, public_key_pem:$pk, ts:$ts, nonce:$n, signature:""}')"
  sig="$(c2c::canonical POST /v1/register "$ts" "$nonce" "$full_for_sig" | c2c::sign_b64)"
  full="$(jq -nc --arg name "$name" --arg pk "$pubkey" --argjson ts "$ts" --arg n "$nonce" --arg s "$sig" \
    '{name:$name, public_key_pem:$pk, ts:$ts, nonce:$n, signature:$s}')"

  local tmp; tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  local code
  code="$(curl -sS -X POST -o "$tmp" -w '%{http_code}' --max-time 30 \
    -H "Authorization: Bearer ${C2C_MEDIATOR_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "$full" "${C2C_URL%/}/v1/register")" || { echo "ERROR: registration failed" >&2; return 2; }

  if [[ "$code" -ge 400 ]]; then
    echo "ERROR: registration HTTP $code" >&2; cat "$tmp" >&2; echo >&2; return 1
  fi

  # Persist the server-assigned id so subsequent authenticated calls can sign
  # with the correct X-Machine-ID.
  local assigned_id
  assigned_id="$(jq -r '.machine.id // empty' "$tmp")"
  if [[ -z "$assigned_id" ]]; then
    echo "ERROR: register response missing machine.id" >&2; cat "$tmp" >&2; return 1
  fi
  c2c::_persist_identity "$assigned_id"
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

# c2c::parse_recipient_and_body <usage-msg> "$@"
#
# Shared parser for send.sh / reply.sh. The first positional becomes RECIPIENT;
# the rest becomes BODY via one of three modes:
#   - <recipient> <message words...>     → exact rest of CLI / $ARGUMENTS
#   - <recipient> --file PATH | -f PATH  → read PATH
#   - <recipient> --stdin   | -          → read stdin
#
# Two entry points:
#   - $# == 1: the slash-command harness passed everything as one "$ARGUMENTS"
#     arg. We split off the first whitespace-token as RECIPIENT and keep the
#     rest *verbatim* (no whitespace collapse) for body / flag inspection.
#   - $# >= 2: direct CLI from a user shell. Positional args are already
#     tokenized; --file/--stdin live at $2 and the path at $3.
#
# Outputs RECIPIENT and BODY via globals (bash doesn't have multi-return).
# Body is read via $(...), so trailing newlines from files/stdin are stripped
# — matches every other CLI in the universe (git commit -F, gh pr create, …).
# NUL bytes are explicitly rejected — bash $(...) strips them silently, which
# would corrupt the body without the user noticing.
c2c::parse_recipient_and_body() {
  local usage_msg="$1"; shift
  RECIPIENT=''; BODY=''
  local _arg1='' _rest_raw='' _path=''
  # In $# == 1 (slash-command) mode, _path can only come from the body rest, so
  # paths with whitespace are unrepresentable there. In $# >= 2 (direct CLI)
  # mode, _path arrives as its own argv element and survives whitespace
  # intact. The two branches feed _arg1 / _path / BODY accordingly.
  local _mode=''

  if [[ $# -eq 1 ]]; then
    _mode='single'
    # Split off recipient (first whitespace-token) and keep the rest exactly
    # as typed — runs of spaces inside the body must survive (ASCII tables,
    # markdown code blocks, etc.).
    IFS=$' \t' read -r RECIPIENT _rest_raw <<<"$1"
    # Peek the first token of the rest without disturbing it.
    IFS=$' \t' read -r _arg1 _ <<<"$_rest_raw"
  elif [[ $# -ge 2 ]]; then
    _mode='multi'
    RECIPIENT="$1"; shift
    _arg1="${1:-}"
    shift
    # In multi-mode the path/body live in remaining positional args, not _rest_raw.
  else
    echo "$usage_msg" >&2; return 1
  fi

  if [[ -z "$RECIPIENT" ]]; then
    echo "$usage_msg" >&2; return 1
  fi

  case "$_arg1" in
    --file|-f)
      if [[ "$_mode" == 'single' ]]; then
        # Path is the second token of _rest_raw; anything after it is ignored.
        local _trailing
        IFS=$' \t' read -r _ _path _trailing <<<"$_rest_raw"
      else
        _path="${1:-}"
      fi
      if [[ -z "$_path" ]]; then
        echo "ERROR: --file requires a PATH" >&2
        echo "$usage_msg" >&2
        return 1
      fi
      if [[ ! -e "$_path" ]]; then
        echo "ERROR: --file: no such file: $_path" >&2
        return 1
      fi
      if [[ ! -f "$_path" ]]; then
        echo "ERROR: --file: not a regular file: $_path" >&2
        return 1
      fi
      if [[ ! -r "$_path" ]]; then
        echo "ERROR: --file: file is not readable: $_path" >&2
        return 1
      fi
      # NUL-byte check before the cat: $() strips NULs silently with a stderr
      # warning, which would corrupt the body without the user noticing.
      # NUL via PCRE — passing a literal NUL through argv (`$'\x00'`) is
      # impossible (POSIX argv terminates on NUL), so `grep -q $'\x00'` matches
      # an empty pattern and always succeeds. -P with the `\x00` escape works.
      if LC_ALL=C grep -qaP '\x00' "$_path"; then
        echo "ERROR: --file: $_path contains NUL bytes; binary payloads aren't supported." >&2
        return 1
      fi
      # Pre-flight size check — server caps body at MAX_BODY_LEN (64 KiB) and
      # ARG_MAX would mangle anything multi-MB on the curl --data-binary side.
      # Trips a clear error well before either.
      local _size
      _size=$(wc -c <"$_path")
      if (( _size > 65536 )); then
        echo "ERROR: --file: $_path is $_size bytes; server cap is 65536 bytes (64 KiB)." >&2
        return 1
      fi
      BODY="$(cat "$_path")"
      ;;
    --stdin|-)
      if [[ -t 0 ]]; then
        echo "ERROR: --stdin requested but stdin is a terminal (no data piped)" >&2
        return 1
      fi
      # Buffer stdin via mktemp so we can NUL-check and size-check it the same
      # way as --file. Doing this on the bash side is cheaper than catching a
      # 64KB+ E2BIG from curl downstream and surfacing a confusing error.
      local _tmp; _tmp="$(mktemp)"
      trap "rm -f \"$_tmp\"" RETURN
      cat >"$_tmp"
      if LC_ALL=C grep -qaP '\x00' "$_tmp"; then
        echo "ERROR: --stdin contains NUL bytes; binary payloads aren't supported." >&2
        return 1
      fi
      local _size
      _size=$(wc -c <"$_tmp")
      if (( _size > 65536 )); then
        echo "ERROR: --stdin is $_size bytes; server cap is 65536 bytes (64 KiB)." >&2
        return 1
      fi
      BODY="$(cat "$_tmp")"
      ;;
    '')
      echo "$usage_msg" >&2; return 1
      ;;
    *)
      # Legacy path: glue body back exactly as received.
      if [[ "$_mode" == 'single' ]]; then
        BODY="$_rest_raw"
      else
        # Multi-mode: arg1 was the first body word, $* is everything that
        # remained after the leading shift.
        if [[ $# -ge 1 ]]; then
          BODY="$_arg1 $*"
        else
          BODY="$_arg1"
        fi
      fi
      ;;
  esac

  if [[ -z "$BODY" ]]; then
    echo "ERROR: empty body — nothing to send" >&2
    return 1
  fi
}

# --- Bootstrap (must run last: c2c::project_slug needs c2c::sha256_hex) ---
c2c::_resolve_dirs
c2c::_fill_from_config_file
# Default for optional field, applied last so any upstream source wins.
: "${C2C_WAIT:=10}"
