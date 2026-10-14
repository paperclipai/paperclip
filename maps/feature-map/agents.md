---
navigation: {"section":"Agents and reusable capabilities","sectionOrder":30,"order":10}
---

# Hiring, configuration, and organization

Operators hire agents, configure their identity and instructions, assign reporting relationships, and manage their lifecycle. Built-in agents have their own setup and lifecycle constraints.

Implementation: [hiring](../../ui/src/pages/NewAgent.tsx), [configuration](../../ui/src/components/AgentConfigForm.tsx), [organization](../../ui/src/pages/OrgChart.tsx).

Agent access: [companion](../agent-access-map/agents.md).

## Sub-features

- `hire`: choose identity, harness, model, and required account settings; edit
  reporting relationships through the agent configuration afterward.
- `grok-bot`: experimental existing-Bot agent setup through remote OAuth, routine credentials, and an authenticated two-way challenge; current contact, stop and explicit recovery.
- `instructions`: edit agent configuration and instruction files with durable revisions.
- `organization`: inspect and change reporting relationships through supported controls.
- `primary-agent`: choose a personal primary agent for the company, confirm replacement, and inspect its roster/sidebar and task/chat defaults.
- `lifecycle`: pause/resume or retire an agent while preserving history.
- `built-in`: configure required agents without treating them as ordinary removable hires.

## How to get to it (user POV)

### `hire-agent`

Use New agent from the roster or `/agents/new`.

### `agent-configuration`

Open `/agents/:agentId` and the configuration/instruction surfaces it exposes.

### `organization`

Use the roster’s organization view; `/org` redirects to the roster in the streamlined shell.

### `personal-primary-agent`

Open an agent profile and choose **Set as my primary**. Inspect its crown on the
profile/roster and its position in the Agents sidebar, then open a new task or Chat.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a disposable company and supported adapter; hiring may require a formal approval.

### `hire-agent`

Automated: [new agent page](../../ui/src/pages/NewAgent.test.tsx) and [configuration form](../../ui/src/components/AgentConfigForm.render.test.tsx) cover mocked UI behavior.

Manual: Hire an agent with a distinct name and role. Complete any required approval, reload the roster, and open its configuration. Confirm manager, adapter, and model persisted; run a small task to prove execution readiness.

For a new Codex hire, choose the Codex harness. Automatic selection uses Paperclip
Runner on a qualified selected target; Advanced offers an explicit Legacy runner
override. Other harness defaults are unchanged. Record the persisted runner and
underlying harness, rather than treating the displayed Codex name as execution
proof. See [runtime selection and validation](./runs-adapters.md#adapter-setup)
and [target qualification](./execution-environments.md#environment-settings).

Repeat with an explicit Legacy Codex hire. If approval is required, compare its
reviewed execution configuration before and after restart and activation; approval
must retain the reviewed runner. Test an existing Legacy and native agent through
an unrelated edit, reload and restart: neither is automatically upgraded.

Creation defaults also apply to API/CLI hires, built-ins, plugins and new team
imports. Exports preserve resolved execution choices; a package without a runner
choice uses the new-agent default, while updating an existing same-harness agent
preserves its execution. For a native Codex import, edit a model or account binding
and verify unchanged runtime settings survive; an explicit clear must stay cleared.
Use the [portability recipe](./companies.md) for package preparation and boundaries.

The current hiring wizard assigns the first hire CEO and subsequent hires
General reporting to the CEO. Change manager/role afterward through supported
configuration. Process/HTTP agents can be created through API/CLI but are excluded
from the hiring picker; API fixture creation does not prove this UI journey.

### `agent-configuration`

Automated: [instruction service](../../server/src/__tests__/agent-instructions-service.test.ts) and [instruction revisions](../../server/src/__tests__/agent-instruction-revisions.test.ts) cover file/revision contracts.

Manual: Save a harmless instruction edit, reload, and verify its revision and effect in the next eligible run. Pause and resume the disposable agent; confirm pause prevents new work and does not erase previous runs.

An explicit runner change is a configuration change, with normal revisions and
session invalidation. Incompatible settings must produce a field-specific error;
selecting another runner must not silently discard them or change an active run's
recorded execution. Keep runner choice in Advanced and verify the next eligible
run separately from historical transcripts.

### `organization`

Automated: [org chart](../../ui/src/pages/OrgChart.test.tsx) is component evidence. Built-in setup also has [configuration modal tests](../../ui/src/components/ConfigureBuiltInAgentModal.test.tsx).

Manual: Inspect a manager and report, change the relationship through the offered controls, and reload both views. Exercise a rejected invalid relationship. Configure a built-in agent and verify it retains its required identity and restrictions.

### `personal-primary-agent`

Automated: [primary-agent context](../../ui/src/context/PrimaryAgentProvider.test.tsx)
and [primary-agent routes](../../server/src/__tests__/primary-agent.test.ts)
cover selection, company/user scope, and request contracts.

Manual: Select an available agent, reload, and inspect the retained personal choice.
Replace it and verify confirmation is required. Leave or terminate the selected
agent through permitted controls and inspect the unavailable/cleared state.
Switch company/user to check isolation. Open a task and Chat with a
valid draft or recent selection; verify those explicit choices take precedence
over the primary fallback. Opening Chat must not start execution.

## Gotchas

- A roster entry is not proof of an authenticated or invokable adapter.
- Pending hires may live in approval/task surfaces rather than the active roster.
- Skill and tool grants are separate: see [skills](./skills.md) and [app permissions](./app-permissions.md).
- A personal primary agent is a per-user/company preference. It does not change
  reporting lines, stars, permissions, or another person's primary agent.

### `connect-grok-bot`

Choose **Invite an external agent → Grok Bot**, identify the Bot by its desktop name, connect its remote MCP plugin, configure a webhook-only routine, and verify delivery plus authenticated reply. Save & exit resumes the same agent. Keep pairing codes in browser authorization and routine credentials in Paperclip’s fields. A working Bot web URL is not required.

Prerequisites: authenticated public HTTPS, Assistant connections (MCP), Paperclip Runner and Grok Bot experimental settings. Cloud uses its normal managed Runner environment. Provider usage is unknown. Routine uncertainty blocks new assignments until explicit inspection and recovery; stopping work revokes Paperclip authority without confirming remote termination.

Evidence: source implementation and focused protocol tests; real provider assigned/proactive workflows and deployed managed acceptance remain release gates.
### Documentation scope: Agents, organization, and runtime setup

Per-harness/model/account capabilities, every instruction-file error, and complete built-in-agent lifecycle variants remain separate qualification matrices.
