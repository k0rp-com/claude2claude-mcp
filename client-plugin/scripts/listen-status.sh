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
c2c::warm_window_id
case "$(c2c::listener_state)" in
  mine)    echo "listener: running in this window (pid=$(c2c::listener_recorded_pid))" ;;
  foreign) echo "listener: running in another window (pid=$(c2c::listener_recorded_pid)) — this window takes it over at the end of its next turn" ;;
  *)       echo "listener: not running — it is re-armed automatically at the end of the next turn" ;;
esac
