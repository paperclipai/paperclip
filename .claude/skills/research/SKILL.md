---
name: research
description: Research web articles, GitHub repos, or local files — analyze source then compare against paperclip codebase
---

# Research Source for Paperclip

Two-phase research: understand the source, then compare against paperclip to find adoptable patterns and gaps.

## Input

`/research <input> [comments]`

| Input | Detection | Action |
|-------|-----------|--------|
| `https://github.com/...` | github.com URL | Fetch README, tree, key files |
| `https://...` | Other URL | WebFetch, strip boilerplate |
| `/path/to/file` or `./file` | Local path | Read directly |
| Plain text | Everything else | WebSearch top 3-5 results |

Comments after the input steer both phases.

## Phase 1 — Understand Source

Fetch and analyze. Output:

```
## Source Analysis: <name>

What it is: [1 sentence]
Core approach: [2-3 sentences]
Key patterns: [bullet list]
Relevant to paperclip because: [1-2 sentences]
```

Stop and wait for confirmation before Phase 2.

## Phase 2 — Compare Against Paperclip

Search the codebase:

```bash
grep -r "<pattern>" server/ ui/ packages/
find . -name "*.ts" | xargs grep "<symbol>"
```

Output:

```
## Paperclip Comparison

Already have: [what paperclip does well in this area]
Gaps: [what source has that paperclip doesn't]
Adoptable: [specific patterns worth borrowing — file:line evidence required]
Skip: [patterns that don't fit paperclip's architecture]
```

## Filing Issues

For each adoptable gap:
```bash
gh issue create --title "feat(area): <pattern from research>" --body "..."
```

Only file issues tied to observed gaps with specific file:line evidence.
Do NOT file speculative issues.
