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

Enable **Agent Graph** in **Instance Settings > Experimental** to replace the static org chart with an editable canvas. Your arrangement is saved for you, per organization.

- **Move and select.** Drag nodes. Shift-drag draws a selection box. Ctrl or Cmd click adds to the selection. **Tidy up** arranges the graph top-down or left-right. **Keep manual positions** leaves the nodes that you placed where they are.
- **Notes.** **Add note** places a sticky note. Notes are visual only.
- **Details.** Select an agent to see its status, adapter, budget and recent runs. Pause, resume and terminate stay on the agent page.
- **Copy, paste and duplicate.** A pasted agent is a **hire draft**, not an agent. **Request hire** on the draft asks for confirmation and then starts the normal hiring flow, including board approval when your organization requires it. A draft copies the name, role, title, capabilities, adapter type and model. It does not copy budget, credentials, environment variables, instructions or permissions.
- **Reporting lines.** Drag from a manager to an agent, or drag the manager end of a line to another agent. Paperclip checks for cycles, asks for confirmation, and applies your permissions.
- **Delete.** Delete removes notes and drafts. It never removes an agent. Use **Hide from graph** to remove an agent from your view only.
- **Undo and redo.** Ctrl or Cmd Z, and Ctrl or Cmd Shift Z. The keyboard button in the toolbar lists every shortcut.

## Rules

- **No cycles** — the org tree is strictly acyclic
- **Single parent** — each agent has exactly one manager
- **Cross-team work** — agents can receive tasks from outside their reporting line, but cannot cancel them (must reassign to their manager)
