---
navigation: {"section":"Oversight and operation","sectionOrder":70,"order":50}
---

# CLI/API and local worktrees

Operators and agents can work through explicit CLI/API context, manage domain resources, inspect runs, and create isolated local worktree instances for development.

Feature ID: `cli-operations`.

Implementation: [command registry](../../cli/src/index.ts), [client context](../../cli/src/commands/client/context.ts), [worktree commands](../../cli/src/commands/worktree.ts).

Agent access: [companion](../agent-access-map/cli-operations.md).

## Sub-features

- `context`: `cli-operations/context` — choose instance/API base, profile, identity, and company explicitly.
- `domain-commands`: `cli-operations/domain-commands` — read/write tasks, agents, projects, goals, approvals, routines, and other registered resources.
- `outputs`: `cli-operations/outputs` — work with documents/assets/skills and inspect machine-readable results.
- `run-controls`: `cli-operations/run-controls` — invoke/inspect supported runs and observe actual outcomes.
- `worktree-instances`: `cli-operations/worktree-instances` — initialize, seed, diagnose, and clean up only an owned development instance.
- `feedback-export`: `cli-operations/feedback-export` — inspect feedback votes and traces, then export a local report bundle without changing remote sharing state.

## How to get to it (user POV)

### `client-context`

Use `paperclipai context show/list/use/set`, auth/connect, and the registered resource command help.

### `subresources-and-runs`

Use issue subresource, asset/skill, and run/heartbeat commands exposed by the CLI help.

### `worktree-instance`

Use the documented worktree/test-drive commands in an owned checkout; inspect `paperclipai worktree --help` first.
Inspect root help too: `worktree:make/list/merge-history/cleanup` are top-level
commands rather than subcommands of `worktree`.

### `feedback-report-export`

Use `paperclipai feedback report --company-id <company-id> --json`, `feedback trace <trace-id> --json`, or `feedback bundle <trace-id> --json`. Export with `paperclipai feedback export --company-id <company-id> --out <empty-owned-directory> --json`. Select the intended board context/profile and use report/export filters such as --vote, --status, --issue-id, --project-id, --from, --to, or --shared-only.

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

### `feedback-report-export`

Automated: [CLI feedback](../../cli/src/__tests__/feedback.test.ts) tests filters, report, and archive construction. [Feedback routes](../../server/src/__tests__/issue-feedback-routes.test.ts), [service](../../server/src/__tests__/feedback-service.test.ts), and [redaction](../../server/src/__tests__/feedback-redaction.test.ts) cover board/company authorization and payload handling. They do not prove every trace format in a live export.

Manual: Use a disposable company with distinguishable up/down feedback and an empty owned output directory. Compare filtered report counts and trace IDs with individual trace/bundle reads. Export and inspect index.json, votes/, traces/, full-traces/, and the resulting ZIP; compare IDs and retained/redacted content with the requested filters. Repeat with another company or inaccessible trace and with an agent bearer. Inspect file contents and exit codes, and verify that report/export did not upload files or change any feedback-sharing state.

Sources: [Feedback CLI](../../cli/src/commands/client/feedback.ts), [company trace list](../../server/src/routes/companies.ts), [trace detail/bundle routes](../../server/src/routes/issues.ts), and [feedback service](../../server/src/services/feedback.ts).

## Gotchas

- Personal MCP login/proxy is covered by [assistant connections](./assistant-connections.md); outbound mail by [chat channels](./chat-channels.md#outbound-agentmail); managed-profile setup by [agents](./agents.md#managed-agent-cli); verified runtime installation/import by [instance operations](./instance-operations.md#runtime-provisioning).
- Feedback export can contain detailed traces. Use an owned output directory and the actual permitted board identity; --shared-only is a read filter, not an upload or consent action.

- API success proves its contract, not the equivalent browser creation journey.
- The CLI command registry is broader than the UI page inventory; new command families need a recipe review.
- See [instance operations](./instance-operations.md) for install/update/backup and feature-specific recipes for domain behavior.

### Storybook verification

#### `context`

Capability ID: `cli-operations/context`.

Scope: cli
Storybook: No authored story required for CLI profile/context selection.
Production: Verify selected API origin, identity and company, JSON output and invalid-token/wrong-company failures. A persona label is not authentication.
Sources: Source: [context.ts](../../cli/src/commands/client/context.ts). Tests: [context.test.ts](../../cli/src/__tests__/context.test.ts), [http.test.ts](../../cli/src/__tests__/http.test.ts)

#### `domain-commands`

Capability ID: `cli-operations/domain-commands`.

Scope: cli
Storybook: No authored story required for command parsing and domain API execution; corresponding product UI keeps its own story needs.
Production: Discover registered help, use a disposable company, assert persisted mutations and denied operations with the actual actor. Command parity is not every endpoint passing live.
Sources: Source: [index.ts](../../cli/src/index.ts), [issue.ts](../../cli/src/commands/client/issue.ts). Tests: [operations-parity.test.ts](../../cli/src/__tests__/operations-parity.test.ts)

#### `outputs`

Capability ID: `cli-operations/outputs`.

Scope: cli
Storybook: No authored story required for CLI document/asset/skill IO or machine-readable output.
Production: Assert payload/schema, exit code, written contents, authorization and file integrity. Open the resulting document/asset in the product for cross-surface acceptance.
Sources: Source: [issue.ts](../../cli/src/commands/client/issue.ts), [asset.ts](../../cli/src/commands/client/asset.ts), [skill.ts](../../cli/src/commands/client/skill.ts). Tests: [issue-subresources.test.ts](../../cli/src/__tests__/issue-subresources.test.ts), [admin-asset-skill-parity.test.ts](../../cli/src/__tests__/admin-asset-skill-parity.test.ts)

#### `run-controls`

Capability ID: `cli-operations/run-controls`.

Scope: cli
Storybook: No authored story required for invoke/list/get/cancel/events/log command execution.
Production: Assert the real run ID, event/log output and resulting state, eligible actor and cancellation denial. Printed success does not prove provider completion.
Sources: Source: [run.ts](../../cli/src/commands/client/run.ts), [heartbeat-run.ts](../../cli/src/commands/heartbeat-run.ts). Tests: [operations-parity.test.ts](../../cli/src/__tests__/operations-parity.test.ts)

#### `worktree-instances`

Capability ID: `cli-operations/worktree-instances`.

Scope: cli
Storybook: No authored story required for worktree initialize/seed/repair/cleanup commands.
Production: Use only an owned isolated checkout/instance; verify paths, ports, health, login and seed provenance, then cleanup ownership. Capture evidence before teardown.
Sources: Source: [worktree.ts](../../cli/src/commands/worktree.ts), [test-drive.ts](../../cli/src/commands/test-drive.ts). Tests: [worktree.test.ts](../../cli/src/__tests__/worktree.test.ts), [test-drive.test.ts](../../cli/src/__tests__/test-drive.test.ts)
