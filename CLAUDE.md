# Paperclip — Project CLAUDE.md

Project-specific rules. Overrides personal `~/.claude/CLAUDE.md` for this repo.

## Commit format

Conventional Commits. One logical change per commit.

```
<type>(<scope>): <subject>

<body — what changed and WHY, wrapped ~72 cols. Omit for trivial commits.>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

**Rules**

- `<subject>`: imperative mood, lower-case, no trailing period, ≤ 72 chars.
- `<type>`: `feat` | `fix` | `refactor` | `perf` | `test` | `docs` | `build` | `chore`.
- `<scope>`: package or area — `db` | `shared` | `server` | `ui` | `plugins` | `adapters` | `docker`. Omit if change is cross-cutting.
- Body explains the *why*, not a restatement of the diff. Reference issue/PR numbers when relevant.
- Always end with the `Co-Authored-By` trailer above.
- Split unrelated changes into separate commits (e.g. `db` migration vs `server` route vs `ui` component).

**Examples**

```
feat(db): add plan_details sidecar table for MyHive plans
fix(server): use <= in token expiry check to avoid off-by-one
test(server): cover issue-scope budget hard-stop path
```

## MyHive board feature

Active branch: `feat/myhive-board`. Plan + overview live in `~/docs/plans/myhive-board.md`
and `~/docs/myhive-backend-overview.md`. Backend complete; frontend (`ui/src/components/hive/`) pending.
