# Linear Completion Evidence Bridge

Status: Paperclip enforcement/domain contract
Contract version: `1`

## Purpose

For software-factory issues whose canonical delivery record is Linear, Paperclip
must not become a second source of truth. A gated issue may enter `done` only
after a connector proves that:

1. the Paperclip issue has a stable Linear mapping;
2. the exact completion evidence was posted to that Linear issue;
3. an independent verifier reported a passing result; and
4. no Paperclip/Linear conflict remains unresolved.

Core Paperclip owns the fail-closed gate. The Linear connector owns credentials,
external IDs, cursors, delivery attempts, receipts, and conflict state. This
matches the plugin-state boundary in `doc/plugins/PLUGIN_SPEC.md`; external IDs
must not be copied onto core issue rows.

## Enabling the gate

Set the issue execution policy field:

```json
{
  "linearEvidence": {
    "required": true,
    "independentQaRequired": true
  }
}
```

An issue with this policy fails closed when no bridge reader is installed. The
gate also remains active if a caller attempts to remove the policy and set
`status: "done"` in the same mutation. A board operator can deliberately remove
the policy in a separate audited mutation when Linear is no longer canonical.
Agent principals cannot remove the gate or weaken its independent-QA setting.

## Stable identity

The connector must use the helpers exported by
`server/src/services/linear-evidence-bridge.ts` or reproduce their byte-exact
outputs:

```text
mappingKey = paperclip-linear:v1:<companyId>:<paperclipIssueId>
evidenceSha256 = sha256(stable-json(evidencePayload))
idempotencyKey = paperclip-evidence:v1:<mappingKey>:<evidenceSha256>
```

The evidence timestamp is part of the payload and therefore part of the
idempotency key. A retry must reuse the originally persisted payload and
timestamp; generating a new timestamp creates a new evidence event.
The payload also records the Paperclip issue's `updatedAt` value. Any later
issue mutation makes the receipt stale and requires a new evidence event.

## Connector snapshot contract

Paperclip injects a `LinearEvidenceBridgeReader` into `issueService` (and, for
HTTP issue mutations, `issueRoutes`). Its only operation is read-only:

```ts
interface LinearEvidenceBridgeReader {
  getCompletionSnapshot(input: {
    companyId: string;
    paperclipIssueId: string;
    paperclipIssueUpdatedAt: string | null;
    mappingKey: string;
  }): Promise<LinearEvidenceCompletionSnapshot | null>;
}
```

The returned snapshot contains:

- `mappingKey` and `linearIssueId`;
- the canonical evidence payload;
- `evidenceSha256` and `idempotencyKey`;
- a delivery receipt with state, remote Linear comment ID, publication time,
  idempotency key, and exact comment-body SHA-256; and
- all detected conflicts with explicit `unresolved` or `resolved` disposition.

The evidence payload contains:

- what changed;
- the Paperclip issue `updatedAt` value that the evidence covers;
- the stable implementer principal ID;
- a pull-request URL or artifact SHA-256 (both are allowed);
- verifier identity, independence flag, pass/fail result, test summary, and
  test timestamp; and
- evidence timestamp.

Use `buildLinearEvidenceComment(payload)` for the exact Linear comment body. It
includes a hidden marker:

```text
<!-- paperclip-evidence:<idempotencyKey> -->
```

Paperclip hashes that exact body and accepts only a matching delivery receipt.

## Idempotent publish algorithm

The external connector must persist state in its own transactional store (for a
Paperclip plugin, issue-scoped `plugin_state` is appropriate) and implement this
algorithm:

1. Resolve the configured Linear issue for `mappingKey`. If the existing
   mapping points elsewhere, persist an explicit conflict and stop.
2. Canonicalize and persist the evidence payload once, including `recordedAt`.
3. Compute the evidence digest, idempotency key, comment body, and body digest.
4. In one transaction, claim the idempotency key unless a published receipt
   already exists.
5. Before posting, query connector state and Linear for the hidden idempotency
   marker. If found, reconcile its remote comment ID instead of posting again.
6. Post the exact comment body to the mapped Linear issue.
7. Persist the remote comment ID, body digest, and `publishedAt` before marking
   the delivery `published`.
8. If the network result is ambiguous, leave the delivery pending. On retry,
   reconcile by marker before attempting another post.

This makes retries safe even when the connector loses the response after Linear
accepted a comment. The connector must never synthesize a successful receipt
without reading a concrete remote comment ID.

## Completion evaluation

`issueService.update(..., {status: "done"})` validates the snapshot before any
issue mutation. It rejects the transition with HTTP `422` and
`code: linear_evidence_gate_failed` when any of these hold:

- the reader or snapshot is absent;
- the mapping or issue IDs differ;
- the canonical payload digest or idempotency key differs;
- neither a valid PR URL nor artifact SHA-256 is present;
- the comment is pending, missing, or its body digest differs;
- QA failed, was not marked independent, or names the implementer as verifier
  when independence is required; or
- any conflict remains unresolved.

Error details expose conflict keys, not arbitrary external values. The connector
must preserve both sides of every conflict in its protected state and require an
explicit resolution; last-write-wins behavior is forbidden.

## Connector composition and remaining deployment dependency

`linearEvidenceConnector(db, transport)` implements the persisted mapping,
idempotency lease, marker reconciliation, read-after-write verification,
receipt, and conflict-preservation behavior. Its transport is injected and is
the only credential-bearing boundary; Paperclip core contains no Linear token,
network client, or secret logging. `dryRun: true` persists a pending delivery
without invoking the transport.

The private workspace deployment companion at
`packages/linear-evidence-transport` implements `LinearEvidenceTransport`
against Linear's GraphQL comment API. It accepts only a SecretRef and injected
resolver, uses a fixed Linear API origin, resolves the credential per request,
performs bounded complete marker scans, rejects duplicate markers, reads a
concrete comment after creation, and never retains remote or resolver messages
in public errors.

Deployment still requires an explicit approved composition step:

- provision a least-privilege Linear credential with only the issue/comment
  read and comment-create access needed for the intended workspace;
- provide a deployment-owned SecretRef resolver without exposing the resolved
  value to Paperclip core;
- instantiate the companion transport and `linearEvidenceConnector`; and
- inject the connector as `createApp(..., { linearEvidenceBridge })`.

No credential, live config, or real Linear call is included in this repository
change. Until the deployment owner approves and installs that composition and
independent live acceptance passes, gated issues cannot be completed. That is
the intended fail-closed behavior, not a degraded success path.
