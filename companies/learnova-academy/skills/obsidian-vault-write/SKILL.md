---
schema: agentcompanies/v1
kind: skill
slug: obsidian-vault-write
name: Obsidian Vault Write
description: Conventions and helper patterns for writing markdown files into the Obsidian-friendly vault at koenig-ai-org/vault. Frontmatter format, wikilinks, tags, file paths.
version: 0.1.0
license: MIT
sources: []
---

# Obsidian Vault Write

Shared by every agent that writes narrative output to the vault: researchers, Research Editor, Content Author, Content Reviewer, CEO (decisions/retrospectives), all chiefs (team retros).

## Vault root

`/Users/vardaankoenig/Documents/Paperclip/koenig-ai-org/vault/`

## Folder structure

| Folder | Who writes | What goes there |
|---|---|---|
| `research/anthropic/` | researcher-anthropic | One file per day: `<YYYY-MM-DD>.md` |
| `research/openai/` | researcher-openai | Same |
| `research/google/` | researcher-google | Same |
| `research/community/` | researcher-community | Same |
| `research/_daily/` | research-editor | One file per day, synthesised: `<YYYY-MM-DD>.md` |
| `courses/<slug>/` | content-author + slide-audio + voice | `outline.md`, `draft.md`, chapter files, `slides.pptx`, `audio.mp3`, `voiceover-<idx>.mp3` |
| `blogs/<slug>/` | content-author | `draft.md` |
| `decisions/` | CEO + chiefs | `<task-id>-<slug>.md` — captured decisions (e.g., "why we shipped X over Y") |
| `retrospectives/<agent-slug>/` | each agent's manager | `<YYYY-MM-DD>-<task-id>.md` — 3-line after-action reviews |
| `retrospectives/_team/` | each chief | `<team>-W<n>.md` — Monday weekly retros |
| `retrospectives/_company/` | CEO | `W<n>.md` — company-level weekly retros |
| `people/` | CEO + chiefs | `<agent-slug>.md` — agent profile pages with current SOUL summary, recent retros linked |

## Frontmatter conventions

Every vault file starts with YAML frontmatter:

```yaml
---
date: YYYY-MM-DD            # always present
agent: <slug>               # who wrote this (or "team:<team>" for team docs)
type: research | course-draft | decision | retrospective | team-retro | company-retro
tags:                       # Obsidian tags
  - vendor/<vendor-id>      # for research notes
  - course/<slug>            # for course-related notes
  - decision                  # generic tag
  - retrospective
sources:                    # optional URLs for external evidence
  - <url>
---
```

## Wikilink conventions

Use Obsidian's `[[wikilink]]` format. Targets:

- `[[course/claude-tool-use-from-zero]]` — links to a course's vault folder
- `[[research/_daily/2026-04-29]]` — links to a specific daily brief
- `[[decisions/T-1234-stripe-course]]` — links to a decision file
- `[[retrospectives/researcher-anthropic/2026-04-29-T1234]]` — links to a specific retro
- `[[people/ceo]]` — links to an agent profile

When linking by slug, prefer `[[type/slug]]` over relative paths so links survive vault re-organisation.

## Tag conventions

Use `#` tags inline for filtering:

- `#vendor/anthropic` `#vendor/openai` `#vendor/google` `#vendor/community`
- `#course/<slug>` — when discussing a specific course
- `#decision` — major decision captured
- `#retrospective` — any retro
- `#hot` — HOT items in research
- `#blocked` — work that's blocked

## File naming rules

- Daily notes: `<YYYY-MM-DD>.md` (no time component)
- Decisions: `<paperclip-task-id>-<short-slug>.md` (e.g., `T1234-stripe-course-launch.md`)
- Retrospectives: `<YYYY-MM-DD>-<task-id>.md` (one per task per day)
- Course folders: `<course-slug>/` (matches `lib/fixtures.ts` slugs)
- Blog folders: `<YYYY-MM-DD>-<short-slug>/` (chronological prefix for sort order)

## Atomic writes

Use the Filesystem MCP `write_file` (or `create_file`) operation. NEVER:
- Write half a note, get interrupted, leave a partial file
- Modify someone else's vault file (each agent owns its own folders; cross-folder writes need a manager-level skill)

If you're producing a long note (>500 lines), write incrementally with append operations and frontmatter `_status: in-progress` until done.

## What NOT to put in the vault

- **API keys, secrets, .env values** — those go in Paperclip's encrypted secrets store
- **Personally identifiable information** — anonymous-session-IDs are fine; learner email addresses are not
- **Customer data** — never write Vardaan's emails / Slack messages here
- **Token logs** — Paperclip already audits these

## Cross-agent ownership rules

- **Researchers**: write only to `research/<vendor>/` (their assigned vendor)
- **Research Editor**: write only to `research/_daily/`
- **Content Author**: write to `courses/<slug>/draft.md`, `blogs/<slug>/draft.md`
- **Content Reviewer**: never writes drafts; writes review comments to Paperclip task (NOT vault)
- **Slide+Audio Producer**: writes to `courses/<slug>/slides.*`, `audio.*`
- **Voice Producer**: writes to `courses/<slug>/voiceover-*.mp3`
- **CEO**: writes to `decisions/`, `retrospectives/_company/`, `people/`
- **Chiefs**: write to `retrospectives/<their-team-agents>/`, `retrospectives/_team/`

## Reading from the vault

Use Filesystem MCP `read_file`. The vault is the agent's long-term memory across heartbeats. Use it as RAG fodder: load relevant past notes before starting a task.

## Backup

Vault is git-tracked (in `koenig-ai-org` repo). Daily backups via `scripts/backup-paperclip-db.sh`. If you accidentally clobber a note, recover from git: `git checkout HEAD~1 -- vault/path/to/file`.
