---
navigation: {"section":"Automation and structured work","sectionOrder":60,"order":10}
---

# Routines, schedules, and triggers

Operators define repeatable work, configure its inputs and triggers, run it on demand or automatically, and inspect the execution history and resulting tasks.

Feature ID: `routines`.

Implementation: [routine list](../../ui/src/pages/Routines.tsx), [routine detail](../../ui/src/pages/RoutineDetail.tsx), [trigger editor](../../ui/src/components/routine-triggers/TriggerWizard.tsx).

Agent access: [companion](../agent-access-map/routines.md).

## Sub-features

- `definition`: `routines/definition` — save the request, agent, project, variables, and execution context.
- `triggers`: `routines/triggers` — configure supported schedules/webhooks or other offered triggers.
- `run-now`: `routines/run-now` — supply inputs and create an observable routine execution.
- `history`: `routines/history` — inspect resulting tasks and past outcomes.
- `management`: `routines/management` — organize, pause/disable, archive, and distinguish plugin-managed routines.

## How to get to it (user POV)

### `routine-editor`

Open `/routines`, create one, and inspect `/routines/:routineId` and its edit sections.

### `trigger-history`

Use the routine's trigger controls and Runs/Recent Runs/Audit links; lists also
offer Run now. **View all tasks** opens the Tasks list with **Routine tasks**
selected, using `/issues?view=all&originKind=routine_execution`. Uncheck the
filter to return to other tasks. **History** records configuration versions, not executions.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a disposable routine, deterministic test agent, and harmless target. Record schedule timezone and enabled state.

### `routine-editor`

Automated: [routine detail helper](../../ui/src/pages/RoutineDetail.test.tsx) tests project-selector options, not the rendered editor. [Routine service](../../server/src/__tests__/routines-service.test.ts) covers server contracts. Saving and running through the editor remain manual checks.

Manual: Save an agent, request, project, and a required variable. Reload and inspect the saved definition. Run now with a distinguishable input, follow the resulting task, and verify its output and history entry. Check a missing required input.

Variables are detected from `{{name}}` placeholders; mark a detected variable
Required and verify missing input prevents Run routine. Configuration can be
checked without model credentials. A successful subprocess run alone does not
complete the generated task or establish a useful task output.

### `trigger-history`

Automated: [trigger wizard](../../ui/src/components/routine-triggers/TriggerWizard.test.tsx) is component coverage; [routine integration](../../server/src/__tests__/routines-e2e.test.ts) is server integration rather than a provider-wide browser proof.

Manual: Set a near-term disposable schedule or authorized test webhook, verify one eligible execution and its source trigger, then disable it and confirm further invocations stop. Inspect a failed execution without losing its history. Remove the temporary trigger after testing.

## Gotchas

- Saving a schedule does not prove the scheduler invoked it.
- Timezone, overlap/concurrency rules, and plugin ownership affect behavior.
- A routine run’s task must still respect pause, access, and budget gates.
- Managed idle hosts may use the [routine wake protocol](../../doc/idle-sleep-safety.md#scheduled-routine-wake-protocol)
  to sleep between supported future runs. The host must save a durable alarm
  and verify the same generation before stopping. Local execution and catch-up
  remain unchanged. Unsupported triggers and other pending work keep it awake.

### Latest skill references

Routine instructions retain stable skill mentions. After a project source syncs an
upstream change, the next execution uses the latest installed version without waiting
on GitHub. Record the resolved version before/after and verify a resumed execution
keeps its original version. Private skill references require current project access
for both the agent and its responsible person.

### Storybook verification

#### `run-now`

Capability ID: `routines/run-now`.

Scope: ui
Storybook: Mount RoutineRunVariablesDialog through actual RoutineDetail with required/default inputs, project/workspace overrides, pending, blocked and failed submission. RunButton-only no-op examples do not supply/run inputs.
Production: POST /routines/{id}/run must validate variables, create one attributed execution/task and obey pause/access/budget gates; inspect actual task outcome separately.
Sources: Source: [RoutineRunVariablesDialog.tsx](../../ui/src/components/RoutineRunVariablesDialog.tsx), [RoutineDetail.tsx](../../ui/src/pages/RoutineDetail.tsx), [routines.ts](../../server/src/routes/routines.ts). Tests: [RoutineRunVariablesDialog.test.tsx](../../ui/src/components/RoutineRunVariablesDialog.test.tsx), [routines-service.test.ts](../../server/src/__tests__/routines-service.test.ts), [routines-e2e.test.ts](../../server/src/__tests__/routines-e2e.test.ts)

### Documentation scope: Routines, cases, and status cards

All three capabilities have recipes. Trigger/provider/timezone combinations, custom case schemas and summarizer quality need deeper cases.
