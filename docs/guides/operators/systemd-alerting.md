# Systemd Alerting - Dedupe Pipeline

## Overview

`systemd_alert` is a special `originKind` in Paperclip that prevents duplicate incident tickets for systemd unit failures.

## How It Works

When creating an issue with `originKind: "systemd_alert"`:

1. `originFingerprint` is required and must be unique per `{host}:{unit}`.
2. Paperclip checks if an open issue exists with the same `originFingerprint`.
3. If an open issue exists, Paperclip posts a recurrence comment and returns that issue.
4. If no open issue exists, Paperclip creates a new issue.

## Usage

### Creating a Systemd Alert Issue

```bash
curl -X POST "http://localhost:3100/api/companies/{companyId}/issues" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "[ofmstars-prod] balance1-etl.service failed",
    "description": "Unit failed with exit code 1",
    "originKind": "systemd_alert",
    "originFingerprint": "ofmstars-prod:balance1-etl.service",
    "priority": "high",
    "status": "todo",
    "projectId": "{serverProjectId}"
  }'
```

### Fingerprint Format

Use format: `{hostname}:{unitName}`

Examples:
- `ofmstars-prod:balance1-etl.service`
- `datejasmin-prod:content-pipeline-bot.service`

### Auto-Closing After 24h Green

When a monitor observes the unit healthy, it should update `executionState.lastGreenAt`.
Paperclip auto-closes open `systemd_alert` issues when `lastGreenAt` is 24+ hours old.

Example monitor-side update:
```bash
curl -X PATCH "http://localhost:3100/api/companies/{companyId}/issues/{issueId}" \
  -H "Content-Type: application/json" \
  -d '{
    "executionState": {
      "lastGreenAt": "2026-05-17T10:00:00.000Z"
    }
  }'
```

## Database Schema

Unique constraint prevents duplicates:
```sql
CREATE UNIQUE INDEX issues_active_systemd_alert_incident_uq
  ON issues (company_id, origin_fingerprint)
  WHERE
    origin_kind = 'systemd_alert'
    AND hidden_at IS NULL
    AND status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');
```

## Related

- Migration: `0085_systemd_alert_dedupe.sql`
- Code: `server/src/services/issues.ts` (`create` + `update`)
- Issue: OFM-236
