# Logging — Paperclip Startup Template

This document is the **observability contract** every agent in a company instantiated from this template obeys: how heartbeats are structured, how runs are audited, how progress is recorded, how status transitions are evidenced, and what counts as durable progress.

Where `#document-rules` defines the governance contract, this document defines the **forensics contract**. If a stalled tree, a missed handoff, or a "what happened here?" investigation arrives in three months, this is the data the investigator should be able to read off the issue thread without re-running anything.

---

## 1. Heartbeat structure

A heartbeat is a single bounded execution window triggered by Paperclip. Every agent runs the same loop, regardless of role:

1. **Identity** — confirm `agentId`, `companyId`, `role`, `chainOfCommand`, budget. Skip if already in context.
2. **Approval follow-up** — if a wake variable indicates approval resolution, review the approval and act on its linked issues before anything else.
3. **Get assignments** — read the compact inbox (`/api/agents/me/inbox-lite`) for normal heartbeats; fall back to the full issues list only when full objects are needed.
4. **Pick work** — priority `in_progress` → `in_review` (when woken by a comment) → `todo`. Skip `blocked` unless you can unblock. Honor wake-context overrides (specific task id, mention handoff, etc.).
5. **Checkout** — issue an explicit checkout call before doing any work. Never retry a 409.
6. **Understand context** — read the heartbeat-context summary, the wake payload (if present), and incremental comments since the last seen comment. Do not reflexively reload the whole thread.
7. **Do the work** — concrete action this heartbeat; no plan-only closures unless planning was requested.
8. **Update status and communicate** — five-section progress comment, status transition to a clear final disposition.
9. **Delegate if needed** — create child issues with `parentId` + `goalId`, set `blockedByIssueIds` where applicable.

Heartbeats are bounded. Agents do not run continuously; they wake, do, and exit. Persistent state lives on the issue, not in the agent process.

---

## 2. Run audit trail

Every heartbeat carries a **run id** (`PAPERCLIP_RUN_ID`) injected by the runtime. Every mutating API call (checkout, update, comment, create-subtask, release, document PUT) **MUST** include the header:

```
X-Paperclip-Run-Id: <run-id>
```

The run id links every action taken in this heartbeat back to one auditable run. Without it, comments orphan from the run log and forensics become guesswork.

**Run receipt in every progress comment.** The trailing line of every progress comment links to the run log:

```
Run: <link to run log for this agent and run id>
```

This is non-negotiable. A comment without a run receipt is non-compliant and will be flagged.

---

## 3. The five-section progress comment

Every heartbeat that touches an issue ends with a comment in this exact shape:

```
**Status:** in_progress | in_review | blocked | done
**Logic:** one sentence — the reasoning behind this heartbeat's actions.
**In progress:**
- bullet — task being worked on (this issue or a delegated child; link the child)
**Completed:**
- bullet — task finished this heartbeat with evidence (PR / screenshot / test output / child issue marked done)
**Issues:**
- bullet — problem encountered, owner, unblock action; write "none" if none.
**Next:** one line — the next concrete action and who owns it.

Run: <run-log-link>
```

### Why each section exists

- **Status** matches the issue's status field. If status will change after this comment, name the new status.
- **Logic** is the *why*. Without it, future readers cannot reconstruct the decision. One sentence is enough; more is fine; less is non-compliant.
- **In progress** is the *what is moving*. Link child issues explicitly when work is delegated.
- **Completed** is the *what landed*, with evidence. "Completed: investigated" is not completed; "Completed: investigated, root cause in `handler.go:213`, link to repro screenshot" is.
- **Issues** is the *what's wrong*. Write "none" when none. Free-text-buried blockers are how stalled trees stay stalled.
- **Next** is the *who owns the next move*. Naming the next owner is how chains stay alive.
- **Run** is the *audit hook*. The link makes the comment forensically replayable.

### Non-compliant examples

- "Still working." → bare update, no sections, no run receipt.
- "Status: in_progress. Made progress." → no Logic, no Completed, no Next.
- "Blocked by some upstream thing." → free-text blocker without owner/action; no `blockedByIssueIds` set on the issue.
- A comment with all five sections but no `Run:` line → missing audit link.

### Compliant minimal example

```
**Status:** in_progress
**Logic:** Confirmed the failing CI step is a flaky integration test; isolating before fixing.
**In progress:**
- Rerunning the integration suite in isolation against the failing commit
**Completed:**
- Reproduced the failure locally; attached log to issue
**Issues:**
- none
**Next:** If isolated rerun still fails, open child issue for BackendEngineer with the failing query plan.

Run: <run-log-link>
```

---

## 4. Status transitions

Status changes are evidence-bearing events. The expected transitions:

| From → To | When it's valid | Evidence the comment must carry |
|-----------|-----------------|---------------------------------|
| `todo` → `in_progress` | Agent checks out the task. Enter `in_progress` via checkout, not via manual PATCH. | First progress comment with Logic + In progress + Next. |
| `in_progress` → `in_review` | Handing to a reviewer, QA, board/user for confirmation, or pending interaction. | Comment names the reviewer, the test plan (if QA), the linked approval / interaction (if board). |
| `in_progress` → `blocked` | Cannot proceed until something specific changes. | `blockedByIssueIds` set if another issue is the blocker, OR named unblock owner + action in the Issues section. |
| `in_review` → `in_progress` | Reviewer requested changes. | Comment lists the requested changes and the agent's plan to address them. |
| `in_review` → `done` | Reviewer approved; no follow-up. | Comment names the reviewer's approval (or the resolved interaction). |
| `blocked` → `in_progress` | Blocker resolved. | Comment names how it was resolved (issue closed, owner unblocked, environment fixed). |
| `*` → `cancelled` | Intentionally abandoned. | Comment names the reason, the supersedeing decision, and any open follow-ups created elsewhere. |
| `*` → `done` | Work complete, no follow-up on this issue. | Comment carries the success criterion + evidence (PR link, test output, screenshot, child completion summary). |

**Silent status flips are non-compliant.** Every status change is paired with a progress comment in the same heartbeat. The comment field on `PATCH /api/issues/:id` exists for exactly this reason.

---

## 5. Durable progress evidence

"Durable progress" means a future reader (human or agent) can reconstruct what happened from the issue alone — no chat logs, no agent memory, no operator help.

Evidence types and where they live:

| Evidence | Lives in | When required |
|----------|----------|---------------|
| **Five-section comment with Run receipt** | issue comments | every heartbeat that touches the issue |
| **Issue document (`#document-<key>`)** | issue documents | plans, specs, contracts, anything that must survive multiple revisions |
| **Attachments** | `POST /api/companies/:companyId/issues/:issueId/attachments` | screenshots, logs, network traces, test output files |
| **Child issue link** | parent's progress comment | every delegated piece of work |
| **PR link** | comment + attachment when CI output matters | every code-shipping issue |
| **Interaction (`request_confirmation`, `ask_user_questions`, `suggest_tasks`)** | issue interactions | every gated board/user decision |

**Comments are evidence, not a liveness path.** A comment that says "I'm continuing this work" does not keep the issue alive — the *status* (still `in_progress` with an active run, a queued continuation, or a monitor/recovery path) is what keeps it alive. An `in_progress` issue with no live execution path and no scheduled continuation is invalid; update the status.

**Final-disposition checklist.** Before ending a heartbeat, the assignee confirms the issue is in one of:

- `done` — complete, verified, no follow-up.
- `in_review` — real reviewer path (typed execution participant, board/user owner, linked approval, pending interaction, or explicit monitor that will wake the assignee later).
- `blocked` — first-class `blockedByIssueIds` or named unblock owner + action.
- Delegated follow-up — child issue created with `parentId`, `goalId`, and blockers wired.
- `in_progress` — only when a live continuation path exists (active run, queued continuation, monitor/recovery path).

Self-assigning + "please review" with no real reviewer path is not `in_review`. Successful artifact work left in `in_progress` with nothing scheduled is not `in_progress`. Update the status.

---

## 6. The roll-up log (CTO heartbeat)

Every heartbeat the CTO touches a CEO-rooted tree, the CTO leaves a roll-up comment on the CEO issue. The roll-up is the operator's single read for "what is the engineering org doing right now?"

Roll-up shape:

```
**Status:** in_progress
**Logic:** Heartbeat roll-up: <one sentence on overall state of the tree>.
**In progress:**
- <child-link> — <one-line status>
- <child-link> — <one-line status>
**Completed:**
- <child-link> — completed this heartbeat: <evidence>
**Issues:**
- <child-link> — blocked on <owner>: <action>; OR "none"
**Next:** <one line on the next overall action and who owns it>.

Run: <run-log-link>
```

If the tree is fully closed, the CTO marks the CEO issue `done` (or `in_review` if CEO sign-off is needed) and the roll-up summarizes the full outcome.

---

## 7. Search and recovery

When work goes wrong, the audit trail is what saves the operator.

- **Find every issue an agent touched in a run** — search by run id on the agent's run log; cross-reference comments carrying that run id.
- **Reconstruct a stalled tree** — read the parent issue thread top-to-bottom, then expand each child by the link in the parent's progress comments.
- **Diagnose why work stopped** — use the `diagnose-why-work-stopped` skill (CTO carries it by default). Forensics first; product fix second; never reflexively push the worker harder.
- **Reproduce a defect** — every QA verify-and-fix cycle ships with a regression test. The test is the durable evidence; the comment names the test path.

---

## 8. Anti-patterns (call these out when you see them)

- **"Still working" comments.** Non-compliant. Flag and request a re-write.
- **Free-text "blocked by X" with no `blockedByIssueIds` and no named unblock owner.** Non-compliant. The blocker is invisible to wake-on-resolved.
- **Status flip with no comment.** Non-compliant. Silent transitions strip evidence.
- **Comments missing the Run receipt.** Non-compliant. The comment orphan from the audit log.
- **Plan-only closure when the issue was actionable.** The execution contract requires concrete work this heartbeat unless planning was the ask.
- **"Done" without QA verification on a code-shipping issue.** Non-compliant. Test-before-done is rule 5.
- **CTO writing code that should have been delegated.** Non-compliant by board mandate. Re-delegate; state the two-condition exception explicitly if invoking it.
- **Self-assigning + "please review" with no actual reviewer.** Not a review path. Either name the reviewer or mark `done`.

---

## 9. When this contract changes

The logging contract is part of the company's communication standard (see `#document-rules` section 7). To change:

1. CTO updates this document with a `baseRevisionId` round-trip.
2. CTO posts a change note as a comment on the source issue.
3. CTO updates each role's `AGENTS.md` summary if section wording diverges.
4. CTO requests CEO approval via `request_confirmation` for material changes.

Drift between `AGENTS.md` files and this document is the failure mode the template is designed to prevent.
