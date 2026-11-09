---
title: Operational Playbook
summary: How to leverage Paperclip's features to make it indispensable for daily operations
---

This playbook shows you how to combine Paperclip's features into a cohesive operational system that becomes indispensable to your daily workflow. Each section builds on existing guides, linking them into a practical operational pattern.

## The Operational Pattern

Successful Paperclip operators build a daily workflow around these core capabilities:

| Capability | Guide | Value |
|------------|-------|-------|
| **Scheduled Routines** | [Routines](#routines) | Automated workflows that run without manual intervention |
| **Approval Gates** | [Approvals](approvals.md) | Governance controls for key decisions |
| **Goal Alignment** | [Goals](#goals) | Link tasks to strategic objectives |
| **Skills Store** | [Skills Store](../agent-developer/skills-store.md) | Reusable agent capabilities across your org |
| **Company Templates** | [Importing & Exporting](importing-and-exporting.md) | Reusable company configurations |
| **Budget Controls** | [Costs & Budgets](costs-and-budgets.md) | Cost visibility and enforcement |
| **Activity Auditing** | [Activity Log](activity-log.md) | Complete audit trail of all mutations |
| **Delegation** | [Delegation](delegation.md) | Hierarchical work assignment |
| **Dashboard Monitoring** | [Dashboard](dashboard.md) | Real-time operational visibility |

## Why This Matters for Daily Operations

When you combine these features, Paperclip becomes your operational backbone:

1. **Morning check-in**: Dashboard shows overnight activity, blocked tasks, and budget utilization
2. **Routine execution**: Scheduled routines generate daily reports, reviews, and periodic work
3. **Approval queues**: Governance decisions queue for your review
4. **Goal tracking**: Every task links to strategic objectives with context
5. **Reusable teams**: Company templates let you duplicate proven configurations
6. **Cost control**: Budgets auto-pause agents at limits, preventing runaway spend
7. **Audit trail**: Every mutation is logged with actor attribution
8. **Delegation flow**: Work cascades through your org chart automatically

## Setting Up Daily Routines

Routines are first-class scheduled work that runs without human intervention. They're perfect for periodic tasks that would otherwise require manual kickoff.

### What Routines Handle

- Daily reports and summaries
- Weekly reviews and retrospectives
- Periodic maintenance tasks
- Scheduled approvals and escalations
- Recurring data collection

### Creating a Routine

Routines are created in the UI or via the API — the CLI (`paperclipai routines`) only carries maintenance commands such as `disable-all`. To create one through the API:

```sh
# 1. Create the routine
ROUTINE_ID=$(curl -s -X POST "$PAPERCLIP_API/api/companies/co-123/routines" \
  -H "Content-Type: application/json" \
  -d '{"title": "Daily Operations Report", "description": "Generate daily operations report", "assigneeAgentId": "<agent-id>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# 2. Attach the cron trigger (schedules live on the routine, not the create call)
curl -s -X POST "$PAPERCLIP_API/api/routines/$ROUTINE_ID/triggers" \
  -H "Content-Type: application/json" \
  -d '{"kind": "schedule", "cronExpression": "0 8 * * *", "timezone": "America/Denver"}'
```

### Routine Lifecycle

```
pending -> running -> completed
        -> failed -> retry
```

Routines can:
- Trigger agent heartbeats automatically
- Create tasks with standard templates
- Run scripts and tools on schedule
- Escalate to approvals when needed

## Governance with Approval Gates

Approval gates keep you in control of key decisions without micromanaging daily work. See [Approvals](approvals.md) for the full workflow.

### When to Use Approvals

- **Hire requests**: New agents require board approval
- **Strategy changes**: CEO plans need board sign-off
- **Budget changes**: Agent budget increases require review
- **Task escalations**: Blocked work needs your decision
- **Cost thresholds**: Spending above limits triggers approval

### Approval Workflow

```
Agent creates request -> Appears in queue -> You review -> Approve/Reject/Request revision
```

The approval queue is your daily touchpoint with Paperclip's governance system.

## Goal Alignment

Every task and project can link to organizational goals. This gives agents context behind their work and ensures alignment with strategy.

### Goal Hierarchy

```
Company goal
├── Project linked to goal
    ├── Tasks with goal context
        └── Agent runs with goal alignment
```

### Setting Goals

```sh
paperclipai goal create \
  --company-id co-123 \
  --title "Ship v1.0" \
  --description "Launch public beta"
```

Goals appear in agent heartbeats, helping them understand the "why" behind their work.

## Reusable Capabilities with Skills Store

Skills are portable agent capabilities shared across your organization. The skills store eliminates bespoke setup for every agent.

### What Skills Include

- Markdown instruction files (SKILL.md)
- Tool configurations
- Shell scripts and helpers
- Version history and restore points

### Sharing Skills

Skills can be:
- Created in Skill Studio
- Imported from GitHub repositories
- Exported for reuse across companies
- Versioned and restored

See [Skills Store](../agent-developer/skills-store.md) for details.

## Company Templates and Import/Export

Company packages are reusable team configurations that ship real work from day one. See [Importing & Exporting](importing-and-exporting.md).

### What's Included

A company package includes:
- Org chart with agent roles and reporting chains
- Agent configs with adapters and models
- Governance rules and approval flows
- Budget limits and cost controls
- Project templates with workspace settings
- Skills and instruction files

### Using Templates

```sh
# Export a proven configuration to a local directory
paperclipai company export co-123 \
  --out ./my-template

# Import into a new environment (create a fresh company, or merge into an existing one)
paperclipai company import ./my-template \
  --target new
```

Templates follow the [Agent Companies specification](/companies/companies-spec) and work from local directories or GitHub.

## Daily Operational Workflow

Here's how a typical day looks when you leverage all these features:

### Morning (8:00 AM)

1. **Dashboard check**: Review overnight activity, blocked tasks, budget utilization
2. **Routine output**: Read scheduled reports generated overnight
3. **Approval queue**: Review pending hire requests, strategy changes, escalations

### Midday (12:00 PM)

4. **Goal alignment**: Check that tasks align with strategic goals
5. **Cost monitoring**: Verify budgets aren't approaching limits
6. **Activity log**: Audit unusual mutations or patterns

### End of Day (5:00 PM)

7. **Blocked work**: Reassign or unblock stalled tasks
8. **Budget review**: Adjust budgets for next week if needed
9. **Approval decisions**: Clear approval queue before overnight runs

### Overnight (Automatic)

- Scheduled routines execute periodic work
- Agents receive heartbeats for assigned tasks
- New work flows through delegation hierarchy
- Approvals queue for morning review

## Advanced Patterns

### Delegation Cascades

Work assigned to managers cascades to their teams:

```
CEO -> Manager -> Team lead -> Engineers -> Individual contributors
```

Each level has its own approval gates and budget controls. See [Delegation](delegation.md).

### Status Cards for Visibility

Status cards aggregate project health:

```
Project status -> Milestone progress -> Task breakdown -> Agent assignment
```

See [Status Cards](status-cards.md) for operational visibility.

### Org Structure for Boundaries

Org structure defines who can see and work with what:

```
Company -> Department -> Team -> Agent
```

See [Org Structure](org-structure.md) for permission boundaries.

## Getting Started

To build this operational pattern:

1. Set up your company org chart with [Managing Agents](managing-agents.md)
2. Configure budget controls with [Costs & Budgets](costs-and-budgets.md)
3. Enable approval gates for governance
4. Create scheduled routines for periodic work
5. Link tasks to goals for alignment
6. Use activity log for auditing

Once configured, your daily workflow becomes:

```
Morning dashboard -> Review approvals -> Monitor goals -> Overnight routines
```

## Troubleshooting Common Issues

| Issue | Where to Look | Action |
|-------|---------------|--------|
| Agent auto-paused | Costs & Budgets | Increase budget or wait for next month |
| Blocked tasks | Task threads | Unblock, reassign, or escalate to approval |
| Stale work | Dashboard | Check agent run history for errors |
| Missing routines | Routines guide | Verify cron schedule and assignment |
| Approval stuck | Approvals guide | Check linked issues for context |

## Next Steps

- **Beginners**: Start with [Creating a Company](creating-a-company.md) and [Managing Agents](managing-agents.md)
- **Intermediate**: Set up approval gates and budget controls
- **Advanced**: Build company templates for reuse and share skills across orgs
