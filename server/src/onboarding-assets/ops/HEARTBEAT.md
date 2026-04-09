# HEARTBEAT.md -- Ops Manager Review Checklist

Run this checklist on every heartbeat. Your job is to gather data, analyze it, and produce a structured report.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, companyId.
- Check `PAPERCLIP_WAKE_REASON`. Proceed with full review regardless of reason.

## 2. Gather Data

All read-only. Collect everything before analyzing.

1. `GET /api/companies/{companyId}/dashboard` -- agent counts, task counts, costs, budget utilization.
2. `GET /api/companies/{companyId}/goals` -- all goals with status.
3. `GET /api/companies/{companyId}/projects` -- all projects.
4. `GET /api/companies/{companyId}/issues?status=todo,in_progress,in_review,blocked` -- all open issues.
5. `GET /api/companies/{companyId}/issues?status=done` -- completed issues (for goal progress counts).
6. `GET /api/companies/{companyId}/agents` -- all agents with status.
7. `GET /api/companies/{companyId}/activity?limit=50` -- recent activity since last report.

## 3. Analyze

Work through each category:

- **Goal progress:** For each active goal, count linked issues by status. Calculate done/total. Flag goals with zero in_progress issues.
- **Stale tasks:** Find issues with status `in_progress` or `in_review` where `updatedAt` is older than 3 days from now.
- **Blocked work:** List issues in `blocked` status. Include their `blockedByIssueIds` and who owns the blockers.
- **Agent health:** Flag agents with status `paused` or `error`. Flag agents over 80% monthly budget utilization.
- **Unassigned work:** List issues in `todo` with no `assigneeAgentId` and no `assigneeUserId`.

## 4. Produce Report

1. Create one issue:

    POST /api/companies/{companyId}/issues
    {
      "title": "Ops Report — YYYY-MM-DD",
      "description": "Periodic operations review",
      "status": "todo"
    }

2. Check out the issue: `POST /api/issues/{issueId}/checkout`

3. Attach the report document:

    PUT /api/issues/{issueId}/documents/report
    {
      "content": "<the full report markdown>"
    }

The report must use this format:

### Report Template

    # Ops Report — YYYY-MM-DD

    ## Executive Summary
    - [2-3 bullet overview of company health]

    ## Goal Progress

    | Goal | Level | Status | Done | Total | Progress |
    |------|-------|--------|------|-------|----------|
    | [name] | [company/team/agent] | [active/planned] | [n] | [n] | [n/n] |

    Goals with no in_progress work: [list or "None"]

    ## Risks & Blockers

    **Stale tasks (no update in 3+ days):**

    | Issue | Assignee | Status | Last Updated |
    |-------|----------|--------|--------------|
    | [title] | [agent name] | [status] | [date] |

    **Blocked issues:**

    | Issue | Assignee | Blocked By |
    |-------|----------|------------|
    | [title] | [agent name] | [blocker titles and owners] |

    **Budget warnings (>80% utilization):**

    | Agent | Role | Spend | Budget | Utilization |
    |-------|------|-------|--------|-------------|
    | [name] | [role] | [amount] | [amount] | [%] |

    ## Agent Status

    | Agent | Role | Status | Active Tasks | Budget % |
    |-------|------|--------|--------------|----------|
    | [name] | [role] | [status] | [count] | [%] |

    ## Unassigned Work

    | Issue | Priority | Created |
    |-------|----------|---------|
    | [title] | [priority] | [date] |

4. Mark the report issue as done: `PATCH /api/issues/{issueId} { "status": "done" }`

## 5. Exit

- Comment on the report issue: "Ops review complete."
- Exit cleanly.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Do not create subtasks, reassign issues, or modify any issue other than your report.
- If an API call fails, note the failure in the report and continue.
