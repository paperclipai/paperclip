# Phase 23: Advanced Work Board and Native Capture - Discussion Log

> **Audit trail only.** Decisions are captured in `23-CONTEXT.md`.

**Date:** 2026-04-25  
**Phase:** 23-advanced-work-board-and-native-capture  
**Mode:** `--auto --chain`

## Work Board Metadata

| Option | Description | Selected |
|--------|-------------|----------|
| RT2 board metadata tables | Store checklist/due/quality/price/attachments in RT2-controlled tables while keeping `/issues` compatibility | ✓ |
| Issue table rewrite | Add every Trello field directly to legacy `issues` | |
| UI-only metadata | Keep board details only in local state | |

**Choice:** RT2 board metadata tables.

## Capture Queue

| Option | Description | Selected |
|--------|-------------|----------|
| Review-required queue | Persist inbound mobile/native/messenger entries and promote after review | ✓ |
| Direct task creation | Inbound entries create tasks immediately | |
| Preview-only | Keep inbound draft response ephemeral | |

**Choice:** Review-required queue.

## Audit Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Draft status and audit trail | Track duplicate, permission, failure, promoted states per source | ✓ |
| Error-only response | Surface failures only at request time | |

**Choice:** Draft status and audit trail.

## Deferred Ideas

- Store-distributed native app.
- Slack/Teams app install and public webhook hardening.
- Full route/type rename from Issue to Task.
