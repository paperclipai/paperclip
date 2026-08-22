---
name: "paperclip-commit-message"
description: ">"
slug: "paperclip-commit-message"
metadata:
  paperclip:
    slug: "paperclip-commit-message"
---

# Paperclip Commit Message

This is the Paperclip-native port of `tac-4/.claude/commands/commit.md`. The tac original prefixed messages with agent name and issue class (e.g. `sdlc_planner: feat: …`). Paperclip uses standard conventional-commits, lets the run log carry the agent identity, and pins the issue identifier in the body so the commit is reverse-discoverable from the issue thread.

## When to use

- After completing a logical step from the plan's "Step-by-Step Tasks."
- Before pushing the branch for PR review.
- For every code, doc, config, or test change made under a Paperclip issue checkout.

## When NOT to use

- For non-code work — plans, comments, documents are not committed; they live in the issue.
- For broken / WIP states you do not intend to keep — use `git stash` or amend the previous commit if it is your own and unpushed.
- For merge / rebase commits — let git author those; do not override `--message` on them.

## Inputs (Paperclip primitives, not files)

1. The issue identifier (``) from the current checkout — available in `GET /api/issues/{id}` or the heartbeat context.
2. The label (`bug`/`feature`/`chore`/`spike`).
3. `git diff --cached` — the staged change set. Only stage files relevant to the current step.

You do not need agent name in the commit message. The Paperclip run log captures the authoring agent; the commit's `Co-Authored-By: Paperclip` line is the contractual bridge.

## Message shape

```
<type>: <subject>

<one short paragraph: what changed and why; future tense disallowed>

Refs:

Co-Authored-By: Paperclip <noreply@paperclip.ing>
```

### Subject line (first line)

- Conventional-commits prefix mapped from the issue label:

  | Issue label | Commit type |
  |---|---|
  | `bug` | `fix` |
  | `feature` | `feat` |
  | `chore` | `chore` (or `refactor` / `docs` / `style` / `build` / `ci` / `test` when those fit better) |
  | `spike` | rarely commits code; if it does, `chore` |

- Imperative mood ("add", "fix", "update"), not past tense.
- ≤ 72 characters total including the prefix; aim for ≤ 50 when possible.
- No trailing period.
- No emoji. No agent name. No issue identifier in the subject (that goes in the body footer).

Examples:

- `fix: handle null assignee in inbox-lite`
- `feat: add labels filter to issues list endpoint`
- `chore: bump @paperclipai/sdk to 0.42.0`
- `refactor: extract checkout claim into shared helper`

### Body paragraph (lines after the blank line)

- One short paragraph (1–3 sentences) on the **why**, not the what. The diff already shows the what.
- Mention any non-obvious constraint or side effect (e.g., "Migration is online; backfill defaults to null and is filled by the next nightly job.").
- Wrap at ~72 chars per line.
- Skip the body only if the change is utterly self-explanatory (typo, single-character fix). Default to including it.

### Footer

Two required trailers, in this order, separated from the body by a blank line:

```
Refs:

Co-Authored-By: Paperclip <noreply@paperclip.ing>
```

- `Refs:` — the issue identifier. Use the exact identifier string. If the commit closes the issue when merged, prefer the platform's auto-close form on the PR description (`Closes #N`), not the commit footer.
- `Co-Authored-By: Paperclip <noreply@paperclip.ing>` — **the literal string**. Do not substitute your agent name. This is the Paperclip skill's contractual marker.

## Emitting the message (heredoc pattern)

Build the message with a heredoc so newlines survive shell escaping:

```bash
git commit -m "$(cat <<'EOF'
fix: handle null assignee in inbox-lite

The inbox-lite aggregator dereferenced `assignee.urlKey` without
checking for null assignees on system-created issues, returning a
500. Guard the lookup and fall back to the createdBy display name.

Refs:

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

Stage explicit files (`git add path/to/file`), not `git add -A`, so credential files, `.env`, and stray editor backups cannot sneak in.

## Pre-commit checklist (run before staging)

- [ ] Staged diff is the change for this step only — no unrelated edits.
- [ ] No secrets, tokens, or credentials in the diff (re-grep before commit).
- [ ] No `.env`, `id_rsa`, or `*.pem` in the diff.
- [ ] Subject line is imperative, ≤ 72 chars, no trailing period.
- [ ] Body explains why, not what (or is omitted for trivial fixes).
- [ ] Footer has the exact `Refs:` identifier and the literal `Co-Authored-By: Paperclip` line.
- [ ] No `--no-verify`, no `--no-gpg-sign`, no skipping of pre-commit hooks. If a hook fails, fix it, re-stage, new commit.

## Anti-patterns

- **Hand-amending a published commit.** Once pushed, treat the commit as immutable. New problem → new commit.
- **Agent-name prefix.** `cto: feat: …` is the tac pattern. Paperclip's pattern is plain conventional-commits + the trailer.
- **Issue identifier in the subject.** Subject is for humans skimming `git log`. Identifier belongs in the footer.
- **"Various fixes."** Subjects must name a concrete change. If you cannot, the commit is too big — split it.
- **Closing the issue from the commit message.** Auto-close via the PR description (`Closes …`), not the commit footer; commits land independently of issue lifecycle.
- **Skipping hooks.** A failing pre-commit hook is a fact about your change, not a nuisance. Fix the root cause, then commit again.
