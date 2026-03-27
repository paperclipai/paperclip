# Issue Route Hardening And Wakeup Repair

This change set closes three Paperclip failure paths that were causing avoidable friction for the overnight Poly Capital org:

- malformed UUID filters/cursors in issue APIs could reach deeper service queries and surface as 500s instead of clean 400s
- incremental comment polling could break when the anchor timestamp was bound through postgres-js as a raw `Date`
- queued issue wakeups could be persisted without an attached heartbeat run, leaving assignment/comment work stranded until later recovery

## Behavior changes

- `GET /api/companies/:companyId/issues` now rejects malformed UUID query filters such as `assigneeAgentId`, `participantAgentId`, `projectId`, `parentId`, and `labelId` with `400`.
- Issue comment routes now reject malformed `afterCommentId` and `commentId` values with `400`.
- Heartbeat-context, approval unlink, label delete, work product mutation, and attachment content/delete routes now reject malformed UUID path/query params with `400`.
- Incremental comment fetch now compares against the anchor timestamp using an ISO string cursor, which keeps polling stable.
- Heartbeat resume now repairs queued issue wakeups that were saved without a corresponding heartbeat run.
- New wakeup creation now persists the wakeup request and queued heartbeat run in one transaction so Paperclip does not recreate that orphaned state in normal execution.

## Trading-program impact

- Agents and operators should see fewer avoidable 500s while filtering issues or polling comments.
- Assignment and comment wakes should be less likely to disappear into queued-but-unrunnable state after restarts or partial failures.
- Overnight remediation work should resume more predictably because Paperclip now repairs the missing-run wakeup state during queued-run recovery.

## QA checks

Run these against a dev instance:

1. Request `GET /api/companies/:companyId/issues?assigneeAgentId=not-a-uuid` and confirm `400` with no server error.
2. Request `GET /api/issues/:id/comments?afterCommentId=not-a-uuid` and confirm `400`.
3. Create two comments on an issue, then request `GET /api/issues/:id/comments?afterCommentId=<first-comment-id>&order=asc` and confirm only the later comment returns.
4. Assign an issue to an agent or add a wake-triggering comment, restart the server mid-flight if needed, and confirm the wakeup still results in a queued/running heartbeat after recovery.

## Verification

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
