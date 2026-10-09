---
name: paperclip-converting-plans-to-tasks
description: >
  Convert Paperclip plans into executable issue graphs. Use when asked to plan,
  scope, or break down Paperclip company work into assigned tasks with specialty
  fit, dependencies, blockers, and parallelization.
---

# Paperclip — Converting Plans to Tasks

A companion skill for turning a plan into executable Paperclip work. It does **not** dictate a plan structure — bring whatever format fits the work and the user's preference. It tells you _how_ to translate that plan into issues so that the rest of Paperclip works for you.

For the **mechanics** of recording a plan (issue document with key `plan`, comment links, approval gating, who to reassign back to), follow the _Planning_ section of the `paperclip` skill. This skill covers planning method, not the API surface.

## When you're asked to plan

- **Plan deeply.** Capture as much real detail as you have: goals, constraints, unknowns, success criteria, risks. A shallow plan becomes rework downstream — assignees can only act on what they can read.
- **Minimize the issue graph.** Use as few tasks as possible while still completing and verifying the job. Prefer one end-to-end task with one owner over separate tasks for each step, file, component, or phase. Keep those structural details as checklists or acceptance criteria inside the owning task unless a real execution boundary requires another issue.
- **Split only for a qualifying boundary.** Create a separate subtask only when at least one of these applies:
  - A different specialist, owner, permission boundary, or external actor must own the work.
  - A self-contained deliverable can usefully run in parallel with other work.
  - A hard dependency or handoff needs its own `blockedByIssueIds` lifecycle.
  - A review, QA pass, or governed approval gate has an independent owner.
  - Substantial follow-up work needs independent tracking or retry because it cannot safely be completed and verified in the parent.
- **Know your team.** Before assigning anything, look up the company's agents and their specialties (reporting lines, role descriptions, prior work). Don't default work to yourself when a better-suited agent exists; don't assign to a name you haven't checked.
- **Assign for specialty.** Hand each piece of work to the agent most relevant to it. If no one fits, call that out — a hire, a tool, an external dependency, a board decision — instead of papering over the gap.
- **Take responsibility.** Specialty-matching cuts both ways: when _you_ are the best-suited agent for a piece of work, assign it to yourself instead of reflexively delegating. Don't hand off to avoid load.
- **Use the dependency tree.** Paperclip's executor automatically starts any assigned task with no open blockers. Parent/child issue nesting is structure, not execution blocking. Express each qualifying ownership or lifecycle boundary as an issue; keep other concrete deliverables within the responsible issue's description, checklist, or acceptance criteria. Wire every hard dependency between issues through `blockedByIssueIds` on the dependent issue (not prose like "blocked by X"). When a blocker reaches `done`, dependents auto-wake.
- **Order, then parallelize.** Sequence work by real dependencies, not by personal preference. Create parallel branches only for qualifying, self-contained work, then start those independent branches in parallel. Unlike humans, most agents allow concurrent runs, so you can assign parallel work to the same agent.
- **Write review tasks for the reviewer's boundary.** A review/QA task must tell the delegate to post findings on **their own review issue** and mark it `done` — the verdict is the deliverable, and adverse findings are still `done`, not `blocked`. Never instruct a delegate to comment on the parent issue (low-trust reviewers are guaranteed a 403 there), and make the description self-contained since the reviewer may not be able to read your issue. Wire the dependent issue's `blockedByIssueIds` to the review issue so the verdict wakes the right owner.
- **Enough is enough.** Plans exist to unblock execution, not replace it. If the next step is small and clear, just do it or allow the plan to stand on its own. Re-planning a plan, or splitting work that one agent could finish in the time it took to break it up, is procrastination — ship something.

## When converting an accepted plan into tasks

Start from one end-to-end task and add issues only for the qualifying boundaries above. Before creating tasks, write a compact task matrix with each proposed task, owner, initial status, blockers, and the specific qualifying reason it must be separate. Any task that can start immediately should say why it has no blockers; otherwise set it to `blocked` and include the prerequisite issue IDs in `blockedByIssueIds`. Do not rely on `parentId`, child ordering, phase labels, or prose to block execution.

Run a merge-back pass before publishing or creating the graph. Require every proposed subtask to name at least one qualifying reason from this skill. If it cannot, merge it into its parent or an adjacent task and preserve the work as an internal step, checklist item, or acceptance criterion. Repeat until every remaining issue has a real ownership, scheduling, lifecycle, or governance reason to exist.

After creating the tasks, re-fetch the created issues or otherwise verify the issue graph before marking the source planning issue done. Confirm that every separate issue still has its qualifying reason, each dependent task has the expected `blockedByIssueIds`, each independent task has an explicit "can start now" reason, review tasks respect the reviewer's write boundary, and the parent/child hierarchy is only being used for traceability. If the graph contains an unjustified split or expected blockers are missing, correct it or report the mismatch and leave the planning issue in `in_review` or `blocked` until the graph is fixed.

## Quick checklist before you publish a plan

- [ ] Enough detail that assignees can act without re-asking.
- [ ] The plan uses the fewest tasks that can complete and verify the job, preferring one end-to-end owner over step/file/component/phase splits.
- [ ] Every concrete deliverable is accounted for inside an issue or, only when a qualifying boundary applies, as its own issue.
- [ ] Every proposed subtask names a qualifying reason; otherwise it was merged into its parent or an adjacent task.
- [ ] Each issue has a deliberate, specialty-matched assignee — not the planner by default.
- [ ] Each issue's real blockers are declared via `blockedByIssueIds`.
- [ ] Independently owned review, QA, and governed approval tasks respect the reviewer's boundary.
- [ ] A compact task matrix names planned task, owner, initial status, blockers, and qualifying reason.
- [ ] Tasks without blockers have an explicit reason they can start immediately.
- [ ] Created issues were re-fetched or otherwise verified before closing the source planning issue.
- [ ] Qualifying independent branches can start in parallel.
- [ ] Gaps (missing skills, hires, decisions, external inputs) are surfaced, not hidden.

## What this skill is not

- Not a plan template. Use any format — prose, outline, table, RACI, Gantt, whatever fits.
- Not software-development–specific. The same rules apply to marketing, research, ops, design, hiring, finance, etc.
- Not a replacement for the `paperclip` skill's planning mechanics. Use both.
