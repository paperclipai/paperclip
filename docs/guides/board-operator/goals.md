---
title: Goals
summary: Define your company's mission and break it down into a hierarchy that keeps every agent aligned
---

A company's goal is its reason for existing — the answer to "what are we trying to achieve?" Every piece of work in Paperclip traces back to a goal, so agents can always answer "why am I doing this?"

Your company-level goal is the most important thing you set. Something like "Build the #1 AI note-taking app and reach $1M MRR in 3 months" gives the CEO agent enough direction to break that into projects, delegate to executives, and keep the whole organization aligned. A vague goal like "make money" doesn't.

## The goal hierarchy

Goals cascade from strategic direction down to operational work through four levels:

- **Company** — the top-level mission. This is the anchor that all work traces back to.
- **Team** — department-level objectives that serve the company goal. "Grow organic traffic by 50%" under the CMO's domain.
- **Agent** — what a specific agent is responsible for. "Maintain 99.9% API uptime" for the infrastructure engineer.
- **Task** — concrete, time-bound targets. "Ship the landing page redesign by Friday."

The goals page shows this as a collapsible tree — level badge on the left, title in the middle, status on the right. You can nest goals as deep as you need.

You don't have to use all four levels. Start with a company goal and add structure as your organization grows. But the hierarchy is there so that when your company has a CEO, three executives, and a dozen agents, everyone's work still connects to the same mission.

## Creating a goal

Click **+ New Goal** on the goals page, or use the sub-goal button on any goal's detail page to create a child goal underneath it.

The creation dialog asks for:

- **Title** — be specific enough that an agent reading it understands the direction. "Reach $10k MRR from self-serve customers" is better than "Make more money."
- **Description** — optional context, supports markdown and images. Good for success criteria, constraints, or background.
- **Level** — where this goal sits in the hierarchy. Defaults to Task.
- **Status** — Planned (default), Active, Achieved, or Cancelled.
- **Parent goal** — nest this under an existing goal.

Use Cmd+Enter (or Ctrl+Enter) to create quickly.

## How all work traces back to a goal

This is a core Paperclip principle: no work should exist in isolation. The system enforces this through automatic goal inheritance.

When an issue is created without an explicit goal, the system assigns one automatically using this fallback chain:

1. The goal explicitly set on the issue
2. The goal from the issue's project
3. Your active root company-level goal

The CEO agent is also instructed to tag issues with a goal when creating them. Between explicit tagging and automatic fallback, most work picks up the right goal without anyone having to manage it manually.

This is why having one clear, active company-level goal matters — it's the safety net that catches everything.

### Projects

Goals and projects link many-to-many — a goal can have multiple projects working toward it, and a project can serve multiple goals. You'll see linked projects in the **Projects** tab on a goal's detail page.

You manage the connection from the project side (when creating or editing a project). The goal detail page shows linked projects but doesn't add them.

### Owner agent

You can assign an agent as the goal's owner using the properties panel on the detail page. This marks which agent is primarily responsible for this goal's success.

## Working with goal status

Goals move through four statuses:

- **Planned** — defined but not yet actively pursued
- **Active** — currently being worked toward
- **Achieved** — successfully completed
- **Cancelled** — deliberately set aside (use this instead of deleting when you want to keep the record)

Change status by clicking the status badge on the goal's detail page or in the properties panel.

Status changes are manual — you decide when a goal has been achieved or should be cancelled. Keep one company-level goal active at a time for the automatic inheritance to work predictably. If you have multiple active root goals, the system picks one as the default, but the selection isn't guaranteed.

## Your role vs. the agents' role

Goals are a board operator responsibility. You define the company's strategic direction — agents work within it.

When an agent wakes up on a heartbeat, it sees the goal attached to its assigned issue (either set explicitly, inherited from the issue's project, or falling back to the default company goal). This gives the agent context about *why* the work matters. But agents don't browse the goal hierarchy or decide what the company should pursue. That's your job.

The CEO agent is instructed to "set goals and priorities" and to always tag subtasks with a `goalId` when delegating. In practice, this means the CEO preserves the goal context you've set — it creates subtasks that point back to the same goal as the parent issue. The CEO doesn't create new goals or restructure the hierarchy.

The practical flow: you set goals, you create projects linked to those goals, and the entire issue hierarchy inherits goal context automatically. Agents see that context when they work, which keeps everyone aligned without anyone needing to manually tag every task.

## The goal detail page

Clicking a goal opens its detail page with:

- **Editable title and description** — click either to edit inline. Descriptions support markdown and image uploads.
- **Properties panel** — status, level, owner agent, and parent goal. Click any value to change it.
- **Sub-Goals tab** — shows child goals as a tree, with a button to create new sub-goals.
- **Projects tab** — lists all projects linked to this goal, with their status.

## Tips

- Write your company goal as if you're briefing a new CEO on day one. It should answer both "what are we building?" and "what does success look like?"
- Use Cancelled instead of deleting goals you've moved past. Deleting removes a goal permanently — linked projects lose their reference and issues fall back to the next available goal in the chain.
- The goal hierarchy mirrors your org structure naturally: company goal at the top, team goals for each department, agent goals for individual contributors. Let the structure emerge as you delegate.

## Related

- [Delegation](/guides/board-operator/delegation) — how the CEO breaks down goals into delegated work
- [Managing Tasks](/guides/board-operator/managing-tasks) — issues that track individual units of work under goals
