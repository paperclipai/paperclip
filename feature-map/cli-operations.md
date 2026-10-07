# CLI, API clients, and local worktrees

Operators and agents can work through explicit CLI/API context, manage domain resources, inspect runs, and create isolated local worktree instances for development.

Implementation: [command registry](../cli/src/index.ts), [client context](../cli/src/commands/client/context.ts), [worktree commands](../cli/src/commands/worktree.ts).

## Sub-features

- `context`: choose instance/API base, profile, identity, and company explicitly.
- `domain-commands`: read/write tasks, agents, projects, goals, approvals, routines, and other registered resources.
- `outputs`: work with documents/assets/skills and inspect machine-readable results.
- `run-controls`: invoke/inspect supported runs and observe actual outcomes.
- `worktree-instances`: initialize, seed, diagnose, and clean up only an owned development instance.

## How to get to it (user POV)

### `client-context`

Use `paperclipai context show/list/use/set`, auth/connect, and the registered resource command help.

### `subresources-and-runs`

Use issue subresource, asset/skill, and run/heartbeat commands exposed by the CLI help.

### `worktree-instance`

Use the documented worktree/test-drive commands in an owned checkout; inspect `paperclipai worktree --help` first.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use `--help` from the checked-out CLI to discover exact arguments. Select a disposable company and isolated context; do not inherit an unknown API target.

### `client-context`

Automated: [context](../cli/src/__tests__/context.test.ts), [HTTP client](../cli/src/__tests__/http.test.ts), and [operations parity](../cli/src/__tests__/operations-parity.test.ts) cover client contracts, not every live endpoint.

Manual: Inspect the selected context and identity, list the disposable company’s resources, create a harmless task through the supported command, and verify it in the browser. Exercise an invalid token and wrong-company resource. Inspect JSON output and nonzero errors rather than only printed success text.

### `subresources-and-runs`

Automated: [issue subresources](../cli/src/__tests__/issue-subresources.test.ts) and [asset/skill parity](../cli/src/__tests__/admin-asset-skill-parity.test.ts) cover command/API contracts.

Manual: Write a small task document or attach a fixture using the supported command, open it in the UI, and compare contents. Invoke eligible test work, inspect the resulting run ID/status/output, and verify denial when the actor lacks permission.

### `worktree-instance`

Automated: [worktree commands](../cli/src/__tests__/worktree.test.ts) and [test drive](../cli/src/__tests__/test-drive.test.ts) cover isolation/setup contracts.

Manual: Initialize an owned disposable worktree instance, inspect its printed paths and ports, verify health and login, and confirm any seed data belongs to the intended source. Stop and clean up only that instance; inspect preserved work before deleting any checkout.

## Gotchas

- API success proves its contract, not the equivalent browser creation journey.
- The CLI command registry is broader than the UI page inventory; new command families need a recipe review.
- See [instance operations](./instance-operations.md) for install/update/backup and feature-specific recipes for domain behavior.
