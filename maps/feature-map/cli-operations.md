---
navigation: {"section":"Oversight and operation","sectionOrder":70,"order":50}
---

# CLI/API and local worktrees

Operators and agents can work through explicit CLI/API context, manage domain resources, inspect runs, and create isolated local worktree instances for development.

Implementation: [command registry](../../cli/src/index.ts), [client context](../../cli/src/commands/client/context.ts), [worktree commands](../../cli/src/commands/worktree.ts).

Agent access: [companion](../agent-access-map/cli-operations.md).

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
Inspect root help too: `worktree:make/list/merge-history/cleanup` are top-level
commands rather than subcommands of `worktree`.

## Driving it with the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use `--help` from the checked-out CLI to discover exact arguments. Select a disposable company and isolated context; do not inherit an unknown API target.
Pass the server origin to `--api-base` (without appending `/api`); the commands
already include the API path. `issue create` requires explicit `--company-id`
even when a profile stores a company. A persona label is not authentication proof.

### `client-context`

Automated: [context](../../cli/src/__tests__/context.test.ts), [HTTP client](../../cli/src/__tests__/http.test.ts), and [operations parity](../../cli/src/__tests__/operations-parity.test.ts) cover client contracts, not every live endpoint.

Manual: Inspect the selected context and identity, list the disposable company’s resources, create a harmless task through the supported command, and verify it in the browser. Exercise an invalid token and wrong-company resource. Inspect JSON output and nonzero errors rather than only printed success text.

### `subresources-and-runs`

Automated: [issue subresources](../../cli/src/__tests__/issue-subresources.test.ts) and [asset/skill parity](../../cli/src/__tests__/admin-asset-skill-parity.test.ts) cover command/API contracts.

Manual: Write a small task document or attach a fixture using the supported command, open it in the UI, and compare contents. Invoke eligible test work, inspect the resulting run ID/status/output, and verify denial when the actor lacks permission.

### `worktree-instance`

Automated: [worktree commands](../../cli/src/__tests__/worktree.test.ts) and [test drive](../../cli/src/__tests__/test-drive.test.ts) cover isolation/setup contracts.

Manual: Initialize an owned disposable worktree instance, inspect its printed paths and ports, verify health and login, and confirm any seed data belongs to the intended source. Stop and clean up only that instance; inspect preserved work before deleting any checkout.

## Gotchas

- API success proves its contract, not the equivalent browser creation journey.
- The CLI command registry is broader than the UI page inventory; new command families need a recipe review.
- See [instance operations](./instance-operations.md) for install/update/backup and feature-specific recipes for domain behavior.

### Storybook verification

#### `context`

Scope: cli
Storybook: No authored story required for CLI profile/context selection.
Production: Verify selected API origin, identity and company, JSON output and invalid-token/wrong-company failures. A persona label is not authentication.
Sources: Source: [context.ts](../../cli/src/commands/client/context.ts). Tests: [context.test.ts](../../cli/src/__tests__/context.test.ts), [http.test.ts](../../cli/src/__tests__/http.test.ts)

#### `domain-commands`

Scope: cli
Storybook: No authored story required for command parsing and domain API execution; corresponding product UI keeps its own story needs.
Production: Discover registered help, use a disposable company, assert persisted mutations and denied operations with the actual actor. Command parity is not every endpoint passing live.
Sources: Source: [index.ts](../../cli/src/index.ts), [issue.ts](../../cli/src/commands/client/issue.ts). Tests: [operations-parity.test.ts](../../cli/src/__tests__/operations-parity.test.ts)

#### `outputs`

Scope: cli
Storybook: No authored story required for CLI document/asset/skill IO or machine-readable output.
Production: Assert payload/schema, exit code, written contents, authorization and file integrity. Open the resulting document/asset in the product for cross-surface acceptance.
Sources: Source: [issue.ts](../../cli/src/commands/client/issue.ts), [asset.ts](../../cli/src/commands/client/asset.ts), [skill.ts](../../cli/src/commands/client/skill.ts). Tests: [issue-subresources.test.ts](../../cli/src/__tests__/issue-subresources.test.ts), [admin-asset-skill-parity.test.ts](../../cli/src/__tests__/admin-asset-skill-parity.test.ts)

#### `run-controls`

Scope: cli
Storybook: No authored story required for invoke/list/get/cancel/events/log command execution.
Production: Assert the real run ID, event/log output and resulting state, eligible actor and cancellation denial. Printed success does not prove provider completion.
Sources: Source: [run.ts](../../cli/src/commands/client/run.ts), [heartbeat-run.ts](../../cli/src/commands/heartbeat-run.ts). Tests: [operations-parity.test.ts](../../cli/src/__tests__/operations-parity.test.ts)

#### `worktree-instances`

Scope: cli
Storybook: No authored story required for worktree initialize/seed/repair/cleanup commands.
Production: Use only an owned isolated checkout/instance; verify paths, ports, health, login and seed provenance, then cleanup ownership. Capture evidence before teardown.
Sources: Source: [worktree.ts](../../cli/src/commands/worktree.ts), [test-drive.ts](../../cli/src/commands/test-drive.ts). Tests: [worktree.test.ts](../../cli/src/__tests__/worktree.test.ts), [test-drive.test.ts](../../cli/src/__tests__/test-drive.test.ts)
