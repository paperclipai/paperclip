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
- **Use the dependency tree.** Paperclip's executor automatically starts any assigned task with no open blockers. Parent/child issue nesting is structure, not execution blocking. Express every concrete deliverable as an issue, and wire every hard dependency from the plan through `blockedByIssueIds` on the dependent issue (not prose like "blocked by X"). When a blocker reaches `done`, dependents auto-wake.
- **Order, then parallelize.** Sequence work by real dependencies, not by personal preference. Independent branches of the graph should start in parallel. Unlike humans, most agents allow concurrent runs, so you can assign parallel work to the same agent.
- **Enough is enough.** Plans exist to unblock execution, not replace it. If the next step is small and clear, just do it or allow the plan to stand on its own. Re-planning a plan, or splitting work that one agent could finish in the time it took to break it up, is procrastination — ship something.

## The default issue-graph template

Whatever prose format the plan takes, give its execution the shape that survives long, multi-step work — a shape the executor and a resumed run can both follow without re-deriving it:

1. **One epic at the top.** A single parent issue naming the whole initiative and its definition of done. It carries the cross-cutting view; it is not itself a unit of work.
2. **Children parented to the epic.** Every concrete deliverable is its own issue whose parent is the epic, set at creation — not a bullet in the epic's description, not a comment mention. Parenting is traceability, not execution order.
3. **One verifiable unit per child.** Scope each child to a single thing you can *prove* done — one file migrated *and* its old copy removed, one document written *and* reviewed, one setting changed *and* confirmed in effect. If "done" needs an "and also," split it. Small verifiable children make every close a real checkpoint and let a resumed run know exactly what remains.
4. **An explicit blocker chain for real sequencing.** Wire every hard "do B after A" dependency as a blocker on the dependent child — not prose, not parent/child nesting, not phase labels. Independent children carry no blockers and start in parallel. When a blocker finishes, its dependents wake in order, so the graph does the sequencing and no one has to guess what is next.
5. **Configure before you assign — assign last.** Assignment is a wake trigger: the instant a child has an assignee, its owner can pick it up. So set structure *before* the owner exists. Either create the child with its parent, its blockers, *and* its assignee all in one atomic create, **or**, if you configure across several calls, create it unassigned, set the parent, set the blockers, then set the assignee last. Never assign first and configure after — that wakes the owner onto a half-built, parent-less or blocker-less issue.

The result is an epic whose children each prove one thing, chained in real dependency order, each handed off only once it is fully wired — the structure that stays navigable and recoverable across many work sessions. This templates the issue *graph*, not the plan's prose; keep bringing whatever plan format fits the work.

## When converting an accepted plan into tasks

Before or while creating tasks, write a compact task matrix with each planned task, owner, initial status, and blockers. Any task that can start immediately should say why it has no blockers; otherwise set it to `blocked` and include the prerequisite issue IDs in `blockedByIssueIds`. Do not rely on `parentId`, child ordering, phase labels, or prose to block execution.

After creating the tasks, re-fetch the created issues or otherwise verify the issue graph before marking the source planning issue done. Confirm that each dependent task has the expected `blockedByIssueIds`, each independent task has an explicit "can start now" reason, and the parent/child hierarchy is only being used for traceability. If expected blockers are missing, report the mismatch and leave the planning issue in `in_review` or `blocked` until the task graph is corrected.

## Quick checklist before you publish a plan

- [ ] Enough detail that assignees can act without re-asking.
- [ ] Every concrete deliverable is an issue (or named as a known follow-up).
- [ ] Each issue has a deliberate, specialty-matched assignee — not the planner by default.
- [ ] Each issue's real blockers are declared via `blockedByIssueIds`.
- [ ] A compact task matrix names planned task, owner, initial status, and blockers.
- [ ] Tasks without blockers have an explicit reason they can start immediately.
- [ ] Created issues were re-fetched or otherwise verified before closing the source planning issue.
- [ ] Independent branches can start in parallel.
- [ ] Gaps (missing skills, hires, decisions, external inputs) are surfaced, not hidden.

## What this skill is not

- Not a plan template. Use any format — prose, outline, table, RACI, Gantt, whatever fits.
- Not software-development–specific. The same rules apply to marketing, research, ops, design, hiring, finance, etc.
- Not a replacement for the `paperclip` skill's planning mechanics. Use both.
