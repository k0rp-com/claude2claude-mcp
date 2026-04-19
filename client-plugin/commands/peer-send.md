---
description: Send a message to a paired peer by name (e.g. /c2c-client:peer-send laptop "hi from desktop")
argument-hint: <peer-name> <message>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/send.sh:*)
---

!`${CLAUDE_PLUGIN_ROOT}/scripts/send.sh "$ARGUMENTS"`
