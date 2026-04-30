---
name: github-pr-flow
description: >
  Shared engineering skill for branch + PR + review hygiene. Used by Planner
  (read-only via gh pr view), Executor (open + push), Code Reviewer (gh pr
  review). Captures conventions for branch names, commit messages, PR titles,
  and merge rules in this monorepo.
---

# GitHub PR Flow

The shared skill the harness team relies on. Read once; apply everywhere.

## Scope

- Branch + PR conventions for `learnovaBeast` and `koenig-ai-org` repos
- Commit message format
- PR title + body templates
- Merge rules + branch protection

## Branch naming

`<ticket-id-prefix>/<short-slug>`

Examples:
- `koe-123/extract-format-time` (Executor on engineering ticket)
- `chore/llms-txt-regen-2026-04-30` (SEO regen)
- `release/2026-04-30-academy-mvp` (release branch)

Always feature branches off `main`. Never push to `main` directly.

For Academy work in learnovaBeast, branch off `academy/main`, not `main`. Promote to `academy/main` only after gates pass.

## Commit messages (Conventional Commits)

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `style`, `perf`, `build`, `ci`

Examples:
- `feat(academy): add SkillGraph component to lesson page`
- `fix(format): handle undefined input in formatLessonTime`
- `chore(seo): regen llms.txt for W17 publishes`
- `docs(agents): add SOUL.md for content-author`

## PR title

`[KOE-<id>] <plan title>` for engineering tickets.

`<type>(<scope>): <subject>` for non-ticket work (e.g., `chore(seo): regen llms.txt`).

## PR body template

```markdown
## Plan
- Vault: `vault/decisions/<ticket-id>-plan.md`
- Steps completed: 1 ✓ 2 ✓ 3 ✓ 4 ✓ 5 ✓

## Verification
- Local tests: `<N>/<N>` ✓
- Typecheck: ✓
- Lint: ✓

## Risks
<from plan>

## How to verify
<from plan's Verification section>

## Closes
KOE-<id>
```

## Opening a PR

```bash
git push -u origin <branch>
gh pr create \
  --base academy/main \  # or main, depending on repo
  --title "[KOE-<id>] <plan title>" \
  --body "$(cat /tmp/pr-body.md)"
```

## Reviewing a PR

```bash
gh pr checkout <PR>
pnpm install
pnpm test
gh pr review <PR> --approve --body "..."   # or --request-changes
```

## Merge rules

- 1 G_code APPROVE required (Code Reviewer)
- 1 G2 PASS required (QA Verifier — runs after G_code)
- All CI checks green
- No unresolved review comments
- Use **squash merge** by default (preserves harness audit trail in main)

```bash
gh pr merge <PR> --squash --delete-branch
```

## When CI is red

Use the `prcheckloop` skill (referenced from upstream Paperclip skills) to iteratively get checks green. Don't merge without all checks green.

## Output

Branch + PR + (post-merge) tag if release.

## Notes

- Never `--no-verify` unless explicitly authorized by Vardaan + plan
- Never force-push (`--force-with-lease` is OK for your own branch; never on main)
- Never delete branches that aren't merged
- Use `gh pr view --json` for programmatic reads; never scrape the web UI

## Escalation

- CI consistently flaky → chief-engineering (stability investigation)
- Branch protection blocking a merge that should be allowed → chief-engineering
- Required check missing → check `.github/workflows/`; if config issue, fix it
