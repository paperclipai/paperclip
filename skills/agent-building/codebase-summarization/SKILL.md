---
name: codebase-summarization
description: Use when developers want persistent codebase understanding, auto-generated file maps, or navigation for large repos. Triggers on: "codebase summarization", "code map", "CODEBASE.md", "file summaries", "repo map", "summarize my codebase", "map this repo", "map this codebase", "give me a map of this repo", "Claude keeps re-reading files", "context fills up with repeated reads", "agents re-read the same files", "large codebase navigation", "auto-summarize files", "codebase navigation", "file index", "persistent codebase understanding", "navigate large codebase", "codebase understanding". Also fires for: "I spend too much context re-reading", "my sessions fill up before I finish", "new to this codebase and need a map", "spending too much context on files already seen". NOT for: API docs or docs for external audiences, dependency graph generation, semantic search (requires vector DB), or one-off file explanations.
---

# Codebase Summarization & Navigation

Without a persistent map, agents re-read the same files every session — a 30-file project burns 40% of context on content already seen last week. Claude Code auto-generates a navigable `CODEBASE.md` using PostToolUse hooks: every file read becomes a summary entry, every session end rebuilds the index. Zero extra effort. No external tools.

## Quick Setup (3 steps)

1. **Install hook scripts** to `~/.claude/hooks/` — PostToolUse captures summaries, Stop rebuilds the index. Full scripts at `references/hooks.md`.
2. **Register hooks** in `~/.claude/settings.json` — PostToolUse matcher on Read + Stop hook. Config at `references/hooks.md`.
3. **Add `@CODEBASE.md`** to project `CLAUDE.md` — loads the map at every session start.

Work normally. `.claude/summaries/` auto-populates. Stop hook regenerates `CODEBASE.md` at session end.

## Map Format

10-line summaries per file — 90%+ context savings. Full format spec at `references/codebase-md-format.md`.

## On-Demand Summarization

Trigger phrases and prompt patterns at `references/on-demand-summarization.md`.

## Stale Detection

Changed files are flagged `[STALE]` in `CODEBASE.md` — never silently wrong. Logic at `references/stale-detection.md`.

## Large Repos (50+ files)

Summaries group by directory — a 100-file repo becomes 8-10 domain sections. Strategy at `references/per-directory-groups.md`.

## Composability

Pairs with **#004 context-cost-management** (30-50% context reduction), **#008 structured-project-workflow** (architecture-aware spec generation), and **#010 self-improving-agent** (code map + decision map). Integration patterns at `references/composability.md`.

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "CODEBASE.md will get stale immediately" | Stop hook regenerates it every session. Stale entries are flagged, never silently wrong. |
| "PostToolUse hook will slow down file reads" | Writes a few lines to a markdown file. ~50ms per read. Invisible in practice. |
| "I'll just remember which files I read" | You won't. Context compression erases it. CODEBASE.md doesn't compress. |
| "My codebase is too large for this" | Per-directory groups handle 100+ file repos. See `references/per-directory-groups.md`. |
| "I can ask Claude to summarize when I need it" | On-demand works once. PostToolUse builds the map automatically as you work — no prompting needed. |
