# Janitor Anomaly Rules

The Janitor should not silently fix suspicious operational patterns. It should report them and open a Paperclip issue tagged `needs-review`.

## Severity Levels

| Severity | Meaning | Action |
|----------|---------|--------|
| `info` | Worth noting but not urgent | Include in report |
| `warn` | Needs CEO/operator review soon | Open issue if repeated or above threshold |
| `critical` | May block operations or risk data loss | Open issue immediately |

## Agent Health Anomalies

| Rule | Severity | Condition |
|------|----------|-----------|
| Agent has no successful runs | warn | 0 successful runs in 7 days and at least 1 attempted run |
| Repeated failures | warn | >3 failed runs in 24 hours for one agent |
| Run timeout burst | warn | >2 timed-out runs in 24 hours for one agent |
| Agent appears stuck | critical | Any run `running` longer than configured heartbeat timeout plus 15 minutes |

## Storage Anomalies

| Rule | Severity | Condition |
|------|----------|-----------|
| Paperclip disk high | warn | `/paperclip` usage >80% |
| Paperclip disk critical | critical | `/paperclip` usage >90% |
| Temp disk high | warn | `/tmp` usage >80% |
| Oversized workspace | warn | Any workspace >5 GB |
| Rapid growth | warn | Estimated Paperclip disk usage grew >20% since last Janitor report |

## Cleanup Anomalies

| Rule | Severity | Condition |
|------|----------|-----------|
| Unsafe candidate skipped | warn | Any candidate matched retention but failed safety gates |
| Missing cleanup command | info | CLI/API command for safe heartbeat artifact cleanup is unavailable |
| Repeated stale locks | warn | >5 stale locks found in one run |
| Many orphaned workspaces | warn | >10 orphaned workspaces found in one run |
