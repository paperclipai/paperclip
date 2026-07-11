# AI Factory SOP

Paperclip execution uses a two-level issue topology.

```text
Main parent issue
  - execution lane 1
  - execution lane 2
  - execution lane N
```

There are no execution grandchildren.

## Topology Rules

- A main parent issue may create direct child execution lanes.
- A parent issue may have at most 10 direct child execution lanes.
- An execution lane is any issue with `parentId` set.
- Execution lanes must not create child issues.
- Engineer, QA, fix, and review loops stay inside the same execution-lane issue thread.
- Hard blockers are reported in the execution lane. When any child lane becomes `blocked`, Paperclip writes a durable parent escalation and wakes the child assignee's `reportsTo` manager, even when first-class blocker edges exist. The manager escalates through its own reporting chain to CEO/board when needed.
- Parent issues can set `budgetLimits.issueTreeCents` to cap the parent plus direct lanes, and `budgetLimits.childIssuesCents` to cap execution lanes only.

## Role Rules

- Board, CEO, CTO, PM, and execution-manager agents operate mainly on parent issues.
- Parent-facing agents may create bounded direct child execution lanes for parallelism.
- Specialist agents operate inside one execution lane and should not create additional issues for normal delegation, QA, fixes, or follow-up.
- If a specialist believes more work is needed, it should comment with the proposed lane/follow-up and block or escalate the current issue instead of creating a new issue directly.

## Correct Patterns

- Parent issue plans up to 10 parallel deliverables and creates direct child execution lanes.
- Engineer completes implementation in an execution lane, then QA comments or review stages drive fixes inside that same lane.
- A blocker appears in an execution lane; the lane is marked blocked with a named unblock owner/action and `blockedByIssueIds` when another issue is the blocker.
- The blocked agent's manager receives `PAPERCLIP_WAKE_REASON=child_blocked_manager_escalation`, reviews the child from the parent issue, proposes concrete recovery options, and decides whether to revise scope, reassign, create another sibling lane, resolve the blocker, or escalate through `reportsTo` to CEO/board.
- Agent mentions are reference-only. Assignment, comments to the current assignee, `Next owner:` assignment handoffs, issue-thread interactions, and reporting-chain escalation are the actionable coordination paths.

## Incorrect Patterns

- An execution lane creates another child issue.
- QA creates a separate sub-issue under an execution lane for fixes.
- An engineer creates several follow-up child issues instead of using comments/review/status inside the current lane.
- Agents recursively decompose work beyond parent plus direct children.

## Enforcement

The issue service rejects:

- creating a child under an issue that already has `parentId`;
- creating more than 10 direct children under one parent.

UI surfaces should hide sub-issue creation for execution lanes, but backend enforcement is authoritative.
Issue budget hard-stops also apply to issue trees: `issue_tree` cancels parent plus lanes, and `issue_children` cancels lanes without cancelling the parent board-facing thread.

## Handoff Invariants

Topology says how work fans out; these invariants say what must travel with it. The recurring factory failure is context-loss across handoffs: a manager compresses rich intent into a thin child issue, the executor fills gaps with assumptions, and QA passes plausible-but-wrong output. These rules exist to make that impossible:

- **Every delegated execution lane carries a hidden `executionContract`.** Delegation without a contract is invalid. Schema and duties: `references/execution-contract.md`.
- **A manager's hidden reasoning must be externalized into the child issue's contract.** The issue description is the human brief and must remain readable on its own; the contract is the machine-readable handoff. No executor should have to infer the real task from the parent thread, scattered comments, or unstated manager context.
- **Missing required context is a blocker, not permission to invent.** Executors block and name what is missing instead of guessing.
- **QA reviews against the contract, not against plausibility.** High-quality work that solves the wrong problem fails QA.

## Orchestration Lifecycle

**1. Intake.** The receiving manager identifies: user objective, business reason, task type, source-of-truth materials, constraints, non-goals, acceptance checks, required evidence, and missing context. If the request is ambiguous, ask questions or create a discovery task — do not delegate execution with vague context.

**2. Planning and capability gate.** Planning produces the work breakdown, assignees, blockers, and — critically — the contract each task will be judged against. Before dispatch, verify each assignee has the required adapter/runtime, desired company skills, MCP or credential access, and execution environment. Route missing setup to one bounded provisioning lane instead of repeatedly waking an incapable executor. A list of task titles is not a plan.

**3. Delegation.** Each child lane is created with a concise human-readable `description` plus the full hidden `executionContract` (objective, source-of-truth, constraints, acceptance checks, evidence required, block-if-missing list, manager reasoning summary).

**4. Executor preflight.** Before starting, the executor verifies the contract exists, source-of-truth is reachable, and block-if-missing items are present. Preflight failure → `blocked` with exact missing items named.

**5. Execution.** Work against the contract; record evidence as you go. Store required outputs as issue documents, attachments, previews, files, or external links, and register every declared completion item as a qualifying issue work product. A comment, document, or attachment alone is communication or storage, not proof recognized by the completion gate until its durable reference is registered as a work product.

**6. QA and disposition.** QA compares output to the contract: source-of-truth used, must-preserve preserved, must-not-change untouched, acceptance checks passing with evidence, and required outputs registered. Fail wrong-problem work regardless of polish. Leave exactly one machine-visible next path: done, a typed review/approval owner, a bounded monitor, or a first-class blocker.

**Agent termination is a typed handoff, not reassignment by guess.** Paperclip contains the terminated identity first: cancel queued work, pause owned routines, disable their triggers, revoke keys, quiesce owner-bound monitors/review principals, and preserve the original source-task ownership as evidence. It then opens a bounded recovery action owned by an exact role/capability peer when available, otherwise a reporting coordinator, otherwise the board. The recovery owner coordinates; it does not inherit the source task automatically. It must explicitly accept or repair/reassign the lane and resolve the recovery action only after a real next path exists. Owned routines receive a separate typed routine-recovery issue containing routine, trigger schedule, revision, and secret-reference metadata; every routine must be accepted/reassigned or archived before that recovery closes. Timed-out or no-disposition recovery runs escalate to the board queue.

**7. Incident learning.** If work failed, drifted, or needed rework, classify the incident and route the durable fix to the right layer (agent prompt vs company skill vs root skill vs code). See `references/governance.md`.
