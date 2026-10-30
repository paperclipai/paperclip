# Onboarding and first work — agent access

Product map: [Onboarding and first work](../feature-map/onboarding.md).

Feature ID: `onboarding`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

Scoped runner-default source review: 2026-10-12 at
`eee0534154eaf5d0d3f2bbc97c1e24d86f34a5a5`, limited to first-agent selection,
selected-runtime validation and draft restoration. Unrelated baseline entries
retain the original source commit; no live agent verification is added.

## `instance`

Capability ID: `onboarding/instance`.

Review: `baseline`.

API: `not-applicable` — Bootstrapping an instance cannot depend solely on an API served
by that not-yet-running instance.

Agent access: `operator-only` — Existing CLI onboard/run/doctor / test-drive.

Policy: Instance setup is operator work; company creation is board; agent creation/task
creation retain their individual permissions.

Evidence: `source-only` —
[implementation](../../ui/src/components/OnboardingWizard.tsx#L279) at the reviewed
commit above.

Verification: `not-run` — exercise the listed local workflow in an authorized, owned
operator environment. Verify its isolation and result; do not count local machine
authority as company-agent API access.

Gaps: Bootstrapping an instance cannot depend solely on an API served by that
not-yet-running instance.

## `company`

Capability ID: `onboarding/company`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies`.
- `POST /api/companies/{companyId}/agents`.

Agent access: `partial` — Board company creation; authorized in-company agent hiring
API.

Policy: Instance setup is operator work; company creation is board; agent creation/task
creation retain their individual permissions.

Evidence: `source-only` —
[implementation](../../ui/src/components/OnboardingWizard.tsx#L279) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: API building blocks exist; an ordinary agent cannot create its parent company with
a company key.

## `adapter`

Capability ID: `onboarding/adapter`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/adapters/{type}/models`.
- `POST /api/companies/{companyId}/adapters/{type}/test-environment`.

Agent access: `partial` — Permitted agent/model API; operator
provider-account/environment setup.

Policy: Instance setup is operator work; company creation is board; agent creation/task
creation retain their individual permissions.

The wizard selects the Codex harness and lets the server resolve an automatic
new-agent runner; explicit Legacy remains available. Supported-platform and
immutable sandbox evidence follow [environment probe policy](./execution-environments.md#probe).
Creation/discovery do not provision a target to determine this default. Adapter
setup validation requires `agents:create`, plus saved-agent update access when
testing an existing agent; interactive account login additionally requires a
board user and owner-bound session. An agent's right to hire is not login or
instance-environment administration authority.

A name-only, held setup has no provider selection yet, so the wizard omits its
runner choice until the provider is chosen. The existing board-only setup and
saved-agent update permissions remain; normal runner compatibility validation
is unchanged. No runnable legacy fallback is created.

Scoped source-only runtime preparation: the existing authorized adapter test
prepares the default Claude CLI in its already acquired sandbox when the image
version is too old for the selected model. It installs a pinned package into a
workspace-private versioned prefix and verifies the executable before the hello
test. This adds no installation API, account grant, environment authority or
engine fallback. Cloud UI omits manual shell debugging and legacy operator hints
while retaining check messages and details. Local, SSH and custom
commands remain operator-managed. Controls:
[runtime](../../packages/adapters/claude-local/src/server/sandbox-cli-version.test.ts),
[probe](../../packages/adapters/claude-local/src/server/test.remote.test.ts), and
[wizard](../../ui/src/components/OnboardingWizard.test.tsx). Live managed
authorization and subscription execution remain `not-run` for this change.

For fresh managed Codex Auto setup, the wizard's explicit Connect path can call
`POST /api/environments/{environmentId}/probe?companyId={companyId}` before
selected-runtime testing, then refresh scoped adapter discovery. This reuses the
existing board instance-admin/local-implicit probe gate; `agents:create` alone
is insufficient. A 403, absent proof, changed configuration, missing response
identity or unconfirmed cleanup remains visible. No probe is added to creation
or discovery, no agent/company grant is broadened, and provider authentication
errors never cause an automatic runner switch.

Native setup derives outer sandbox isolation from the server-resolved execution
target, as task execution does. This is an internal transport choice, not a
request/configuration permission. Local and SSH setup keep Codex isolation;
caller-supplied environment flags do not authorize an external sandbox. Existing
company, account, probe and registration-cleanup gates still apply.
The bounded hello probe retains read-only permissions and no dynamic tools. Its
trusted launch skips project-instruction discovery in the new, empty setup
workspace. This grants no filesystem or networking permission and does not
change instruction discovery for ordinary task execution.

Scoped source review: 2026-10-13, exact baseline
`1a0ca66242121e39d88455aa2b52a07acc4a07d9` plus the privately composed onboarding
correction. [Wizard controls](../../ui/src/components/OnboardingWizard.test.tsx)
and [existing Product E2E observer controls](../../tests/runner-e2e/first-task.test.ts)
exercise mocked allowed/denied setup and sticky unknown cost coverage. They do
not prove live actor authorization or provider execution. The explicit manual
`confirmation-replies.runner-codex.daytona.task-card-accept` case requires an
eligible immutable OCI target and the existing probe authority, two identified
setup leases and separately authorized paid/cleanup reservations. Its fixture
neither prequalifies the environment nor creates the agent. Actual Cloud named
snapshot binding, warm/cold signup and live allowed/denied agent checks remain
`not-run`.


Evidence: `source-only` —
[implementation](../../ui/src/components/OnboardingWizard.tsx#L279) at the reviewed
commit above.

Scoped Evidence: `source-only` — [wizard/default selection](../../ui/src/components/OnboardingWizard.tsx),
[creation resolver](../../server/src/services/agent-runner-selection.ts) and
[setup/login authorization](../../server/src/routes/agents.ts) at the scoped
commit. Existing agent/approval execution preservation follows
[hiring access](./agents.md#hire); no live onboarding proof is claimed here.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Account authorization, environment administration and model selection need
separate checks.

Verify automatic onboarding without a post-hire runner change, explicit Legacy,
saved configuration after reload and the actual selected runtime's useful task
plus follow-up. Assert denied agent login/probe and foreign-company account or
environment access separately. These agent-context checks remain `not-run`.

## `first-task`

Capability ID: `onboarding/first-task`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/issues`.
- `POST /api/issues/{issueId}/children`.

Agent access: `available` — Native create_task / agent REST / CLI issue.

Policy: Instance setup is operator work; company creation is board; agent creation/task
creation retain their individual permissions.

An authenticated run bound to the server-created onboarding first task must
obtain persisted human acceptance of the latest ordinary proposal before creating
new tasks through native `create_task` or REST. Its authenticated run determines
this admission even for an explicit standalone task. A card decision or a saved
conversational resolution with a genuine later same-task user message supplies
acceptance; an agent-only resolution does not. A plan approval must name the
current same-task revision. Newer pending/rejected proposals stop new creation.
Already admitted task replay and ordinary delegation retain their existing rules.
Native proposal metadata `version` and `supersedeOnUserComment` stays inside
`request_human_input.payload`. Invalid root metadata is rejected before dispatch;
repair guidance keeps the approval kind instead of replacing it with questions.
The shipped recipes are checked against the advertised schema and the real
interaction service. Idempotent proposal replay still needs a saved human decision.
An accepted onboarding execution cannot create a new task blocked by its
authenticated onboarding source. Native and REST creation return a recoverable
input error before committing that task or its wake. The same source restriction
applies to later blocker edits, using database UUID identity. A child's own agent
run also cannot add its server-owned onboarding parent as a blocker. Native dependency
edits carry their authenticated run. Empty-list corrections and other blockers
remain available without a new proposal decision. The API keeps its normal
attempt audit. A corrected creation call retains
the human acceptance and can reuse the unconsumed command key. Other blocker
relationships remain available. The child needs self-contained approved inputs;
the parent uses `set_dependencies` to wait on the child, not the reverse.

Native `paperclip_finish` does not grant completion authority from an opening
answer. The onboarding parent requires a trusted saved human decision on its
latest proposal. Acceptance permits completion under the existing policy;
rejection permits acknowledgment and closure without authorizing new work.
The native status commit checks this decision again under its existing task/run
locks. This adds no new agent endpoint or cross-company authority. The
[native completion controls](../../server/src/services/native-runtime/paperclip-control-plane-port.test.ts)
check persisted outcomes on disposable PostgreSQL; they are not live Cloud
credential or onboarding qualification.
Source: [creation admission](../../server/src/services/onboarding-first-task-admission.ts).
Controls: [native/REST PostgreSQL regressions](../../server/src/__tests__/onboarding-first-task-admission.test.ts).
These controls do not qualify a live Cloud provider journey.

Evidence: `source-only` —
[implementation](../../ui/src/components/OnboardingWizard.tsx#L279) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Task creation is agent-accessible where permitted; scheduling/readiness does not
follow from successful creation.
The Codex first-task fixture's operator cost guard uses the existing board
agent-configuration PATCH before admitting work. This is not evidence of agent
permission to update its runtime; the listed agent-context checks remain not-run.

Scoped source review: 2026-10-13, the first-task asset correction against
`ea6c8eb5e16d61111968f633a66748b397b64a3e`. The existing
[first-task instructions](../../server/src/onboarding-assets/first-task/skills/first-task/SKILL.md)
send file-producing work through the child's own execution and existing
dependency/block controls. Native `register_deliverable` retains its current-task
binding; this adds no cross-task file-registration authority or permission.
Document-only work may use the existing child-document API inline, and plan-only
approval does not authorize implementation. The existing asset tests check
wording only. The literal baseline live attempt failed child-file delivery and
completion reporting; revised live authorization and execution remain `not-run`.

## `resume`

Capability ID: `onboarding/resume`.

Review: `baseline`.

API: `not-applicable` — No server onboarding-draft API for this browser-local state;
classify explicitly or intentionally make it a cross-client product feature.

Agent access: `not-applicable` — Browser localStorage wizard draft; persisted resources
use their domain APIs.

Policy: Instance setup is operator work; company creation is board; agent creation/task
creation retain their individual permissions.

Evidence: `source-only` —
[implementation](../../ui/src/components/OnboardingWizard.tsx#L279) at the reviewed
commit above.

Verification: `not-run` — use the product recipe for the local/developer surface. Verify
listed shared-resource reads separately; local presentation alone is not agent API
evidence.

Gaps: No server onboarding-draft API for this browser-local state; classify explicitly
or intentionally make it a cross-client product feature.

Scoped source review of [draft restoration](../../ui/src/components/OnboardingWizard.tsx)
preserves harness/runner intent and invalidates obsolete setup-test results after
a selection change. Browser draft continuity is not API or live-agent evidence,
and opening a saved Legacy agent does not apply new-agent defaults.

The initial matching route opening preserves the authorized saved wizard step
on bare and company-prefixed reloads. Explicit new-company or changed-company
openings retain their navigation override and clear foreign company resource
IDs. [Existing component controls](../../ui/src/components/OnboardingWizard.test.tsx)
exercise these presentation and account boundaries. This scoped correction adds
no server draft API, agent grant or proof of live actor authorization. The
managed first-task eval still reloads before Get started and remains a separate
live acceptance gate. The existing mocked-login browser case also checks the
same company-scoped active session and saved selection through route reopening
and a real reload, with one login start and no pending-login hire. These fixture
assertions do not prove server authorization or live credential use.
