---
name: terminal-bench-loop
description: >
  Run a single Terminal-Bench problem through Paperclip in a bounded,
  human-in-the-loop improvement cycle until the smoke passes, the board
  rejects the next fix, the iteration budget is exhausted, or a real
  blocker is named. Each iteration runs a bounded smoke against an
  isolated Paperclip App worktree, captures artifacts, diagnoses the
  exact stop point with `/diagnose-why-work-stopped`, requests board
  confirmation before any product fix, then reruns against the same
  worktree. Use whenever an issue asks to "run Terminal-Bench in a
  loop", "drive Terminal-Bench until it passes", "loop fix-git through
  Paperclip", or otherwise points at a Terminal-Bench task and asks for
  bounded iteration with diagnosis.
---

# Terminal-Bench Loop

A repeatable operating skill for driving one Terminal-Bench problem to a passing smoke through Paperclip, with explicit issue topology, bounded runs, board-gated product fixes, and worktree continuity.

This skill is **operational + diagnostic**, not engineering. It coordinates issues, artifacts, and approvals around a Terminal-Bench loop. It does not authorize code changes — every accepted product fix lands as a separate implementation child issue after a board confirmation.

Canonical execution model: read `doc/execution-semantics.md` before starting a loop or moving any loop issue. Every loop issue must rest in a state the doc allows: terminal (`done`/`cancelled`), explicitly live (active run / queued wake), explicitly waiting (`in_review` with participant/interaction/approval), or explicit recovery/blocker (`blocked` with `blockedByIssueIds` and a named owner).

## When to use

Trigger on an assignment whose title or body matches any of:

- "run Terminal-Bench in a loop", "loop \<task-name\> through Paperclip"
- "drive Terminal-Bench fix-git", "iterate on Terminal-Bench until it passes"
- "Terminal-Bench smoke loop", "bench loop", "smoke loop on \<task-name\>"
- An attached link to a Terminal-Bench loop parent issue, plus a request to do another iteration

Also use when the user hands you an existing top-level loop issue and asks for the next iteration, diagnosis, or rerun.

## When NOT to use

- The assignment is to build or change `paperclip-bench` itself (Harbor adapter, wrapper, telemetry). Use normal engineering flow on that repo.
- The assignment is to submit a benchmark result for ranking. This skill produces smoke/non-comparable runs by design — escalate full-suite or comparable runs to BenchmarkQualityManager.
- The assignment is a normal Paperclip product bug not surfaced by a Terminal-Bench loop. Use normal investigation.
- You have not been granted permission to install or assign company skills, and the asker actually wants library mutation. Hand that step to an authorized skill-library owner.

## Three invariants you must preserve

Every loop iteration and every proposed product fix must hold these three invariants together. They come from `/diagnose-why-work-stopped` and the user has restated them across the liveness work:

1. **Productive work continues.** Each loop issue must always have a clear next action owner — agent, board, user, or named blocker. No silent `in_review` with nothing waiting on it.
2. **Only real blockers stop work.** Stops happen when something genuinely cannot proceed (board confirmation, QA, missing credentials, exhausted budget). Pseudo-stops must be detected and routed.
3. **No infinite loops.** Iteration count, wall-clock budget, and a board gate before product fixes are applied keep the loop bounded.

If a proposed iteration violates any of the three, drop it or rework it. State explicitly in the loop issue how each invariant is held this iteration.

## Inputs

Collect these on the top-level loop issue before iteration 1. Any input that cannot be supplied is a blocker — name the unblock owner and stop.

- **Source issue.** The Paperclip issue that asked for the loop. The loop parent links back to it.
- **Terminal-Bench task name.** Single-task identifier (e.g. `terminal-bench/fix-git`). Multi-task suites are out of scope for this skill.
- **Iteration budget.** Maximum number of iterations before the loop must stop without further fixes (typical: 3–5). Also record a per-iteration wall-clock cap.
- **Paperclip App worktree issue.** The implementation-side issue under the Paperclip App project whose execution workspace owns the isolated worktree. First iteration creates it; later iterations reuse it via `inheritExecutionWorkspaceFromIssueId` or equivalent.
- **Benchmark command.** The exact `paperclip-bench` invocation, including the `PAPERCLIPAI_CMD` (or equivalent) binding pinned to the Paperclip App worktree under test. Record verbatim on the loop issue.
- **Latest artifact root.** Filesystem or storage path under which `paperclip-bench` writes run artifacts (manifest, `results.jsonl`, Harbor raw job folders, redacted telemetry). Each iteration appends; nothing is overwritten.
- **Approval policy.** Who must accept a proposed product fix before implementation (default: board via `request_confirmation`; CTO if delegated; never the loop driver alone).

Record each input on the top-level loop issue (description or a dedicated `inputs` document). If any input changes mid-loop, note the change and the iteration it took effect.

## Issue topology

The loop must be representable as a tree, not as prose in comments:

- **Top-level loop issue.** Long-lived. Holds inputs, iteration counter, current state, links to every iteration child, and the product-rule history. Rests in `in_progress` while an iteration is running, `in_review` only when a typed waiter sits directly on the loop parent (execution-policy participant, `request_confirmation` / `ask_user_questions` / `suggest_tasks` interaction, approval, or named human owner), `blocked` with `blockedByIssueIds` while a child issue is the gating work (iteration child holding the fix-proposal `request_confirmation`, or implementation, QA, or CTO review children), `done` on pass, or `cancelled` on board-rejection / budget exhaustion.
- **Iteration child issues.** One per iteration. Each carries: a bounded run issue (smoke), a diagnosis issue (applies `/diagnose-why-work-stopped`), a fix-proposal document with a `request_confirmation` interaction, and — only after acceptance — implementation, QA, CTO review, and rerun children. Iteration children are blocked by their predecessors so the executor wakes them in order.
- **Paperclip App implementation issue.** The first iteration creates a fresh Paperclip App child whose project policy spawns an isolated worktree. Every later iteration's implementation/rerun child references that same execution workspace via `inheritExecutionWorkspaceFromIssueId` so the same worktree is amended and tested.

Wire dependencies with `blockedByIssueIds`, never with prose like "blocked by X". When a dependent child is `done`, the executor auto-wakes the next.

## Procedure

### 0. Read the current execution contract

Before opening or advancing a loop, read `doc/execution-semantics.md`. Use that document's terms intact when classifying loop-issue state: live path / waiting path / recovery path; post-run disposition; bounded continuation; productivity review; pause-hold; watchdog. Do not invent a new state.

### 1. Open or reuse the top-level loop issue

- If an existing loop issue is supplied, read it: inputs, iteration counter, last iteration's stop reason, current Paperclip App worktree pointer, latest benchmark command.
- If no loop issue exists, create one under the Paperclip App project (or the project the source issue points at). Title: `Terminal-Bench loop: <task-name>`. Description captures the inputs above, the iteration budget, and a link to the source issue.
- Verify the worktree pointer still resolves. If the recorded execution workspace was discarded (worktree pruned, project changed), the loop is blocked — name the unblock owner (CodexCoder or the Paperclip App owner) and stop.

### 2. Open the iteration child

- Increment the iteration counter on the loop issue.
- Create an iteration child titled `Iteration N: <task-name>`. Its description repeats the inputs and references the loop parent. Block it on the prior iteration's terminal child (if any) so the executor cannot start two iterations in parallel.
- If the iteration counter would exceed the budget, do not create the child. Move the loop issue to `cancelled` (budget exhausted) or `in_review` if the user must decide whether to extend the budget.

### 3. Run the bounded smoke

- The benchmark command must use the Paperclip App worktree under test. Set `PAPERCLIPAI_CMD` (or the equivalent command binding) to the CLI entrypoint inside that worktree. Never let the smoke run against the operator's current Paperclip checkout.
- Bound the run by wall-clock and by Paperclip's run-budget controls. If the smoke would exceed the per-iteration cap, kill it and record the truncation reason.
- Capture, in the iteration child or a dedicated `run` document:
  - Paperclip run id and heartbeat run ids
  - benchmark run id, manifest, `results.jsonl` row, Harbor raw job folder
  - the exact stop reason reported by the harness (pass, harness fail, verifier fail, timeout, agent gave up, infrastructure error)
  - failure taxonomy bucket (task/model, Paperclip product, harness/setup, verifier/infrastructure, security, unclear)
  - artifact paths under the latest artifact root
- Label the iteration as **smoke / non-comparable**. Comparable runs are out of scope for this skill.

### 4. Diagnose the exact stop point

Apply the `/diagnose-why-work-stopped` pattern to the iteration's run, scoped to this loop only — do not pull in unrelated forensic boilerplate. Specifically:

- Walk the Paperclip issue tree the smoke produced under the Paperclip App worktree, node by node, and find the exact `(issue, status)` combination that stopped progress. Quote evidence: run ids, comment timestamps, status transitions.
- Classify every non-progressing issue in that subtree as **truly needs human/board intervention**, **agent-actionable but not currently routed**, or **already covered**.
- State whether the failure is task/model, Paperclip product, harness/setup, verifier/infrastructure, security, or unclear. Be explicit when evidence is inferred (e.g. cross-company API boundary blocks direct reads).
- If the failure is a Paperclip product gap, frame the fix as a **general product rule** stated as a contract, and check it against the three invariants above. If the rule would have blocked a recent productive run, narrow it.

Record the diagnosis on the iteration child as a `diagnosis` document. Do not propose code yet.

### 5. Decide the next move

Based on the diagnosis, the iteration ends in exactly one of these terminal-for-iteration states:

- **Pass.** Smoke verifier reports pass. Move the iteration child and the loop parent toward QA/CTO review (Step 8).
- **Product fix proposed.** A Paperclip product gap was identified. Write the fix proposal as a `plan` document on the iteration child, then go to Step 6.
- **Non-product failure with retry.** Failure is harness/setup/infrastructure or model flakiness, the iteration budget is not exhausted, and the loop driver believes a rerun without code changes has signal (e.g. transient infra). Record the rationale on the iteration child and go to Step 7 with no implementation step.
- **Real blocker.** Named external blocker (credentials, quota, third-party outage, security review). Move the loop issue to `blocked`, set `blockedByIssueIds` to the blocker issue (creating one if needed), and name the unblock owner. Stop.
- **Budget or board stop.** Iteration budget reached, or the board has rejected the next fix proposal. Move the loop issue to `cancelled` with a comment that summarizes the run history and the reason for stopping.

### 6. Request board confirmation before any product fix

When the iteration ends in **product fix proposed**:

- Update the iteration child's `plan` document with the proposed contract, the three-invariant check, the affected Paperclip surfaces, and the phased subtasks (implementation, QA, CTO review, rerun) — but do not create those subtasks.
- Open the `request_confirmation` interaction on the **iteration child** (the same issue that owns the `plan` document), targeting the latest plan revision. Idempotency key: `confirmation:{iterationIssueId}:plan:{revisionId}`. Set `continuationPolicy` to `wake_assignee`.
- Move the **iteration child** to `in_review`. The typed waiter — the `request_confirmation` interaction — sits directly on it, so its `in_review` is healthy. Comment links the plan document and names the pending confirmation.
- Move the **loop parent** to `blocked` with `blockedByIssueIds: [iterationChildId]` and a comment naming the board (or whichever approver the approval policy designates) as the unblock owner. Do not move the loop parent to `in_review` here: the typed waiter lives on the iteration child, not on the parent, so the parent's wait path is the child blocker. This matches the topology rule that the loop parent only sits in `in_review` when a typed waiter is attached directly to the parent.
- Wait for acceptance. If the board posts a superseding comment that changes the plan, revise the document, then open a fresh confirmation tied to the new revision on the iteration child — the prior one is invalidated. The loop parent's `blockedByIssueIds` already points at the iteration child, so it does not need to change.
- On rejection, end the loop per the **Budget or board stop** rule; do not silently retry the same proposal.
- On acceptance, create the implementation, QA, CTO review, and rerun child issues with `blockedByIssueIds` wired in order, and update the loop parent's `blockedByIssueIds` to point at the new gating child (typically the implementation child) so the parent stays `blocked` against real downstream work. The implementation child must inherit the Paperclip App execution workspace (`inheritExecutionWorkspaceFromIssueId` to the worktree-owning issue) so the fix lands in the same isolated worktree the smoke ran against.

### 7. Rerun against the same worktree

After implementation and QA complete (or immediately, in the **non-product failure with retry** case), the rerun child runs the same `paperclip-bench` invocation with `PAPERCLIPAI_CMD` still pinned to the Paperclip App worktree under test.

- The rerun must use the same worktree the fix landed in. If the workspace was reset between iterations, the loop is invalid — open a blocker on the loop issue and stop.
- On completion, the rerun child becomes the next iteration's run record. If the smoke now passes, jump to Step 8. Otherwise return to Step 4 with a new iteration child (subject to the iteration budget).

### 8. Pass: QA, CTO review, close

When the smoke passes:

- Create QA and CTO review children if they are not already in the dependency chain (CTO review blocked by QA, so the chain wakes in order). Move the loop parent to `blocked` with `blockedByIssueIds` set to the QA / CTO review chain, and post a comment that names QA and CTO as the unblock owners and links the children. The loop parent stays `blocked` — not `in_review` — because the typed waiter lives on the children, not on the parent.
- If you instead want the loop parent itself to sit in `in_review` during this phase (for example because a board user has explicitly volunteered to drive the review), put a typed waiter directly on the parent — execution-policy participant, `request_confirmation` / `ask_user_questions` / `suggest_tasks` interaction, approval, or named human owner — and do not rely on the child chain alone. Do not combine `in_review` on the parent with QA/CTO children acting as the blocker; that is the ambiguous review shape this skill exists to prevent.
- QA validates artifacts (manifest, `results.jsonl`, Harbor raw job, redacted telemetry) and the rerun reproducibility against the same worktree.
- CTO reviews the technical scope of any product fixes that landed during the loop.
- On QA + CTO acceptance, close the loop issue with a board-level summary comment: task name, iteration count, stop reason (pass), worktree pointer, link to the final artifact root, and the list of accepted product fixes (each with its implementation issue id).

### 9. Stop rules

The loop **must** stop, with state explicitly recorded on the loop issue, when any of these is true:

- **Pass.** Smoke verifier reports pass and QA + CTO accept (Step 8). Loop issue → `done`.
- **Board rejection.** Board rejects a fix proposal and does not request a revision. Loop issue → `cancelled`. Comment names the rejected proposal and the reason.
- **Iteration budget reached.** Iteration counter reaches the budget without a pass. Loop issue → `cancelled` (or `in_review` if the user must decide whether to extend the budget). Never silently start iteration N+1.
- **Real blocker named.** External blocker (credentials, quota, infra, security, missing skill) cannot be resolved by the loop driver. Loop issue → `blocked` with `blockedByIssueIds` to the blocker issue and the unblock owner named.

A loop must never end on a prose comment alone. Every stop is a status transition with a named next-action owner.

## Worktree rule

The loop must not test whatever Paperclip checkout happens to be current for the heartbeat. It must test the same isolated Paperclip App worktree where proposed fixes are applied.

- The first iteration creates the Paperclip App implementation child; that project's git-worktree policy spawns a fresh worktree.
- The loop issue records the worktree-owning issue id and the workspace path (or workspace id).
- Every later implementation, QA, and rerun child sets `inheritExecutionWorkspaceFromIssueId` to that worktree-owning issue, so all subsequent loop work shares one workspace.
- The benchmark command always sets `PAPERCLIPAI_CMD` (or the equivalent command binding) to the CLI entrypoint inside that worktree. The benchmark command stored on the loop issue is the source of truth — if a heartbeat needs to run the smoke from a different shell, it copies the recorded command verbatim.
- If the workspace is pruned or the worktree path no longer resolves, the loop is invalid until rebuilt. Mark the loop `blocked` and name the unblock owner (typically CodexCoder or the Paperclip App owner).

## Liveness rule

Every loop issue, at the end of every heartbeat, must rest in one of:

- **Terminal:** `done` or `cancelled`. No further action.
- **Explicitly live:** `in_progress` with an active run, an upcoming queued wake, or a child issue actively executing under it.
- **Explicitly waiting:** `in_review` with a typed waiter — execution-policy participant, `request_confirmation` / `ask_user_questions` / `suggest_tasks` interaction, approval, or a named human owner.
- **Explicit recovery / blocker:** `blocked` with `blockedByIssueIds` set to a real blocking issue, plus a comment naming the unblock owner and the action needed.

If a loop issue does not fit one of these on exit, the heartbeat is not done. Fix the state before exiting.

## Pitfalls

- **Running the smoke against the operator's Paperclip checkout.** The whole point of the worktree rule is that the bench tests the worktree the fix lands in. Always set `PAPERCLIPAI_CMD` and verify the path before launching the run.
- **Coding before approval.** No implementation child exists until a board confirmation accepts the iteration's `plan` document. Do not push code in the diagnostic phase.
- **Skipping the recent-work survey.** When proposing a Paperclip product rule, check what already shipped in the affected liveness/execution area in the last few days. A rule that contradicts last-week's accepted contract is rework.
- **Letting `in_review` mean done.** A loop or iteration child sitting in `in_review` with no participant, no interaction, no approval, and no human owner is a stop, not progress. Treat it as a liveness violation and route it.
- **Silent iteration N+1.** If the iteration budget is reached, never start another iteration without an explicit budget extension recorded on the loop issue.
- **Comparable-run drift.** This skill produces smoke runs only. If the asker wants a comparable benchmark submission, hand off to BenchmarkQualityManager and BenchmarkForensics — do not relabel a smoke as comparable.
- **Recursive recovery.** Stranded-work recovery that recovers its own recovery issues is the canonical infinite loop. If a diagnosis surfaces it inside the smoke's subtree, refuse to deepen and route to `/diagnose-why-work-stopped` for a product-rule fix.
- **Skill-library mutation.** This skill never installs, edits, or assigns company skills as part of a loop iteration. Library changes go to an authorized skill-library owner via a separate issue.
- **Hiding the chain.** Do not silently delete or hide failed iteration children, retracted proposals, or rejected confirmations. The audit trail is the loop's evidence.

## Verification checklist (before exiting a heartbeat that touched the loop)

- [ ] All inputs are recorded on the top-level loop issue, including the exact benchmark command and `PAPERCLIPAI_CMD` binding.
- [ ] Iteration counter is up to date and within budget.
- [ ] The Paperclip App worktree pointer still resolves, and the iteration's run/implementation/rerun children share that workspace.
- [ ] The smoke run is captured with run ids, manifest, `results.jsonl`, Harbor raw job folder, and stop reason.
- [ ] Diagnosis applies the `/diagnose-why-work-stopped` pattern, classifies every non-progressing issue, and checks the three invariants.
- [ ] No implementation child exists for an unapproved fix proposal; if one was proposed, a `request_confirmation` is open against the latest plan revision.
- [ ] Every loop and iteration issue rests in a terminal, explicitly-live, explicitly-waiting, or named-blocker state.
- [ ] The stop reason — if the loop stopped this heartbeat — is one of pass, board rejection, budget exhausted, or named real blocker.
- [ ] No company-skill library mutation happened in this heartbeat.

## Deterministic smoke

Run this smoke after installing or changing the skill, before treating it as operational for a live Terminal-Bench loop:

```sh
pnpm smoke:terminal-bench-loop-skill
```

The command uses the current Paperclip API token and company from `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, and `PAPERCLIP_COMPANY_ID`. When `PAPERCLIP_TASK_ID` is set, it attaches the smoke issues under that source issue and inherits its project/goal context. By default it cancels the short-lived smoke issues after verification; pass `-- --keep` to leave the verified `blocked` loop parent, `in_review` iteration child, and pending confirmation available for manual inspection.

The smoke is deterministic and intentionally non-comparable. It does not start Terminal-Bench, Harbor, an agent model, or a provider runtime. It verifies only the control-plane shape:

- local `skills/terminal-bench-loop/SKILL.md` contains the loop contract terms;
- a top-level loop issue can be created and updated into a blocker posture;
- an iteration child issue can be created under the loop parent;
- mocked benchmark artifact paths are recorded on a `run` document;
- a `diagnosis` document names the exact stop point and next-action owner;
- a `request_confirmation` interaction is created and the iteration child rests in `in_review` with a typed waiting path rather than silent review.
