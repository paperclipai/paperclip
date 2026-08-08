---
name: "paperclip-branch-name"
description: ">"
slug: "paperclip-branch-name"
metadata:
  paperclip:
    slug: "paperclip-branch-name"
---

# Paperclip Branch Name

This is the Paperclip-native port of `tac-4/.claude/commands/generate_branch_name.md`. The tac original produced `{class}-{number}-{adw_id}-{slug}` with a parallel 8-char ADW UUID. Paperclip drops the UUID: the issue identifier (``) is already short, unique, and present in every commit, comment, branch, and run log. Two linkers is one too many.

## When to use

- A new issue is checked out and you are about to make code/doc changes.
- The plan has been accepted and implementation is starting.
- A long-lived branch needs to be reused for a follow-up (still on the same issue) — keep the branch name; do not generate a new one.

## When NOT to use

- The issue is `spike` and the deliverable is not code — no branch needed; commit the artifact (doc / decision) directly via the appropriate documentation flow.
- A child issue inherits the parent's workspace and the parent's branch is already in use — the child uses the parent branch, not a new one.
- The work is a tiny doc edit on `main` with no review path — skip the branch only when policy explicitly allows it.

## Inputs (Paperclip primitives, not files)

1. Issue identifier (e.g. ``).
2. Issue label (`bug`/`feature`/`chore`/`spike`).
3. Issue title — basis for the slug.

That's it. No `adw_id` argument. No agent name. No prefix from the repo.

## Format

```
{type}-{identifier}-{slug}
```

- `{type}` — exactly one of: `fix`, `feat`, `chore`, `refactor`, `docs`, `test`, `ci`, `build`. Map from the issue label:

  | Issue label | Branch type |
  |---|---|
  | `bug` | `fix` |
  | `feature` | `feat` |
  | `chore` | `chore` (or `refactor` / `docs` / `test` / `ci` / `build` when one of those is a strictly better fit) |
  | `spike` | rarely branches; if forced to, `chore` |

- `{identifier}` — the Paperclip issue identifier exactly as Paperclip emits it (``). Preserve case for the alphabetic prefix; the issue identifier is already canonical.

- `{slug}` — 3 to 6 lowercase words from the issue title, separated by hyphens. Rules:
  - Strip stopwords (`a`, `the`, `for`, `in`, `to`, …) only where it keeps meaning.
  - Drop punctuation, parentheses, slashes, colons.
  - Replace whitespace runs and `_` with single `-`.
  - Replace non-ASCII with closest ASCII (`naïve` → `naive`).
  - No leading or trailing hyphens; collapse runs (`--` → `-`).
  - Max 40 chars total in the slug.

Examples:

| Issue | Label | Branch |
|---|---|---|
|  "Guard null assignee in inbox-lite" | bug | `fix--null-assignee-inbox-lite` |
|  "Add labels filter to issues list endpoint" | feature | `feat--labels-filter-issues-list` |
|  "Bump @paperclipai/sdk to 0.42.0" | chore | `chore--bump-sdk-0-42-0` |
|  "Investigate cold-start latency on Cloudflare sandbox" | spike | `chore--investigate-cold-start` |

## Generating the branch

```bash
TYPE=fix
ID=
SLUG=null-assignee-inbox-lite
BRANCH="${TYPE}-${ID}-${SLUG}"

git fetch origin main
git checkout -B "$BRANCH" origin/main
```

Use `checkout -B` so a stale local branch of the same name is reset to the freshest `origin/main`. Never branch from an arbitrary local HEAD.

## Pre-flight checks

- Branch does not already exist on the remote (`git ls-remote --exit-code --heads origin "$BRANCH"`). If it does and is yours, reuse it. If it is someone else's work on the same identifier, **stop and coordinate** — do not overwrite.
- The slug does not collide with an existing branch in the repo's reserved namespace (`release/*`, `hotfix/*`, `dependabot/*`).
- The full branch name is ≤ 80 chars; trim the slug if needed.

## Anti-patterns

- **Embedding ADW UUIDs.** The Paperclip issue identifier is the linker. If you see legacy branches with UUIDs, fine — leave them alone — but do not create new ones.
- **Issue number without prefix.** `fix-42-…` collapses across companies. Use the full identifier `` so the branch is unambiguous across imports and exports.
- **Free-form slugs ("misc-cleanup", "fix-stuff").** The slug should match the work. If you can't summarize in 3–6 words, the issue is probably too broad — break it into child issues first.
- **Re-using a branch from a different issue.** One branch per issue; cross-issue branches make the issue-thread / branch / PR triple ambiguous.
- **Encoding agent name in the branch.** Agent identity lives in the run log and the commit trailer, never in the branch.
- **Hash- or date-suffixing branches.** `fix--null-assignee-20260515` and similar add no information the issue identifier doesn't already give.
