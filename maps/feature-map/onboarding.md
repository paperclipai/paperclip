---
navigation: {"section":"Getting started and access","sectionOrder":10,"order":10}
---

# Onboarding and first work

An operator can start an instance, create a company, configure its first agent, and reach a real first task. Instance setup and company onboarding are separate steps.

Implementation: [web wizard](../../ui/src/components/OnboardingWizard.tsx), [CLI setup](../../cli/src/commands/onboard.ts).

Agent access: [companion](../agent-access-map/onboarding.md).

## Sub-features

- `instance`: choose local instance configuration and start the server.
- `company`: create a company with its identity and initial agent.
- `adapter`: choose an available harness, model, account, and execution environment.
- `first-task`: leave setup with a task whose execution or missing prerequisite is visible.
- `resume`: return to an incomplete wizard without losing saved state.

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

### `cli-setup`

Automated: [CLI onboarding](../../cli/src/__tests__/onboard.test.ts) and [isolated test drive](../../cli/src/__tests__/test-drive.test.ts) cover their setup contracts; they do not establish that every model account is usable.

Manual: Run setup in the disposable directory, open the URL it prints, and confirm the instance identity and company. Restart using that same configuration and verify saved state. Exercise an unavailable adapter and confirm an actionable error.

## Gotchas

- An empty company, an empty instance, and an unauthenticated browser are different states.
- Creating an agent does not prove its provider login or first execution succeeded.
- See [access](./access.md) for authenticated deployments and [agents](./agents.md) for later hiring.

### Storybook verification

#### `resume`

Scope: ui
Storybook: Restored incomplete wizard; invalid or unauthorized saved company; temporarily withheld draft; account switch; storage failure.
Production: Reload company-prefixed onboarding without duplicating company; restore only authorized account/company draft and retain input after recoverable loading failure.
Sources: Source: [OnboardingWizard.tsx](../../ui/src/components/OnboardingWizard.tsx), [onboarding-state.ts](../../ui/src/lib/onboarding-state.ts). Tests: [OnboardingWizard.test.tsx](../../ui/src/components/OnboardingWizard.test.tsx), [onboarding-state.test.ts](../../ui/src/lib/onboarding-state.test.ts), [onboarding.spec.ts](../../tests/e2e/onboarding.spec.ts)

#### `instance`

Scope: cli
Storybook: No authored UI story required for host installation and startup.
Production: Configure isolated data directory, start instance, confirm printed URL/identity/health, restart with saved configuration.
Sources: Source: [onboard.ts](../../cli/src/commands/onboard.ts), [onboard-service.ts](../../cli/src/onboard-service.ts). Tests: [onboard.test.ts](../../cli/src/__tests__/onboard.test.ts), [onboard-service.test.ts](../../cli/src/__tests__/onboard-service.test.ts), [test-drive.test.ts](../../cli/src/__tests__/test-drive.test.ts)

### Documentation scope: Login, invitations, and access

Deployment modes and core login/invite/member/token paths are mapped; exhaustive identity-provider, expiry, role, and resource-policy combinations remain.
