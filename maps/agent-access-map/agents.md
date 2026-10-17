# Hiring, agent configuration, and organization — agent access

Product map: [Hiring, agent configuration, and organization](../feature-map/agents.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

Scoped runner-default source review: 2026-10-12 at
`eee0534154eaf5d0d3f2bbc97c1e24d86f34a5a5`, limited to creation/configuration,
approval activation, built-in provisioning and import preservation described
below. The original baseline commit above still governs unrelated entries; this
update does not claim operation-complete review or live agent verification.

## `hire`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/agent-hires`.
- `POST /api/companies/{companyId}/agents`.

Agent access: `partial` — Native hire_agent; REST / CLI agent; runtime inheritance for
native hires.

Policy: Agent creation/configuration uses action grants, resource policies and change
consent; some controls require a board actor.

The creation boundary resolves the request-level runner before adapter validation
and credential normalization. Omitted/automatic new Codex selection uses the
qualified target's default; explicit Legacy is retained. Disabled adapters and
external overrides affect new selection, while missing credentials/runtime or
incompatible settings remain errors. Existing agents and reviewed pending hires
retain their recorded execution. Native `hire_agent` explicitly inherits its
caller's runtime and remains subject to permission and credential restrictions;
it is not an arbitrary host-configuration or login tool. REST/CLI creation and
hire runner options use the [shared request contract](../../packages/shared/src/validators/agent.ts).

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L1395) at
the reviewed commit above.

Scoped Evidence: `source-only` — [creation policy](../../server/src/services/agent-hiring.ts),
[runner resolution](../../server/src/services/agent-runner-selection.ts),
[native hire binding](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts),
[frozen approval activation](../../server/src/modules/agent-lifecycle/adapters/approvals.ts)
and [same-harness import preservation](../../server/src/services/company-portability.ts)
at the scoped commit. No permitted-agent journey was executed for this map update.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

For this scope, compare automatic and explicit Legacy creation, assert foreign
company/environment and missing-grant denials, then compare pending approval
configuration across restart and activation. An unrelated edit/import update must
not change existing execution; a new package without a runner choice receives
creation defaults. Do not count a board call or component test as agent evidence.

Gaps: Identity/persona hiring works. Operator account login and sensitive
adapter/environment configuration are separate guarded actions.

The runner request does not grant new account, environment-probe or native API
fallback authority; see [validation access](./runs-adapters.md#validation) and
[environment administration](./execution-environments.md#probe). Full access
qualification remains not run.

## `instructions`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/agents/{id}/instructions-bundle/file`.
- `PUT /api/agents/{id}/instructions-bundle/file`.

Agent access: `available` — Native read/update/history/restore instruction tools; REST /
CLI.

Policy: Agent creation/configuration uses action grants, resource policies and change
consent; some controls require a board actor.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L1395) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Canonical entry file, revision guard, company boundary, and protected-change
policy apply.

## `organization`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/org`.
- `PATCH /api/agents/{id}`.

Agent access: `available` — list_agents/get_agent; native call_api for permitted
configuration fields; REST / CLI.

Policy: Agent creation/configuration uses action grants, resource policies and change
consent; some controls require a board actor.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L1395) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Reporting-line changes need configuration authorization; a title alone gives no
authority.

## `lifecycle`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/agents/{id}/pause`.
- `POST /api/agents/{id}/resume`.
- `POST /api/agents/{id}/terminate`.
- `POST /api/agents/{id}/lifecycle/retry`.
- `GET /api/agents/{id}` returns the safe failed phase/step and action in `lifecycleError`.

Agent access: `partial` — REST / native `call_api` resume under agent_config:update
change-grant authorization; pause and termination remain board-only.

Policy: Agent creation/configuration uses action grants, resource policies and change
consent; some controls require a board actor.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L1395) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Resume has a generic native REST path. Pause and termination remain
enforced actor restrictions.

## `built-in`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/built-in-agents/{key}/provision`.

Agent access: `partial` — REST / native fallback for eligible provisioning; built-in
routine controls require board.

Policy: Agent creation/configuration uses action grants, resource policies and change
consent; some controls require a board actor.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L1395) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Provisioning checks agents:create. Enabling/running its built-in routine is not
the same permission path.

Scoped source review: [built-in provisioning](../../server/src/services/built-in-agents.ts)
recognizes the underlying Codex harness of a native company agent. New configured
provisioning resolves the runner, while unrelated reconciliation and same-harness
edits retain existing execution. Verify explicit runner changes preserve compatible
saved settings; the general creation/access policy above still applies. This is
source-only evidence at the scoped commit, not a live provisioning result.

## `primary-agent`

Review: `baseline`.

API: `present` — GET and PUT /api/companies/{companyId}/primary-agent/me.

Agent access: `restricted` — this is the authenticated human's personal
preference. Agent keys and native call_api use agent identity and are denied by
the board gate; no dedicated agent selection tool is present.

Policy: Requires board user identity, company access and active membership,
except implicit-local board or instance administrator. Viewers may choose their
own primary. Selection requires a same-company readable, available agent and
is scoped to actor user ID; the request cannot select another user's preference.
Explicit null selection is rejected; leave/termination can clear an unavailable
choice. Initialization stays recorded so clearing does not silently replace it.

Evidence: `source-only` — reviewed on 2026-10-13 at
`60bc0d5fee9a6e48db08fc016521fee3d9f57d67`:
[routes](../../server/src/routes/primary-agent.ts),
[service](../../server/src/services/primary-agent.ts),
[provider](../../ui/src/context/PrimaryAgentProvider.tsx), and
[route tests](../../server/src/__tests__/primary-agent.test.ts).

Verification: `not-run` — select and read the preference as two company users;
assert isolation, wrong-company/unreadable targets, pending/terminated agent
rejection and agent-key denial. Verify replacement confirmation and fallback
precedence in the UI; inspect the cleared state after permitted leave/termination.

Gaps: No agent mutation path for another person's preference. Live human/agent
access is unverified; UI fixture callbacks do not establish persistence or task
and Chat default resolution.

## `grok-bot`

Review: `baseline`.

API: `present` — `POST /api/companies/{companyId}/grok-invitations`, operator-owned Grok invitations and agent-scoped `/grok-binding` setup, routine, verify, stop, recover and disconnect endpoints. Direct HTTPS `/mcp/runner` uses fixed named-agent OAuth. Grok tools expose durable assignment operations and task-bound upload/download grants.

Agent access: `available` — `paperclip_grok_*` through the dedicated agent grant. First-party Paperclip operations execute through the shared Rust Runner. The Bot retains its own apps; Paperclip workspace and third-party app tools are unavailable.

Policy: company/agent/client/resource/authorizer binding; current manage-agent permission for consent and subsequent calls; normal task ownership, controller lease, governance, pause, revocation and recorded budget checks. Execution and file transfers require current task-bound sessions. Secret credentials remain in encrypted secret storage and are redacted from HTTP logs.

Evidence: `source-only` — [routes](../../server/src/routes/grok-bot.ts), [shared authority](../../server/src/services/external-bot-authority.ts), [routine receipts](../../server/src/services/grok-bot/routine.ts) and [Runner broker](../../server/src/services/dot-runner-broker.ts). Temporary actual-client OAuth and an outbound routine wake are qualified separately; they do not prove this candidate’s acceptance.

Verification: `not-run` — deployed acceptance pending; focused protocol/authorization and actual Rust backend tests; run fresh/saved setup, assigned and proactive tasks, duplicate calls, stale sessions, restart, ambiguous delivery, stop and recovery through the real client on the serving managed candidate.

Gaps: deployed two-way work and unattended first-time onboarding remain unqualified; remote termination, provider transcript streaming and usage accounting are unavailable.

## `fixed-process-service`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/agents/{agentId}` (own agent only, no query).
- `POST /api/agents/{agentId}/wakeup` and `POST /api/agents/{agentId}/heartbeat/invoke` (own agent only, body limited to `idempotencyKey`).
- Watchdog runs: `GET /api/companies/{companyId}/issues`, `GET /api/issues/{issueId}`, `GET /api/issues/{issueId}/comments`, `POST /api/companies/{companyId}/issues`, `POST /api/issues/{issueId}/comments`.

Agent access: `partial` — A `process` agent with `adapterConfig.fixedCommand: true` runs only
its saved `command`, `args`, `cwd` and environment.

Policy: The persistent key of a fixed-command agent can only read its own agent record and
trigger its own run without execution parameters; every other request is denied
(`assertFixedProcessKeyRequest`). A run with `watchdogService` configuration can only read its
bound secret and report configured signals (`assertWatchdogServiceRequest`). Signal reads and
comments require an open issue of the configured assignee with a verified watchdog origin, and
the signal list also applies the caller's private-issue access (`issueReadSqlCondition`).
Rejected watchdog requests are recorded as `watchdog.service_action_rejected`. The agent itself,
another agent or an agent-approved request cannot change this configuration.

Evidence: `source-only` — [fixed-process key](../../server/src/middleware/fixed-process-key.ts),
[watchdog requests](../../server/src/middleware/watchdog-service-request.ts) and
[configuration guard](../../server/src/middleware/fixed-process-configuration.ts) at `69eb3b6eff4ef00453b623f89abc8a34c8172a9f`.

Verification: `not-run` — run `fixed-process-secret-http.test.ts`, `fixed-process-execution.test.ts`,
`fixed-process-configuration.test.ts` and `watchdog-service-request.test.ts` on an isolated database.

Gaps: No live agent execution is claimed. Ordinary `process` agents keep their existing access.
