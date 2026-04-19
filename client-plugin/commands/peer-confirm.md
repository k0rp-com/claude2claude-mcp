---
description: Accept an incoming pair request by entering the 6-digit code shown on the initiator
argument-hint: <code> [request_id]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/confirm.sh:*)
---

!`${CLAUDE_PLUGIN_ROOT}/scripts/confirm.sh "$ARGUMENTS"`
