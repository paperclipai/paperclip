# Onboarding and first work

An operator can start an instance, create a company, configure its first agent, and reach a real first task. Instance setup and company onboarding are separate steps.

Implementation: [web wizard](../ui/src/components/OnboardingWizard.tsx), [CLI setup](../cli/src/commands/onboard.ts).

## Sub-features

- `instance`: choose local instance configuration and start the server.
- `company`: create a company with its identity and initial agent.
- `adapter`: choose an available harness, model, account, and execution environment.
- `first-task`: leave setup with a task whose execution or missing prerequisite is visible.
- `resume`: return to an incomplete wizard without losing saved state.

## How to get to it (user POV)

### `web-wizard`

Open `/onboarding` or the onboarding launcher in an empty company context.

### `cli-setup`

Use `paperclipai onboard --help` or `paperclipai run --help` to select an isolated data directory before setup.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a new isolated data directory and record deployment mode. A configured adapter may still need account authentication.

### `web-wizard`

Automated: [wizard tests](../ui/src/components/OnboardingWizard.test.tsx) cover mocked wizard behavior; [onboarding browser suite](../tests/e2e/onboarding.spec.ts) supplies its own test environment. Live model execution is a separate check.

Manual: Create a disposable company and first agent. Save and leave midway, reopen, and finish. Follow the created first task, verify the selected agent and company, and inspect its output or explicit authentication gate. Reload both company and task.

### `cli-setup`

Automated: [CLI onboarding](../cli/src/__tests__/onboard.test.ts) and [isolated test drive](../cli/src/__tests__/test-drive.test.ts) cover their setup contracts; they do not establish that every model account is usable.

Manual: Run setup in the disposable directory, open the URL it prints, and confirm the instance identity and company. Restart using that same configuration and verify saved state. Exercise an unavailable adapter and confirm an actionable error.

## Gotchas

- An empty company, an empty instance, and an unauthenticated browser are different states.
- Creating an agent does not prove its provider login or first execution succeeded.
- See [access](./access.md) for authenticated deployments and [agents](./agents.md) for later hiring.
