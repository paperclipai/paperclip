# Workshop Brain

Shared knowledge base for the Workshop control plane. Committed to git. Every Claude Code session reads from this directory before starting work. Every session that learns something should write to it.

Workshop is the personal agent control plane forked from Paperclip AI. It orchestrates agents across companies (Lobbi today, Lobbi Card + personal projects later). Products live in their own repos — Workshop is NOT a monorepo.

## Structure

```
brain/
├── concepts/    — Durable ideas: architecture decisions, persona rosters, operating principles
├── ops/         — Timestamped event logs: setup history, incidents, weekly notes
└── README.md    — This index
```

## Pages

### Concepts
- [initial-setup.md](concepts/initial-setup.md) — Hour 1 decision log: why fork Paperclip, shallow rebrand rationale, user-scope MCP, Workshop-vs-products repo model
- [persona-roster.md](concepts/persona-roster.md) — 12-persona plan across three tiers. Hermes seeded in Hour 1. Atlas/Minerva next.
- [operating-principles.md](concepts/operating-principles.md) — Green/Yellow/Red decision authority framework. Governs what agents can do autonomously vs what needs Janis.
- [communication-style.md](concepts/communication-style.md) — WHAT/WHY/HOW/WHAT-YOU'LL-SEE teaching rule for infrastructure builds. Non-technical founder learning through the process.

### Ops
- [hour-1-log.md](ops/hour-1-log.md) — 2026-04-22 setup session: fork → install → boot → smoke test → JWT fix → MCP wire → bootstrap commit

## Rules for brain/ pages

- YAML frontmatter required: `type`, `title`, `tags`
- Summarize, don't paste. No raw transcripts or full command output.
- No secrets, tokens, or API keys — ever.
- Update existing pages instead of duplicating. Stale pages get pruned, not layered.
- When a session introduces a new repeatable process, write a skill in `skills/` (agent-facing) or `.claude/skills/` (Claude-Code-facing), not just a brain page.
