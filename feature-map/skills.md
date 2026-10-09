# Skill discovery, authoring, and policy

Operators discover or import skills, author and test them in Skill Studio, manage source versions, and decide which agents may use them.

Implementation: [skill library](../ui/src/pages/CompanySkills.tsx), [studio](../ui/src/pages/SkillStudio.tsx), [sources](../ui/src/pages/SkillSources.tsx), [agent skills](../ui/src/pages/agent-skills/AgentSkillsTab.tsx).

## Sub-features

- `discovery`: browse installed/discover views and import a skill or source.
- `authoring`: create/edit a writable skill or fork a read-only source.
- `versions`: inspect revisions, source updates, diffs, and selected releases.
- `policy`: apply agent enablement and skill usage policy independently from installation.
- `testing`: run a bounded Studio test and inspect its result and interactions.

## How to get to it (user POV)

### `library-sources`

Open `/skills`, Discover, or `/skills/sources`; project import is available through the library’s import flow.

### `studio`

Use New skill or `/skills/studio/:skillId`; writable copies and source-backed originals differ.

### `agent-enablement`

Use skill policy/agent selection in the library or an agent’s Skills tab.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a harmless skill fixture and test agent with skill support. Record whether the source is local, bundled, project, or remote.

### `library-sources`

Automated: [library UI](../ui/src/pages/CompanySkills.test.tsx) and [source service](../server/src/__tests__/skill-sources.test.ts) cover their respective layers.

Manual: Install a fixture, locate it in Installed, inspect its source and files, and reload. Import a source update and compare versions before accepting it. Check a source requiring unavailable repository access and verify the failure is explicit.

### `studio`

Automated: [Studio](../ui/src/pages/SkillStudio.test.tsx) covers UI behavior; model-driven skill testing remains a separate manual result.

Manual: Create or fork a disposable skill, edit instructions, save, and reload. Run a bounded test, respond to any question, and inspect the output. Verify the saved version matches what was tested and failed saves retain the draft.

### `agent-enablement`

Automated: [policy service](../server/src/__tests__/company-skill-policy-service.test.ts) and [agent skills state](../ui/src/pages/agent-skills/AgentSkillsTab.test.ts) cover policy/state contracts.

Manual: Enable the skill for one test agent and leave another without access. Run a small task on each, inspect the available skill context, then change the release/policy and verify the next eligible run uses the intended version.

## Gotchas

- Installed does not mean enabled for every agent.
- Read-only GitHub/bundled skills may require a writable copy rather than an in-place edit.
- Studio interaction coverage is in [questions and approvals](./questions-and-approvals.md); a passing mock is not a live harness test.
