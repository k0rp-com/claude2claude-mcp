---
description: Manually load (and ack) all unread peer messages, wrapped in a security frame
argument-hint: [wait_seconds]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/inbox.sh:*)
---

!`${CLAUDE_PLUGIN_ROOT}/scripts/inbox.sh $ARGUMENTS`
