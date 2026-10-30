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
An unfinished record keeps compatibility status `paused` with a
`setup` hold and cannot receive API keys or authenticate with keys or JWTs.
Its standard grants apply at hire. Authorized completion retries recover the
same record and approval without changing the submitted configuration.
Normal agent-authored hiring keeps its existing approval policy.

An agent-owned plugin may prepare the draft and leave its lifecycle in
`verifying` while that setup hold remains. Only bounded Core-issued setup probes
can run there. The creator's company creation permission also covers configuring
and retrying their draft during preparation or stopping; other actors still require the
ordinary configuration permission. This is a board wizard path, not new agent
execution or probe authority. Lifecycle and component regressions cover these
transitions; no permitted-agent or live-provider journey is claimed here.
Companies requiring hire approval keep drafts paused and allocate no agent-owned
resource before approval. Selecting an account there is pending verification,
not approval or execution authority.
The board confirmation follows preparation and verification through the existing
foreground detail query before presenting readiness or enabling first-task
assignment. The handoff updates only an older cached roster record; it cannot
resume an explicit pause, clear an import hold or bypass approval.

The ordinary picker also exposes pending Google Antigravity configuration when
the native Runner adapter is available. This is a board configuration preview: selecting it
does not write native execution settings or remove the inactive draft's setup
hold. Non-secret draft metadata retains only the selected adapter/provider and
runner intent for display and resume; it cannot admit execution. Existing Google connection authorization governs credential setup and
account metadata; Test, hire completion and execution still require the normal
provider release gates. An isolated operator can authorize one company, exact
model and pinned local native candidate until a fixed expiry. Only company-local
adapter discovery projects its agent/model as a Candidate; it never returns the
launch descriptor or stores that authority on the agent. Server validation and
native launch independently enforce the trusted descriptor. The selected managed
home feeds a zero-turn native admission Test; uncertain cleanup returns a bounded
diagnostic and retains the credential home until physical retirement and refresh
handoff, then performs normal writeback. This exception leaves global release
qualification pending. UI discoverability grants no additional agent or probe
authority. Source: [picker](../../ui/src/components/new-agent/AgentBasicsDialog.tsx)
and [setup](../../ui/src/components/new-agent/NewAgentSetup.tsx). This scoped note
is source-only and does not claim a permitted-agent journey or live Antigravity
task acceptance.

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

The board-driven [Antigravity setup/task eval](../../tests/runner-e2e/ANTIGRAVITY-AGENT-JOURNEY.md)
creates its measured agent through the ordinary wizard and reuses only the
signed-in owner's existing personal default Google grant. Its observer may read
the owned records; it cannot seed the hire or manufacture readiness. This case
does not qualify agent-authored hiring, credential administration or a broader
agent permission boundary.

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

The operator's Advanced YAML editor uses the existing configuration GET/PATCH
operations plus the owning instructions, skills, tools, channels, permissions,
secrets, API key, and revision APIs. It does not add aggregate write authority;
each request retains its own company and actor checks. Resource reads fail closed.
The compact YAML editor omits inherited access/history, company catalogs, and
instruction contents. Profile-key references resolve only within the company.
Omitted settings are preserved; named file patches use explicit null for deletion.
The normal domain APIs still enforce every write. Multi-resource writes are
sequential, with preflight comparison and explicit partial-failure recovery;
Core configuration, managed files, and entry revisions enforce their existing
atomic revision/hash preconditions. External supporting files and other
unversioned resource writes retain a race window after preflight. Configuration reads include the complete redacted, revisioned fields
and `configurationRevision`; writes accept an optional
`expectedConfigurationRevision`, checked again under the write lock. A stale
write returns `409`. Revision-guarded writes preserve unchanged redacted values
at their original paths. Configuration read/configure authority, company scope,
instruction-path restrictions, environment/account checks, revision history, and
activity attribution still apply. YAML does not expose a permission-grant or
lifecycle mutation shortcut. See [the format](../../doc/agent-configuration-yaml.md).

Capability ID: `agents/instructions`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/agents/{id}/instructions-bundle/file`.
- `GET /api/agents/{id}/project-access` and `POST /api/agents/{id}/project-access`
  are board-only. The POST requires `agents:create`, checks selected projects in
  the same company, and adds IDs under an agent row lock. It preserves existing
  containment, audits new grants and rejects pending-approval agents. Agent keys
  cannot use this route to grant themselves access; a read-only board viewer
  receives `canManage: false`. Saving never creates a run or wakeup.
- `PUT /api/agents/{id}/instructions-bundle/file`.
- `PATCH /api/agents/{id}` with an explicit `runner: "paperclip"` upgrade.
- `POST /api/agents/{id}/qualify-runner` to qualify the saved effective sandbox before upgrading or testing an existing native runner.
- `PATCH /api/agents/{id}` with `runtimeSettings: { harness, model?, aiConnection?, expected: { model, aiConnection } }` for a narrow roster edit. Each request handles one agent; the UI batches at most four writes and collects per-agent outcomes.

Agent access: `available` — Native read/update/history/restore instruction tools; REST /
CLI.

Policy: Agent creation/configuration uses action grants, resource policies and change
consent; some controls require a board actor.

The roster intent preserves unrelated settings, rejects stale model/connection
previews and harness changes, and checks the full execution configuration under
the lifecycle write lock. It uses the same configuration, company, credential,
environment, and consent checks as other edits. It adds no agent permission or
credential fallback. Pool and externally managed agents use their existing
configuration surfaces. Board browser verification does not qualify agent access.

The existing-agent upgrade notice for Claude, Codex, and Grok Build uses this configuration PATCH. It does not
grant configuration, account, or environment access. The server resolves the
saved settings under normal company/configuration authorization. Grok migration preserves
the effective legacy search setting. Task model/effort overrides retain the
agent's account binding and tool policy without granting extra account access. Obsolete Claude
tuning fields are removed with `configurationWarnings`; security incompatibilities
remain errors. Unqualified sandbox upgrades first use the agent-scoped
`POST /api/agents/{id}/qualify-runner` under the same `agent_config:update`
authorization as saving the upgrade. The server resolves the saved computer;
`expectedEnvironmentId` rejects stale state and cannot select another computer.
Qualification checks company binding, returns only its receipt, and audits within
the agent's company. General instance environment probes still require instance
admin. An existing native agent's clean configuration Test uses the same
saved-computer qualification before its runtime test. A current proof is reused;
a missing or stale proof requires a real successful probe and verified cleanup.
Draft settings and target changes do not qualify another computer. No probe runs
merely on page load. Operator browser evidence does not
qualify the agent permission paths for this operation.

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
