---
name: agents-md
description: Use when authoring AGENTS.md files, configuring agent-specific behavior, separating agent identity from shared project context, or designing workflow routing for Claude Code agents. Triggers on: "write an AGENTS.md", "agent config file", "agent instructions file", "what goes in AGENTS.md", "CLAUDE.md vs AGENTS.md", "agent identity", "workflow routing table", "agent manifest", "tool permissions per agent", "agent role config", "CLAUDE.md is bloated", "agent-specific rules", "declarative agent config", "agent design". NOT for: agent tool mechanics or parallel execution (use multi-agent-coordination), heartbeat/cron scheduling (use proactive-agent), MCP server configuration (use mcp-integration).
---

# AGENTS.md for Claude Code

AGENTS.md is the declarative manifest for a Claude Code agent — its identity, workflow routing, and tool access in one version-controlled file.

| Component | Purpose | Lives In |
|---|---|---|
| CLAUDE.md | Project context, shared rules, conventions | repo root or `~/.claude/` |
| AGENTS.md | Agent identity, role, workflow routing, tool access | `agents/[role]/AGENTS.md` |
| Hooks | Event-driven automation | `.claude/settings.json` |
| Skills | Reusable capabilities the agent invokes | `~/.claude/skills/` |

## Quick Setup

1. **Create** `agents/[role]/AGENTS.md` with the minimal identity block (name, role, title, capabilities, reportsTo)
2. **Add** a workflow routing table with 3+ trigger patterns mapped to named workflows
3. **Declare** tool access scoped to this agent's actual role

Bootstrap any agent type in under 10 minutes using the copy-paste templates in `references/06-templates.md`.

## What is AGENTS.md

AGENTS.md separates agent-specific configuration from shared project context. An agent's identity, routing logic, and permission boundaries travel with it — not buried in CLAUDE.md.

**Mental model:** CLAUDE.md answers "how does this project work?" AGENTS.md answers "who am I and what do I do?"

## The Split Rule: CLAUDE.md vs AGENTS.md

One rule prevents bloat: **shared project context lives in CLAUDE.md; agent-specific identity, routing, and constraints live in AGENTS.md.**

Decision table with 20 categorized examples → `references/01-split-rule.md`

## Core Structure

Every AGENTS.md has four blocks: identity (name, role, title, capabilities, reportsTo), workflow routing table, tool access declarations, and an anti-rationalization section for the agent's own mandate.

Full annotated template → `references/02-core-structure.md`

## Workflow Routing Tables

The most underused pattern. A routing table makes agent behavior explicit and auditable — trigger patterns mapped to named workflows, no ambiguity.

How to write patterns that fire reliably → `references/03-workflow-routing.md`

## Tool Access Design

Scope tools to the agent's actual role. A researcher doesn't need deploy permissions. A reviewer shouldn't write to production.

**The principle:** start with nothing. Add only what the role explicitly requires.

Tool scoping patterns by agent type → `references/04-tool-access.md`

## Composability Bridge

AGENTS.md wires agents into a team:
- Reference skills with `/skill-name` in capabilities
- Define `reportsTo` for escalation chain
- List authorized data sources
- Document sub-agent coordination patterns

Orchestrator composition patterns → `references/05-composability.md`

## Templates Gallery

Four ready-to-copy templates (Researcher, Builder, Reviewer, Orchestrator) → `references/06-templates.md`

## Anti-Patterns and Maintenance

| Anti-Pattern | Failure Mode |
|---|---|
| Instruction dump | Walls of text agents ignore at line 150+ |
| Workflow creep | Agent takes work outside its mandate |
| Permission sprawl | Overprivileged agents cause unexpected side effects |
| Missing anti-rationalization | Agent talks itself out of the hard parts |
| No data sources declared | Agent uses whatever it finds, quality undefined |
| Stale routing tables | Triggers no longer match current workflows |

Audit quarterly: Is routing table current? Does tool access match the role? Any mandate drift?

---

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "I'll just put this in CLAUDE.md, it's faster" | CLAUDE.md bloat is exactly what AGENTS.md solves. Every agent-specific rule in CLAUDE.md is a maintenance liability across every agent that reads it. |
| "My agents don't need routing tables, prose is fine" | Prose is ambiguous. Routing tables are explicit contracts. Agents skip ambiguous instructions. |
| "I'll configure tool access later" | Underconfigured access = unexpected behavior in production. Set it at creation, not after the first incident. |
| "This template is too much structure for a simple agent" | Simple agents still need identity blocks. Undefined behavior is agent drift. Structure is what keeps "simple" simple. |
| "I already have CLAUDE.md, that's enough" | CLAUDE.md can't express per-agent identity or least-privilege access. Works until you have 3+ agents with conflicting rules. |

---

## Reference Index

| File | Contents |
|------|----------|
| `references/01-split-rule.md` | Decision table: 20 examples of CLAUDE.md vs AGENTS.md |
| `references/02-core-structure.md` | Full annotated AGENTS.md template with identity block |
| `references/03-workflow-routing.md` | Routing table deep dive, 5 trigger types, reliable patterns |
| `references/04-tool-access.md` | Tool scoping by agent role, least privilege, permission anti-patterns |
| `references/05-composability.md` | Skills invocation, agent coordination, orchestrator composition |
| `references/06-templates.md` | 4 ready-to-copy templates: researcher, builder, reviewer, orchestrator |
| `references/test-cases.md` | Test scenarios (trigger + no-fire + output) |
| `references/test-log.md` | Execution results by iteration |
