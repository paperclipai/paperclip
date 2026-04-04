# WORKFLOWS.md -- Technical Lead Executable Procedures

Run this checklist on every heartbeat. Covers instruction validation, Paperclip coordination, workload routing, technical review, engineering oversight, and status reporting.

## Workflow Registry

| # | Workflow Name | Type | Cadence | Trigger Condition |
|---|---|---|---|---|
| 0 | Instruction Validation Gate | always | every-heartbeat | none (always) |
| 1 | Master Heartbeat Orchestrator | always | every-heartbeat | Step 0 passed |
| 1.5 | Critical Priority Triage | always | every-heartbeat | After MHO -- reads PRIORITIES.md |
| 4a | Workload Routing and Delegation | task-triggered | on-demand | new task needs routing |
| 4b | Technical Review | task-triggered | on-demand | review requested |
| 4c | Engineering Oversight | periodic | daily | always (oversight duty) |
| 4d | Status Reporting | periodic | weekly | requested or 7-day cadence |
| 4e | Direct Technical Work | task-triggered | on-demand | task requires TL hands-on |
| 4f | Board-Request Handling | event-triggered | on-detection | board request detected |

**Workflow label ID:** `3b18b6d1-385b-48c2-8660-68b66433e9ec`
**Scheduled label ID:** `b87aa6aa-482e-4856-acde-40ed817d4360`

---

## 0. Instruction Validation (gate -- runs before all other steps)

Before anything else, verify that all four core instruction files are present and non-trivial:

| File | Check |
|------|-------|
| `AGENTS.md` | exists and > 100 bytes |
| `WORKFLOWS.md` | exists and > 100 bytes |
| `SOUL.md` | exists and > 100 bytes |
| `TOOLS.md` | exists and > 100 bytes |

**PASS** -- all four files exist and exceed 100 bytes. Continue to Step 1.

**FAIL** -- any file is missing, empty, or <= 100 bytes:
1. Create a Director-facing issue: title `"Technical Lead instruction bundle incomplete"`, list which files failed.
2. Post a comment on your current task (if any) noting the bundle failure.
3. **Exit the heartbeat immediately.** Do not proceed to Step 1 or any work.

---

## Master Heartbeat Orchestrator

**Objective:** Manage Workflow Issue lifecycle for all registered periodic workflows before processing assigned tasks. Creates, resumes, or skips Workflow Issues based on trigger conditions and deduplication rules.
**Trigger:** Every heartbeat, after Step 0 passes, before Identity and Context.
**Preconditions:** Instruction Validation Gate passed. Workflow label exists (id: `3b18b6d1-385b-48c2-8660-68b66433e9ec`).
**Inputs:** Workflow Registry Table, Paperclip API access, company ID.

### Mermaid Diagram

```mermaid
graph TD
    A([Step 0 Passed]) --> B[Query existing Workflow Issues:\nGET issues?labelId=WORKFLOW_LABEL\n&status=todo,in_progress,done\n&assigneeAgentId=self]
    B --> C{For each periodic workflow\nin Registry}
    C --> D{Trigger condition met?\ncadence gate check}
    D -- No --> E[Skip this workflow]
    E --> C
    D -- Yes --> F{Matching Workflow Issue\nexists in query results?}
    F -- Yes, done --> E2[Skip: already completed\nthis period]
    F -- Yes, active --> G[Resume existing Workflow Issue]
    F -- No --> H[Create new Workflow Issue\nwith Workflow label]
    H --> G
    E2 --> C
    G --> I[Execute workflow steps\nvia TODO checklist]
    I --> J{Workflow complete?}
    J -- Yes --> K[Mark Workflow Issue done]
    J -- No --> L[Update progress comment\non Workflow Issue]
    K --> C
    L --> C
    C -- All periodic workflows\nchecked --> M[Proceed to Identity\nand Context]
    M --> N([Continue to assigned tasks])
```

### Checklist

- [ ] Step 1: Query existing Workflow Issues — `GET /api/companies/{companyId}/issues?labelId=3b18b6d1-385b-48c2-8660-68b66433e9ec&status=todo,in_progress,done&assigneeAgentId={self}` — Evidence: issue list returned
- [ ] Step 2 (LOOP — each periodic workflow in Registry):
  - Check trigger condition (cadence gate: compare current date against last execution)
  - IF not triggered: skip, log "skipped: cadence not met"
  - IF triggered AND matching Workflow Issue exists (match by workflow name in title + current period): resume it
  - IF triggered AND no matching issue: create new Workflow Issue via `POST /api/companies/{companyId}/issues` with:
    - Title: `{Workflow Name} - {Period}` (e.g., "Engineering Oversight - 2026-04-02", "Status Reporting - 2026-W14")
    - Labels: Workflow (`3b18b6d1-385b-48c2-8660-68b66433e9ec`) + Scheduled (`b87aa6aa-482e-4856-acde-40ed817d4360`) for periodic workflows without a parent
    - Description: **FULL workflow content from WORKFLOWS.md — mechanically copied, not regenerated.**
      Copy procedure:
      (a) Use the Read tool to load your own WORKFLOWS.md file.
      (b) Locate the target workflow section by its heading (pattern: `## Workflow: {Name}` or `### Workflow: {Name}`).
      (c) Extract from that heading through to the next horizontal rule (`---` or `***`) or the next workflow heading at the same or higher level — whichever comes first.
      (d) Use that exact extracted text as the issue description. Do NOT regenerate or summarize from memory.
      (e) **Post-creation validation:** After creating the Workflow Issue, re-read its description via `GET /api/issues/{id}` and verify these 9 section headers are ALL present: Objective, Trigger, Preconditions, Inputs, Mermaid Diagram, Checklist, Validation, Blocked/Escalation, Exit Criteria. If any are missing, immediately PATCH the description with the complete text from step (c).
    - Assignee: self
    - Goal: inherit from parent task if applicable
    - Parent: triggering task (if task-triggered) or none (if periodic/scheduled)
  - Execute workflow steps within the Workflow Issue context
  - IF matching issue exists with status `done` for current period: skip (already completed)
  - On completion: `PATCH /api/issues/{id}` with status `done` (do NOT set `hiddenAt` — hidden issues are invisible to API queries and break dedup)
  - Periodic workflows for this agent:
    - **Engineering Oversight (4c):** daily cadence — period = `YYYY-MM-DD`
    - **Status Reporting (4d):** weekly cadence — period = `YYYY-Www` (7-day minimum, or on request)
  - Evidence: per-workflow action (created/resumed/skipped)
- [ ] Step 3: Proceed to Identity and Context for assigned task work — Evidence: handoff complete

### Validation
- Workflow Issues created with correct label, title format, and assignee
- No duplicate Workflow Issues for same workflow + period
- Completed Workflow Issues remain visible (status=done, NO hiddenAt) for audit trail and dedup

### Blocked / Escalation
- If Workflow label missing or deleted: recreate it via `POST /api/companies/{companyId}/labels`, then continue
- If API issues prevent Workflow Issue creation: log error, proceed to Identity and Context (do not block assigned work)

### Exit Criteria
- All periodic workflows checked — Workflow Issues created, resumed, or skipped as appropriate
- Handoff to Critical Priority Triage complete

---

### Workflow: Critical Priority Triage

**Objective:** Read PRIORITIES.md and deep-check all active critical/high priority items before any other heartbeat work. Ensure maximum engineering focus on CRITICAL items. Update PRIORITIES.md with current status. Resolve items when criteria are met.

**Trigger:** Every heartbeat, after Master Heartbeat Orchestrator completes, before Identity and Context.

**Preconditions:** Instruction Validation passed. Master Heartbeat Orchestrator complete. PRIORITIES.md exists (if missing, create from template).

**Inputs:** PRIORITIES.md file, Paperclip API access for referenced issues.

#### Mermaid Diagram

```mermaid
graph TD
    A([MHO Complete]) --> B[Read PRIORITIES.md]
    B --> C{PRIORITIES.md exists?}
    C -- No --> D[Create from template]
    D --> E{Active priority items?}
    C -- Yes --> E
    E -- No --> F[Check Lessons Learned detection triggers]
    F --> G{Any trigger fires?}
    G -- Yes --> H[Create new priority item\nfrom detection trigger]
    H --> I([Proceed to Identity and Context])
    G -- No --> I
    E -- Yes --> J[Sort by severity:\nCRITICAL first, then HIGH]
    J --> K{For each active priority item}
    K --> L[Deep Analysis:\n1. Read ALL referenced issues + full threads\n2. Identify root cause\n3. Check blocking dependencies\n4. Verify action packets have owners]
    L --> M{Resolution criteria met?}
    M -- Yes --> N[Record Lessons Learned entry\nin PRIORITIES.md]
    N --> O[Remove from Active Priorities]
    O --> P{Director confirmation needed?\nCRITICAL items only}
    P -- Yes --> Q[Post resolution for Director confirmation\nbefore final removal]
    P -- No --> K
    Q --> K
    M -- No --> R[Update item:\n- Actions Being Taken\n- Last Reviewed date\n- Post progress on referenced issues]
    R --> S{Energy allocation:\nCRITICAL items present?}
    S -- Yes --> T[Deprioritize lower-value engineering work\nConcentrate capacity on CRITICAL]
    S -- No --> K
    T --> K
    K -- All items processed --> I
```

#### Checklist

- [ ] Step 1: Read PRIORITIES.md -- if missing, create from template in this workflow description
  - Evidence: File contents loaded, active item count noted
- [ ] Step 2: If no active items, check Lessons Learned detection triggers against current engineering state
  - Scan for known trigger patterns (e.g., `in_review` pile-up, `blocked` without action packet)
  - IF trigger fires: create new priority item in PRIORITIES.md
  - Evidence: Trigger check results noted
- [ ] Step 3 (LOOP -- each active priority item, CRITICAL first):
  - 3a. Read ALL referenced issues via `GET /api/issues/{id}/heartbeat-context` and comments
  - 3b. Identify root cause status -- is the root cause being addressed or just symptoms?
  - 3c. Check all blocking dependencies -- are they tracked and owned?
  - 3d. Verify action packets -- does each action have an explicit owner and status?
  - 3e. IF resolution criteria met: record Lessons Learned entry, remove item (Director confirmation for CRITICAL)
  - 3f. IF not resolved: update Actions Being Taken, update Last Reviewed, post progress on referenced issues
  - 3g. IF CRITICAL items present: apply energy allocation rule -- flag lower-priority engineering work for deprioritization
  - Loop rule: inline checklist (priority items should be few; if > 7, escalate to Director -- too many CRITICALs is itself critical)
  - Evidence: Per-item analysis documented
- [ ] Step 4: Write updated PRIORITIES.md back to disk
  - Evidence: File updated with new Last Reviewed dates and any changes
- [ ] Step 5: Proceed to Identity and Context
  - Evidence: Handoff complete

#### Validation

- Every active priority item was analyzed in depth (not just acknowledged)
- PRIORITIES.md Last Reviewed dates updated for all items reviewed
- Progress posted on all referenced issues for active priority items
- Energy allocation rule applied when CRITICAL items present

#### Blocked/Escalation

- If more than 3 CRITICAL items exist simultaneously: escalate to Director -- too many engineering fires
- If a CRITICAL item has been active for more than 48 hours without progress: escalate to Director with full analysis
- If referenced issues are inaccessible: note in PRIORITIES.md, escalate per Escalation Protocol

#### Exit Criteria

- All active priority items analyzed and progressed
- PRIORITIES.md updated with current status
- Energy allocation applied if needed
- Handoff to Identity and Context

---

## 1. Identity and Context

- `GET /api/agents/me` -- confirm id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.
- Load instruction files in order: AGENTS.md, WORKFLOWS.md, SOUL.md, TOOLS.md.

---

## 1.5. Browser Identification (required before any browser work)

Whenever you use the browser (Playwright MCP), your very first browser action MUST be opening your **identity tab (Tab 0)** -- a custom page showing your identity and the current task. This tab MUST remain open at all times.

**Tab management procedure:**

Follow the **Browser Platform Verification Protocol** from `dspot-company-rules`. In summary:

1. Build a `data:text/html;charset=utf-8,...` identity page with your agent name ("Technical Lead"), role, the current task identifier/title/brief description, and a clickable link to the Paperclip issue URL. **Do NOT use an iframe** -- render the content directly in the page.
2. Navigate Tab 0 to that URL. Take a `browser_snapshot` to confirm the title shows "Technical Lead -- {ISSUE_ID}".
3. For ALL subsequent browser work, open a **new tab** using `mcp__playwright__browser_tabs` with `action: "new"`, then navigate within that new tab.
4. Never navigate Tab 0 away from the identity page.
5. When work is complete, close the work tab and return to Tab 0.

**Why this matters:** The board sees Tab 0 to instantly identify whose browser this is and what task is active.

---

## 2. Get Assignments

- `GET /api/agents/me/inbox-lite` for assignment list.
- Prioritize: `in_progress` first, then `todo` **sorted by priority (critical > high > medium > low)**. Skip `blocked` unless you can unblock it.
- **Active-CRITICAL gate:** When PRIORITIES.md contains any active CRITICAL item, `todo` tasks belonging to the CRITICAL item's issue subtree (parentId chain) or marked `critical` priority take precedence over non-critical, non-subtree `todo` tasks. Non-critical `todo` tasks outside the CRITICAL subtree are deferred until no CRITICAL items remain active. This gate does not block `in_progress` tasks (already committed work).
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.
- Board-assignment guard — For each issue in inbox, check if `assigneeUserId` is set (board-assigned). Board-assigned issues are always blocked per company rules.
  - IF `assigneeUserId` is set AND `assigneeAgentId` is null: issue is board-assigned — skip it (treat as blocked)
  - IF status is not already `blocked`: flag in exit comment as anomaly
  - IF `assigneeUserId` is set AND `assigneeAgentId` is also set: normal agent assignment, process normally

---

## 3. Checkout and Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409.
- Read issue context, comments, and ancestor chain before starting.

---

## 4. Technical Lead Domain Work

After checkout, determine which workflow applies to your current task. The major workflows are:

- **4a. Workload Routing / Delegation** -- Task needs to be decomposed and assigned to an engineer.
- **4b. Technical Review** -- Work product from a report needs review and approval/rejection.
- **4c. Engineering Oversight** -- Periodic check on report status, PR health, and blockers.
- **4d. Status Reporting** -- Director or board needs a technical status digest.
- **4e. Direct Technical Work** -- Rare: task requires your own hands-on work (architecture decisions, cross-team coordination).
- **4f. Board-Request Handling** -- Board-authored request detected, needs immediate triage.

If the task does not clearly map to one workflow, start with 4a (triage and route).

---

### 4a. Workflow: Workload Routing and Delegation

**Objective:** Decompose incoming work into well-defined subtasks and route them to the correct engineer with clear acceptance criteria.

**Trigger:** New task assigned to you that requires engineering work (not a review or status request).

**Preconditions:** Task checked out. Issue context and comments read. Team routing rules loaded from AGENTS.md.

**Inputs:** Source issue (id, title, description, comments, parent chain, goalId).

#### Mermaid Diagram

```mermaid
graph TD
    A([Heartbeat: new task assigned]) --> B[Read issue context + comments + parent chain]
    B --> C{Task requires your direct work?}
    C -- Yes --> D[Go to Workflow 4e: Direct Technical Work]
    C -- No --> E{Task is clear and actionable?}
    E -- No --> F[Post comment requesting clarification]
    F --> G[Set task to blocked]
    G --> Z([Exit])
    E -- Yes --> H{Single engineer or multi-engineer?}
    H -- Single --> I[Identify target engineer via routing rules]
    I --> J[Create subtask with parentId + goalId]
    J --> K[Write acceptance criteria + priority]
    K --> L[Assign to engineer]
    L --> M[Post delegation comment on parent task]
    M --> N{Engineer has capacity?}
    N -- Yes --> Z
    N -- No --> O[Check if work can wait or needs re-routing]
    O --> P{Re-route possible?}
    P -- Yes --> I
    P -- No --> Q[Escalate capacity conflict to Director]
    Q --> Z
    H -- Multi --> R[Break into separate subtasks per engineer]
    R --> S[For each subtask: create + assign + comment]
    S --> T[Post coordination comment linking all subtasks]
    T --> Z
```

#### Checklist

- [ ] **Step 1: Read context.** Read the full issue: title, description, comments, parent chain, goalId.
  - Evidence: You can summarize the task in one sentence.
- [ ] **Step 2: Determine ownership.** Does this need your direct work, or should it be delegated?
  - If direct work needed: proceed to Workflow 4e.
- [ ] **Step 3: Assess clarity.** Is the task clear enough to delegate as-is?
  - If unclear: post a comment requesting clarification, set to `blocked`, exit.
- [ ] **Step 4: Identify target engineer(s).** Apply routing rules from AGENTS.md.
  - Evidence: Named engineer(s) and reasoning in your delegation comment.
- [ ] **Step 5: Check capacity.** Does the target engineer have room in their queue?
  - Quick check: `GET /api/agents/{engineer_id}/inbox-lite` -- count `in_progress` and `todo` tasks.
  - If overloaded (3+ `in_progress`): consider re-routing or escalating.
- [ ] **Step 6: Create subtask(s).** `POST /api/issues` with `parentId` and `goalId`.
  - Include: clear title, description, acceptance criteria, priority, assignee.
  - If the task introduces a compatibility alias, transition window, staged migration, or temporary fallback surface: require the subtask or sibling cleanup packet to name the owner, define the transition window, state removal criteria, link a cleanup task, and define the validation path for retirement.
  - **Dependency decision:** Apply the Three-Way Dependency Decision Rule (Section 6). Use `parentId` for true subtask decomposition where the child is part of the parent's deliverable. If the new task will block or be blocked by a separate existing issue, do NOT model that as parent-child — instead use the `Blocked-By:` dependency edge on the blocked issue.
  - Evidence: Subtask ID(s) created.
- [ ] **Step 7: Post delegation comment.** On the parent task, note who got the work and why.
  - Format: "Delegated to {Agent Name} as {ISSUE_ID}: {brief rationale}."
- [ ] **Step 8: Verify assignment.** Confirm the subtask appears in the engineer's inbox.

#### Validation

- Subtask exists with correct parentId, goalId, assignee, and status `todo`.
- Parent task has a delegation comment with subtask link.
- Engineer's inbox includes the new subtask.

#### Blocked/Escalation

- If the task is unclear after reading all context: set to `blocked`, comment requesting clarification from the Director or task creator.
- If no engineer has capacity and the task is urgent (P0/P1): escalate to the Director with capacity data.
- If the task requires skills outside your team (design, marketing, client comms): escalate to the Director for cross-functional routing.

#### Exit Criteria

- All work items from the source task are captured as subtasks assigned to specific engineers, OR the task is being handled directly by you (Workflow 4e), OR the task is `blocked` with a clear blocker comment.

---

### 4b. Workflow: Technical Review

**Objective:** Review engineering deliverables (PRs, plans, architecture decisions, task completions) for quality, correctness, and compliance with contribution standards.

**Trigger:** A direct report requests review (comment mention, PR link posted, task status moved to `in_review`), OR you discover unreviewed work during oversight (Workflow 4c).

**Preconditions:** Deliverable exists and is accessible. You have context on what was requested (parent issue, acceptance criteria).

**Inputs:** PR link or task ID, acceptance criteria from the original subtask, contribution standards from `AGENTS.md` (`CS-1` through `CS-7`).

**External references:** Contribution standards live in `AGENTS.md`, section `Contribution Standards`.

#### Mermaid Diagram

```mermaid
graph TD
    A([Review requested or discovered]) --> B[Read original task + acceptance criteria]
    B --> B2[Post acknowledgment comment:\nreview queued + expected timeframe]
    B2 --> C[Read deliverable: PR diff, plan doc, or task output]
    C --> D{Deliverable type?}
    D -- PR --> E[Check PR: scope, branch target, commit hygiene]
    D -- Plan/Architecture --> F[Check plan: completeness, feasibility, risks]
    D -- Task completion --> G[Check task: acceptance criteria met, evidence provided]
    E --> H{PR passes checks?}
    F --> H
    G --> H
    H -- Yes --> I{Verification evidence provided?}
    I -- Yes --> J[Approve: post approval comment with summary]
    I -- No --> K[Request verification: ask for typecheck/test/build evidence]
    K --> L[Set task back to in_progress]
    L --> Z([Exit])
    H -- No --> M{Issues are blocking or advisory?}
    M -- Blocking --> N[Reject: post specific actionable feedback]
    N --> O[Set task back to in_progress with revision instructions]
    O --> Z
    M -- Advisory --> P[Approve with notes: post approval + suggestions]
    P --> Z
    J --> Q[Update parent task with review outcome]
    Q --> R{Parent task fully complete?}
    R -- Yes --> S[Mark parent task in_review + post summary]
    R -- No --> Z
    S --> Z
```

#### Checklist

- [ ] **Step 1: Retrieve context.** Read the original task that spawned this deliverable. Note acceptance criteria.
  - Evidence: Acceptance criteria list identified.
- [ ] **Step 1b: Acknowledge review receipt.** Post a brief comment on the review issue confirming the review is queued and expected timeframe.
  - Format: "Review queued. Expected completion within {estimate based on current queue depth, max 12 hours}."
  - Evidence: Acknowledgment comment posted with comment ID.
- [ ] **Step 2: Read the deliverable.** For PRs: read the diff, check branch, check commit messages. For plans: read the full document. For task completions: read the output/comments.
  - Evidence: You can describe what the deliverable contains.
- [ ] **Step 2b: Scan the full PR conversation surface before judging readiness.** For PR deliverables, review the top-level PR comments, review summaries, and inline review comments/threads.
  - Treat any unresolved reviewer ask, open thread, or still-unanswered board/user concern as blocking until it is explicitly addressed or intentionally deferred with justification.
  - Do not approve a PR or treat it as fully addressed while open PR comment/review-thread concerns remain.
  - Evidence: "no unresolved/open PR comments or review threads" or a list of blocking threads returned to the engineer.
- [ ] **Step 3: Check scope compliance.** Does the deliverable match what was asked? No scope creep, no missing requirements?
  - Evidence: Each acceptance criterion checked off or noted as missing.
- [ ] **Step 3b: Check staged-transition cleanup coverage.** If the deliverable introduces a compatibility alias, transition window, staged migration, or temporary fallback surface:
  - Verify a linked cleanup task exists in Paperclip.
  - Verify the cleanup path names an owner, defines the transition window, states removal criteria, and explains the validation path for final retirement.
  - If any of those are missing: reject the deliverable as incomplete.
  - Evidence: Cleanup task identifier linked.
- [ ] **Step 4: Check contribution standards.** Use `AGENTS.md`, section `Contribution Standards` (`CS-1` through `CS-7`). For PRs:
  - [ ] 4a. Correct branch target (PR branch from `master`, work in agent's dedicated worktree)?
  - [ ] 4b. No stray commits or unrelated changes?
  - [ ] 4c. Single commit or justified multi-commit?
  - [ ] 4d. PR description adequate?
  - [ ] 4e. For upstream PRs: no private-instance references (`CS-8`)? PR title and body are self-contained for external contributors (no `DSPA-*`, no internal URLs, no private agent IDs)?
- [ ] **Step 5: Check verification evidence.** Did the engineer run `pnpm -r typecheck && pnpm test:run && pnpm build` (or equivalent)?
  - If no evidence: request it before approving.
- [ ] **Step 5b: UI/Web Evidence Check (for frontend-touching deliverables).**
  - Does the deliverable touch frontend code, UI components, API contracts consumed by the UI, or user-visible behavior?
  - If YES: require evidence from a running browser showing the feature working.
  - Minimum approval evidence: exact route/path verified + screenshot captured with `mcp__playwright__browser_take_screenshot` + PASS/FAIL verdict on user-visible behavior.
  - `browser_snapshot` may be reviewed as additional context, but it is not a substitute for the screenshot proof.
  - If the screenshot, route/path, or PASS/FAIL verdict is missing: request it before approving. Do not approve frontend work without browser proof.
  - If the engineer is blocked on Playwright MCP or the dev server: verify the blocker is legitimate (did they try `/mcp reconnect`? Is Playwright MCP available in their tool list?). Require the task to remain `blocked` and require the blocker comment to preserve what was verified via code inspection. Do not approve the deliverable until browser validation is completed.
- [ ] **Step 5c: API documentation coverage check.** Does the deliverable add, modify, or remove API endpoints?
  - If YES: verify that the relevant API documentation surface has been updated in the PR/deliverable. If API documentation is missing or incomplete, request it before approving.
  - If NO: skip this check.
  - Evidence: API doc update confirmed in deliverable, or "no API changes"
- [ ] **Step 6: Decide outcome (with open-comment re-verification gate).**
  - **6a. Re-scan gate (BLOCKING):** Before deciding any outcome, re-scan the full PR conversation surface one final time. Enumerate ALL currently-open/unresolved comments and review threads. If ANY remain that were not present in Step 2b, add them to the blocking list. Do NOT approve while any open comment or thread remains unaddressed.
  - **6b. Decide:**
    - **Approve**: All open comments/threads confirmed resolved. Post approval comment summarizing what was reviewed and why it passes.
    - **Approve with notes**: All open comments/threads confirmed resolved. Post approval + advisory suggestions for future improvement.
    - **Reject**: Post specific, actionable feedback including any unresolved threads. Set task back to `in_progress`.
  - Evidence: `All {N} open comments/threads confirmed resolved` or list of blocking threads returned to engineer.
- [ ] **Step 6d: Work product reconciliation (for PR deliverables).** After approving a PR, trigger reconciliation to update PR state labels:
  ```bash
  curl -s -X POST \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    -H "Content-Type: application/json" \
    -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
    "$PAPERCLIP_API_URL/api/issues/{issueId}/work-products/reconcile"
  ```
  This updates PR status (open/merged/closed) and applies extension labels (Merged, Upstream PR, Upstream Merged).
  - Evidence: Reconciliation triggered (or skipped if no work products registered)
- [ ] **Step 7: Update parent task.** Post a comment on the parent task noting the review outcome.
  - If all subtasks under the parent are now complete: mark parent as `in_review` with a summary. Use `done` only for housekeeping tasks.

#### Validation

- Review comment posted on the deliverable (PR or task).
- Task status reflects the review outcome (done, in_progress, or blocked).
- Parent task updated if applicable.
- For PR deliverables: work product reconciliation triggered.

#### Blocked/Escalation

- If the deliverable reveals a design flaw that requires Director input: set to `blocked`, escalate with analysis.
- If the deliverable involves an upstream PR: remind the engineer of the upstream PR gate (board-only).
- If you cannot access the PR (permissions): escalate to the Director.

#### Exit Criteria

- Every deliverable in the review queue has a review comment and updated status. Parent tasks reflect downstream completion.

---

### 4c. Workflow: Engineering Oversight

**Objective:** Proactively monitor the health and progress of all engineering work across your direct reports. Identify stale tasks, blocked engineers, unreviewed PRs, and capacity issues.

**Trigger:** Every heartbeat (this workflow runs as a periodic check even when you have a specific assigned task).

**Preconditions:** API access to query your reports' task lists and PR status.

**Inputs:** Your direct reports' agent IDs.

#### Mermaid Diagram

```mermaid
graph LR
    A([Heartbeat oversight check]) --> B[Query each report's inbox-lite]
    B --> C{For each report:\ncount actionable tasks\ntodo + in_progress}
    C --> D{Actionable count = 0?}

    D -- Yes --> D0[BACKLOG CHECK FIRST:\nQuery backlog items for report]
    D0 --> D0a{Backlog items exist?}
    D0a -- Yes --> D0b[Promote highest-priority\nbacklog item to todo]
    D0b --> D2[Re-query report inbox-lite]
    D0a -- No --> D1[ZERO-ACTIONABLE REPAIR:\nCreate or re-route at least 1\nsmallest runnable todo task]
    D1 --> D2
    D2 --> D3{Actionable count still 0?}
    D3 -- Yes --> D4[Retry once, then escalate to Director]
    D3 -- No --> D5[Repair confirmed]

    D -- No --> BkScan[Backlog activation scan:\nquery backlog for report]
    BkScan --> BkCheck{Backlog items AND\nactionable count lte 2?}
    BkCheck -- Yes --> BkPromote[Promote highest-priority\nbacklog item to todo]
    BkCheck -- No --> E2

    D4 --> FDM[Findings Disposition Matrix:\neach finding resolved to\nfollow-up / covered / waived]
    D5 --> E2{Actionable count = 1\nAND task is in_progress?}
    BkPromote --> E2

    E2 -- Yes --> E3[PRE-ZERO BUFFER:\nQueue next smallest runnable\ntodo packet if feasible]
    E2 -- No --> F
    E3 --> F{Any task in_progress > 24h\nwithout comment?}

    F -- Yes --> G[Post check-in comment on stale task]
    F -- No --> H{Any task blocked?}
    G --> H

    H -- Yes --> I{Can you unblock it?}
    H -- No --> H2{in_review tasks\nassigned to self\nolder than 12h?}

    I -- Yes --> J[Unblock: provide info, approve, re-route]
    I -- No --> K[Escalate blocker to Director]

    J --> H2
    K --> H2

    H2 -- Yes --> H3[Force-prioritize:\ngo to Workflow 4b for oldest]
    H2 -- No --> L{Open PRs needing review?}
    H3 --> L

    L -- Yes --> M[Review PRs — go to Workflow 4b]
    L -- No --> N{Recent completions need follow-up?}
    M --> N

    N -- Yes --> O[Create or request follow-up tracking]
    N -- No --> FDM

    O --> FDM
    FDM --> P1[Post per-issue comments\non each observed issue]
    P1 --> P2[Post oversight summary\non current task]
    P2 --> Q([Continue to assigned task work])
```

#### Checklist

- [ ] **Step 1: Query report inboxes.** For each direct report, `GET /api/agents/{id}/inbox-lite`.
  - Count only `todo` + `in_progress` tasks as **actionable**. Do not count `blocked`, `backlog`, `done`, or `cancelled`.
  - Evidence: Per-report actionable count documented.
- [ ] **Step 2: Zero-actionable guard (BLOCKING).** For each report with 0 actionable tasks:
  - **P-1 priority gate:** When PRIORITIES.md contains any active CRITICAL item, the repair MUST prefer work from the CRITICAL item's issue subtree or critical-priority items. Only fall through to non-CRITICAL work if no CRITICAL-related work is available for that report.
  - **2a. Repair.** Create or re-route at least one smallest runnable `todo` task for that report before exiting this heartbeat.
    - Sources (check in this order, applying P-1 priority gate when active):
      1. Promote a `backlog` item to `todo` — query `GET /api/companies/{companyId}/issues?assigneeAgentId={reportId}&status=backlog` and promote the highest-priority item (CRITICAL-subtree items first when P-1 active)
      2. Break down an existing parent issue (prefer CRITICAL-subtree parents when P-1 active)
      3. Derive from the report's mandate
      4. Re-route a `blocked` task you can unblock
    - If no appropriate work exists after exhausting all sources: escalate to Director with evidence of empty queue.
  - **2b. Post-repair recheck (REQUIRED).** After creating/re-routing:
    - Re-query `GET /api/agents/{id}/inbox-lite`.
    - Verify the report's actionable count is now > 0.
    - If still 0 (creation failed, assignment error): retry once, then escalate to Director.
  - Evidence: Repair action listed with task ID, recheck result documented.
- [ ] **Step 2c: Pre-zero buffer.** For each report with exactly 1 actionable task AND that task is `in_progress`:
  - Queue the next smallest runnable `todo` packet for that report when feasible.
  - **P-1 priority gate:** When PRIORITIES.md contains any active CRITICAL item, the buffer packet MUST be from the CRITICAL item's issue subtree or be critical-priority. Do not buffer with non-CRITICAL work while P-1 is active.
  - Purpose: prevent the report from draining to 0 before the next manager heartbeat.
  - This is best-effort — skip if no appropriate work is available, but log the skip.
  - Evidence: Buffer task created with ID, or "no buffer: {reason}" logged.
- [ ] **Step 2d: Backlog activation scan.** For each report, query `backlog` items: `GET /api/companies/{companyId}/issues?assigneeAgentId={reportId}&status=backlog`
  - **P-1 priority gate:** When PRIORITIES.md contains any active CRITICAL item, only promote backlog items that belong to the CRITICAL item's issue subtree (parentId chain) or are themselves `critical` priority. Non-CRITICAL backlog items remain in backlog until no CRITICAL items are active.
  - If backlog items exist AND the report's actionable count is low (<=2): promote the highest-priority eligible backlog item to `todo` via `PATCH /api/issues/{id}` with `{"status": "todo"}`
  - Purpose: ensure existing backlog is consumed before creating new work from scratch — while respecting P-1 energy allocation
  - This step runs regardless of zero-actionable guard outcome — it is a general backlog health check
  - Evidence: Per-report backlog count and promotions (noting P-1 filter if active), or "no backlog items"
- [ ] **Step 3: Check for stale tasks.** Any `in_progress` task with no comment update in > 24 hours?
  - If stale: post a check-in comment asking for status.
  - **Wake/reminder protocol for waiting packets:**
    1. **Initial wake:** If a waiting packet depends on a direct report's task and that report has no `activeRun` (idle), post ONE explicit wake-up comment on the stalled task using wake-triggering agent mention syntax: `[@Agent Name](agent://<agent-uuid>)`. Do NOT use the profile link form `[Agent Name](/DSPA/agents/{slug})` — it does not trigger a heartbeat wake.
    2. **Repeated reminders (anti-spam):** If the assignee is already running (`activeRun` is set) or was recently woken, do NOT post a duplicate reminder. Post another reminder ONLY if: (a) the task is still stalled, AND (b) no reminder comment from you exists on that task within the last 2 hours.
    3. **Escalation:** If 3 reminders have been posted with no progress, escalate to Director.
- [ ] **Step 4: Check for blocked tasks.** Any task in `blocked` status?
  - If you can unblock (information, approval, re-routing): do so.
  - If not: escalate to Director with blocker details.
  - **Blocked-By review (manager oversight fallback):** For each blocked task, check if the comment contains a `Blocked-By:` line referencing another issue. If so, check the referenced blocker's status. If the blocker is `done`, post a resolution comment on the blocked issue to wake the assignee: `Blocker resolved: [DSPA-NNN](/DSPA/issues/DSPA-NNN) is now done.`
- [ ] **Step 4b: Review age gate (BLOCKING).** Query all tasks with status `in_review` where `assigneeAgentId` = self.
  - For each `in_review` task: calculate age from last status change or last comment.
  - If age > 12 hours: force-prioritize â€” immediately switch to Workflow 4b for that task before continuing oversight.
  - If multiple overdue reviews: process oldest first.
  - Evidence: List of `in_review` tasks with age and disposition, or "no overdue reviews."
- [ ] **Step 5: Check open PRs and fresh merges (with full comment enumeration).** Query GitHub for open PRs from your reports, plus any report-authored PR merged in the last 24 hours that could still receive follow-up comments.
  - For each PR, scan the full PR conversation surface: top-level PR comments, review summaries, and inline review comments/threads.
  - **Enumerate ALL open/unresolved comments and threads per PR.** List them explicitly — do not rely on summary scanning alone.
  - If any unresolved/open PR comment or review-thread concern exists, force-prioritize review/follow-up (Workflow 4b or direct re-routing) before treating the route as healthy.
  - Any PR waiting for review > 12 hours? Prioritize review (Workflow 4b).
  - Evidence: Per-PR list of open comments/threads with count and disposition, or `0 unresolved` confirmed.
- [ ] **Step 6: Check upstream PR gate compliance.** Verify no report has created an upstream PR without board authorization.
  - If violation found: escalate immediately to Director.
- [ ] **Step 6b: Check follow-up completeness.** For report-completed tasks from the last 48 hours that produced findings, audits, or review outcomes:
  - Were follow-up subtasks created for actionable items?
  - Are those follow-up tasks assigned and visible from the parent issue?
  - If follow-up is missing: create a tracked task yourself or direct the report to create it immediately.
  - Evidence: follow-up status recorded per completed task, or "no follow-up-producing completions."
- [ ] **Step 6c: Findings disposition matrix (REQUIRED).** Before posting the summary (Step 7), enumerate every actionable finding discovered during this oversight cycle. Each finding MUST resolve to exactly one of:
  1. **Follow-up issue created** — a Paperclip subtask with owner (`assigneeAgentId`), `parentId`, `goalId`, and acceptance criteria. Include the issue link.
  2. **Already covered** — an existing open issue already addresses this finding. Include the covering issue link.
  3. **Waived/deferred** — explicitly state the rationale and name the owner of the waive/defer decision.
  - Post the findings disposition matrix as part of the Step 7b summary comment.
  - Format: table with columns `Finding | Disposition | Link | Owner`.
  - A finding mentioned in prose without an explicit disposition row is incomplete work.
  - If no actionable findings were discovered: state "No actionable findings" explicitly — do not omit the matrix silently.
  - Evidence: findings disposition matrix posted with one row per finding, or "no actionable findings."
- [ ] **Step 7: Log oversight findings.**
  - **7a. Per-issue comments.** For each issue-specific observation found during oversight (stale task check-in, blocker action, capacity concern, review feedback), post a brief comment directly on THAT issue describing the finding and any action taken.
    - Evidence: Comment IDs posted on individual issues, or "no issue-specific observations."
  - **7b. Summary comment.** Post a brief summary comment on your current oversight task.
    - Format: "Oversight: {N} reports checked. {findings or 'all healthy'}. Per-issue comments posted: {count}."

#### Validation

- Every direct report's inbox was queried.
- No direct report was left at 0 actionable tasks at heartbeat exit (zero-actionable guard enforced).
- Any repair actions have corresponding post-repair rechecks documented.
- Any issues found (idle, stale, blocked, unreviewed PRs) have been actioned or escalated.
- Any recent finding-producing completions were checked for follow-up tracking.
- Every actionable finding has an explicit disposition row (follow-up issue, already-covered link, or waive/defer with rationale). No finding left as prose-only.
- Oversight findings logged.

#### Blocked/Escalation

- If a report is blocked on board action (plugin install, secret storage, credential setup): escalate to Director with exact steps needed.
- If a report's workspace or platform access is broken: create a setup task or escalate.

#### Exit Criteria

- All direct reports have active work (actionable count > 0). No report left at zero actionable tasks without escalation.
- No task is stale without a check-in.
- All blocked tasks have been actioned or escalated.
- Open PRs have been reviewed or queued for review.
- Findings disposition matrix posted with every finding resolved to an explicit outcome.

---

### 4d. Workflow: Status Reporting

**Objective:** Produce a concise, actionable technical status digest for the Director and/or board.

**Trigger:** Director requests a status update, OR a board-authored request asks for engineering status, OR periodic cadence (weekly minimum).

**Preconditions:** Oversight check (4c) completed for current heartbeat. Access to all reports' task data.

**Inputs:** Report inbox data, recent PR activity, blocker list, completed work since last report.

#### Mermaid Diagram

```mermaid
graph TD
    A([Status report triggered]) --> B[Gather data: report inboxes, recent completions, blockers]
    B --> C[Gather PR data: open, merged, review status]
    C --> D[Compile findings into structured digest]
    D --> E{Any P0/P1 blockers?}
    E -- Yes --> F[Lead with blockers -- explicit callout]
    E -- No --> G[Lead with progress summary]
    F --> H[Post status comment on requesting task or Director issue]
    G --> H
    H --> I{Board requested?}
    I -- Yes --> J[Ensure Director is tagged for visibility]
    I -- No --> K([Done])
    J --> K
```

#### Checklist

- [ ] **Step 1: Gather task data.** For each report: count of `done` (since last report), `in_progress`, `todo`, `blocked`.
  - Evidence: Per-report task counts.
- [ ] **Step 2: Gather PR data.** Open PRs, recently merged PRs, PRs awaiting review.
  - Evidence: PR list with status.
- [ ] **Step 3: Gather blockers.** All `blocked` tasks across the team, with blocker reasons.
  - Evidence: Blocker list with issue IDs and reasons.
- [ ] **Step 4: Compile digest.** Use the reporting format from SOUL.md:
  - Lead with blockers (if any P0/P1).
  - Then progress summary (completed, in-progress, upcoming).
  - Then PR status.
  - Then capacity notes (idle engineers, overloaded engineers).
- [ ] **Step 5: Post the digest.** Comment on the requesting task, or create a Director-facing issue if periodic.
  - If board-requested: ensure the Director is mentioned for visibility.

#### Validation

- Status digest posted and covers all direct reports.
- All data points are current (from this heartbeat's oversight check).
- No stale or inaccurate claims.

#### Blocked/Escalation

- If you cannot access a report's data (API error): note the gap in the digest and escalate.

#### Exit Criteria

- Status digest posted. Director and/or board can see current engineering state from the digest alone.

---

### 4e. Workflow: Direct Technical Work

**Objective:** Handle technical work that requires your personal involvement (architecture decisions, cross-team technical coordination, complex triage).

**Trigger:** Task assigned to you that cannot be delegated (requires your judgment, authority, or cross-team coordination).

**Preconditions:** You have confirmed this task cannot be delegated (Workflow 4a, Step 2).

**Inputs:** Task context, relevant codebase state, architectural constraints.

#### Mermaid Diagram

```mermaid
graph TD
    A([Task requires direct work]) --> B[Analyze the problem]
    B --> C[Make a plan: steps, risks, dependencies]
    C --> D[Post plan as task comment for Director visibility]
    D --> E[Execute the plan step by step]
    E --> F{Need engineer help for sub-parts?}
    F -- Yes --> G[Create subtask and delegate -- Workflow 4a]
    F -- No --> H{Work complete?}
    H -- No --> E
    H -- Yes --> I[Verify: run relevant checks]
    I --> J[Post completion summary on task]
    J --> K([Mark task in_review])
    G --> H
```

#### Checklist

- [ ] **Step 1: Analyze.** Understand the full scope of the problem. Read all context.
- [ ] **Step 2: Plan.** Document your approach as a task comment before executing.
- [ ] **Step 3: Execute.** Work through the plan. If sub-parts need delegation, use Workflow 4a.
- [ ] **Step 4: Verify.** Run relevant checks (typecheck, tests, build if code was touched).
- [ ] **Step 5: Report.** Post a completion summary on the task with evidence of verification.

#### Validation

- Plan posted before execution.
- Verification evidence provided.
- Task set to `in_review` with summary. Use `done` only for housekeeping tasks.

#### Blocked/Escalation

- If the work requires board authority (budget, credentials, strategic decisions): set to `blocked`, escalate to Director.

#### Exit Criteria

- Task set to `in_review` with verification evidence, or delegated sub-parts created and assigned. Use `done` only for housekeeping tasks.

---

### 4f. Workflow: Board-Request Handling

**Objective:** Ensure every board-authored request is immediately triaged, tracked, and either actioned or escalated within the current heartbeat.

**Trigger:** Board-authored request, directive, question, or complaint detected on any surface you review (task comment, PR comment, direct assignment).

**Preconditions:** Board request identified.

**Inputs:** The board request content, source location (issue ID, PR link, comment ID).

#### Mermaid Diagram

```mermaid
graph TD
    A([Board request detected]) --> B[Read and understand the request]
    B --> C{Within your authority?}
    C -- Yes --> D{Can action within this heartbeat?}
    D -- Yes --> E[Action immediately]
    E --> F[Post completion comment with evidence]
    F --> Z([Done])
    D -- No --> G[Create tracked subtask]
    G --> H[Assign to self or appropriate engineer]
    H --> I[Post acknowledgment comment on source]
    I --> Z
    C -- No --> J[Escalate to Director immediately]
    J --> K[Post escalation comment with source link]
    K --> Z
```

#### Checklist

- [ ] **Step 1: Read the request.** Understand what the board is asking for.
- [ ] **Step 2: Assess authority.** Is this within your mandate?
  - If not: escalate to Director with source link. Done.
- [ ] **Step 3: Assess timeline.** Can you action this within the current heartbeat?
  - If yes: do it now. Post evidence.
  - If no: create a tracked subtask, assign it, acknowledge receipt.
- [ ] **Step 4: Acknowledge.** Post a comment on the source confirming the request is tracked.
  - Format: "Board request received. {Action taken or plan}."

#### Validation

- Board request has a tracking artifact (comment, subtask, or completion evidence).
- Response was within the same heartbeat.

#### Blocked/Escalation

- If the request is ambiguous: post a clarification question to the Director (not directly to the board unless you are certain).
- If the request conflicts with existing priorities: escalate the conflict to the Director.

#### Exit Criteria

- Board request is actioned, tracked, or escalated. No board request goes unacknowledged.

---

## 5. Fact Extraction and Memory

1. Extract durable facts to `$AGENT_HOME/life/` (PARA structure) using `para-memory-files` skill.
2. Update `$AGENT_HOME/memory/YYYY-MM-DD.md` with timeline entries for significant events (delegation decisions, review outcomes, escalations, board requests).
3. Store team capacity observations for future routing decisions.

---

## 6. Update and Exit

- Comment on in_progress work before exiting.
- PATCH status to `blocked` with blocker details if stuck.
- If no assignments and oversight is clean, exit cleanly.
- Never leave a heartbeat without commenting on your current task state.
- **Full task accounting rule:** The final exit comment MUST list EVERY assigned task from the inbox with its disposition:
  - **Progressed:** what was done this heartbeat and what remains
  - **Deferred:** explicitly state why (time constraint, deprioritized, dependency not met)
  - **Blocked:** blocker details and who needs to act
  - **Not started:** state reason (new assignment not yet reached, lower priority)
- **Honest language rule:** Never use "all tasks addressed", "complete", or "done" in exit summaries unless tasks are literally finished (status=done) or explicitly blocked. Use precise language: "progressed", "deferred", "not started this heartbeat".
- **Dependency-aware status rule:** During inbox scanning, if a task in `todo` has an unmet dependency (waiting on another task, waiting on external input), transition it to `blocked` with explicit blocker details before proceeding with other work. No task should remain in `todo` if it cannot actually be worked on.
- **Task completion status guidance:** When your own task work is complete and ready for higher-level review, set status to `in_review` (not `done`). Use `done` only for housekeeping tasks (Workflow Issues, memory updates, internal cleanup with no deliverable). The Director or board will transition reviewed work to `done`.
- **Stale `in_review` escalation:** During inbox scanning, if any task you own has been in `in_review` for more than 12 hours with no acknowledgment from the Director (no comment or status change), post a follow-up comment tagging the Director. Do NOT change the status — leave it as `in_review`. If no response after a second 12-hour window, escalate per the Escalation Protocol (Severity 2).

### Dependency Handling Rules

#### Three-Way Dependency Decision Rule

When modeling a blocking relationship between work items, choose exactly one of these three mechanisms:

| Situation | Mechanism | How |
|-----------|-----------|-----|
| Work is a true decomposition of a larger task into smaller pieces | **Parent-child (subtask)** | Create the subtask with `parentId` set to the parent issue. The child is part of the parent's scope. |
| A separate, independently-tracked issue blocks another separate issue | **First-class issue dependency edge** | Set the blocked issue to `blocked` with a structured `Blocked-By:` line (see format below). The blocker is NOT a subtask of the blocked issue. |
| Blocker is external, human, or untracked (board action, credential, user reply, review gate) | **Plain blocked comment** | Set to `blocked` with prose explaining the blocker. Do NOT use `Blocked-By:` format — it is reserved for issue-to-issue dependencies only. |

**Decision test:** If you are about to create a subtask, ask: "Is this work a part of the parent task's deliverable?" If yes, use parent-child. If instead you are waiting on an entirely separate issue that has its own lifecycle, use a dependency edge. If the blocker has no Paperclip issue at all, use a plain blocked comment.

#### Blocked-By Format (Issue-to-Issue Dependencies)

When setting an issue to `blocked` because it depends on another issue's completion:

1. **Structured blocker line (mandatory).** The blocked comment MUST include a machine-parseable declaration on its own line:
   ```
   Blocked-By: [DSPA-NNN](/DSPA/issues/DSPA-NNN)
   ```
   Multiple blockers use comma separation:
   ```
   Blocked-By: [DSPA-111](/DSPA/issues/DSPA-111), [DSPA-222](/DSPA/issues/DSPA-222)
   ```
2. **Human-readable context (mandatory).** Below the `Blocked-By` line, explain what the blocker needs to deliver and who owns it.
3. **Scope limitation.** `Blocked-By:` is reserved for issue-to-issue dependencies only. Review waits, human-action waits, and general feedback waits use prose, NOT `Blocked-By:` format.

#### Resolution Notification (When Completing an Issue)

When you mark an issue as `done`, check whether any blocked issues reference it as a blocker:

1. Search for issues with `Blocked-By:` lines that reference the completed issue identifier.
2. If found: post a comment on each blocked issue: `Blocker resolved: [DSPA-NNN](/DSPA/issues/DSPA-NNN) is now done.`
3. This triggers a comment-based wake for the blocked issue's assignee.
4. If not found: no action needed (log "no dependents found").

---

## Technical Lead Responsibilities Summary

- **Workload balancing**: Ensure engineering agents have appropriate task queues. No idle engineers.
- **Quality gates**: Review plans and deliverables before marking done. No rubber-stamping.
- **Technical planning**: Break down complex work into actionable subtasks with clear acceptance criteria.
- **Board-request tracking**: Ensure every board request gets tracked and actioned within one heartbeat.
- **Escalation**: Surface blockers and risks to Director promptly with facts and evidence.
- **Contribution compliance**: Enforce the upstream PR gate and fork-based workflow.
- **Team advocacy**: Credit engineers when they deliver. Protect them from unclear or unbounded work.

---

## Heartbeat Loop Rules

- **Oversight (4c) runs every heartbeat**, even when you have a specific assigned task. Budget ~5 minutes for the oversight check before diving into your assigned work.
- **Board-request handling (4f) takes priority** over all other workflows. If you detect a board request during any step, pause and handle it first.
- **Status reporting (4d) runs on request or weekly minimum.** If a week has passed since your last status digest, produce one proactively.
- **Review latency target: < 12 hours.** If a report has been waiting for your review for more than 12 hours, that review jumps to top priority.
- **Maximum heartbeat without Director update: 48 hours.** If 48 hours pass without a Director-facing comment from you, produce a status update (Workflow 4d).

---

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown.
- Never look for unassigned work -- only work on what is assigned to you, plus oversight of your reports.
