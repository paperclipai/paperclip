# CLAUDE.md — paperclip-latest-20260512

> This is the generic development template. For non-dev projects, consider using
> a scenario-specific template instead: `routic init --guided --type <web|design|pm|data|dev>`.

Import the shared agent brief from `AGENTS.md`.

## Project Memory

- Working order & entry points: `docs/项目计划/README.md`
- Requirements (incl. open questions & residual risks): `docs/项目计划/01.项目需求说明.md`
- Task queue, acceptance criteria, rules: `docs/项目计划/00.项目任务清单.md` (per-task verification evidence lives in `docs/项目计划/执行/*.md`)
- External tooling / forensics playbook: `docs/项目计划/最佳实践/012-实践-回形针外部开发工具与排障流水线.md`
- AI DB scaffolding (orchestration tables + column snapshot): `docs/项目计划/最佳实践/013-实践-编排平面AI查数据脚手架.md`, `docs/项目计划/执行/orchestration-schema-snapshot.json`

## How To Work

1. Read `docs/项目计划/README.md` first.
2. Read `docs/项目计划/01.项目需求说明.md` before changing product behavior.
3. Read `docs/项目计划/00.项目任务清单.md` before starting implementation.
4. Record verification evidence in the relevant `docs/项目计划/执行/*.md` task. When **acceptance-criteria** wording changes, edit `docs/项目计划/00.项目任务清单.md`. Put **residual risks** in `docs/项目计划/01.项目需求说明.md` — do not duplicate per-task evidence tables in `00` beyond the task links table.

## Rules

- **No code changes without explicit go-ahead** — same as `AGENTS.md` §5 第 6 条与 `.cursor/rules/routic-project.mdc`：无「批准 / 干 / 做 / 改 …」类行动令时，问句与叙述句只读分析与方案，不动 `server/`、`packages/` 等核心代码。协作条文会随踩坑**先膨胀、后收敛**，新增时仍守此条。
- **`docs/` voice** — see `AGENTS.md` §5 第 8 条: secondary-topic dirs under `docs/` = Chinese-first, same copy for you + future outsiders, concise; screenshots Chinese UI; no fork fluff. Doc *site* removed ≠ drop Markdown. `.agents/skills/**` etc. exempt unless asked.
- **Doc filenames** — in `doc/` and `docs/`, new human-facing Markdown must include Chinese in the filename (no pure-English slug); exceptions and form: `AGENTS.md` §5 第 14 条.
- **Documentation links: purposeful only** — same as `AGENTS.md` §5 第 7 条；见 `.cursor/rules/routic-project.mdc`「文书与 Git」。**Large doc corpora:** link sprawl inflates retrieval noise and context tokens—default stingy.
- Do not rewrite the project structure without explicit approval.
- Prefer small, reviewable changes.
- Keep project decisions in `docs/项目计划/`.
- Treat missing requirements as a question, not permission to guess.
- When checking local AI tool installs, prefer `routic doctor --tools` instead of inventing new filesystem search rules.
- **No push to remote by default** — same as `AGENTS.md` §5 item 12 / §10 opening: do not `git push` / `gh pr create` unless the human explicitly authorizes that turn; local commits OK.
- **After `git commit`, do not nag about push** — no closing reminders about remote / authorization unless the human asks.

## Keep This File Short

Put changing details (architecture decisions, API docs, runbooks) in `docs/项目计划/` or `docs/`. Reference them here.
