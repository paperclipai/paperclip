# Agent lifecycle

The agent lifecycle module controls hiring, pause, resume, and termination.
Its public entry point is `server/src/modules/agent-lifecycle/index.ts`.
Use its commands to create an agent or change its lifecycle state.
Do not pass a database transaction to a command.
Each command owns its transaction.

## States

| State | Meaning | Next state |
| --- | --- | --- |
| `pending_approval` | The hire needs board approval. | `preparing` or `rejected` |
| `preparing` | Required plugins prepare the agent. | `verifying` |
| `verifying` | The host tests the saved harness configuration. | `ready` |
| `ready` | The lifecycle permits work. | `pausing` or `terminating` |
| `pausing` | The host stops work. Required plugins stop their resources. | `paused` |
| `paused` | A pause hold prevents work. | `resuming` or `terminating` |
| `resuming` | Required plugins start their resources. | The state saved before pause |
| `terminating` | The host revokes keys and stops work. | `cleaning_up` |
| `cleaning_up` | Required plugins remove their resources. | `terminated` |
| `terminated` | Termination is complete. | None |
| `rejected` | The board rejected the hire. | None |

Termination can start before preparation or verification completes.
An old result cannot complete a newer operation.
Deletion requires completed termination or a rejected hire.
The existing restrictions for built-in agents and accounting still apply.

## Commands and transactions

`requestHire` writes the agent record before preparation starts.
An approved hire starts preparation after the transaction commits.
A proposed hire waits for `approveHire` or the approval service.
The existing company approval rules still apply.

`pauseAgent`, `resumeAgent`, and `terminateAgent` record the requested change.
They do not wait for external resource operations.
`retry` makes a failed step available for another attempt.
`purgeAgent` removes a record after termination.

Approval, invitation, onboarding, and company deletion use named module entry
points. Their adapters own the related database work.
Callers cannot add agent writes to an unrelated transaction.
The ordinary agent service retains reads and configuration changes.
It rejects lifecycle fields in a configuration update.

Manual, budget, and company pause holds are independent.
A manual resume does not remove a budget or company hold.
Restoring a company does not remove a manual hold.
Budget and company policy still prevent admission while the pause work runs.

The legacy `status` field remains available to existing clients.
It shows `paused` during preparation, verification, pause, and resume.
It shows `terminated` as soon as termination starts.
Execution code can change this field only when the lifecycle is `ready`.
Use `lifecycleState` to distinguish the steps.
This change does not change the user interface.

## Required plugin work

A plugin can declare `agentLifecycle: true` in its manifest.
It must also request `agents.lifecycle.manage`.
The plugin implements `onAgentLifecycle` in the SDK.
This method is separate from event delivery and event acknowledgment.

The host selects the enabled participants before the first lifecycle step.
It stores that selection on the agent.
A disabled or removed participant cannot silently release an existing requirement.
Restore that participant to complete the operation.
A later plugin installation does not change an existing selection.

Each request contains these fields:

- `companyId` and `agentId` identify the agent.
- `phase` identifies the lifecycle step.
- `operationId` identifies the operation.
- `version` identifies the state revision.

Return the same `operationId` and `version` with `status: "complete"` or
`status: "pending"`.
Return `complete` only after the requested effect is complete.
Return `pending` while external work continues.
Throw an error when the step fails.
The host stores a fixed error message. It does not store the provider error text.

Calls can repeat after a timeout or a server restart.
A participant must make repeated calls safe.
It must retain the highest version for each company and agent.
It must reject an older request after it accepts a newer version.
It must also prevent an older operation from creating resources after cleanup.
Serialize external effects or remove resources from a late completion.
Do not treat a host timeout as cancellation of the external effect.

## Verification and recovery

The host uses the existing environment-test code for verification.
It tests the saved agent configuration and the selected environment.
It uses the saved responsible user for managed credentials.
The host does not grant new credential access for this test.
A connection pool selects an account for a separate lifecycle test operation.
An external controller must complete its existing readiness test.

The worker starts after a committed command.
A periodic scan recovers work after a process stops.
A database lease permits one active attempt for each agent.
The worker renews that lease during external calls.
Each result must match the current revision and lease owner.
Shutdown waits for active work.

The agent API returns `lifecycleState`, `lifecycleVersion`, and `lifecycleError`.
A board user can retry through `POST /api/agents/:id/lifecycle/retry`.
The route applies the existing company access checks.

## Existing installations

Migration `0320_daily_onslaught.sql` maps the current status of each agent.
Active execution states become `ready`.
Paused, pending, and terminated agents retain their current meaning.
The migration retains each existing pause reason as a hold.
It does not provision external resources or record a successful harness test.
Resource backfill is a separate task.

Run the normal database migration process before starting the new server.
Stop older server processes during the change.
An older process can write the legacy status without the new lifecycle checks.

`pnpm check:module-boundaries` checks the module imports and agent writes.
Tests and migration fixtures can write records directly.
Production creation and deletion must use the lifecycle module.
