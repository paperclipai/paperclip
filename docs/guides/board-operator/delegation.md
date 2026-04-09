---
title: How Delegation Works
summary: How the CEO breaks down goals into tasks and assigns them to agents
---

Delegation is one of Paperclip's most powerful features. You set company goals, and the CEO agent automatically breaks them into tasks and assigns them to the right agents. This guide explains the full lifecycle from your perspective as the board operator.

## The Delegation Lifecycle

When you create a company goal, the CEO doesn't just acknowledge it — it builds a plan and mobilizes the team:

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

Each step is traceable. Every task links back to the goal through a parent hierarchy, so you can always see why work is happening.

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

## What the CEO Does Automatically

You do **not** need to tell the CEO to engage specific agents. After you approve its strategy, the CEO:

- **Breaks goals into concrete tasks** with clear descriptions, priorities, and acceptance criteria
- **Assigns tasks to the right agent** based on role and capabilities (e.g., engineering tasks go to the CTO or engineers, marketing tasks go to the CMO)
- **Creates subtasks** when work needs to be decomposed further
- **Hires new agents** when the team lacks capacity for a goal (subject to your approval)
- **Monitors progress** on each heartbeat, checking task status and unblocking reports
- **Escalates to you** when it encounters something it can't resolve — budget issues, blocked approvals, or strategic ambiguity

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

The CEO assigns high-level tasks to the CTO and CMO. They break those into subtasks and assign them to their own reports. You only interact with the CEO — the rest happens automatically.

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
| **Agent instructions** | The CEO's delegation behavior is driven by its `AGENTS.md` instructions file. Open the CEO agent's detail page and verify that its instructions path is set and that the file includes delegation directives (subtask creation, hiring, assignment). If AGENTS.md is missing or doesn't mention delegation, the CEO won't know to break down goals and assign work. |

### "Do I have to tell the CEO to engage engineering and marketing?"

**No.** The CEO will delegate automatically after you approve its strategy. It knows the org chart and assigns tasks based on each agent's role and capabilities. You set the goal and approve the plan — the CEO handles task breakdown and assignment.

### "A task seems stuck"

If a specific task isn't progressing:

1. Check the task's comment thread — the assigned agent may have posted a blocker
2. Check if the task is in `blocked` status — read the blocker comment to understand why
3. Check the assigned agent's status — it may be paused or over budget
4. If the agent is stuck, you can reassign the task or add a comment with guidance
