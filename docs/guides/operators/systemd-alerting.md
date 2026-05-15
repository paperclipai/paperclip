# Systemd Alerting — Anti-Dedupe Pipeline

## Overview

`systemd_alert` is a special `originKind` in Paperclip that prevents duplicate incident tickets for systemd unit failures.

## How It Works

When creating an issue with `originKind: "systemd_alert"`:

1. Paperclip checks if an open issue exists with the same `originFingerprint` (unit + service combo)
2. If exists: adds a comment with recurrence timestamp and returns the existing issue
3. If not: creates a new issue

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

Create a routine that:
1. Checks systemd unit status via health-check.sh
2. Updates `executionState.lastGreenAt` when unit is healthy
3. Closes issue if `lastGreenAt` was 24+ hours ago

Example routine logic:
```typescript
const issue = await findOpenSystemdAlertIssue(fingerprint);
if (issue && issue.executionState?.lastGreenAt) {
  const hoursSinceGreen = (Date.now() - new Date(issue.executionState.lastGreenAt).getTime()) / 3600000;
  if (hoursSinceGreen >= 24) {
    await closeIssue(issue.id, { comment: "Auto-closed after 24h green" });
  }
}
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

- Migration: `0073_systemm_alert_dedupe.sql`
- Code: `server/src/services/issues.ts` (create method, line 2643)
- Issue: OFM-236
