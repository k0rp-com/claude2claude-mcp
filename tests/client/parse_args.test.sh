#!/usr/bin/env bash
# Regression tests for send.sh / reply.sh argument parsing.
#
# Under C2C_DRY_PARSE=1 the scripts must print parsed PEER/RID + BODY and exit 0
# *before* hitting any network or identity check, so we can exercise the
# parser in isolation. The whole point of this suite is to lock down the
# delivery contract for long / special-character messages that don't survive
# shell quoting (e.g. zsh expanding unquoted "(foo)" as a glob qualifier).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SEND="$REPO_ROOT/client-plugin/scripts/send.sh"
REPLY="$REPO_ROOT/client-plugin/scripts/reply.sh"

PASS=0; FAIL=0; FAILED_NAMES=()

assert_eq() {
  # assert_eq <name> <expected> <actual>
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf '  ok   %s\n' "$name"
    PASS=$((PASS+1))
  else
    printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$name" "$expected" "$actual"
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$name")
  fi
}

assert_exit_nonzero() {
  # assert_exit_nonzero <name> <exit_code>
  local name="$1" code="$2"
  if [[ "$code" -ne 0 ]]; then
    printf '  ok   %s (exit=%d)\n' "$name" "$code"
    PASS=$((PASS+1))
  else
    printf '  FAIL %s (expected nonzero exit, got 0)\n' "$name"
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$name")
  fi
}

run_parse() {
  # run_parse <script> <args...>  →  echoes "PEER=...\nBODY=..." on success
  C2C_DRY_PARSE=1 bash "$@" 2>/dev/null
}

# ---------- send.sh ----------
echo "send.sh — positional CLI (\$# >= 2)"
out="$(run_parse "$SEND" laptop hello world)"
assert_eq "positional: peer" "PEER=laptop" "$(printf '%s\n' "$out" | head -n1)"
assert_eq "positional: body joined by space" "BODY=hello world" "$(printf '%s\n' "$out" | tail -n1)"

echo "send.sh — slash-command form (\$# == 1, single \$ARGUMENTS arg)"
out="$(run_parse "$SEND" "laptop hello world")"
assert_eq "single-arg: peer" "PEER=laptop" "$(printf '%s\n' "$out" | head -n1)"
assert_eq "single-arg: body single spaces" "BODY=hello world" "$(printf '%s\n' "$out" | tail -n1)"

echo "send.sh — slash-command form preserves runs of whitespace (regression)"
out="$(run_parse "$SEND" "laptop hello   world")"
assert_eq "single-arg: 3 spaces preserved" "BODY=hello   world" "$(printf '%s\n' "$out" | tail -n1)"
out="$(run_parse "$SEND" "laptop col1	col2	col3")"
assert_eq "single-arg: tabs preserved" "BODY=col1	col2	col3" "$(printf '%s\n' "$out" | tail -n1)"

echo "send.sh — special characters in body (the zsh-glob bug)"
out="$(run_parse "$SEND" laptop "with (parens) and 'quotes'")"
assert_eq "special chars: body intact" "BODY=with (parens) and 'quotes'" "$(printf '%s\n' "$out" | tail -n1)"

echo "send.sh — --file PATH (positional form)"
tmpfile="$(mktemp)"; printf 'big text with (parens)\nand a newline' > "$tmpfile"
out="$(run_parse "$SEND" laptop --file "$tmpfile")"
assert_eq "--file: peer" "PEER=laptop" "$(printf '%s\n' "$out" | head -n1)"
assert_eq "--file: body from file" "BODY=big text with (parens)
and a newline" "$(printf '%s\n' "$out" | tail -n+2)"
rm -f "$tmpfile"

echo "send.sh — --file with multi-line body (full content preserved)"
tmpfile="$(mktemp)"; printf 'line A\nline B\nline C' > "$tmpfile"
out="$(run_parse "$SEND" laptop --file "$tmpfile")"
assert_eq "--file: middle lines survive" "BODY=line A
line B
line C" "$(printf '%s\n' "$out" | tail -n+2)"
rm -f "$tmpfile"

echo "send.sh — --file with trailing newline (stripped per contract)"
tmpfile="$(mktemp)"; printf 'hello\n' > "$tmpfile"
out="$(run_parse "$SEND" laptop --file "$tmpfile")"
assert_eq "--file: trailing \\n stripped" "BODY=hello" "$(printf '%s\n' "$out" | tail -n1)"
rm -f "$tmpfile"

echo "send.sh — --file path with whitespace (direct-CLI form)"
spacedir="$(mktemp -d)/dir with space"
mkdir -p "$spacedir"
spacedfile="$spacedir/msg.txt"
printf 'spaced path body' > "$spacedfile"
out="$(run_parse "$SEND" laptop --file "$spacedfile")"
assert_eq "--file: spaced path works (direct CLI)" "BODY=spaced path body" "$(printf '%s\n' "$out" | tail -n1)"
rm -rf "$(dirname "$spacedir")"

echo "send.sh — -f PATH (short alias, positional form)"
tmpfile="$(mktemp)"; printf 'short alias works' > "$tmpfile"
out="$(run_parse "$SEND" laptop -f "$tmpfile")"
assert_eq "-f alias: body" "BODY=short alias works" "$(printf '%s\n' "$out" | tail -n1)"
rm -f "$tmpfile"

echo "send.sh — --file PATH (slash-command single-arg form)"
tmpfile="$(mktemp)"; printf 'from slash form' > "$tmpfile"
out="$(run_parse "$SEND" "laptop --file $tmpfile")"
assert_eq "single-arg --file: peer" "PEER=laptop" "$(printf '%s\n' "$out" | head -n1)"
assert_eq "single-arg --file: body" "BODY=from slash form" "$(printf '%s\n' "$out" | tail -n1)"
rm -f "$tmpfile"

echo "send.sh — --stdin"
out="$(echo 'piped body with (parens)' | C2C_DRY_PARSE=1 bash "$SEND" laptop --stdin 2>/dev/null)"
assert_eq "--stdin: peer" "PEER=laptop" "$(printf '%s\n' "$out" | head -n1)"
assert_eq "--stdin: body" "BODY=piped body with (parens)" "$(printf '%s\n' "$out" | tail -n1)"

echo "send.sh — - (dash = stdin alias)"
out="$(echo 'dash alias' | C2C_DRY_PARSE=1 bash "$SEND" laptop - 2>/dev/null)"
assert_eq "- alias: body" "BODY=dash alias" "$(printf '%s\n' "$out" | tail -n1)"

echo "send.sh — error cases"
out="$(run_parse "$SEND" 2>&1; echo "EXIT=$?")"
assert_exit_nonzero "no args: exit nonzero" "${out##*EXIT=}"

out="$(run_parse "$SEND" laptop 2>&1; echo "EXIT=$?")"
assert_exit_nonzero "peer but no body: exit nonzero" "${out##*EXIT=}"

out="$(C2C_DRY_PARSE=1 bash "$SEND" laptop --file /no/such/file 2>&1; echo "EXIT=$?")"
assert_exit_nonzero "--file missing: exit nonzero" "${out##*EXIT=}"

out="$(C2C_DRY_PARSE=1 bash "$SEND" laptop --file 2>&1; echo "EXIT=$?")"
assert_exit_nonzero "--file without PATH: exit nonzero" "${out##*EXIT=}"

empty="$(mktemp)"; : > "$empty"
out="$(C2C_DRY_PARSE=1 bash "$SEND" laptop --file "$empty" 2>&1; echo "EXIT=$?")"
assert_exit_nonzero "--file empty: exit nonzero" "${out##*EXIT=}"
rm -f "$empty"

out="$(C2C_DRY_PARSE=1 bash "$SEND" laptop --stdin </dev/null 2>&1; echo "EXIT=$?")"
assert_exit_nonzero "--stdin empty: exit nonzero" "${out##*EXIT=}"

echo "send.sh — --file with directory (rejected)"
tdir="$(mktemp -d)"
out="$(C2C_DRY_PARSE=1 bash "$SEND" laptop --file "$tdir" 2>&1; echo "EXIT=$?")"
assert_exit_nonzero "--file directory: exit nonzero" "${out##*EXIT=}"
rm -rf "$tdir"

echo "send.sh — --file with NUL bytes (rejected)"
binfile="$(mktemp)"; printf 'abc\x00def' > "$binfile"
out="$(C2C_DRY_PARSE=1 bash "$SEND" laptop --file "$binfile" 2>&1; echo "EXIT=$?")"
assert_exit_nonzero "--file NUL bytes: exit nonzero" "${out##*EXIT=}"
rm -f "$binfile"

echo "send.sh — --stdin with NUL bytes (rejected)"
out="$(printf 'abc\x00def' | C2C_DRY_PARSE=1 bash "$SEND" laptop --stdin 2>&1; echo "EXIT=$?")"
assert_exit_nonzero "--stdin NUL bytes: exit nonzero" "${out##*EXIT=}"

echo "send.sh — --file over 64 KiB (rejected)"
bigfile="$(mktemp)"; head -c 70000 /dev/zero | tr '\0' 'A' > "$bigfile"
out="$(C2C_DRY_PARSE=1 bash "$SEND" laptop --file "$bigfile" 2>&1; echo "EXIT=$?")"
assert_exit_nonzero "--file 70KB: exit nonzero" "${out##*EXIT=}"
rm -f "$bigfile"

echo "send.sh — --file at exactly 64 KiB (accepted)"
fitfile="$(mktemp)"; head -c 65536 /dev/zero | tr '\0' 'A' > "$fitfile"
out="$(C2C_DRY_PARSE=1 bash "$SEND" laptop --file "$fitfile" 2>&1; echo "EXIT=$?")"
# Should succeed and print PEER=... + BODY=... (64KB of A's). We just check exit=0.
if [[ "${out##*EXIT=}" == "0" ]]; then
  printf '  ok   %s\n' "--file 64KB cap: accepted"
  PASS=$((PASS+1))
else
  printf '  FAIL %s (exit=%s)\n' "--file 64KB cap: accepted" "${out##*EXIT=}"
  FAIL=$((FAIL+1)); FAILED_NAMES+=("--file 64KB cap: accepted")
fi
rm -f "$fitfile"

# ---------- reply.sh (mirror coverage) ----------
echo "reply.sh — positional CLI"
out="$(run_parse "$REPLY" msg-id-123 hello body)"
assert_eq "reply positional: rid" "RID=msg-id-123" "$(printf '%s\n' "$out" | head -n1)"
assert_eq "reply positional: body" "BODY=hello body" "$(printf '%s\n' "$out" | tail -n1)"

echo "reply.sh — slash-command form"
out="$(run_parse "$REPLY" "msg-id-123 hello body")"
assert_eq "reply single-arg: rid" "RID=msg-id-123" "$(printf '%s\n' "$out" | head -n1)"
assert_eq "reply single-arg: body" "BODY=hello body" "$(printf '%s\n' "$out" | tail -n1)"

echo "reply.sh — --file PATH"
tmpfile="$(mktemp)"; printf 'reply via file' > "$tmpfile"
out="$(run_parse "$REPLY" msg-id-123 --file "$tmpfile")"
assert_eq "reply --file: body" "BODY=reply via file" "$(printf '%s\n' "$out" | tail -n1)"
rm -f "$tmpfile"

echo "reply.sh — --stdin"
out="$(echo 'reply piped' | C2C_DRY_PARSE=1 bash "$REPLY" msg-id-123 --stdin 2>/dev/null)"
assert_eq "reply --stdin: body" "BODY=reply piped" "$(printf '%s\n' "$out" | tail -n1)"

# ---------- summary ----------
echo
echo "------------------------------"
echo "passed: $PASS"
echo "failed: $FAIL"
if (( FAIL > 0 )); then
  printf 'failing tests:\n'
  printf '  - %s\n' "${FAILED_NAMES[@]}"
  exit 1
fi
exit 0
