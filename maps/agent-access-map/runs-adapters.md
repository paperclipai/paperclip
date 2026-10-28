# Runs, harnesses, and model accounts — agent access

Product map: [runs-adapters](../feature-map/runs-adapters.md).

Feature ID: `runs-adapters`.

Delegated native entries inherit the [native admission and work-mode limits](README.md#native-rest-transport).

Review date: 2026-10-26. Source base: `a1f77821b9cd5c9c846fdf7a0fa5cc620ad2b6bb`; implementation: [#17737](https://github.com/paperclipai/paperclip/pull/17737).

Connection operations reviewed in this working tree. The inventory was reconciled
against production UI clients, REST registrations and service entry points; it is
a review checklist, not a runtime registry. [Authorization and evidence contract](../../doc/plans/2026-10-13-connection-api-parity.md).
Fixture evidence is separate from live provider qualification and from empirical
LLM success. Source-only entries have a reviewed agent path or an explicit boundary,
but do not claim an individually executed HTTP test.

Scoped runner-default source review: 2026-10-12 at
`eee0534154eaf5d0d3f2bbc97c1e24d86f34a5a5`, limited to runner discovery,
selected-runtime testing and saved execution/session preservation. The original
baseline source and review depth remain unchanged for unrelated operations.

Scoped native cancellation source review: 2026-10-12 at
`ce23716503a2c9158b5a7ab74ab61571ff4ee7a3`, limited to owned startup and
shutdown/readiness ordering. The original baseline and review depth remain for
unrelated operations; no live provider or agent authorization is claimed.

## `availability`

Capability ID: `runs-adapters/availability`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/adapters`.
- `GET /api/companies/{companyId}/adapters/{type}/models`.

Agent access: `partial` — Agent company-model REST / native `call_api` discovery and
bound runtime context; instance adapter inventory remains board-only; model-account management is enumerated below.

Policy: Company model discovery requires company access; account-backed discovery
also enforces its account/pool and target-agent rules. Instance adapter inventory
and installation retain board/admin gates. Delegated managed
AI-account login operations are enumerated under `model-accounts`; they do not
grant raw host administration or execution-session reset.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Runner discovery exposes `supportedRunners` and `defaultRunner`; it describes
qualified selection, not successful authentication or task execution. Native
Claude retains existing account grants and company/responsible-user boundaries.
Source: [adapter discovery](../../server/src/adapters/registry.ts).

Gaps: Raw instance adapter listing requires board, while company model discovery exists
for eligible agents.

Scoped source-only evidence: [adapter discovery](../../server/src/routes/adapters.ts)
reports supported runners/effective default for the selected company/environment;
[selection policy](../../server/src/services/agent-runner-selection.ts) reads
server-owned immutable sandbox facts without provisioning. Managed Cloud images
skip saved qualification after company access checks; custom environments and
active captured custom images retain the existing policy. New Codex defaults
and explicit overrides follow the [shared runner contract](../../packages/shared/src/agent-runner.ts);
Claude follows its qualified rollout described above. The board inventory does not grant a
native agent an equivalent discovery binding. See
[probe restrictions](./execution-environments.md#probe) for acquiring qualification.
OpenCode now follows the qualified native default without the experimental
flag on macOS and GNU/Linux x64; Linux ARM64 retains Legacy. An explicit
`provider/model` is required for test/hire; only server-owned
inactive setup drafts may omit it. Saved runners and permission/lifecycle
policies remain authoritative. Actor/company checks and board-only discovery
remain unchanged. This is scoped source/control evidence for OpenCode selection,
not live provider execution or agent authorization proof.
Pi follows the same supported platform/default and model-free inactive-draft
boundary, with explicit pinned-runtime setup required on the execution host.
Native ACPX Pi is admitted with the generic flag off. Existing direct Pi agents
remain Legacy; saved native policies remain authoritative. Incompatible thinking,
launch, permission, or lifecycle settings return remediation on conversion.
Managed Pi accounts accept OpenRouter routing and matching OpenAI, Anthropic,
Google, or OpenRouter API-key models. Subscription methods and custom gateways
remain excluded for Pi. Selection keeps the existing company, user, grant, and
agent-install checks; runtime preparation clears alternate credentials and rejects
custom Pi provider overrides. This adds no cross-company access or runtime installation API.
An absent forced-Kubernetes environment is an unqualified sandbox target, never
a local target. Discovery and automatic creation keep the Legacy path without
provisioning it; explicit Paperclip selection returns qualification guidance.
The existing execution path owns lazy environment creation. Saved runners remain
unchanged. This is source/control evidence, not live Kubernetes qualification.

## `validation`

Capability ID: `runs-adapters/validation`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/adapters/{type}/test-environment`.

Agent access: `partial` — Permitted agent-creation validation through REST / native
`call_api` / CLI; supported account-login initiation has the delegated path below.

Policy: Environment tests follow agent creation/configuration authority. Supported
managed-account login initiation follows `model-accounts` below; human codes and
consent, raw host login and adapter installation retain their specific gates.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Environment test path checks creation/configuration policy; missing provider auth
must use its owner setup flow.

Scoped source-only Claude CLI preparation: both the selected environment test
and normal CLI execution use
[versioned sandbox preparation](../../packages/adapters/claude-local/src/server/sandbox-cli-version.ts).
An outdated default sandbox command can use a private pinned compatible CLI;
local, SSH and custom commands are not replaced. The selected model, engine,
account and existing actor/company checks remain authoritative. Installer
failure cannot turn an incompatible CLI into a passing probe. Local subprocess
controls exercise version checks and installer outcomes; live agent and
subscription access are `not-run` for this change.

Scoped Legacy Codex shell delivery: resolved task configuration can explicitly
assign service-secret variables to shell tools through ACP or CLI execution.
The existing configuration and secret-access checks still authorize that binding;
the shell allowlist grants no extra company or vault access. Codex login keys,
observability credentials, private runtime transport credentials, and unassigned
host secrets retain their separate paths. Source/control evidence:
[shared shell policy](../../packages/adapter-utils/src/codex-shell-environment.ts)
and the adapter executor regressions. Live delivery remains a separate check
under `runs-adapters/validation`.

Scoped source review: [test authorization and resolution](../../server/src/routes/agents.ts)
requires same-company `agents:create`, saved-agent update access when supplied,
allowed environment selection, and normal secret/responsible-user checks. An
unchanged saved runner avoids new-creation policy but still receives selected
runtime validation. [Native readiness](../../server/src/services/native-runtime/setup-readiness.ts)
tests native Codex startup/model/account and bounded teardown; an authentication
or Legacy CLI check cannot replace that runtime evidence. Missing dependencies,
credentials, invalid models and incompatible settings fail without silently
changing runners. Account login remains board/owner-bound.

Scoped artifact-preparation source evidence: [native preparation](../../server/src/services/native-runtime/native-session-executor.ts)
can overlap runner and default image-harness work only when the selected command
runner declares concurrent sync support. Current executable hash, metadata,
transport, and final-path checks still precede dispatch. The caller waits for
both operations on failure. Explicit harness uploads and npm installs remain
serial. This changes no API or agent grant. The
[real-shell controls](../../server/src/services/native-runtime/native-artifact-preparation.test.ts)
do not qualify the whole validation capability or a live response-time target.

Scoped backend-preparation source evidence: remote native Codex can prepare its
managed GitHub transport during fresh assigned-MCP discovery. The session claim,
wake binding, review assignment and complete gateway launch binding checks still
precede that work. Provider startup waits for both results. Failures drain both
operations before the existing run cleanup releases any created GitHub access.
No grant, token, authority cache or provider dispatch bypass is added. The
[executor controls](../../server/src/services/native-runtime/native-session-executor.test.ts)
remain separate from live latency and permitted/denied agent acceptance.

Scoped OpenCode assigned-tool source evidence: local and remote native sessions
use the server-owned authenticated relay. The provider sees bounded
`paperclip_search_assigned_tools` and `paperclip_call_assigned_tool` schemas,
then uses pinned aliases. Search describes its 1–20 page limit and default of 5
in the tool and parameter descriptions. It intersects fresh grants and work modes; calls
retain the run's original gateway policy, validation, approvals, revocation and
audit path. Prompt arguments cannot select gateway authority. Assigned gateway
launch credentials stay on the controller. Former direct-catalog OpenCode
checkpoints refresh; other provider fingerprints stay unchanged. The
[projection controls](../../server/src/services/native-runtime/assigned-mcp-tools.test.ts)
and [wiring controls](../../server/src/services/native-runtime/native-session-executor.test.ts)
are source evidence, not live permitted/denied sandbox acceptance.

For a linked Codex subscription with server-resolved managed credential provenance,
setup checks the resolved owner and stages a private probe copy before local or
remote isolation. Without a selected API key, an unbound linked `CODEX_HOME` is
rejected with explicit Legacy
or managed-account guidance. Caller configuration cannot supply that provenance. Selected `CODEX_API_KEY` and
`OPENAI_API_KEY` authentication skips unrelated subscription reads and refresh
bindings, matching task materialization. The fake-credential controls verify key
precedence without changing the account source or exposing either credential.
The general native
home materializer retains its no-follow symlink guard. Refresh still targets the
checked account source, and confirmed bounded retirement removes its private
copy. Unconfirmed retirement retains the existing cleanup block and owned state.
Failures before probe handoff remove only the owned temporary preparation root;
local daemon resolution occurs before credential staging. Once a probe is handed
off, unconfirmed retirement still retains its recovery state.
[Existing fake-credential setup controls](../../server/src/services/native-runtime/setup-readiness.test.ts)
exercise linked/regular sources and failure cleanup. This adds no credential-read
API, agent login authority or cross-company account access. Its source-only
evidence does not qualify a live permitted/denied agent operation.

Verification for this scope remains `not-run`: use an admitted agent REST/CLI
validation path, assert missing grants and cross-company targets/accounts are
denied, then prove the useful task/follow-up separately. `hire_agent` inherits its
caller's runtime; do not assume its binding accepts arbitrary runner or account
settings. See [creation access](./agents.md#hire).

## `runs`

Capability ID: `runs-adapters/runs`.

Review: `baseline`.

Scoped source-only timing evidence: workspace preparation spans carry only the
existing hashed run ID. Controller startup phase spans carry no custom attributes.
Native controller setup and settlement phases use that same run hash, including
assigned MCP discovery; neither tool definitions nor credentials are recorded.
Both retain operator-controlled tracing; unconfigured clients stay silent.
The native first-text span ends after text is committed for the existing run-events
reader, including reasoning and completed responses. It exports only the bounded
text kind and timing, with no text content or new agent access.
This adds no agent API, credential access, run-log write, or recovery authority.
See [the tracing contract](../../doc/observability.md#controller-preparation-phases).
Live latency verification remains separate from the existing access baseline.

API: `present` — representative operation IDs:

- `GET /api/heartbeat-runs/{runId}`.
- `GET /api/heartbeat-runs/{runId}/log` (optional `alignStartToRecord=true` extends a tail backward to its first complete record; this can exceed `limitBytes` by that record's prefix and retains the same access/redaction checks).
- `GET /api/heartbeat-runs/{runId}/events` (optional `view=conversation` returns assistant messages and request lifecycles through the same access/redaction checks; `afterSeq` remains a sequence cursor).
- `GET /api/heartbeat-runs/{runId}/workspace-operations`.
- `GET /api/heartbeat-runs/{runId}/issues`.
- `GET /api/companies/{companyId}/heartbeat-runs`.
- `GET /api/companies/{companyId}/live-runs`.
- `GET /api/issues/{id}/runs`.
- `GET /api/issues/{id}/recovery-actions`.

Agent access: `available` — REST / native call_api / CLI run, plus the listed
read-only paths through the default queue and HTTP/2 sandbox callback bridge.
The sandbox uses its injected run credential. See
[run diagnostics](../../skills/paperclip/references/run-diagnostics.md) and the
[activity access contract](activity.md#runs).

Policy: Same company, company-scope read authority and run/task visibility still
apply. Task-bound history and recovery records require task read authority.
Each run-linked task is filtered by the caller's task-read predicate; a readable
company run cannot expose inaccessible private task titles. Existing content
and credential redaction apply. Adapter installation, raw host login, execution
session control, recovery writes and raw provider-trace administration retain
their board/admin or dedicated-tool gates. Delegated managed AI-account setup
is separately enumerated under `model-accounts`.

Evidence: `source-only` — diagnostic scope reviewed at
`f10210990a3c9cad1a4359318388f237de3169dd` in the
[bridge route list](../../packages/adapter-utils/src/sandbox-callback-bridge.ts),
[run routes](../../server/src/routes/agents.ts),
[task-link route](../../server/src/routes/activity.ts), and
[private-run regression suite](../../server/src/__tests__/heartbeat-run-privacy-routes.test.ts).

Verification: `not-run` for a live sandbox using the updated routes. Bridge and
controller fixtures cover permitted reads, denied writes, redaction and private
task-link filtering. After deployment, verify with an actual run identity and
assert foreign-company, private-task and restricted-mode denial. Source review,
board reads and skipped fixtures do not qualify that live path.

Gaps: Provider trace reveals/downloads require instance-admin and cannot be counted as
ordinary run output access.
The new bridge surface does not qualify retry, cancellation, workspace repair or
session-control access. Deployed diagnostic usefulness remains unverified.

## `session`

Plugin suspension receipts remain required through recovery and admission, then
are removed when the admitted session becomes live. A later warm run therefore
does not inherit an obsolete stopped-run identity. Repository-free fresh plugin
directories retain their saved company, task, workspace, provider owner and
attempt bindings on follow-up. This does not grant session-reset authority or
discard an explicit repository strategy. See the
[session recipe](../feature-map/runs-adapters.md#session) for the continuation
checks; source regressions do not establish live provider acceptance.

Scoped source evidence: completed warm-runner retirement can persist maintenance
under the same process's live, task-bound preparation lease before native
coordinator admission. Original controller generation, committed-result and
no-new-work checks remain required. This changes no actor permission or session
reset authority. Follow the [session recipe](../feature-map/runs-adapters.md#session)
for configuration invalidation and expired or foreign owner rejection.

Fresh-session admission with external checkpoints reads current canonical state
from the registered controller. A local marker does not grant bootstrap or
session-reset authority. Exact run/session/runner/lease binding, no prior activity,
backup checks and atomic remote directory admission retain their existing gates.

Capability ID: `runs-adapters/session`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/agents/{id}/runtime-state/reset-session`.
- `GET /api/agents/{id}/task-sessions`.

Agent access: `restricted` — Board session controls; native server-owned session
continuation.

Policy: Task-session listing and execution-context reset require board agent
management at their HTTP routes. These controls are separate from delegated
managed AI-account authentication attempts under `model-accounts`.

Ordinary remote `per_turn` continuation restores an external controller marker
through the existing company/task-bound checkpoint store, with the expected
normalized session. Prior-owner, lifecycle and backup admission checks remain
authoritative. Prior-run projections refresh when that checkpoint exists; legacy
file-backed admission remains available when it does not. This changes no agent
grant or session-control endpoint. The
[executor controls](../../server/src/services/native-runtime/native-session-executor.test.ts)
provide source-level restoration and denial evidence; live provider continuity
is a separate verification step.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Task-session listing and execution-context reset require board agent
management at their HTTP routes. Native `call_api` preserves these denials; native
continuation remains server-owned.

Scoped source evidence: replacement of a workspace may bootstrap a newly
admitted provider session only with matching current run/runner/lease identity,
no prior activity or backup, and an atomic claim of an absent remote session
directory. Existing sessions retain verified restore. This adds no reset or
cleanup authority. Follow the [session recipe](../feature-map/runs-adapters.md#session)
with a board-owned disposable fixture; live provider and actor-access evidence
remain separate from the executor regressions.

Scoped source-only evidence: [configuration changes](../../server/src/services/agent-configuration.ts)
and [native execution/recovery](../../server/src/services/native-runtime/native-session-executor.ts)
retain existing execution on unrelated edits and use recorded run configuration
for active/recovered runs. Explicit runner changes use revisions and session
invalidation. Verify saved configuration, current versus historical run identity,
restart and follow-up without granting session-reset authority to an agent.

Scoped source review: 2026-10-13, the recovery correction against
`ea6c8eb5e16d61111968f633a66748b397b64a3e` reuses
[completed onboarding handoff validation](../../server/src/services/chat-completion-delivery.ts)
before applying the issue-terminal backstop. The company, parent origin/status,
assignee, completed child and remaining children must match. Only that backstop
is suppressed for the validated report; process-death and controller/native
ownership checks still apply. No agent gains session or recovery control.
PostgreSQL regressions cover valid native/Legacy callbacks and rejected bindings;
revised live execution and actor authorization remain `not-run`.

Scoped source-only evidence: [configuration changes](../../server/src/services/agent-configuration.ts)
and [native execution/recovery](../../server/src/services/native-runtime/native-session-executor.ts)
retain existing execution on unrelated edits and use recorded run configuration
for active/recovered runs. Explicit runner changes use revisions and session
invalidation. Verify saved configuration, current versus historical run identity,
restart and follow-up without granting session-reset authority to an agent.

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

Scoped shutdown source review: 2026-10-14, against literal
`651a3de64fc943216cc414b64b1443809f9499da`. The suspension barrier bounds remote
state reads by its remaining deadline and rejects late proof. Intentional
[provider ingress shutdown](../../server/src/realtime/runner-prp-outbound.ts)
joins physical socket closure and retires the connection owner before endpoint
release. Unconfirmed termination stays blocked. Existing fake-peer and delayed
read controls are source evidence; this changes no actor, company, account or
session-reset permission. Operation-level verification remains `not-run` and
the failed Test setup does not qualify successful live cleanup.


## `model-accounts`

Capability ID: `runs-adapters/model-accounts`.

Review: `operation-reviewed`.

### `get-companies-ai-connection-pools`

API: `present` — `GET /api/companies/{companyId}/ai-connection-pools`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-ai-connection-pools-inspection`

API: `present` — `GET /api/companies/{companyId}/ai-connection-pools/{poolId}/inspection`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-ai-connection-pools`

API: `present` — `POST /api/companies/{companyId}/ai-connection-pools`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections` and `tools:manage_profiles`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `delete-companies-ai-connection-pools`

API: `present` — `DELETE /api/companies/{companyId}/ai-connection-pools/{poolId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections` and `tools:manage_profiles`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-companies-ai-connections-local-attempts`

API: `present` — `POST /api/companies/{companyId}/ai-connections/local/attempts`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; explicitly supplying ownership, `agentIds`, or `allAgents` also requires `tools:manage_profiles`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-ai-connections-local-check`

API: `present` — `POST /api/companies/{companyId}/ai-connections/local/check`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; explicitly supplying ownership, `agentIds`, or `allAgents` also requires `tools:manage_profiles`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/ai-connections.ts) and [actual-auth native receipt fixture](../../server/src/__tests__/connection-management.integration.test.ts), with real database persistence.
Verification: `passed` — production native call_api with actual run JWT and a deterministic browser-login process returns device URL/code inline, encrypts the mutation receipt, replays exactly, redacts history, and creates no runner response asset. Login start/check/cancel use the real service and persisted addressed-user attempt.
Gaps: The browser process is a fixture; no real provider consent, CLI credentials or live setup is qualified.

### `delete-companies-ai-connections-local-attempts`

API: `present` — `DELETE /api/companies/{companyId}/ai-connections/local/attempts/{sessionId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-ai-connections-local-attempts-code`

API: `present` — `POST /api/companies/{companyId}/ai-connections/local/attempts/{sessionId}/code`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-companies-ai-connections`

API: `present` — `GET /api/companies/{companyId}/ai-connections`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware, including account/pool filtering by agent connection scope with both persistent keys and run JWTs. Pool visibility checks every member account.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `get-companies-ai-connections-usage`

API: `present` — `GET /api/companies/{companyId}/ai-connections/{connectionId}/usage`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-ai-connections-active-runs`

API: `present` — `GET /api/companies/{companyId}/ai-connections/{connectionId}/active-runs`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-ai-connections`

API: `present` — `POST /api/companies/{companyId}/ai-connections`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; explicitly supplying ownership, `agentIds`, or `allAgents` also requires `tools:manage_profiles`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-companies-ai-connections-local`

API: `present` — `POST /api/companies/{companyId}/ai-connections/local`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; explicitly supplying ownership, `agentIds`, or `allAgents` also requires `tools:manage_profiles`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `put-companies-ai-connections-default`

API: `present` — `PUT /api/companies/{companyId}/ai-connections/default`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-ai-connections-login-setup`

API: `present` — `GET /api/companies/{companyId}/ai-connections/login/{sessionId}/setup`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-ai-connections-login`

API: `present` — `GET /api/companies/{companyId}/ai-connections/login/{sessionId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/ai-connections.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-adapters-models`

API: `present` — `GET /api/companies/{companyId}/adapters/{type}/models`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/agents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-adapters-login-sessions`

API: `present` — `POST /api/companies/{companyId}/adapters/{type}/login-sessions`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; explicitly supplying ownership, `agentIds`, or `allAgents` also requires `tools:manage_profiles`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/agents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-adapters-login-sessions-active`

API: `present` — `GET /api/companies/{companyId}/adapters/{type}/login-sessions/active`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [production-authenticated integration fixture](../../server/src/__tests__/connection-management.integration.test.ts), with a saved database session and deterministic registered adapter capability.
Verification: `passed` — actual persistent-key/run-JWT management reads, cancellation, and denial for another saved owner. Session ownership is the responsible human; no device provider or sandbox process was launched in this fixture.
Gaps: Live device authentication remains unqualified. The start route retains strict managed-account, approved adapter command, sandbox, and provider availability checks; human consent completes authentication.

### `get-companies-adapters-login-sessions`

API: `present` — `GET /api/companies/{companyId}/adapters/{type}/login-sessions/{sessionId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [production-authenticated integration fixture](../../server/src/__tests__/connection-management.integration.test.ts), with a saved database session and deterministic registered adapter capability.
Verification: `passed` — actual persistent-key/run-JWT management reads, cancellation, and denial for another saved owner. Session ownership is the responsible human; no device provider or sandbox process was launched in this fixture.
Gaps: Live device authentication remains unqualified. The start route retains strict managed-account, approved adapter command, sandbox, and provider availability checks; human consent completes authentication.

### `post-companies-adapters-login-sessions-cancel`

API: `present` — `POST /api/companies/{companyId}/adapters/{type}/login-sessions/{sessionId}/cancel`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [production-authenticated integration fixture](../../server/src/__tests__/connection-management.integration.test.ts), with a saved database session and deterministic registered adapter capability.
Verification: `passed` — actual persistent-key/run-JWT management reads, cancellation, and denial for another saved owner. Session ownership is the responsible human; no device provider or sandbox process was launched in this fixture.
Gaps: Live device authentication remains unqualified. The start route retains strict managed-account, approved adapter command, sandbox, and provider availability checks; human consent completes authentication.

### `post-agents-claude-login`

API: `present` — `POST /api/agents/{id}/claude-login`; JSON REST.
Agent access: `operator-only` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/agents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-companies-setup-token-login-sessions`

API: `present` — `POST /api/companies/{companyId}/setup-token-login-sessions`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; explicitly supplying ownership, `agentIds`, or `allAgents` also requires `tools:manage_profiles`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/agents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-setup-token-login-sessions-active`

API: `present` — `GET /api/companies/{companyId}/setup-token-login-sessions/active`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/agents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-setup-token-login-sessions`

API: `present` — `GET /api/companies/{companyId}/setup-token-login-sessions/{sessionId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/agents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-setup-token-login-sessions-prompt`

API: `present` — `GET /api/companies/{companyId}/setup-token-login-sessions/{sessionId}/prompt`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/agents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-setup-token-login-sessions-code`

API: `present` — `POST /api/companies/{companyId}/setup-token-login-sessions/{sessionId}/code`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/agents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-companies-setup-token-login-sessions-completion`

API: `present` — `POST /api/companies/{companyId}/setup-token-login-sessions/{sessionId}/completion`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/agents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-setup-token-login-sessions-cancel`

API: `present` — `POST /api/companies/{companyId}/setup-token-login-sessions/{sessionId}/cancel`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/agents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `update-agent-ai-binding`

API: `present` — `PATCH /api/agents/{id}` with a managed AI binding in runtime configuration; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: existing agent configuration permission plus `tools:manage_profiles`, current responsible-user authority, resolved account/pool access and target-agent authority. Pool members retain their credential audience.
Evidence: `verified` — the production-authenticated [integration suite](../../server/src/__tests__/connection-management.integration.test.ts) saves a personal account and binds it to the fresh standard agent; provider response is a fixture.
Verification: `passed` — binding persistence and loss of profile-management authority tested with actual agent credentials. Other adapter/provider combinations remain source-reviewed.
Gaps: live provider setup is outside this delivery.
