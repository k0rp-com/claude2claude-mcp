---
description: Set or change this machine's name (required before pairing). First call also registers with the mediator.
argument-hint: <new-name>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/name.sh:*)
---

!`${CLAUDE_PLUGIN_ROOT}/scripts/name.sh "$ARGUMENTS"`
