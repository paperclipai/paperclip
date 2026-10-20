# Steering and queued messages — agent access

Product map: [Steering and queued messages](../feature-map/steering.md).

Feature ID: `steering`.

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `queue`

Capability ID: `steering/queue`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}/queued-comments`.

Agent access: `partial` — REST / native call_api for visible queue; server-owned queue
admission.

Policy: Queue inspection follows task visibility; queued user-message mutation and run
cancellation require a board actor/user.

Compact task run reads retain `wakeupRequestId` and `queuedCommentSourceWakeIds`
to identify consumed input queues, including coalesced requests. These receipt
fields follow the existing task/run read checks and grant no queue mutation authority.

Accepted deferred requests remain pending while their recipient agent is paused.
Resume uses the normal admission checks. This grants no new pause, resume, queue
mutation, or execution authority to an agent.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16166) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Agents can read eligible queue state; sending/steering the person's queued
messages requires separate authority.

## `edit-order-discard`

Capability ID: `steering/edit-order-discard`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/issues/{id}/queued-comments/{commentId}`.
- `PUT /api/issues/{id}/queued-comments/order`.
- `DELETE /api/issues/{id}/queued-comments/{commentId}`.

Agent access: `restricted` — Board-user queue mutation API.

Policy: Queue inspection follows task visibility; queued user-message mutation and run
cancellation require a board actor/user.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16166) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: No agent user-message edit/reorder/discard path; explicit delegated-user policy
needed before granting one.

## `steer`

Capability ID: `steering/steer`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/queued-comments/{commentId}/steer`.

Agent access: `restricted` — Board-user execution control API; agent receives eligible
new run/wake.

Policy: Queue inspection follows task visibility; queued user-message mutation and run
cancellation require a board actor/user.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16166) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Steering requires a board user at the HTTP route. Native `call_api`
preserves this denial and cannot impersonate the steering user.

## `interrupt`

Capability ID: `steering/interrupt`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/queued-comments/interrupt`.
- `POST /api/heartbeat-runs/{runId}/cancel`.

Agent access: `restricted` — Board-user interruption/cancel API.

Policy: Queue inspection follows task visibility; queued user-message mutation and run
cancellation require a board actor/user.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16166) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Explicit operator action is distinct from an agent yielding/blocking its own turn.

## `stop-and-pause`

Capability ID: `steering/stop-and-pause`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/tree-holds`.
- `POST /api/agents/{id}/pause`.

Agent access: `restricted` — Board control APIs; agent paperclip_finish/paperclip_block
for its own turn.

Policy: Queue inspection follows task visibility; queued user-message mutation and run
cancellation require a board actor/user.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16166) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Task-tree/agent pause and confirmed stop need policy-preserving authority; no
generic agent management path.

## `drafts`

Capability ID: `steering/drafts`.

Review: `baseline`.

API: `not-applicable` — No shared server draft resource for this presentation state;
cross-client drafts would be a deliberate new capability.

Agent access: `not-applicable` — Browser-local task composer draft / submission state.

Policy: Queue inspection follows task visibility; queued user-message mutation and run
cancellation require a board actor/user.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16166) at
the reviewed commit above.

Verification: `not-run` — use the product recipe for the local/developer surface. Verify
listed shared-resource reads separately; local presentation alone is not agent API
evidence.

Gaps: No shared server draft resource for this presentation state; cross-client drafts
would be a deliberate new capability.

## `approval-queue`

Capability ID: `steering/approval-queue`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}/interactions`.
- `GET /api/issues/{id}/queued-comments`.

Agent access: `partial` — Agent can inspect authorized persisted interactions; server
continuation/queue delivery.

Policy: Queue inspection follows task visibility; queued user-message mutation and run
cancellation require a board actor/user.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16166) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Resolving as a human and controlling queued wakes is separate from seeing the
approval response.
