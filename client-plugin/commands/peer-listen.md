---
description: Show whether the peer-mail listener is running. It is armed automatically by hooks — nothing to start by hand.
argument-hint:
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/listen-status.sh:*)
---

!`${CLAUDE_PLUGIN_ROOT}/scripts/listen-status.sh`

Relay the line above to the user as is. The peer-mail listener runs as a background hook armed at session start and re-armed at the end of every turn; it wakes this session only when a peer message or pair request arrives. Do not start a Monitor or poll the inbox yourself.
