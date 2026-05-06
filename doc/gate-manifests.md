# Gate Manifests

Gate manifests are machine-readable completion checklists for production-bound missions.

## Issue Document Convention

Store the manifest as an issue document:

- key: `gate_manifest`
- title: `Gate Manifest`
- format: `markdown`
- body: deterministic JSON formatted by `formatGateManifestDocumentBody`

The API validates this document on upsert. Malformed JSON, duplicate gate ids, and dangling gate blockers are rejected.

## Materializing Gates

Gate manifests can be materialized into first-class child issues:

```sh
pnpm paperclipai issue gates:materialize <issue-id>
```

The materializer creates or reuses one child issue per gate, writes each child `issueId`
back into the `gate_manifest` document, converts `blockedByGateIds` into concrete
`blockedByIssueIds`, and blocks the parent issue on the materialized gate children by
default. Re-running the command is idempotent when the manifest already has `issueId`
values or when matching gate children exist with origin id `<parentIssueId>:<gateId>`.

Use `--no-block-parent` only for exploratory drafts where the parent should not be held
behind the gate children yet.

## Schema

The v1 schema is exported as `gateManifestSchema` from `@paperclipai/shared`.

```json
{
  "version": 1,
  "gates": [
    {
      "id": "implementation",
      "type": "implementation",
      "title": "Implement the fix",
      "ownerAgentName": "fixer",
      "status": "passed",
      "requiredEvidence": ["commit", "focused_tests"]
    },
    {
      "id": "production-smoke",
      "type": "production_smoke",
      "title": "Smoke production",
      "ownerAgentName": "watcher",
      "status": "pending",
      "blockedByGateIds": ["release"]
    }
  ],
  "donePolicy": "all_required_gates_passed"
}
```

## Completion Guard

When an issue has a `gate_manifest` document, the issue cannot move to `done` unless every gate is `passed` or `waived`. The API returns `409 Required gates are incomplete` with the incomplete gate ids.

Supported gate statuses:

- `pending`
- `in_progress`
- `passed`
- `failed`
- `blocked`
- `waived`

Supported gate types:

- `implementation`
- `review`
- `independent_review`
- `qa`
- `qa_golden_path`
- `security_privacy`
- `release`
- `production_smoke`
- `cleanup`
