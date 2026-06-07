# Memory Core Historical-Memory Migration Policy

Status: draft for review
Owner: CTO
Applies to: Memory Core Phase 6 historical-memory migration

## Objective

Define the default policy, review lifecycle, and candidate schema for migrating
historical agent memory into Memory Core without turning private local state into
authoritative product data. Phase 6 may recall historical memory as context for
review, but it must not bulk-import old memories by default.

## Policy

Historical memory migration is opt-in, candidate-based, and review-gated.
Recalled Memory Core data is non-authoritative context only. It must never
override canonical sources such as source files, GitHub issues or pull requests,
calendar events, mail, host checks, runtime receipts, database state, deployment
state, or fresh operator instructions.

Phase 6 must reject broad historical imports as the default behavior. A
migration job may propose candidates, but no candidate becomes live Memory Core
data until it passes schema validation, privacy classification, source review,
and approval. The implementation must preserve a distinction between stale
historical facts and live/current facts so recall can surface uncertainty instead
of rewriting current state.

Secrets, live configuration, database contents, private logs, raw adapter
payloads, raw memory files, tokens, credentials, and customer-private material
must be excluded from source code, issue comments, pull requests, docs, and
generated review artifacts. Migration tooling may store private review evidence
only in the approved private runtime or data store for that company, never in
source-managed artifacts.

Hermes must not self-approve memories that become operator-shared or
company-shared. Any candidate proposed or edited by Hermes for an
operator-shared scope requires approval by a separate authorized operator or
agent with the relevant review role. Self-approval is allowed only for purely
private, agent-local memories when company policy permits local self-maintenance.

## Candidate Lifecycle

Candidates must move through explicit lifecycle states:

- `proposed`: created by recall, scan, manual entry, or migration tooling.
- `reviewed`: checked by a reviewer for source grounding, privacy, and current
  applicability.
- `approved`: accepted for migration by an authorized approver.
- `migrated`: written into Memory Core through the audited migration path.
- `rejected`: declined because it is wrong, unsafe, duplicative, unsupported, or
  not worth retaining.
- `expired`: aged out by retention policy before or after approval.
- `deleted`: removed through the rollback/delete path, including any derived
  index entries.

Allowed forward transitions:

- `proposed` -> `reviewed`, `rejected`, or `expired`
- `reviewed` -> `approved`, `rejected`, or `expired`
- `approved` -> `migrated`, `rejected`, or `expired`
- `migrated` -> `expired` or `deleted`
- `expired` -> `deleted`

Rejected and deleted candidates must not return to a mutable active state. A new
candidate may be created if new canonical evidence appears.

## Candidate Schema

The implementation should define a JSON Schema or equivalent typed validator for
candidate records. Required fields:

```json
{
  "id": "memcand_...",
  "sourceRefs": [
    {
      "type": "github_issue|github_pr|file|calendar|mail|host_check|runtime_receipt|manual_attestation|memory_recall",
      "ref": "stable external or internal reference",
      "observedAt": "2026-06-07T00:00:00.000Z",
      "canonical": false
    }
  ],
  "summary": "Short reviewable statement, not raw source payload.",
  "reviewState": "proposed|reviewed|approved|migrated|rejected|expired|deleted",
  "privacyClass": "agent_private|operator_private|operator_shared|company_internal|public",
  "staleLive": "stale|live|unknown",
  "retentionPolicy": {
    "class": "ephemeral|time_boxed|until_superseded|permanent_reviewed",
    "expiresAt": "2026-12-07T00:00:00.000Z",
    "reviewAfter": "2026-09-07T00:00:00.000Z"
  },
  "owner": {
    "type": "agent|operator|team",
    "id": "stable owner id"
  },
  "rollbackDeletePath": {
    "procedure": "delete_candidate_and_memory_record",
    "memoryRecordId": "optional after migration",
    "indexKeys": ["optional derived index keys"],
    "auditRef": "audit event or issue reference"
  },
  "approvals": [
    {
      "approverType": "agent|operator|team",
      "approverId": "stable approver id",
      "approvedAt": "2026-06-07T00:00:00.000Z",
      "scope": "operator_shared"
    }
  ],
  "createdAt": "2026-06-07T00:00:00.000Z",
  "updatedAt": "2026-06-07T00:00:00.000Z"
}
```

Validation expectations:

- `sourceRefs` must contain at least one reference. `memory_recall` references
  are allowed as provenance, but they are not canonical evidence.
- `summary` must be a concise derived statement and must not contain raw
  payloads, secrets, credentials, private logs, or full copied source material.
- `privacyClass` controls where the candidate may be displayed, exported,
  indexed, or used for recall. The default for imported historical material is
  the most restrictive plausible class until review downgrades it.
- `staleLive` must be explicit. `unknown` is allowed only before review and must
  reduce recall confidence.
- `retentionPolicy` is required before approval. `permanent_reviewed` requires a
  named owner and canonical source reference.
- `owner` is required for every candidate and owns re-review, expiry, and
  deletion requests.
- `rollbackDeletePath` is required before migration and must identify how to
  remove the migrated record and derived indexes.
- `operator_shared` and `company_internal` candidates require an approval from a
  principal different from the proposing Hermes agent.

## Migration Rules

1. Scan or recall historical memory into candidates only.
2. Classify each candidate before display outside the proposing agent's private
   context.
3. Compare candidate claims against canonical sources when available.
4. Record non-canonical memory recall as provenance, not proof.
5. Require reviewer approval before migration.
6. Migrate through an audited write path that records candidate id, approver,
   owner, privacy class, retention policy, and rollback/delete metadata.
7. Keep stale candidates recallable only as historical context with reduced
   confidence and visible staleness.
8. Delete or expire candidates when retention policy, privacy review, or owner
   request requires it.

## Rejected Alternatives

Bulk importing historical memory by default is rejected. It would mix stale,
private, duplicated, and ungrounded claims into the new Memory Core and create a
high rollback cost after the data has been indexed or recalled by agents.

Treating prior memory as authoritative is rejected. Historical memory can help
find sources or remind agents of prior context, but canonical systems remain the
source of truth.

Making Hermes the sole approver for operator-shared memories is rejected.
Hermes may propose and enrich candidates, but shared memory changes require an
independent approval boundary.

Storing raw historical payloads in source-managed fixtures, issue comments, PRs,
or docs is rejected. Review artifacts must contain derived summaries and stable
references only.

Migrating without a rollback/delete path is rejected. Every approved migration
must remain removable, including derived indexes and cached recall entries.

## Implementation Tasks This Enables

- Add a typed candidate schema and validator matching this policy.
- Add migration-state transition enforcement and audit events.
- Add privacy-class gates for candidate display, export, indexing, and recall.
- Add approval enforcement that prevents Hermes self-approval for
  operator-shared or company-shared memories.
- Add rollback/delete execution for migrated records and derived indexes.
- Add tests proving bulk import is not the default path and non-authoritative
  recall cannot override canonical source checks.
