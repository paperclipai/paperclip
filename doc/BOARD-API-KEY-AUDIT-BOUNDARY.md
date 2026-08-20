# Board API Key Audit Boundary

Board API key allow decisions authorize a request only when the matching
security disposition is durable. PostgreSQL mutations and non-database effects
have different atomicity constraints, so this document states the boundary
explicitly.

## PostgreSQL guarantee

`server/src/security/board-key-audit-coupling.ts` stages an allow disposition in
the request context.

- A mutation inside `db.transaction` writes the allow disposition on that
  transaction before the first domain mutation. Both commit or both roll back.
- Direct `db.insert`, `db.update`, `db.delete`, and mutating `db.execute` calls
  are replayed lazily inside a transaction with the staged disposition. An
  audit insert failure therefore rolls back the direct domain mutation.
- Direct mutation-builder operations that cannot be replayed safely fail before
  issuing SQL and must be moved into an explicit `db.transaction`.
- There is no successful untransacted fallback. Response settlement persists
  only successful no-mutation dispositions; it cannot convert an uncoupled
  mutation into success.

This boundary deliberately classifies unknown raw SQL as mutating. Read-only
raw SQL is limited to statements beginning with `SELECT`, `SHOW`, `EXPLAIN`,
`TABLE`, or `VALUES`.

## Non-database side-effect review

The runtime route inventory denies undeclared board-key routes. Explicit denials
also cover the MCP surface, tool calls and sessions, plugin action/bridge/data
and webhook surfaces, skill-test execution, agent instruction-file mutation,
and auth/claim/invite surfaces. Board keys can still reach authorized management
routes whose handlers may combine PostgreSQL state with effects that PostgreSQL
cannot roll back.

| Reachable route family | Effect outside PostgreSQL | Residual failure mode |
| --- | --- | --- |
| Artifacts, attachments, company import/export, skills | Object storage or local filesystem writes/removals | An audit or domain rollback can leave an orphaned object/materialized tree; compensation can also fail. |
| Agents, heartbeat/runtime, workspaces, environments | Process start/cancel, git/worktree changes, or provider calls | A crash can occur between durable intent and execution/acknowledgement, causing a missed action or a retry. |
| Plugin and tool management | Plugin lifecycle, OAuth/provider, or network activity | Remote state cannot join the database transaction and may be applied despite a later local failure. |
| Activity publication, plugin events, assignee wakeups | In-process publication or adapter dispatch | A post-commit crash can miss delivery; retry after an ambiguous acknowledgement can duplicate delivery. |

The database audit coupling does not claim atomic rollback for these effects.
Side-effecting handlers must use the following pattern when the effect matters
to correctness or security:

1. Persist the domain change, board-key allow disposition, and an intent/outbox
   row in one transaction.
2. Execute the external effect only from the committed intent.
3. Give the effect a stable idempotency key derived from the intent, not from a
   delivery attempt.
4. Persist completion or failure so a worker can retry ambiguous outcomes.
5. Use compensating cleanup for object/file/provider state and treat cleanup as
   retryable, not guaranteed rollback.

Existing durable wake requests and idempotency keys reduce duplicate/lost-work
risk where they are used. Live UI/plugin publications remain best effort. A
successful no-mutation request is audited during response settlement; if that
audit write fails there is no PostgreSQL domain commit to roll back. A handler
that performs only an external effect must therefore not rely on no-mutation
settlement: it needs a durable intent/outbox boundary before the effect.

When a route becomes board-key reachable, security review must identify every
filesystem, object-store, process, adapter, plugin, and outbound-network effect
and either prove an existing outbox/idempotency boundary or record the residual
risk and remediation owner.
