# Readiness Records

Readiness records are durable proof that an agent can safely receive higher-risk work.
They are intended for canary missions and Systems Steward checks.

## Issue Document Convention

Store readiness as an issue document:

- key: `readiness_records`
- title: `Readiness Records`
- format: `markdown`
- body: deterministic JSON formatted by `formatReadinessRecordsDocumentBody`

The API validates this document on upsert.

## Schema

The v1 schema is exported as `readinessRecordsDocumentSchema` from `@paperclipai/shared`.

```json
{
  "version": 1,
  "records": [
    {
      "id": "fixer-canary-1",
      "agentName": "fixer",
      "status": "passed",
      "timestamp": "2026-05-06T00:00:00.000Z",
      "expiresAt": "2026-05-07T00:00:00.000Z",
      "issueId": "11111111-1111-4111-8111-111111111111",
      "runId": "22222222-2222-4222-8222-222222222222",
      "checks": [
        {
          "type": "issue_scoped_wake",
          "status": "passed",
          "message": "PAPERCLIP_TASK_ID and PAPERCLIP_WAKE_PAYLOAD_JSON were present."
        },
        {
          "type": "workspace_preflight",
          "status": "passed",
          "message": "Resolved per-issue git worktree."
        }
      ]
    }
  ]
}
```

Supported check types include adapter executable, model auth, cwd, API, API key,
issue-scoped wake, issue comment/update path, project workspace policy, workspace
preflight, Git/GitHub auth, Browser Harness, and cleanup.
