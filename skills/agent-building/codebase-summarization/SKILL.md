---
name: codebase-summarization
description: Use when developers want persistent codebase understanding, auto-generated file maps, or navigation for large repos. Triggers on: "codebase summarization", "code map", "CODEBASE.md", "file summaries", "repo map", "summarize my codebase", "map this repo", "map this codebase", "give me a map of this repo", "Claude keeps re-reading files", "context fills up with repeated reads", "agents re-read the same files", "large codebase navigation", "auto-summarize files", "codebase navigation", "file index", "persistent codebase understanding", "navigate large codebase", "codebase understanding". Also fires for: "I spend too much context re-reading", "my sessions fill up before I finish", "new to this codebase and need a map", "spending too much context on files already seen". NOT for: API docs or docs for external audiences, dependency graph generation, semantic search (requires vector DB), or one-off file explanations.
---

# Codebase Summarization & Navigation

Claude Code auto-generates a navigable codebase map using PostToolUse hooks — every file read becomes a summary entry, every session ends with an updated `CODEBASE.md` that loads next session instead of re-reading source files. Zero extra effort. No external tools. No paid APIs.

**Problem:** Without a persistent map, agents re-read the same files every session. A 30-file project burns 40% of context on content already seen last week.

## Quick Setup (3 steps)

1. **Install hook scripts** to `~/.claude/hooks/` — PostToolUse captures summaries, Stop rebuilds the index. Full scripts at `references/hooks.md`.
2. **Register hooks** in `~/.claude/settings.json` — PostToolUse matcher on Read + Stop hook. Config at `references/hooks.md`.
3. **Add `@CODEBASE.md`** to project `CLAUDE.md` — loads the map at every session start.

Work normally. `.claude/summaries/` auto-populates. Stop hook regenerates `CODEBASE.md` at session end.

## Map Format

`CODEBASE.md` loads 10-line summaries instead of full file content — 90%+ context savings on familiar codebases.

Full format spec, real example, and token/value breakdown at `references/codebase-md-format.md`.

## On-Demand Summarization

Trigger phrases that produce architectural maps mid-session:
- "give me a map of this repo"
- "summarize the [module] module"
- "show me the codebase architecture"
- "map all files that touch [concept]"

Prompt patterns and consistent output formats at `references/on-demand-summarization.md`.

## Stale Detection

The Stop hook compares source file mtime against last-summary date. Changed files are flagged `[STALE]` in `CODEBASE.md` — never silently wrong.

Detection logic and re-summarization triggers at `references/stale-detection.md`.

## Large Repos (50+ files)

The Stop hook groups summaries by directory into sections. A 100-file repo becomes 8-10 domain groups instead of a flat list.

Grouping strategy and example at `references/per-directory-groups.md`.

## Composability

- **#004 context-cost-management**: Load CODEBASE.md at session start, read source files only when you need depth. 30-50% context reduction on familiar codebases.
- **#008 structured-project-workflow**: Spec generation reads CODEBASE.md to understand existing architecture before writing implementation steps.
- **#010 self-improving-agent**: CODEBASE.md (code map) + lessons-learned.md (decision map) = complete persistent agent context.

Integration patterns at `references/composability.md`.

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "CODEBASE.md will get stale immediately" | Stop hook regenerates it every session. Stale entries are flagged, never silently wrong. |
| "PostToolUse hook will slow down file reads" | Writes a few lines to a markdown file. ~50ms per read. Invisible in practice. |
| "I'll just remember which files I read" | You won't. Context compression erases it. CODEBASE.md doesn't compress. |
| "My codebase is too large for this" | Per-directory groups handle 100+ file repos. See `references/per-directory-groups.md`. |
| "I can ask Claude to summarize when I need it" | On-demand works once. PostToolUse builds the map automatically as you work — no prompting needed. |
