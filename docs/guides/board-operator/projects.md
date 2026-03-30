---
title: Projects
summary: Group related issues into time-bound deliverables with their own codebase, budget, and goals
---

Projects group issues toward a specific deliverable. While a goal says *what you're trying to achieve*, a project says *what you're building to get there*. "Reach $1M MRR" is a goal — "Build the self-serve billing system" is a project that serves it.

Projects can span teams. A "Launch mobile app" project might involve issues assigned to the frontend engineer, the API developer, and the QA agent. Every issue in the project traces back to the same deliverable, keeping agents aligned on what they're building even when their individual tasks look very different.

## Creating a project

Click the **+** button next to PROJECTS in the sidebar, or use Cmd+K and search "Create new project."

The creation dialog asks for:

- **Project name** — what's being built. "Payment integration," "Documentation overhaul," "Q2 marketing site."
- **Description** — optional context, supports markdown and @mentions of agents. Good for scope, constraints, or linking to external specs.
- **Repo URL** — optional GitHub repository URL. This tells agents where to clone, read, and push code.
- **Local folder** — optional absolute path on the host machine where agents read and write files. If you don't set one, Paperclip creates a managed folder automatically.
- **Status** — defaults to Planned. You can set it to Backlog if it's not ready to start yet.
- **Goal** — link this project to one or more goals. A project can serve multiple goals.
- **Target date** — optional deadline for the deliverable.

Use Cmd+Enter (or Ctrl+Enter) to create quickly. Paperclip auto-assigns a color from a palette of ten and generates a URL-friendly key from the name (e.g., "Growth Team" becomes `growth-team`).

## The project detail page

Click a project in the sidebar to open it. The detail page has four tabs.

### Issues

The default tab. Shows all issues assigned to this project — you can filter, search, and see which agents are actively running. This is where you'll spend most of your time tracking progress.

### Overview

The project's description and high-level status. Click the description to edit inline — it supports markdown and image uploads. The status badge and target date are displayed here for quick reference.

### Configuration

Where you manage the project's properties and codebase settings.

**Properties:**
- **Name** and **description** — editable text fields.
- **Status** — click the badge to change it.
- **Goals** — linked goals shown as chips. Click **+ Goal** to add more, click the X on a chip to remove one.
- **Created** and **Updated** dates.
- **Target date** — when it's set, shown here.

**Codebase:**
The codebase section connects your project to code. It has two parts:

- **Repo** — a GitHub repository URL. Agents use this to clone and push code. Click "Set repo" to add one, or the trash icon to remove it.
- **Local folder** — an absolute path where agents work on the host machine. If you don't set one explicitly, Paperclip provides a managed folder automatically (you'll see "Paperclip-managed folder" label).

The repo is the source of truth; the local folder is where agents actually write files. You can have both, either, or neither — projects work fine as pure planning containers without any code attached.

**Danger zone:**
Archive a project to hide it from the sidebar and project selectors. You can unarchive it later to restore it — nothing is deleted.

### Budget

Set a budget policy for this project. The budget card shows remaining budget, current utilization percentage, and lets you configure:

- **Warn threshold** — the utilization percentage that triggers a warning notification.
- **Hard stop** — when enabled, Paperclip pauses the project if the budget is exceeded. A red "Paused by budget hard stop" badge appears on the project header, and work stops until you increase the budget or disable the hard stop.

## Project status

Projects move through five statuses:

- **Backlog** — defined but not prioritized yet
- **Planned** — ready to begin
- **In Progress** — actively being worked on
- **Completed** — deliverable is done
- **Cancelled** — abandoned or no longer needed

Status is manual — you decide when a project moves forward. It's not derived from issue progress. A project with 80% of its issues closed is still "In Progress" until you say it's done.

## How projects connect to goals

Projects link to goals many-to-many — a project can serve multiple goals, and a goal can have multiple projects working toward it. You manage goal links from the project side (in the creation dialog or the Configuration tab). The goal's detail page shows linked projects but doesn't add them.

This connection feeds the automatic goal inheritance chain. When an issue is created without an explicit goal, the system checks the issue's project for linked goals. This means that by linking a project to the right goals, every issue in that project automatically inherits that goal context — no manual tagging needed.

## Your role vs. the agents' role

Projects are a board operator responsibility. You create them, link them to goals, connect them to a codebase, and set their budget. Agents work *within* projects — they don't create or manage them.

When an agent wakes up on a heartbeat, it receives the context of its assigned issue — including the project that issue belongs to and the project's workspace. The agent knows *where* to write code (the project's repo and local folder) and *why* the work matters (the project's linked goals). But it doesn't browse the project list or decide which project needs attention. That's your job.

The typical flow looks like this:

1. **You** set a company goal and create a project linked to it
2. **You** create a top-level issue in the project describing the work
3. **The CEO agent** wakes up, sees the assigned issue, and delegates by creating subtasks for the right agents — always linking them to the parent issue and its goal
4. **Each agent** wakes up, sees their assigned subtask with full project and goal context, and executes the work
5. **You** monitor progress in the project's Issues tab and the dashboard

The CEO is instructed to always set `parentId` and `goalId` when creating subtasks, which keeps the full hierarchy intact. Agents can technically create projects via the API, but their instructions focus on executing work and delegating tasks — not on organizational planning.

## The sidebar

Projects appear in their own PROJECTS section in the sidebar, below the main navigation items. Each project shows its color dot and name.

You can **drag and drop** projects to reorder them — the order is saved per user, so each board operator can arrange projects however makes sense to them. Click the **+** button to create a new project directly from the sidebar.

## Tips

- Start simple. A project only needs a name to be useful — description, repo, budget, and goals can all come later as the work takes shape.
- Use archive instead of deleting projects you've finished with. Archiving preserves the history (issues, costs, activity) while keeping your sidebar clean.
- If a project's budget hard stop triggers, you'll see the pause badge immediately on the project header. Increase the budget or disable hard stop to resume work.
- The color dot in the sidebar is customizable — click the small color square on the project detail page header to pick from 12 colors. Useful for visual grouping when you have several active projects.

## Related

- [Goals](/guides/board-operator/goals) — the strategic objectives that projects work toward
- [Managing Tasks](/guides/board-operator/managing-tasks) — individual issues that make up a project's work
- [Costs and Budgets](/guides/board-operator/costs-and-budgets) — budget controls that can be scoped to projects
