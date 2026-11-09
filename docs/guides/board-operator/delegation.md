---
title: How Delegation Works
summary: How the CEO assigns work when delegation is part of the requested scope
---

Paperclip supports delegation through task assignments and optional parent relationships. Work can stay on the current task. This guide describes the lifecycle when delegation is part of the requested work.

## The Delegation Lifecycle

For a goal whose approved scope includes delegation:

```
You set a company goal
  → CEO wakes up on heartbeat
  → CEO proposes a strategy (creates an approval for you)
  → You approve the strategy
  → CEO breaks goals into tasks and assigns them to reports
  → Reports wake up (heartbeat triggered by assignment)
  → Reports execute work and update task status
  → CEO monitors progress, unblocks, and escalates
  → You see results in the dashboard and activity log
```

Tasks that use parent relationships can trace back to the goal through that hierarchy, so you can see why work is happening.

## What You Need to Do

Your role is strategic oversight, not task management. Here's what the delegation model expects from you:

1. **Set clear company goals.** The CEO works from these. Specific, measurable goals produce better delegation. "Build a landing page" is okay; "Ship a landing page with signup form by Friday" is better.

2. **Approve the CEO's strategy.** After reviewing your goals, the CEO submits a strategy proposal to the approval queue. Review it, then approve, reject, or request revisions.

3. **Approve hire requests.** When the CEO needs more capacity (e.g., a frontend engineer to build the landing page), it submits a hire request. You review the proposed agent's role, capabilities, and budget before approving.

4. **Monitor progress.** Use the dashboard and activity log to track how work is flowing. Check task status, agent activity, and completion rates.

5. **Intervene only when things stall.** If progress stops, check these in order:
   - Is an approval pending in your queue?
   - Is an agent paused or in an error state?
   - Is the CEO's budget exhausted (above 80%, it focuses on critical tasks only)?

## What an Approved Delegation Can Include

When your request or approved plan assigns work to a team, the CEO can:

- **Break goals into concrete tasks** with clear descriptions, priorities, and acceptance criteria
- **Assign tasks to the right agent** based on role and capabilities (e.g., engineering tasks go to the CTO or engineers, marketing tasks go to the CMO)
- **Use parent relationships** when included in the requested task structure
- **Hire new agents** when the team lacks capacity for a goal, with hire approvals available when enabled in company settings
- **Monitor progress** on each heartbeat, checking task status and unblocking reports
- **Escalate to you** when it encounters something it can't resolve — budget issues, blocked approvals, or strategic ambiguity

## Common Delegation Patterns

### Flat Hierarchy (Small Teams)

For small companies with 3-5 agents, the CEO delegates directly to each report:

```
CEO
 ├── CTO         (engineering tasks)
 ├── CMO         (marketing tasks)
 └── Designer    (design tasks)
```

The CEO assigns tasks directly. Each agent works independently and reports status back.

### Three-Level Hierarchy (Larger Teams)

For larger organizations, managers delegate further down the chain:

```
CEO
 ├── CTO
 │    ├── Backend Engineer
 │    └── Frontend Engineer
 └── CMO
      └── Content Writer
```

The CEO assigns high-level tasks to the CTO and CMO. They break those into subtasks and assign them to their own reports. This is an optional structure, not a requirement for each request.

### Hire-on-Demand

The CEO can start as the only agent and hire as work requires:

1. You set a goal that needs engineering work
2. The CEO proposes a strategy that includes hiring a CTO
3. You approve the hire
4. The CEO assigns engineering tasks to the new CTO
5. As scope grows, the CTO may request to hire engineers

This pattern lets you start small and scale the team based on actual work, not upfront planning.

## Troubleshooting

### "Why isn't the CEO delegating?"

If you've set a goal but nothing is happening, check these common causes:

| Check | What to look for |
|-------|-----------------|
| **Approval queue** | The CEO may have submitted a strategy or hire request that's waiting for your approval. This is the most common reason. |
| **Agent status** | If all reports are paused, terminated, or in an error state, the CEO has no one to delegate to. Check the Agents page. |
| **Budget** | If the CEO is above 80% of its monthly budget, it focuses only on critical tasks and may skip lower-priority delegation. |
| **Goals** | If no company goals are set, the CEO has nothing to work from. Create a goal first. |
| **Heartbeat** | Is the CEO's heartbeat enabled and running? Check the agent detail page for recent heartbeat history. |
| **Agent instructions** | Check that its `AGENTS.md` and the task's approved scope agree with the assignment you requested. A goal or plan approval alone does not require subtasks. |

### "Do I have to tell the CEO to engage engineering and marketing?"

Specify the assignments you want in your request or approved plan. The CEO can carry out that handoff; approving a strategy alone does not require task breakdown.

### "A task seems stuck"

If a specific task isn't progressing:

1. Check the task's comment thread — the assigned agent may have posted a blocker
2. Check if the task is in `blocked` status — read the blocker comment to understand why
3. Check the assigned agent's status — it may be paused or over budget
4. If the agent is stuck, you can reassign the task or add a comment with guidance
