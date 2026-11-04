---
name: setup-code-maintenance-bot
description: >
  Set up a Paperclip agent and routine that applies a selected code-maintenance
  skill to a repository and opens pull requests. Use for nightly maintenance
  bots, scheduled code gardening, or webhook-driven maintenance, using an
  existing agent or a new hire.
---

# Set Up a Code Maintenance Bot

Turn the user's maintenance intent into a runnable Paperclip routine with a
named agent, accessible repository and skill, bounded work, and inspectable PRs.
The maintenance skill supplies the domain judgment: test auditing, documentation
upkeep, dependency maintenance, refactoring, or another chosen task.

If asked only to draft instructions or a setup plan, produce that artifact and
stop before provisioning or running anything. Do not perform the maintenance
while setting up the bot. An immediate trial is a separate choice from scheduling.

## 1. Establish the destination and agent

Start with the instance and agent choices, using answers already supplied:

- **Instance:** show a clickable, verified Paperclip web URL and ask which
  instance to use. If none is known, ask for its URL; never assume localhost,
  the instance used in an earlier task, or the first connected tool.
- **Company:** resolve the company within that instance; ask if ambiguous.
- **Agent:** list accessible, suitable agents with names and links, and offer
  **use an existing agent** or **create a new agent**. Do not silently choose.

Example, after resolving the actual URL: “Use [Paperclip](<verified-web-url>),
company Acme? Which agent should own this: an existing agent or a new one?”

For a new agent, resolve its name, harness/adapter, provider and model, AI
connection/account, execution environment, reporting line, and budget. Present
available compatible choices from the selected instance. Distinguish the AI
connection from repository credentials. For an existing agent, inspect these
settings and preserve them unless the requested maintenance needs an authorized
change. Keep maintenance-specific instructions in the routine, not by replacing
an existing agent's role.

Read [references/paperclip-api.md](references/paperclip-api.md) for authentication,
discovery, connection binding, hiring, and exact provisioning calls. If the API
is unavailable or not working and browser access is available, use the selected
instance's Paperclip UI to perform the same setup. Verify the instance and
company, honor UI approval gates, and inspect the saved agent and routine after
saving. Reconcile any partially completed API setup before creating through the
browser so the fallback does not duplicate resources. Resolve access against
the selected instance before collecting secrets or making writes.

## 2. Resolve the maintenance contract

Ask only for missing choices; group related questions rather than presenting a
long questionnaire. Discover actual projects and skills before offering them.

| Choice | Resolve before activation |
| --- | --- |
| Repository | Project, repository URL, target branch, execution workspace/environment |
| Work | Maintenance goal, exact skill/source, included areas and exclusions |
| Trigger | Timer with local time and IANA timezone; webhook event/source; or manual/API |
| Limits | Per-run time/cost limit, maximum PRs per run, outstanding-PR cap |
| Delivery | PR target and reviewer/owner; draft or ready; required verification |
| Lifecycle | Monitor and revise PRs until checks pass; owner and continuation path for blocked work |

“Every night” still needs a time and timezone. Propose a concrete time if useful,
but do not infer one silently. A reasonable starting proposal is one coherent PR
per run, a bounded timebox, no automatic merging, and no new work once the agreed
outstanding-PR cap is reached. These are proposals, not fixed product limits.

Resolve the skill at a source the execution environment can actually read.
A file in this chat's checkout is not proof it exists in a remote worker.
Verify the committed target-branch path and all referenced resources, or install
and assign the company skill. Record the chosen source/version policy. Never
replace an unavailable requested skill with a loosely similar task silently.

## 3. Prepare the configuration

Use [references/run-instructions.md](references/run-instructions.md) to write
the complete routine description. It becomes the task given to the worker;
“run maintenance” or a bare skill name is insufficient.

Inspect existing agents and routines to avoid duplicates. Match by company,
repository, task/skill, and trigger; names alone are not identities. Reuse the
requested agent. If an equivalent routine exists, show it and resolve whether
to reuse or change it rather than creating another nightly job.

Show a compact summary with the instance link, agent choice, connection/harness,
repository, skill, trigger/timezone, limits, PR behavior, and readiness gaps.
Proceed within the user's existing setup authorization once choices are settled;
ask only for unresolved choices or required product approvals. Draft-only scope
never authorizes creation. Honor server approval gates without bypassing them.

## 4. Provision, verify, and activate

Follow the API reference or equivalent browser UI in order: acquire authorized
access, provision/reuse the
agent, make the skill available, create the routine **paused**, add its trigger
**disabled**, and read everything back. Record returned IDs as each step succeeds.
Resume partial setup from those records; an ambiguous response is not a reason
to blindly repeat creation.

Verify the agent is runnable and can use its selected connection, repository,
skill, and PR credentials in the actual execution environment. A successful
adapter probe alone does not prove Git push/PR permission. Keep the routine
paused if a hire approval, credential, workspace, or skill is unresolved.
Do not change shared project defaults just to make this bot work.

Enable the trigger and activate the routine only when readiness and scheduling
authorization are established. Use Paperclip's routine trigger as the clock;
do not add a second agent timer or a desktop automation for the same work.
Run a maintenance trial only if requested. Read back the saved schedule and
next run time; distinguish configured scheduling from an observed successful run.

## 5. Hand off

Return links to the instance, agent, routine, and project; the selected skill;
the trigger and timezone; active/paused state; limits and PR policy; readiness
evidence and remaining gaps. If trialed, link the run issue and resulting PR or
no-change result. Explain how to pause the routine and which owner handles
follow-up. Never report a draft, pending hire, or paused routine as running.
