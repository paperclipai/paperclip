# Reliability Scorecards

Reliability scorecards summarize whether a company is moving toward autonomous task
handling or still depending on manual rescue.

## Issue Document Convention

Store scorecards as an issue document:

- key: `reliability_scorecard`
- title: `Reliability Scorecard`
- format: `markdown`
- body: deterministic JSON formatted by `formatReliabilityScorecardDocumentBody`

The API validates this document on upsert.

## Schema

The v1 schema is exported as `reliabilityScorecardDocumentSchema` from `@paperclipai/shared`.

```json
{
  "version": 1,
  "generatedAt": "2026-05-06T00:00:00.000Z",
  "companyId": "11111111-1111-4111-8111-111111111111",
  "window": {
    "from": "2026-05-05T00:00:00.000Z",
    "to": "2026-05-06T00:00:00.000Z"
  },
  "summary": {
    "status": "passing",
    "controlPlaneReliability": 0.9999,
    "evidenceCompletenessRate": 1,
    "manualRescueCount": 0
  },
  "metrics": [
    {
      "key": "scoped_wake_success_rate",
      "label": "Scoped wake success rate",
      "value": 1,
      "unit": "ratio"
    }
  ],
  "topBlockers": [
    {
      "class": "workspace_preflight",
      "count": 1,
      "blockedMinutes": 12
    }
  ]
}
```

Scorecards are intentionally derived data. They do not replace heartbeat runs, gate
manifests, readiness records, or evidence records; they give the board a compact
view of the control-plane health over a window.
