# Routines, schedules, and triggers

Operators define repeatable work, configure its inputs and triggers, run it on demand or automatically, and inspect the execution history and resulting tasks.

Implementation: [routine list](../ui/src/pages/Routines.tsx), [routine detail](../ui/src/pages/RoutineDetail.tsx), [trigger editor](../ui/src/components/routine-triggers/TriggerWizard.tsx).

## Sub-features

- `definition`: save the request, agent, project, variables, and execution context.
- `triggers`: configure supported schedules/webhooks or other offered triggers.
- `run-now`: supply inputs and create an observable routine execution.
- `history`: inspect resulting tasks and past outcomes.
- `management`: organize, pause/disable, archive, and distinguish plugin-managed routines.

## How to get to it (user POV)

### `routine-editor`

Open `/routines`, create one, and inspect `/routines/:routineId` and its edit sections.

### `trigger-history`

Use the routine’s trigger controls and History/Audit links; lists also offer Run now.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a disposable routine, deterministic test agent, and harmless target. Record schedule timezone and enabled state.

### `routine-editor`

Automated: [routine detail helper](../ui/src/pages/RoutineDetail.test.tsx) tests project-selector options, not the rendered editor. [Routine service](../server/src/__tests__/routines-service.test.ts) covers server contracts. Saving and running through the editor remain manual checks.

Manual: Save an agent, request, project, and a required variable. Reload and inspect the saved definition. Run now with a distinguishable input, follow the resulting task, and verify its output and history entry. Check a missing required input.

### `trigger-history`

Automated: [trigger wizard](../ui/src/components/routine-triggers/TriggerWizard.test.tsx) is component coverage; [routine integration](../server/src/__tests__/routines-e2e.test.ts) is server integration rather than a provider-wide browser proof.

Manual: Set a near-term disposable schedule or authorized test webhook, verify one eligible execution and its source trigger, then disable it and confirm further invocations stop. Inspect a failed execution without losing its history. Remove the temporary trigger after testing.

## Gotchas

- Saving a schedule does not prove the scheduler invoked it.
- Timezone, overlap/concurrency rules, and plugin ownership affect behavior.
- A routine run’s task must still respect pause, access, and budget gates.
