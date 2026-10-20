# Runs, harnesses, and model accounts — agent access

Product map: [Runs, harnesses, and model accounts](../feature-map/runs-adapters.md).

Feature ID: `runs-adapters`.

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

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
bound runtime context; adapter/account inventories remain board-only.

Policy: Run/cost visibility and agent configuration policy; adapter installation/account
login/session control require board/admin.

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
server-owned immutable sandbox facts without provisioning. New Codex defaults
and explicit overrides follow the [shared runner contract](../../packages/shared/src/agent-runner.ts);
Claude follows its qualified rollout described above. The board inventory does not grant a
native agent an equivalent discovery binding. See
[probe restrictions](./execution-environments.md#probe) for acquiring qualification.
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
This adds no agent API, credential access, run-log write, or recovery authority.
See [the tracing contract](../../doc/observability.md#controller-preparation-phases).
Live latency verification remains separate from the existing access baseline.

API: `present` — representative operation IDs:

- `GET /api/heartbeat-runs/{runId}`.
- `GET /api/heartbeat-runs/{runId}/log`.
- `GET /api/heartbeat-runs/{runId}/events`.
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
and credential redaction apply. Adapter installation, account login, session
control, recovery writes and raw provider-trace administration retain their
existing board/admin or dedicated-tool gates.

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

Capability ID: `runs-adapters/session`.

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
