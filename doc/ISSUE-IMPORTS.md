# Staged Linear issue import

Status: review-only implementation; not deployed or enabled in a shared environment.

Paperclip exposes a dedicated board-authorized boundary for provider-origin issues. It does **not** add provenance fields to generic issue creation, does not activate work, and does not schedule agents.

## Endpoints

All endpoints require board access to the path company. Agent API keys, including ordinary task-bridge keys, are rejected.

- `POST /api/companies/{companyId}/issue-imports/preview`
- `POST /api/companies/{companyId}/issue-imports/apply`
- `GET /api/companies/{companyId}/issue-imports/{runId}`

The same contract is published in the generated OpenAPI document.

## Head-of-Product preview payload

```json
{
  "provider": "linear",
  "manifestVersion": 1,
  "sourceSnapshot": {
    "retrievedAt": "2026-07-31T19:00:00.000Z",
    "version": "linear-census-or-sync-version"
  },
  "options": {
    "stageUnassigned": true,
    "suppressWakes": true,
    "conflictPolicy": "record"
  },
  "projectMappings": {
    "linear-project-uuid": "paperclip-project-uuid"
  },
  "items": [
    {
      "sourceId": "linear-immutable-issue-uuid",
      "sourceIdentifier": "EXT-384",
      "sourceVersion": "linear-updated-at-or-revision",
      "sourceUpdatedAt": "2026-07-31T18:00:00.000Z",
      "sourceUrl": "https://linear.app/example/issue/EXT-384/example",
      "title": "Example staged provider issue",
      "description": "Provider text is treated as untrusted data.",
      "sourceStatus": "Backlog",
      "priority": "critical",
      "projectSourceId": "linear-project-uuid",
      "parentSourceId": null,
      "blockedBySourceIds": [],
      "comments": [
        {
          "sourceCommentId": "linear-comment-id",
          "sourceEventId": "linear-event-id",
          "sourceUpdatedAt": "2026-07-31T18:30:00.000Z",
          "body": "Imported once"
        }
      ]
    }
  ]
}
```

Preview computes the manifest digest and each origin fingerprint server-side. It writes bounded audit/run rows only. It does not write issues, relations, assignments, comments, or wake requests. The apply request must echo the returned identifiers:

```json
{
  "previewRunId": "preview-run-uuid",
  "previewDigest": "64-character-server-digest",
  "activate": false
}
```

`activate: true` is rejected. Apply rejects an expired, failed, already-applied, cross-company, or digest-mismatched preview.

## Mapping and reconciliation

- Origin linkage is `originKind=linear_issue`, immutable Linear UUID in `originId`, and `sha256("linear_issue\\0" + sourceId)` in `originFingerprint`.
- A partial unique database index and per-source transaction lock prevent duplicate origins under replay or concurrency.
- Backlog maps to `backlog`; Todo maps to unassigned `todo`. In Progress and In Review stage as `backlog` with `source_status_requires_accountable_execution_path` rather than fabricating execution.
- Missing project mappings are conflicts and apply with no guessed project. Invalid mapped Paperclip projects and unresolved required parent/blocker sources are failures.
- Paperclip fields and relations are authoritative after import state exists. A later source version is recorded as drift and updates origin state/audit data without silently overwriting Paperclip issue fields or restoring Paperclip-side relation edits.
- A pre-existing immutable Linear origin with no import state has one bounded first-link adoption window. Apply may adopt a declared source parent only when the current Paperclip parent is null, and may adopt declared source blockers only when the current Paperclip blocker set is empty. Any established parent or blocker state, including Paperclip-native relations, is preserved; mismatches record `parent_relation_drift` or `blocker_relations_drift` rather than overwriting current state.
- Preview reports proposed parent/blocker source IDs alongside current parent/blocker issue IDs. Apply re-reads current relation state under the import transaction and records `source_initial`, `source_first_link`, or `paperclip` authority plus conflict and applied behavior in each item's `relationResults`.
- Initial parent and blocker edges for newly created issues, and eligible first-link relation adoption for existing origins, are applied only after every source resolves to one issue, in the same transaction.
- Apply writes every imported issue unassigned and never invokes the wake path. Its `wakes=0` report describes import-owned behavior rather than a racy company-wide wake-count delta, so unrelated concurrent wake processing cannot invalidate an import.
- Imported comments use unique provider event receipts and `suppressOutboundMirror=true` metadata. Replay creates one comment and the receipt is the connector-facing loop guard.
- Run and item records retain source version/timestamp, proposed/current/applied values, conflicts, failures, relations, comments, assignment count, and wake count. Request schemas do not accept provider credentials, and persisted failures use a bounded generic message.

## Internal pilot safety rule

An approved internal ten-item manifest may be submitted to **preview only** during review. Its acceptance evidence is `received=10`, `assignments=0`, `wakes=0`, with issue and wake counts unchanged. Do not apply that pilot as part of implementation review.

Synthetic fixtures may exercise apply in an isolated test database.

## Rollback

1. Remove/disable the `issueImportRoutes` mount to stop new previews and applies.
2. Retain the additive audit/origin-state/event-receipt tables for evidence and reconciliation.
3. Do not drop `issues_linear_origin_uq` or the immutable-origin trigger while linked Linear issues exist.
4. A schema rollback requires a reviewed export/migration of existing origin states; deleting origin evidence is not an acceptable operational rollback.

## Residual risks

- The current authorization is intentionally board-only. A future task-bridge/import-agent capability needs separate permission and security review.
- The route accepts at most 100 issues and 50 comments per issue; larger portfolios require bounded batches and cross-batch relation planning.
- Source ordering/version semantics are provider strings; the boundary records equality/drift but does not infer provider-specific revision ordering.
- Comment loop prevention is enforced for inbound receipts and marked for outbound filtering. Any future outbound Linear connector must explicitly honor the marker and receipt table.
- The implementation has focused local PostgreSQL evidence but has not been deployed, externally tested, or used to apply the internal pilot.
