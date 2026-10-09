# Agent lifecycle

The agent lifecycle module controls hiring, pause, resume, and termination.
Its public entry point is `server/src/modules/agent-lifecycle/index.ts`.
Use its commands to create an agent or change its lifecycle state.
Do not pass a database transaction to a command.
Each hire or transition command owns its transaction.

## Application use

Application code imports the configured factory from `services/agent-lifecycle.ts`.
This service supplies the module dependencies. Use the root database connection.
Apply the existing caller authorization checks before you call a command.

```ts
import { createAgentLifecycle } from "../services/agent-lifecycle.js";

const lifecycle = createAgentLifecycle(db);
await lifecycle.updateConfiguration(agentId, { title: "Engineer" });
await lifecycle.pauseAgent(agentId);
const state = await lifecycle.get(agentId);
```

The pause command records the request. The worker completes the external steps.
Read `lifecycleState` to check progress.
Configuration updates accept only the fields in `AGENT_CONFIGURATION_FIELDS`.
They reject identity, company, accounting totals, timestamp, and lifecycle fields.
The public update schema also rejects spend totals. Budget limit changes remain
permitted through `budgetMonthlyCents`.

Do not import module adapters or construct module dependencies in a caller.
The company deletion service uses the separate deletion entry point.
The listed configuration workflows use the restricted transaction service.
These are the only transaction integrations. They are described below.

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
A proposed hire waits for `approveHire`.
`approveHire` and `rejectHire` accept an agent ID or `{ approvalId }`.
Both forms use the same hire decision path. An agent ID also resolves its open
hire approval. The approval and the agent change commit together.
The existing company approval rules still apply.

`pauseAgent`, `resumeAgent`, and `terminateAgent` record the requested change.
They do not wait for external resource operations.
`retry` makes a failed step available for another attempt.
`reconcilePolicyHolds` updates budget and company holds for the specified company.
The background policy check processes at most 100 eligible agents each minute.
It continues from the last agent ID and returns to the start after the last page.
Pending hires and agents in termination or a final state are excluded.
An explicit company or budget change still updates all affected agents immediately.
`updateAndTransition` applies a configuration change and a lifecycle command
in one transaction. A failed command does not save the configuration change.

The onboarding and invitation services own their feature workflows.
They commit the hire through `requestHire` before they save the other records.
A separate database transaction holds only the workflow lock.
It prevents concurrent requests for the same workflow.
The hire command commits through its own connection and transaction.
A failure in the lock transaction cannot undo a committed hire.
If a later step fails, a retry uses the existing agent.
The onboarding revision is saved only after its content and audit record commit.

The approval service owns comments, revisions, and general approval records.
The lifecycle module resolves a hire approval and changes the agent in one
transaction. It retains the original credential owner when it approves a hire.

The company deletion service owns the company data cascade.
It requests agent termination before it starts that cascade.
It locks the company in the deletion transaction and removes dependent records.
It then calls `agentLifecycleCompanyDeletion.deleteCompanyData(tx, companyId)`
through the module's separate `company-deletion.ts` entry point.
This operation implements the shared `CompanyDeletionParticipant` interface.
It locks the agent rows, checks their states, and deletes them.
All agents must be terminated or rejected. Otherwise, it throws an error.
The error rolls back all database changes in the deletion transaction.
A concurrent hire makes deletion fail or waits until deletion ends.
The module's delete statement also restricts removal to terminated or rejected agents.
`purgeAgent` deletes a single agent. It owns the transaction and checks the agent
state before it calls the service to remove dependent records.
The service checks accounting holds. The module then deletes the agent record.
An error rolls back both operations. Neither path permits incomplete termination.

The ordinary agent service owns reads, permissions, and keys.
The configuration service owns validation and configuration revisions.
The lifecycle module owns the agent configuration write.
Credential checks remain in the agent credential service.
Secret proposal approval saves the secret before it applies the agent binding.
If the binding fails, the secret remains approved and the binding remains pending.
A retry uses the approved secret. It does not create another secret.
The binding transaction checks authorization, expiry, and the current reporting
structure again before it changes the agent.
The hire service owns names, appearance, permissions, credential binding,
connection installs, identity setup, and primary-agent selection.
The module calls the hire service before and after the agent record write.
These operations use the lifecycle transaction. A failed operation rolls back
the hire and its dependent records.
The module owns the initial state, approval transition, and lifecycle events.
The service in `services/agent-lifecycle.ts` supplies these integrations to the
module. The module does not import services or routes. Shared record queries
and validation functions are in `lib/`. They do not call lifecycle commands.
The application supplies the worker driver at startup.
`updateConfiguration` owns the transaction for an ordinary configuration update.
The module locks the agent. The configuration service validates and prepares the
patch. The module saves it and invalidates an old verification result when
execution configuration changes during setup. The service then updates dependent
records and saves the configuration revision in the same transaction.
There is no separate invalidation operation for callers.
Configuration writes reject caller-supplied lifecycle fields.
For `updateAndTransition`, lifecycle owns the transaction and calls the
same configuration operation. Both changes commit together.

Some workflows must save an agent reference and their own records together.
The module exposes `configuration.ts` for these transactions. Only
`services/agent-configuration-transaction.ts` can import it.
This service supplies the module integrations. It cannot save a configuration
without the module's invalidation check.
Its permitted callers are secret binding approval, Connection adoption, runner
pairing, avatar updates, instruction revisions, and skill reassignment.
The boundary check lists these callers. Ordinary callers use the root command.
Budget changes always use a root command so enforcement follows the commit.
The transaction integration cannot approve, pause, resume, or terminate an agent.
It does not start a worker before the caller commits. The periodic scan recovers
pending setup work after the commit.

Manual, budget, and company pause holds are independent.
A manual resume does not remove a budget or company hold.
Restoring a company does not remove a manual hold.
Budget and company policy still prevent admission while the pause work runs.

The legacy `status` field remains available to existing clients.
It shows `paused` during preparation, verification, pause, and resume.
It shows `terminated` as soon as termination starts.
Execution code can change this field only when the lifecycle is `ready`.
Use `lifecycleState` to distinguish the steps.
The agent page shows preparation, verification, pause, resume, and cleanup
progress from `lifecycleState`. Failed steps show the host error and a Retry
action. The page refreshes pending steps every two seconds and other states
every thirty seconds. It does not query plugins for a separate readiness state.

## Required plugin work

A plugin can declare `agentLifecycle: true` in its manifest.
It must also request `agents.lifecycle.manage`.
The plugin implements `onAgentLifecycle` in the SDK.
This method is separate from event delivery and event acknowledgment.

The host selects the required plugins before the first lifecycle step.
`setRequiredPlugins` stores their IDs on the agent.
The host is not a plugin ID. Each operation records host completion and
completed plugin IDs separately. The host step must finish before plugin calls.
A disabled or removed plugin cannot silently release an existing requirement.
Restore that plugin to complete the operation.
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
Server logs identify the failed step, phase, operation, and plugin when available.
They include only known error codes. Unknown codes become `unclassified`.
They do not include provider messages, stacks, or configuration values.
A failure before the agent is read can have only a step and agent ID.
A scan failure has no agent ID.

Calls can repeat after a timeout or a server restart.
A plugin must make repeated calls safe.
It must retain the highest version for each company and agent.
It must reject an older request after it accepts a newer version.
It must also prevent an older operation from creating resources after cleanup.
Serialize external effects or remove resources from a late completion.
Do not treat a host timeout as cancellation of the external effect.

## Verification and recovery

The harness verification service uses the existing environment-test code.
It owns test configuration, credential selection, and test result checks.
It tests the saved agent configuration and the selected environment.
A failed login or an incomplete probe cannot complete verification.
The lifecycle module receives completion, pending work, or failure through its
driver. It owns the state transition and has no harness test rules.
The current UI can also run a test before the hire.
Some adapters can charge for these tests.
It uses the saved responsible user for managed credentials.
The host does not grant new credential access for this test.
A connection pool selects an account for a separate lifecycle test operation.
An external controller must complete its existing readiness test.

Task requests can enter the durable run queue during preparation, verification,
and resume. Execution waits for readiness. Queue recovery does not require
periodic agent heartbeats to be enabled.

A cancelled run record does not prove that execution stopped.
The host also checks process ownership, controller leases, and environment cleanup.
Required plugin cleanup cannot start while these checks are incomplete.

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
Production creation and lifecycle state writes must use the lifecycle module.
Production record deletion must also use the lifecycle module.
Execution configuration writes must use the module. The offline worktree seed
command can disable timers in a copied database before the server starts.

## Extension rules

Add a lifecycle command to the module entry point. Put state transition rules in
`domain/policy.ts`. Put database operations in the module adapters.
Keep harness and provider rules in services. Supply external work through the
worker driver. Report completion only after that work is complete.
Add a test for a failed or repeated operation. Run `pnpm check:module-boundaries`
to check the import and write boundaries.
