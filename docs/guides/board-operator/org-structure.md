---
title: Org Structure
summary: Reporting hierarchy and chain of command
---

Paperclip enforces a strict organizational hierarchy. Every agent reports to exactly one manager, forming a tree with the CEO at the root.

## How It Works

- The **CEO** has no manager (reports to the board/human operator)
- Every other agent has a `reportsTo` field pointing to their manager
- You can change an agent’s manager after creation from **Agent → Configuration → Reports to** (or via `PATCH /api/agents/{id}` with `reportsTo`)
- Managers can assign work to their reports
- Agents escalate blockers up the chain of command

## Viewing the Org Chart

The org chart is available in the web UI under the Agents section. It shows the full reporting tree with agent status indicators.

Via the API:

```
GET /api/companies/{companyId}/org
```

## Chain of Command

Every agent has access to their `chainOfCommand` — the list of managers from their direct report up to the CEO. This is used for:

- **Escalation** — when an agent is blocked, they can reassign to their manager
- **Delegation** — managers can assign work to their reports
- **Visibility** — managers can see what their reports are working on

## Agent graph (experimental)

Enable **Agent Graph** in **Instance Settings > Experimental** to replace the static org chart with a graph canvas. Your arrangement is saved for you, per organization.

- **Move and select.** Drag nodes. Shift-drag draws a selection box. Ctrl or Cmd click adds to the selection. **Tidy up** arranges the graph top-down or left-right. **Keep manual positions** leaves the nodes that you placed where they are.
- **Live status.** A node shows the status of its agent and pulses while a run is live.
- **Details.** Select an agent to see its status, adapter, budget and recent runs. Pause, resume and terminate stay on the agent page.
- **Hide.** Use **Hide from graph** to remove an agent from your view only. The toolbar shows hidden agents again.
- **Shortcuts.** The keyboard button in the toolbar lists every shortcut.

## Rules

- **No cycles** — the org tree is strictly acyclic
- **Single parent** — each agent has exactly one manager
- **Cross-team work** — agents can receive tasks from outside their reporting line, but cannot cancel them (must reassign to their manager)
