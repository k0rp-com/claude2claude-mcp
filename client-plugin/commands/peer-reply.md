---
description: Reply to a specific incoming message id (keeps the same thread). For long or special-character bodies use `--file PATH`.
argument-hint: <message_id> <body> | <message_id> --file <path>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/reply.sh:*)
---

!`${CLAUDE_PLUGIN_ROOT}/scripts/reply.sh "$ARGUMENTS"`
