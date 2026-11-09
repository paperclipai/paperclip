---
navigation: {"section":"Getting started and access","sectionOrder":10,"order":10}
---

# Onboarding and first work

An operator can start an instance, create a company, configure its first agent, and reach a real first task. Instance setup and company onboarding are separate steps.

Feature ID: `onboarding`.

Implementation: [web wizard](../../ui/src/components/OnboardingWizard.tsx), [CLI setup](../../cli/src/commands/onboard.ts).

Agent access: [companion](../agent-access-map/onboarding.md).

## Sub-features

- `instance`: `onboarding/instance` — choose local instance configuration and start the server.
- `company`: `onboarding/company` — create a company with its identity and initial agent.
- `adapter`: `onboarding/adapter` — choose an available harness, model, account, and execution environment.
- `first-task`: `onboarding/first-task` — leave setup with a task whose execution or missing prerequisite is visible.
- `resume`: `onboarding/resume` — return to an incomplete wizard without losing saved state.

## How to get to it (user POV)

### `web-wizard`

Open `/onboarding` or the onboarding launcher in an empty company context.
Use `/<company-prefix>/onboarding` to resume an existing company's agent setup;
the unprefixed route starts at organization naming on self-hosted instances.
Cloud-managed instances reuse their existing company for agent setup.

### `cli-setup`

Use `paperclipai onboard --help` or `paperclipai run --help` to select an isolated data directory before setup.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a new isolated data directory and record deployment mode. A configured adapter may still need account authentication.

### `web-wizard`

Automated: [wizard tests](../../ui/src/components/OnboardingWizard.test.tsx) cover mocked wizard behavior; [onboarding browser suite](../../tests/e2e/onboarding.spec.ts) supplies its own test environment. Live model execution is a separate check.

- **Create company and resume.** Start a fresh empty instance and run doctor using
  the [verification skill](../../.agents/skills/verify-paperclip/SKILL.md). Run
  `node .agents/skills/verify-paperclip/scripts/onboarding-smoke.mjs --evidence-dir "$VERIFY_EVIDENCE_DIR"`.
  The helper opens `/onboarding` in a fresh self-hosted instance, enters a unique
  name in `e.g. Northwind Labs`, and chooses `Continue`. The agent-name field must
  appear and the saved company must have no invented goal. Reopen the
  company-prefixed onboarding route and reload; the agent step must appear
  without creating another company. Screenshots and a trace capture the real UI action and result.
  This proves company creation/resumption, not hiring or a first model run.

Manual: Create a disposable company and first agent. Leave midway, reopen the
company's onboarding route, and finish; drafts save automatically. Follow the
created first task, verify the selected agent and company, and inspect its output
or explicit authentication gate. Reload both company and task.

For Codex or Claude, choose the harness and leave runner selection automatic to prove the
first-agent default. On a qualified target it saves Paperclip Runner; Advanced
also permits Legacy. Do not switch runners after onboarding when claiming proof
of that default. Test the selected runtime and account, then complete a bounded
useful task and follow-up with an independently checked file artifact. Saved
execution configuration and recorded run identity must match after reload.
The Codex first-task eval applies operator QA bounds before Get started through
the existing agent configuration API. It verifies that only timeout and
concurrency change; automatic runner, account and environment choices remain.
These campaign bounds are separate from production creation defaults.
Use [runner validation](./runs-adapters.md#adapter-setup) and
[environment qualification](./execution-environments.md#environment-settings)
for the prerequisites; a successful login alone is insufficient.

For managed Cloud setup, an outdated default Claude CLI is prepared automatically
in a private versioned runtime directory before its hello test. Verify that the
selected model and account stay unchanged and that the compatible executable is
actually used. A failed installation still blocks hiring. Cloud failures must
not display Manual debug shell commands or legacy operator hints; self-hosted
failures retain that help.
[Wizard controls](../../ui/src/components/OnboardingWizard.test.tsx) and
[runtime controls](../../packages/adapters/claude-local/src/server/sandbox-cli-version.test.ts)
cover these boundaries. They do not establish live Cloud onboarding success.

For a new Claude agent on an explicit immutable sandbox image or a Daytona
named snapshot, use Connect to
qualify the selected environment through the existing permission-gated probe.
Do not preprobe outside onboarding when claiming this first-use path. Fresh
scoped discovery determines the runner for both the account test and hire;
the measured Legacy result remains valid. An instance-admin denial, incomplete
cleanup, missing lease or changed configuration stops setup before the adapter
test or hire. Daytona resolves the selected snapshot to its immutable provider
ID before creating the measured lease; native execution pins that same ID.
Mutable image tags and other providers’ named templates remain unqualified. [Helper controls](../../ui/src/lib/qualify-claude-setup.test.ts)
and mounted wizard/new-agent tests use mocks; live managed acceptance remains a
separate gate.
For a new Codex agent with Auto on a saved immutable OCI sandbox, Connect first
uses the existing saved environment probe when authoritative qualification is
absent. The board actor needs the existing instance-environment administration
permission. Refresh company/environment-scoped discovery before testing the
selected runtime. A denied probe, unconfirmed cleanup or setup failure must be
visible; selecting Legacy remains an explicit choice. Creation and discovery
themselves allocate no target. A valid measured unsupported target follows the
server's Legacy default. Named Cloud snapshots remain a separate unqualified
boot-identity and fresh-signup gap.

Selected native setup derives its target isolation as task execution does. The
hello probe retains its read-only permission profile, approval-never policy and
bounded provider turn. It skips Codex's project-instruction discovery in its new,
empty private workspace; ordinary tasks still load their project instructions.
Local and SSH transports retain Codex isolation. An injected environment flag
cannot establish an outer sandbox identity. Verify these boundaries with the
existing native setup controls and a real managed task/follow-up; source checks
alone are insufficient.

The explicit manual Product E2E cell
`confirmation-replies.runner-codex.daytona.task-card-accept` covers this fresh
managed wizard path without fixture agent creation or a fixture preprobe. Its
existing attachment oracle checks a downloaded physical file and follow-up
continuity. Setup evidence must correlate both lease IDs with the same company,
environment and provider; missing responses or unmatched rows keep cost coverage
unknown. Run this cell only on an eligible target with separately authorized
provider, runtime and cleanup reservations. Its source and mock controls are
prepared. The literal `ea6c8eb5e16d61111968f633a66748b397b64a3e` live attempt
failed: the child document existed, but the physical file was attached to the
parent, and recovery stopped the completion callback before a provider turn.
The failed report remains evidence; the revised source still needs live proof.
Local cases and automatic selection remain unchanged.

For accepted file-producing work, verify exactly one self-assigned child with a
self-contained description. The onboarding run must yield through the existing
dependency/block disposition so the child's own execution can publish its file.
Native file registration remains bound to the executing task. On completion,
the original conversation must receive the actual child and downloadable file
links. Document-only child work may finish inline; a plan-only request must not
start implementation. Existing first-task asset controls check the instructions,
not model compliance. Inspect the child's execution, document, downloaded file
and source-correlated completion reply in the real journey.

Leave and resume during harness/runner setup. Confirm the draft retains the
explicit choice and compatible account bindings, old native Codex setup links
recover the harness and runner, and a changed harness or runner invalidates stale
test results. Existing Legacy agents remain Legacy when their onboarding/setup
configuration is reopened; this journey does not migrate them.

Reload both `/onboarding` and the company-prefixed route after the first agent is
saved but before Get started. The authorized draft must retain its current step
and that agent's execution choice. An explicit new-company opening still starts
fresh. Opening another company must clear the previous company's resource IDs;
an unauthorized account must not restore its draft. Existing component controls
cover these boundaries; they do not substitute for the managed first-task eval.
The existing mocked-login browser case reopens and reloads Connect directly. It
checks the saved company/name/harness/runner, exact active authorization session,
one login start and no hire while login is pending. This is login UI evidence,
not a provider or managed-environment qualification.

### `cli-setup`

Automated: [CLI onboarding](../../cli/src/__tests__/onboard.test.ts) and [isolated test drive](../../cli/src/__tests__/test-drive.test.ts) cover their setup contracts; they do not establish that every model account is usable.

Manual: Run setup in the disposable directory, open the URL it prints, and confirm the instance identity and company. Restart using that same configuration and verify saved state. Exercise an unavailable adapter and confirm an actionable error.

## Gotchas

- An empty company, an empty instance, and an unauthenticated browser are different states.
- Creating an agent does not prove its provider login or first execution succeeded.
- See [access](./access.md) for authenticated deployments and [agents](./agents.md) for later hiring.

### Storybook verification

#### `resume`

Capability ID: `onboarding/resume`.

Scope: ui
Storybook: Restored incomplete wizard; invalid or unauthorized saved company; temporarily withheld draft; account switch; storage failure.
Production: Reload company-prefixed onboarding without duplicating company; restore only authorized account/company draft and retain input after recoverable loading failure.
Sources: Source: [OnboardingWizard.tsx](../../ui/src/components/OnboardingWizard.tsx), [onboarding-state.ts](../../ui/src/lib/onboarding-state.ts). Tests: [OnboardingWizard.test.tsx](../../ui/src/components/OnboardingWizard.test.tsx), [onboarding-state.test.ts](../../ui/src/lib/onboarding-state.test.ts), [onboarding.spec.ts](../../tests/e2e/onboarding.spec.ts)

#### `instance`

Capability ID: `onboarding/instance`.

Scope: cli
Storybook: No authored UI story required for host installation and startup.
Production: Configure isolated data directory, start instance, confirm printed URL/identity/health, restart with saved configuration.
Sources: Source: [onboard.ts](../../cli/src/commands/onboard.ts), [onboard-service.ts](../../cli/src/onboard-service.ts). Tests: [onboard.test.ts](../../cli/src/__tests__/onboard.test.ts), [onboard-service.test.ts](../../cli/src/__tests__/onboard-service.test.ts), [test-drive.test.ts](../../cli/src/__tests__/test-drive.test.ts)

### Documentation scope: Login, invitations, and access

Deployment modes and core login/invite/member/token paths are mapped; exhaustive identity-provider, expiry, role, and resource-policy combinations remain.
