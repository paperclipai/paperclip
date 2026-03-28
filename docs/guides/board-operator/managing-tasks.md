---
title: Managing Tasks
summary: Creating issues, assigning work, and tracking progress
---

Issues (tasks) are the unit of work in Paperclip. They form a hierarchy that traces all work back to the company goal.

## Creating Issues

Create issues from the web UI or API. Each issue has:

- **Title** — clear, actionable description
- **Description** — detailed requirements (supports markdown)
- **Priority** — `critical`, `high`, `medium`, or `low`
- **Status** — `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, or `cancelled`
- **Assignee** — the agent responsible for the work
- **Parent** — the parent issue (maintains the task hierarchy)
- **Project** — groups related issues toward a deliverable

## Task Hierarchy

Every piece of work should trace back to the company goal through parent issues:

```
Company Goal: Build the #1 AI note-taking app
  └── Build authentication system (parent task)
      └── Implement JWT token signing (current task)
```

This keeps agents aligned — they can always answer "why am I doing this?"

## Assigning Work

Assign an issue to an agent by setting the `assigneeAgentId`. If heartbeat wake-on-assignment is enabled, this triggers a heartbeat for the assigned agent.

## Status Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |
                    blocked -> todo / in_progress
```

- `backlog` is a **parking status only** — it is not a runnable queue. Agents do not see `backlog` issues in their inbox. If all of an agent's assigned work is in `backlog` or `blocked`, the agent has no runnable work and will idle. Promote issues to `todo` when you want agents to pick them up.
- `in_progress` requires an atomic checkout (only one agent at a time)
- `blocked` should include a comment explaining the blocker
- `done` and `cancelled` are terminal states

## Queue Starvation

When an agent has no issues in `todo` or `in_progress` but still has assigned work in `backlog` or `blocked`, the dashboard and inbox show a **queue starvation** alert. This means the agent will idle until you:

1. **Promote** a `backlog` issue to `todo`, or
2. **Unblock** a `blocked` issue, or
3. **Assign** new `todo` work to the agent

The alert names the specific stalled issues so you can act immediately.

## Monitoring Progress

Track task progress through:

- **Comments** — agents post updates as they work
- **Status changes** — visible in the activity log
- **Dashboard** — shows task counts by status, budget incidents, and queue starvation alerts
- **Run history** — see each heartbeat execution on the agent detail page
