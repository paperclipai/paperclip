# Alerting Runbook

## Routing Rules

### Critical

Send immediately to:

1. Telegram (real-time paging)
2. Paperclip Proposal (for traceable follow-up)

Critical conditions include:

- watchdog auto-remediation action fired
- flap protection engaged
- service unhealthy for sustained threshold
- severe socket/disk thresholds breached

### Warning / Info

Send to:

1. Paperclip Proposal only

Typical warning cases:

- elevated but non-critical connection counts
- early pressure indicators without direct remediation

## Alert Payload Contract

Every alert must include:

- `severity`
- `trigger` (what tripped)
- `current value` and `threshold`
- last 20 relevant log lines
- suggested next action

## Core Alert Catalog

- CPU > 80% for 2 minutes
- Memory > 80%
- Disk > 85%
- `/healthz` failure or response > 1s
- Single endpoint > 50 req/sec
- `server.log` growth > 50MB/hour

## Silencing and Ack

### Temporary Silence

- Use short-duration mute only for active maintenance windows.
- Do not mute critical channels for unknown incidents.

### Acknowledgement

- Ack in Paperclip Proposal with owner + expected ETA.
- For critical Telegram pages, follow with Proposal link and action note.

## Flap-Protection Escalation

If watchdog restart cap is exceeded (3x/15m for a service):

- stop automated restart attempts for that service
- send CRITICAL Telegram alert
- create Paperclip Proposal with diagnostics snapshot
- require human/operator acknowledgment before further intervention

