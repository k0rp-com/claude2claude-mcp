#!/usr/bin/env bash
# Report whether this window's peer-mail listener is running. The listener is
# armed by hooks.json (asyncRewake on SessionStart/Stop), so there is nothing to
# start by hand — at worst it comes back at the end of the next turn.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

if [[ ! -f "$C2C_IDENTITY_FILE" || ! -f "$C2C_NAME_FILE" ]]; then
  echo "listener: off — this machine is not registered yet; run /c2c-client:peer-name <name>"
  exit 0
fi
if c2c::session_is_print_mode; then
  echo "listener: off in -p sessions — mail is delivered by the Stop hook at the end of each turn"
  exit 0
fi
# This script always runs inside a turn (the /peer-listen command is one), and the
# Stop hook at the end of that turn arms or takes over the listener — so "this
# turn", not "the next one".
c2c::warm_window_id
state="$(c2c::listener_state)"
case "$state" in
  mine)    echo "listener: running in this window (pid=$(c2c::listener_recorded_pid))" ;;
  foreign) echo "listener: running in another window (pid=$(c2c::listener_recorded_pid)) — this window takes it over as soon as this turn ends" ;;
  *)       echo "listener: not running yet — it starts as soon as this turn ends" ;;
esac
# Не менять, потому что в stream-json листенер не может стартовать на SessionStart (держит system/init) — без пояснения «ещё не запущен» на первом ходу чата выглядит как поломка
if [[ "$state" != mine && "$(c2c::session_mode)" == stream ]]; then
  echo "(chat mode: the listener starts after the first turn of a session; mail that arrives before that waits on the server and is delivered right then)"
fi
