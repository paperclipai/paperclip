---
navigation: {"section":"Agents and reusable capabilities","sectionOrder":30,"order":30}
---

# Skills and Skill Studio

Operators discover or import skills, author and test them in Skill Studio, manage source versions, and decide which agents may use them.

Implementation: [skill library](../../ui/src/pages/CompanySkills.tsx), [studio](../../ui/src/pages/SkillStudio.tsx), [sources](../../ui/src/pages/SkillSources.tsx), [agent skills](../../ui/src/pages/agent-skills/AgentSkillsTab.tsx).

Agent access: [companion](../agent-access-map/skills.md).

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
Direct authoring starts at `/skills/studio/new`: fill **Name** and **Slug**, then
**Create skill**. Authoring/save/reload requires no model credential; running a
Studio test is separate.

### `agent-enablement`

Use skill policy/agent selection in the library or an agent’s Skills tab.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a harmless skill fixture and test agent with skill support. Record whether the source is local, bundled, project, or remote.

### `library-sources`

Automated: [library UI](../../ui/src/pages/CompanySkills.test.tsx) and [source service](../../server/src/__tests__/skill-sources.test.ts) cover their respective layers.

Manual: Install a fixture, locate it in Installed, inspect its source and files, and reload. Import a source update and compare versions before accepting it. Check a source requiring unavailable repository access and verify the failure is explicit.

### `studio`

Automated: [Studio](../../ui/src/pages/SkillStudio.test.tsx) covers UI behavior; model-driven skill testing remains a separate manual result.

Manual: Create or fork a disposable skill, edit instructions, save, and reload. Run a bounded test, respond to any question, and inspect the output. Verify the saved version matches what was tested and failed saves retain the draft.

### `agent-enablement`

Automated: [policy service](../../server/src/__tests__/company-skill-policy-service.test.ts) and [agent skills state](../../ui/src/pages/agent-skills/AgentSkillsTab.test.ts) cover policy/state contracts.

Manual: Enable the skill for one test agent and leave another without access. Run a small task on each, inspect the available skill context, then change the release/policy and verify the next eligible run uses the intended version.

## Gotchas

- The release picker requires `enableBetaSkills`. Do not invent an Instructions
  accessibility label for the Studio body editor; inspect its current handles.

- Installed does not mean enabled for every agent.
- Read-only GitHub/bundled skills may require a writable copy rather than an in-place edit.
- Studio interaction coverage is in [questions and approvals](./questions-and-approvals.md); a passing mock is not a live harness test.

### Project repository source behavior

New GitHub project repositories import skills automatically. Skills → Sources lists
accessible legacy repositories with Import skills, shows source/project provenance,
and provides Refresh and Automatic updates in its source menu. Verify future additions,
retained exclusions, error recovery and reload persistence. Private-only sources must
be absent for unrelated people/agents; access through either originating project is sufficient.

Storybook/browser coverage uses scoped fixtures. Live GitHub-to-routine execution
must be verified separately; inspect resolved version IDs across an upstream update.

### Connection repair during an update

Open Choose connection while a source is being refreshed. Select an authorized account and save. If the source changes, the dialog must retain that selection, load the current revision, and allow a second save without reopening. The [project repository browser suite](../../tests/storybook-visual/project-repository-skills.spec.ts) covers this recovery with simulated upstream data.

### Storybook verification

#### `testing`

Scope: ui
Storybook: Studio test inputs/configuration, running, question/approval, result and failed test states.
Production: Run bounded test of actual saved version with correct selected account/environment; inspect persisted test detail and eligible interaction response.
Sources: Source: [SkillStudio.tsx](../../ui/src/pages/SkillStudio.tsx), [companySkills.ts](../../ui/src/api/companySkills.ts). Tests: [SkillStudio.test.tsx](../../ui/src/pages/SkillStudio.test.tsx), [company-skill-test-runs-service.test.ts](../../server/src/__tests__/company-skill-test-runs-service.test.ts)

### Documentation scope: Skills, Skill Studio, and teams

Main library/Studio/source/policy and CLI team-install paths are mapped. Full source-provider conflicts, harness sync, and remote package variants remain; catalog UI is not a current top-level route.
