# Runs, harnesses, and model accounts — agent access

Product map: [Runs, harnesses, and model accounts](../feature-map/runs-adapters.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

Scoped native cancellation source review: 2026-10-12 at
`ce23716503a2c9158b5a7ab74ab61571ff4ee7a3`, limited to owned startup and
shutdown/readiness ordering. The original baseline and review depth remain for
unrelated operations; no live provider or agent authorization is claimed.

## `availability`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/adapters`.
- `GET /api/companies/{companyId}/adapters/{type}/models`.

Agent access: `partial` — Agent company-model REST / native `call_api` discovery and
bound runtime context; adapter/account inventories remain board-only.

Policy: Run/cost visibility and agent configuration policy; adapter installation/account
login/session control require board/admin.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Raw instance adapter listing requires board, while company model discovery exists
for eligible agents.

## `validation`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/adapters/{type}/test-environment`.

Agent access: `partial` — Permitted agent-creation validation through REST / native
`call_api` / CLI; account login requires its operator.

Policy: Run/cost visibility and agent configuration policy; adapter installation/account
login/session control require board/admin.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Environment test path checks creation/configuration policy; missing provider auth
must use its owner setup flow.

## `runs`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/heartbeat-runs/{runId}`.
- `GET /api/heartbeat-runs/{runId}/log`.

Agent access: `available` — REST / native call_api / CLI run.

Policy: Run/cost visibility and agent configuration policy; adapter installation/account
login/session control require board/admin.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Provider trace reveals/downloads require instance-admin and cannot be counted as
ordinary run output access.

## `session`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/agents/{id}/runtime-state/reset-session`.
- `GET /api/agents/{id}/task-sessions`.

Agent access: `restricted` — Board session controls; native server-owned session
continuation.

Policy: Run/cost visibility and agent configuration policy; adapter installation/account
login/session control require board/admin.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Task-session listing and execution-context reset require board agent
management at their HTTP routes. Native `call_api` preserves these denials; native
continuation remains server-owned.

Scoped Evidence: `source-only` — the
[native transport](../../packages/paperclip-runner/src/live/runnerd-codex-transport.ts)
joins owned startup before certifying cleanup. Rejected duplicates cannot replace
that owner or mutate recovery state. Unconfirmed preparation or registration
retains recovery state; late registration may release only its own route and
cannot launch after close. Shutdown interrupts readiness without granting
authority over an unauthenticated adopted process.

Scoped Verification: `not-run` — verify allowed/denied access using the actual
actor independently from the credential-free ownership controls. This correction
adds no account-setup, cleanup-override or session-reset authority. The real native
readiness/recovery fixtures and installed provider acceptance remain separate gates.
