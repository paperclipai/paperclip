# Hiring, agent configuration, and organization — agent access

Product map: [Hiring, agent configuration, and organization](../feature-map/agents.md).

Feature ID: `agents`.

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

Capability ID: `agents/hire`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/agent-hires`.
- `POST /api/companies/{companyId}/agents`.

Agent access: `partial` — Native hire_agent; REST / CLI agent; runtime inheritance for
native hires.

Creation requests can use `runner: auto | paperclip | legacy`; the server resolves
and persists execution configuration. Claude Auto selects the native ACPX profile
on qualified macOS and GNU/Linux x64/ARM64 targets; unknown environment
qualification remains Legacy. Darwin SSH defaults to Legacy while preserving
explicit native assets and saved execution. Saved runner/model/provider overrides survive edits
and approval activation. This selection does not grant connection access or
bypass hiring authorization. Source: [runner resolver](../../server/src/services/agent-runner-selection.ts).

Policy: Agent creation/configuration uses action grants, resource policies and change
consent; some controls require a board actor.

The early wizard record (`setupId` on create) and completion of that record
(`setupAgentId` on hire) require a board actor and company-scoped creation
permission. Its creator can finish their own inactive setup with that permission;
changing another person's setup requires configuration permission.
Creation retries reuse only records owned by the caller. Returning a completed
record also requires the normal agent-read and configuration-read checks.
An unfinished record stays paused with a
`setup` hold and cannot receive API keys or authenticate with keys or JWTs.
Its standard grants apply at hire. Authorized completion retries recover the
same record and approval without changing the submitted configuration.
Normal agent-authored hiring keeps its existing approval policy.

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

Capability ID: `agents/instructions`.

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

Capability ID: `agents/organization`.

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

Capability ID: `agents/lifecycle`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/agents/{id}/pause`.
- `POST /api/agents/{id}/resume`.
- `POST /api/agents/{id}/terminate`.
- `DELETE /api/agents/{id}` permanently purges an eligible terminated/rejected agent.
- `POST /api/agents/{id}/lifecycle/retry`.
- `GET /api/agents/{id}` returns the safe failed phase/step and action in `lifecycleError`.

Agent access: `partial` — REST / native `call_api` resume under agent_config:update
change-grant authorization; pause and termination remain board-only.

Policy: Agent creation/configuration uses action grants, resource policies and change
consent; some controls require a board actor.
Permanent deletion is board-only. Retained case handoff references return
`409 agent_case_history_retained` before dependency cleanup; keep the agent terminated.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L1395) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Resume has a generic native REST path. Pause and termination remain
enforced actor restrictions.

## `built-in`

Capability ID: `agents/built-in`.

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

Capability ID: `agents/primary-agent`.

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

Capability ID: `agents/grok-bot`.

Review: `baseline`.

API: `present` — `POST /api/companies/{companyId}/grok-invitations`, operator-owned Grok invitations and agent-scoped `/grok-binding` setup, routine, verify, stop, recover and disconnect endpoints. Direct HTTPS `/mcp/runner` uses fixed named-agent OAuth. Grok tools expose durable assignment operations and task-bound upload/download grants.

Agent access: `available` — `paperclip_grok_*` through the dedicated agent grant. First-party Paperclip operations execute through the shared Rust Runner. The Bot retains its own apps; Paperclip workspace and third-party app tools are unavailable.

Policy: company/agent/client/resource/authorizer binding; current manage-agent permission for consent and subsequent calls; normal task ownership, controller lease, governance, pause, revocation and recorded budget checks. Execution and file transfers require current task-bound sessions. Secret credentials remain in encrypted secret storage and are redacted from HTTP logs.

Evidence: `source-only` — [routes](../../server/src/routes/grok-bot.ts), [shared authority](../../server/src/services/external-bot-authority.ts), [routine receipts](../../server/src/services/grok-bot/routine.ts) and [Runner broker](../../server/src/services/dot-runner-broker.ts). Temporary actual-client OAuth and an outbound routine wake are qualified separately; they do not prove this candidate’s acceptance.

Verification: `not-run` — deployed acceptance pending; focused protocol/authorization and actual Rust backend tests; run fresh/saved setup, assigned and proactive tasks, duplicate calls, stale sessions, restart, ambiguous delivery, stop and recovery through the real client on the serving managed candidate.

Gaps: deployed two-way work and unattended first-time onboarding remain unqualified; remote termination, provider transcript streaming and usage accounting are unavailable.

## `api-keys`

Capability ID: `agents/api-keys`.

Review: `baseline`.

API: `present` — GET /api/agents/{id}/keys; POST /api/agents/{id}/keys; DELETE /api/agents/{id}/keys/{keyId}.

Agent access: `restricted` — key listing and mutations require board identity and agent-management authority. The CLI token agent commands use authorized board context. Ordinary agent REST/native `call_api` and public assistant capabilities do not grant key-management authority.

Policy: getAccessibleAgent checks company access and agents:create through the shared access evaluator for reads as well as mutations. Creation rejects pending_approval and terminated agents. Keys retain the creating person’s responsibleUserId; only a hash is stored and token plaintext is returned on creation. Revocation checks that the key belongs to the selected agent. Authentication separately applies agent state, revocation, scope, and responsible-user membership intersections.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Keys tab](../../ui/src/pages/AgentDetail.tsx), [key routes](../../server/src/routes/agents.ts), [key service](../../server/src/services/agents.ts), [authentication](../../server/src/middleware/auth.ts), and [CLI token commands](../../cli/src/commands/client/token.ts).

Verification: `not-run` — Create a disposable key as a permitted authenticated board person, prove one harmless agent read, revoke, and retry the same bearer. Assert metadata persistence, once-only token display, activity, missing management permission, agent identity denial, cross-company/cross-agent IDs, ineligible targets, and missing responsible-user binding.

Gaps: Local implicit key creation does not by itself prove a usable responsible-user binding. No ordinary-agent self-management or assistant delegation path is established; browser creation and actual bearer use need live evidence.

## `managed-agent-setup`

Capability ID: `agents/managed-agent-setup`.

Review: `baseline`.

API: `present` — GET and POST /api/companies/{companyId}/managed-agent-profiles. Provisioning separately calls Anthropic /v1/environments, /v1/agents, and /v1/agents/{id}/versions with operator provider credentials; --probe does not resolve a Paperclip client context or call the profile API.

Agent access: `operator-only` — provider qualification/provisioning uses the explicit operator CLI. Persisted profile reads/writes require board/company identity; viewer writes are denied. This does not authorize a company agent to provision external provider resources.

Policy: A profile uses an active same-company, company-scoped secret reference. Qualification requires the source-supported pinned model/version, no tools/MCP/skills/multiagent capability, and a locked no-network/no-packages environment with retention acknowledgement. Qualified configuration revisions are immutable; changed qualified configuration requires a new profile key. Provider API credentials and Paperclip profile authority are separate checks.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Managed-agent CLI](../../cli/src/commands/managed-agent.ts), [profile routes](../../server/src/routes/managed-agent-profiles.ts), [profile service](../../server/src/services/managed-agent-profiles.ts), and [runtime validation](./runs-adapters.md).

Verification: `not-run` — Compare provider and Paperclip state before/after probe, then inspect a permitted create/adopt and repeated resource reuse. Reject missing acknowledgement, unsafe resources, invalid model/version/secret/company, and viewer/agent mutations. Separately run a bounded useful task with the saved qualified profile before claiming runtime readiness.

Gaps: This is a provider-specific setup path, not qualification of every managed service or deployed environment. Mocked setup and source validation do not prove live retention, remote execution, or provider availability.
