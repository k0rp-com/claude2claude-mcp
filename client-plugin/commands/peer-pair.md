---
description: Initiate pairing with another machine (4-digit code shown — tell the user of the other machine to enter via /c2c-client:peer-confirm)
argument-hint: <other-machine-fingerprint>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/pair.sh:*)
---

!`${CLAUDE_PLUGIN_ROOT}/scripts/pair.sh "$ARGUMENTS"`
