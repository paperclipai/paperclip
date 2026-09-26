---
name: "source-command-spartan-memory-consolidate"
description: "Clean up .memory/ directory — deduplicate entries, remove stale info, fix contradictions, and rebuild the index. Like autoDream but on-demand."
key: "paperclipai/optional/agency-agents/source-command-spartan-memory-consolidate"
recommendedForRoles:
  - "designer"
tags:
  - "agency-agents"
  - "designer"
  - "source"
  - "command"
  - "spartan"
  - "memory"
  - "consolidate"
defaultInstall: false
---
# source-command-spartan-memory-consolidate

Use this skill when the user asks to run the migrated source command `spartan-memory-consolidate`.

## Command Template

# Memory Consolidate — Clean and Optimize Agent Memory

A scoped cleanup pass over `.memory/` that deduplicates, removes stale entries, fixes contradictions, and rebuilds the index. Keeps memory lean and accurate.

## Usage

```
/spartan:memory-consolidate              # Full cleanup
/spartan:memory-consolidate --dry-run    # Show what would change, don't apply
```

## Process

### Step 1: Inventory Current Memory

Read `.memory/index.md` and list all memory files:

```bash
ls -la .memory/
```

For each memory file:
- Read the content
- Note the type (user, feedback, project, reference)
- Note what facts it claims
- Check last modified date

### Step 2: Detect Problems

Check each memory entry for these issues:

#### 2a. Stale Entries
Verify claims against current codebase:
- File paths that no longer exist
- Features that were removed
- Decisions that were reversed
- Config values that changed

```bash
# Example: memory says "auth is in module-auth/src/auth/"
# Verify:
ls module-auth/src/auth/ 2>/dev/null || echo "PATH GONE"
```

#### 2b. Duplicates
Find entries that say the same thing:
- Same fact in different files
- Overlapping project memories
- Redundant feedback entries

#### 2c. Contradictions
Find entries that disagree:
- "Use pattern A" vs "Use pattern B" for the same thing
- Old decision contradicted by newer decision
- Project status that conflicts with current state

#### 2d. Derivable from Code
Find entries that store info already obvious from the codebase:
- File structure descriptions (just run `ls`)
- Code patterns visible in the code itself
- Git history facts (use `git log`)

These should be removed — memory is for things NOT derivable from code.

### Step 3: Present Findings

Show a report:

```markdown
## Memory Consolidation Report

**Total entries:** N files

### Stale (will remove/update)
- `memory-file.md` — [why it's stale]

### Duplicates (will merge)
- `file-a.md` + `file-b.md` — [same fact, keep file-a]

### Contradictions (will resolve)
- `file-x.md` says A, `file-y.md` says B — [which is current]

### Derivable (will remove)
- `file-z.md` — [can be derived from code/git]

### Healthy (no changes)
- `file-ok.md` — verified, still accurate
```

If `--dry-run`: stop here. Show report only.

Otherwise ask: "Apply these changes?"

### Step 4: Apply Cleanup

For each issue:

| Issue | Action |
|-------|--------|
| Stale | Update with current info, or delete if no longer relevant |
| Duplicate | Keep the better-written one, delete the other |
| Contradiction | Keep the newer/correct one, delete the outdated one |
| Derivable | Delete — the code is the source of truth |

### Step 5: Rebuild Index

Rewrite `.memory/index.md` from scratch based on remaining files:
- One line per entry, under 150 characters
- Grouped by type (user, feedback, project, reference)
- Sorted by relevance within each group

### Step 6: Summary

```markdown
## Consolidation Complete

- Removed: N entries
- Updated: N entries
- Merged: N entries
- Healthy: N entries
- Total entries now: N (was M)
```

## Scope Restriction

This command ONLY touches files inside `.memory/`. It MUST NOT:
- Edit any code files
- Edit `.planning/` files
- Edit `AGENTS.md`
- Create files outside `.memory/`
- **Delete or modify anything in `.memory/transcripts/`** — transcripts are append-only archive (Layer 3). They are never cleaned up. Only `index.md` (Layer 1) and topic files (Layer 2) are subject to consolidation.

## When to Run

- Start of a new work session (quick health check)
- After finishing a major milestone
- When memory feels cluttered or contradictory
- Monthly maintenance

## Gotchas

- **Don't delete user preferences.** Feedback memories about how the user likes to work are almost never stale. When in doubt, keep them.
- **Project memories decay fastest.** Status, deadlines, and in-progress work change weekly. These are the most likely to be stale.
- **Check git before declaring something stale.** A memory about a file that was "removed" might just be renamed. Use `git log --follow` to check.
- **The index is rebuilt, not patched.** After cleanup, regenerate the full index from scratch. Don't try to surgically update individual lines.
- **Contradictions need the NEWER truth, not the OLDER one.** Always verify which is current before picking a winner.
