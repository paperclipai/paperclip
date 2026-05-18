# Alerting

## Routing Rules

- **CRITICAL**: Telegram to Nick immediately, then Paperclip Proposal with snapshot.
- **WARNING / informational**: Paperclip Proposal only.

## Alert Catalog

| Alert | Threshold | Channel |
|-------|-----------|---------|
| CPU high | > 80% for 2 min | Telegram |
| Memory high | > 80% | Telegram |
| Disk high | > 85% | Telegram |
| Health check fail | /healthz 503 or > 1s | Telegram |
| Polling storm | > 50 req/sec on any endpoint | Telegram |
| Log growth | > 50 MB/hour | Telegram |

## Flap Protection

If the watchdog restarts a service more than 3 times in 15 minutes:
1. Stop auto-remediation.
2. Send CRITICAL Telegram alert.
3. Create Paperclip Proposal with diagnostic snapshot.
4. Wait for human ack.

## Silencing / Acking

- Reply to the Paperclip Proposal to acknowledge.
- To silence: add a comment on the Proposal with `silence`.