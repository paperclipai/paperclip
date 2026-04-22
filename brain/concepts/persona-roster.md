---
type: concept
title: Workshop persona roster (12 agents across 3 tiers)
tags: [workshop, agents, personas, roadmap]
---

# Persona Roster

Workshop runs up to 12 named agents (Paperclip "agents") per company. Each persona is a role — one job, one accountability, one skill bundle. Personas are stable across sessions; the LLM backing them is pluggable.

This is the target roster. Hour 1 seeded only Hermes. The rest roll out in Hour 2+ as the work arrives.

## Tier 1 — Always on (seed first)

| Persona | Role | Adapter | Status |
|---------|------|---------|--------|
| **Hermes** | Orchestrator / chief of staff. Routes issues, runs the daily briefing, owns routines. | claude-code | ✅ Seeded Hour 1 |
| **Atlas** | Engineer. Implements features, ships PRs, handles dev-pipeline work. | claude-code | ⏳ Hour 2 |
| **Minerva** | Reviewer. Independent codex-style review of Atlas PRs, adversarial. | claude-code (or codex) | ⏳ Hour 2 |

## Tier 2 — On demand (seed when first job arrives)

| Persona | Role | Trigger |
|---------|------|---------|
| **Booker** | Meetings, scheduling, calendar triage | First "schedule X" request |
| **Porter** | Email / comms digest, follow-up drafting | First digest run |
| **Scout** | Research, competitive intelligence, reading & summarizing | First research brief |
| **Forge** | Design / UI work, DESIGN.md enforcement | First UI feature |
| **Vault** | Data ops, migrations, Supabase + embedded postgres hygiene | First destructive SQL |

## Tier 3 — Specialized (seed when product needs)

| Persona | Role | Trigger |
|---------|------|---------|
| **Rory** | Review responses (hotel review AI AGM) | Lobbi reviews engine live |
| **Iris** | Intelligence — comp rates, demand signals | Aggregate Intelligence API live |
| **Hunter** | Outbound / GTM — Instantly + Apollo | Outbound cadences start |
| **Ledger** | Finance / accounting — bookkeeping, runway | First monthly close |

## Naming rules

- One-word proper name. Evocative, not cute.
- Gender-neutral or mythological preferred.
- Avoid names that clash with existing tools (no "Claude", no "Copilot", no "Agent").
- Greek/Roman mythology is the house style; deviate if a name fits the role better.

## Per-persona assets

Each persona gets:
1. A Paperclip agent row (company-scoped, has an API key)
2. A skill file in `skills/<persona-name>/SKILL.md` (agent-facing — loaded into the agent's context)
3. A brain page at `brain/concepts/persona-<name>.md` once the role has non-trivial state worth persisting
4. Optional: scheduled routines (e.g., Hermes morning briefing, Porter twice-daily email digest)

## Authority level per persona

See [operating-principles.md](operating-principles.md) for the Green/Yellow/Red framework. Shorthand:

- **Tier 1 personas** operate with highest autonomy (Green/Yellow) — they are infrastructure.
- **Tier 2 personas** default to Yellow — propose, show, then execute on approval.
- **Tier 3 personas** vary — Rory auto-replies (Green after QA), Ledger never writes to prod books (Red on writes).

## Open questions

- Should Minerva be Claude Code or a different model (GPT-5 / Codex / Gemini) for true adversarial review? Lean toward different-model to catch Atlas's blindspots.
- Does Janis want one "Me" persona that can talk as him (drafts emails in his voice), or is that a mode on Porter? Default: mode on Porter for now.
