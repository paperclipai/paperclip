# Evidence Records

Evidence records are the machine-readable proof for mission gates. Comments may summarize evidence, but comments are not the canonical record.

## Issue Document Convention

Store evidence as an issue document:

- key: `evidence_records`
- title: `Evidence Records`
- format: `markdown`
- body: deterministic JSON formatted by `formatEvidenceRecordsDocumentBody`

The API validates this document on upsert.

Agents can append one record without rebuilding the document by hand:

```sh
pnpm paperclipai issue evidence:append <issue-id> \
  --id prod-smoke-1 \
  --gate-id production-smoke \
  --gate-type production_smoke \
  --url "Production /trips=https://app.example.com/trips" \
  --screenshot "desktop=.paperclip/artifacts/prod-trips.png" \
  --commit-sha 0123456789abcdef0123456789abcdef01234567
```

## Schema

The v1 schema is exported as `evidenceRecordsDocumentSchema` from `@paperclipai/shared`.

```json
{
  "version": 1,
  "records": [
    {
      "id": "qa-1",
      "gateId": "qa",
      "gateType": "qa",
      "status": "passed",
      "timestamp": "2026-05-06T00:00:00.000Z",
      "issueId": "11111111-1111-4111-8111-111111111111",
      "agentName": "watcher",
      "runId": "22222222-2222-4222-8222-222222222222",
      "repo": "example/travel-app",
      "branch": "paperclip/watcher-PC-639",
      "commitSha": "0123456789abcdef0123456789abcdef01234567",
      "commands": [
        {
          "command": "yarn --cwd apps/web vitest run test/services/firestore/tripQueries.legacyOwner.test.ts",
          "cwd": "/tmp/paperclip/worktrees/agent-watch",
          "exitCode": 0,
          "status": "passed"
        }
      ],
      "urls": [],
      "screenshots": [],
      "artifacts": [],
      "notes": "Focused regression passed."
    }
  ]
}
```

Supported evidence statuses:

- `passed`
- `failed`
- `blocked`
- `skipped`

## Completion Enforcement

Gate manifest completion checks structured evidence when an issue moves to `done`.
Passed `release` gates require `commit` and `deploy_url` evidence by default.
Passed `production_smoke` gates require `production_url` and `screenshot_or_artifact`
evidence by default. Gate-specific `requiredEvidence` entries are also enforced.
