---
title: Heartbeat Failure Webhook — Operator Notification Channel
version: prx-46
date: 2026-08-21
commits: 5186d64c25
status: Committed to custom branch. Available when `PAPERCLIP_HEARTBEAT_FAILURE_WEBHOOK_URL` is set.
---

# Heartbeat Failure Webhook — Operator Notification Channel

**Feature:** PRX-46
**Commit:** `5186d64c25`
**Date:** 2026-08-21
**Status:** Committed

## What Changed

Paperclip now supports an operator-facing webhook notification channel for heartbeat failures. When a heartbeat run reaches a terminal failure status (process lost, agent not found, adapter failure, or setup failure), the server can POST a JSON payload to a configured webhook URL — enabling real-time alerting through Discord, Slack, PagerDuty, or any custom endpoint.

### How it works

1. Set the `PAPERCLIP_HEARTBEAT_FAILURE_WEBHOOK_URL` environment variable to your webhook URL
2. The server sends a JSON POST on every terminal heartbeat failure
3. The webhook is fire-and-forget — errors calling the webhook are logged and never break the triggering operation
4. The startup banner shows webhook status on the "HB Failure Webhook" line

### Payload

```json
{
  "event": "heartbeat.failed",
  "timestamp": "2026-08-21T19:30:00.000Z",
  "runId": "run-xxx",
  "agentId": "agent-xxx",
  "agentName": "Agent Name or null",
  "companyId": "company-xxx",
  "errorCode": "adapter_failed|process_lost|agent_not_found|setup_failed",
  "error": "Human-readable error message",
  "previousStatus": "running|queued"
}
```

### Failure paths

| Failure Path | `errorCode` | When |
|---|---|---|
| Process lost | `process_lost` | Reaper detects a process is lost and marks the run as failed |
| Agent not found | `agent_not_found` | The agent referenced by the run no longer exists |
| Adapter execution failure | `adapter_failed` | The adapter throws during execution |
| Setup failure | `setup_failed` | Setup code before adapter execution throws |

### Configuration

| Variable | Description |
|---|---|
| `PAPERCLIP_HEARTBEAT_FAILURE_WEBHOOK_URL` | Webhook URL accepting JSON POST requests (Discord, Slack, custom HTTP endpoint, PagerDuty, etc.) |

## Who This Affects

**Server operators.** This is not a user-configurable feature — it is set at the server level. Board users cannot see or configure it. If the webhook is not configured, heartbeat failures are still logged locally and visible in the server logs.

## Support Impact

Low. This is an operator tool. If a customer reports delayed or missing agent runs and the server operator has the webhook configured, the heartbeat failure webhook can help diagnose whether the agent processes are failing silently.