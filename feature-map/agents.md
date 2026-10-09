# Hiring, agent configuration, and organization

Operators hire agents, configure their identity and instructions, assign reporting relationships, and manage their lifecycle. Built-in agents have their own setup and lifecycle constraints.

Implementation: [hiring](../ui/src/pages/NewAgent.tsx), [configuration](../ui/src/components/AgentConfigForm.tsx), [organization](../ui/src/pages/OrgChart.tsx).

## Sub-features

- `hire`: choose role, manager, adapter, model, and required account settings.
- `instructions`: edit agent configuration and instruction files with durable revisions.
- `organization`: inspect and change reporting relationships through supported controls.
- `lifecycle`: pause/resume or retire an agent while preserving history.
- `built-in`: configure required agents without treating them as ordinary removable hires.

## How to get to it (user POV)

### `hire-agent`

Use New agent from the roster or `/agents/new`.

### `agent-configuration`

Open `/agents/:agentId` and the configuration/instruction surfaces it exposes.

### `organization`

Use the roster’s organization view; `/org` redirects to the roster in the streamlined shell.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a disposable company and supported adapter; hiring may require a formal approval.

### `hire-agent`

Automated: [new agent page](../ui/src/pages/NewAgent.test.tsx) and [configuration form](../ui/src/components/AgentConfigForm.render.test.tsx) cover mocked UI behavior.

Manual: Hire an agent with a distinct name and role. Complete any required approval, reload the roster, and open its configuration. Confirm manager, adapter, and model persisted; run a small task to prove execution readiness.

### `agent-configuration`

Automated: [instruction service](../server/src/__tests__/agent-instructions-service.test.ts) and [instruction revisions](../server/src/__tests__/agent-instruction-revisions.test.ts) cover file/revision contracts.

Manual: Save a harmless instruction edit, reload, and verify its revision and effect in the next eligible run. Pause and resume the disposable agent; confirm pause prevents new work and does not erase previous runs.

### `organization`

Automated: [org chart](../ui/src/pages/OrgChart.test.tsx) is component evidence. Built-in setup also has [configuration modal tests](../ui/src/components/ConfigureBuiltInAgentModal.test.tsx).

Manual: Inspect a manager and report, change the relationship through the offered controls, and reload both views. Exercise a rejected invalid relationship. Configure a built-in agent and verify it retains its required identity and restrictions.

## Gotchas

- A roster entry is not proof of an authenticated or invokable adapter.
- Pending hires may live in approval/task surfaces rather than the active roster.
- Skill and tool grants are separate: see [skills](./skills.md) and [app permissions](./app-permissions.md).
