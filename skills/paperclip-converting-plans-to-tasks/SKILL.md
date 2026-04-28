---
name: paperclip-converting-plans-to-tasks
description: >
  The Paperclip way of converting a plan into executable tasks. Use whenever
  you are asked to plan, scope, or break down work inside a Paperclip company.
  Industry-agnostic guidance on how to translate a plan into assigned issues
  with the right specialty, dependencies, and parallelization so Paperclip's
  executor can pick up the work — it does not prescribe a plan format. Pair
  with the `paperclip` skill, which covers the mechanics of writing the plan
  document and reassigning the issue.
---

# Paperclip — Converting Plans to Tasks

A companion skill for turning a plan into executable Paperclip work. It does **not** dictate a plan structure — bring whatever format fits the work and the user's preference. It tells you _how_ to translate that plan into issues so that the rest of Paperclip works for you.

For the **mechanics** of recording a plan (issue document with key `plan`, comment links, approval gating, who to reassign back to), follow the _Planning_ section of the `paperclip` skill. This skill covers planning method, not the API surface.

## When you're asked to plan

- **Plan deeply.** Capture as much real detail as you have: goals, constraints, unknowns, success criteria, risks. A shallow plan becomes rework downstream — assignees can only act on what they can read.
- **Know your team.** Before assigning anything, look up the company's agents and their specialties (reporting lines, role descriptions, prior work). Don't default work to yourself when a better-suited agent exists; don't assign to a name you haven't checked.
- **Assign for specialty.** Hand each piece of work to the agent most relevant to it. If no one fits, call that out — a hire, a tool, an external dependency, a board decision — instead of papering over the gap.
- **Take responsibility.** Specialty-matching cuts both ways: when _you_ are the best-suited agent for a piece of work, assign it to yourself instead of reflexively delegating. Don't hand off to avoid load.
- **Use the dependency tree.** Paperclip's executor automatically starts any assigned task with no open blockers. Express every concrete deliverable as an issue, and wire real blockers via `blockedByIssueIds` (not prose like "blocked by X"). When `done`, dependents auto-wake.
- **Order, then parallelize.** Sequence work by real dependencies, not by personal preference. Independent branches of the graph should start in parallel. Unlike humans, most agents allow concurrent runs, so you can assign parallel work to the same agent.
- **Enough is enough.** Plans exist to unblock execution, not replace it. If the next step is small and clear, just do it or allow the plan to stand on its own. Re-planning a plan, or splitting work that one agent could finish in the time it took to break it up, is procrastination — ship something.

## Quick checklist before you publish a plan

- [ ] Enough detail that assignees can act without re-asking.
- [ ] Every concrete deliverable is an issue (or named as a known follow-up).
- [ ] Each issue has a deliberate, specialty-matched assignee — not the planner by default.
- [ ] Each issue's real blockers are declared via `blockedByIssueIds`.
- [ ] Independent branches can start in parallel.
- [ ] Gaps (missing skills, hires, decisions, external inputs) are surfaced, not hidden.

## What this skill is not

- Not a plan template. Use any format — prose, outline, table, RACI, Gantt, whatever fits.
- Not software-development–specific. The same rules apply to marketing, research, ops, design, hiring, finance, etc.
- Not a replacement for the `paperclip` skill's planning mechanics. Use both.
