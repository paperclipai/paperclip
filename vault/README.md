# Obsidian Vault — Koenig AI Org

This is an **Obsidian-friendly markdown vault**. Open the `koenig-ai-org` folder as a vault in Obsidian to browse / search / link.

## Layout

| Folder | What goes here |
|---|---|
| `research/anthropic/` | Daily Anthropic research notes (one file per date, e.g. `2026-04-29.md`) |
| `research/openai/` | OpenAI dailies |
| `research/google/` | Google AI dailies |
| `research/community/` | Reddit / HN / X dailies |
| `research/_daily/` | Research Editor's synthesized daily brief |
| `courses/<slug>/` | Course outlines + drafts (pre-publish) |
| `decisions/` | Agent-made + human-approved decisions log |
| `retrospectives/` | Weekly reviews (CEO writes Mondays 09:00 IST) |
| `people/` | Agent profile pages (linked via `[[CEO]]`, `[[Chief Research]]`, etc.) |

## Conventions

- **Frontmatter** on every file: `title`, `date`, `agent`, `tags`, `sources`
- **Tags**: `#vendor/anthropic`, `#vendor/openai`, `#decision`, `#retrospective`, `#course-draft`
- **Wikilinks** liberally: `[[CEO]]`, `[[Chief Research]]`, `[[2026-04-29 Anthropic]]`
- One file per logical unit (one date's research, one course draft, one decision)
- Don't put secrets here. `.env` only.

## Why a vault and not just a database?

Two reasons:
1. **Human-readable.** Vardaan opens Obsidian, browses, follows links. No app required.
2. **AI-readable.** Agents query the vault via the `obsidian-vault` adapter; pgvector / Convex vector index over vault gives RAG to the AI tutor + Research Editor + Content Reviewer.

Structured DB writes (Convex `agentRuns`, `auditLogs`, course tables) happen in addition to vault writes — never instead.
