---
description: Send a message to a paired peer by name. For long or special-character bodies (parens, quotes, newlines) use `--file PATH`; the inline form gets mangled by shell quoting.
argument-hint: <peer-name> <message> | <peer-name> --file <path>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/send.sh:*)
---

!`${CLAUDE_PLUGIN_ROOT}/scripts/send.sh "$ARGUMENTS"`
