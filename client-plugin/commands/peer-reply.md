---
description: Reply to a specific incoming message id (keeps the same thread)
argument-hint: <message_id> <body>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/reply.sh:*)
---

!`${CLAUDE_PLUGIN_ROOT}/scripts/reply.sh "$ARGUMENTS"`
