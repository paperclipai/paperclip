# Metacorp Company Handbook

## Mission

Metacorp exists solely to improve and extend **Metaclip** — our private, optimized fork of Paperclip AI. We have no external customers. All work is for internal or open-source use only.

## Organization

```
Board
 └── CEO | Steve — strategic direction, board liaison, cross-cutting decisions
      └── CTO | Gabriel — technical direction, engineering oversight, branch management
           └── Internal Affairs Lead — routine monitoring, operational dashboards, escalation coordination
           └── UX | Maya — design system, UI/UX improvements
```

- Engineering agents report to the **CTO**
- The CTO reports to the **CEO**
- Board approval is required for any merge to `master`

## Governance Rules

### Must Do

1. **Develop on feature branches only.** Never commit directly to `master`.
2. **Get board approval before merging.** All merges to `master` require explicit board approval via a Paperclip approval request.
3. **Cherry-pick intentionally from upstream.** Review changes first, then selectively apply what is relevant.
4. **Coordinate with your commanding officer before implementing.** Ideacraft and research are autonomous; implementation requires CTO sign-off.

### Must Never Do

- **Never push directly to `master`** without board approval.
- **Never sync or rebase directly from upstream.** Monitor it; cherry-pick selectively.
- **Never modify the running Metaclip instance** at `~/Projects/Metaclip_Dev/Metaclip`. It is the live environment — treat it as read-only.
- **Never start implementation without commanding officer approval.**
- **Never build features for external customers.**

### Server Restart Authorization

Only the **CTO** and **Internal Affairs Lead** may restart the Metaclip server for operational purposes. Requirements:

1. Document the restart reason in the related issue comment
2. Ensure no active runs are in progress that could be disrupted
3. Link to the approval or task that justifies the restart

## Development Workflow

```
1. Identify a task or improvement idea
2. Research / ideacraft (autonomous OK)
3. Summarize findings → report to CTO
4. CTO approves direction (required before coding)
5. Create feature branch: git checkout -b feature/<name>
6. Develop & test on branch
7. Open PR → request board approval in Paperclip
8. Board approves → merge to master
```

## Commit Convention

Every commit must include:

```
Co-Authored-By: Paperclip <noreply@paperclip.ing>
```

## Merge Approval Flow

Before merging any feature branch to `master`, request board approval via a `merge_code` approval request (see AGENTS.md for full procedure).

## Communication Cadence

### Routines

| Routine | Schedule | Owner |
|---------|----------|-------|
| Ops: Server health check | Every 15 min | CTO |
| QA: Weekly test suite run | Weekly Mon 10:00 UTC | CTO |
| Skills: Weekly scan and review | Weekly Mon 09:00 UTC | CTO |
| Upstream Paperclip monitoring | Weekly Mon 09:00 UTC | CTO |

### Issue-Driven Communication

All status updates, blockers, and decisions flow through **Paperclip issues** — not DMs or email. Each heartbeat follows: check inbox → pick work → execute → update status + comment.

### Escalation Path

```
Agent → CTO → CEO → Board
```

Blocked tasks must be marked `blocked` with a comment explaining the blocker and who needs to act.

### All-Hands Sync

Ad-hoc. We are a small team and issue-driven communication through Paperclip is sufficient. Trigger an all-hands for major milestones or blockers, not on a fixed schedule.

## Key Repositories

| Role | URL |
|------|-----|
| Upstream reference (read-only) | https://github.com/paperclipai/paperclip |
| Our fork (active development) | https://github.com/nrdnfjrdio/Metaclip |
| Local running instance | `~/Projects/Metaclip_Dev/Metaclip` |

## Issue Discipline

- **Description field** — clean task description only. No diagnostics, no reasoning, no debugging notes.
- **Comments** — all status updates, blockers, diagnostics, and reasoning go in issue comments.
- **Ticket references** — wrap issue identifiers in Markdown links: `[META-11](/META/issues/META-11)`

## Routine Operations

The Internal Affairs Lead monitors routine failures and escalates to the CTO when fixes are needed. See the Ops: Server health check routine for automated health monitoring.