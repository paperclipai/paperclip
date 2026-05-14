# codebuddy.md — paperclip-latest-20260512

Use this project as a docs-driven AI coding workspace.

## Required Reading

1. `docs/项目计划/README.md`
2. `docs/项目计划/01.项目需求说明.md`
3. `docs/项目计划/00.项目任务清单.md`（状态表、验收标准、规则；逐条验证写在 `执行/`）

## Behavior

- **No code changes without explicit go-ahead** — 与 `AGENTS.md`「核心工程规则」第 6 条一致：无「批准 / 干 / 做 / 改 …」类行动令时，问句与叙述句只做只读分析与方案，不动 `server/`、`packages/` 等核心代码。条文会随踩坑重复出现，后续再收敛。
- **`docs/`** — 见 `AGENTS.md` §5 第 8 条：`docs/` 二级目录中文主稿、预备对外；截图中文；AI 技能稿不必套对外口吻。
- **文档链接** — 与 `AGENTS.md` 核心工程规则第 7 条一致；库一大，链多等于 token 与噪声一起爆，默认省着挂。
- Ask when requirements are missing.
- Write implementation notes into the current task.
- Write verification evidence into the active `docs/项目计划/执行/*.md` task (do not add a master per-row evidence table to `00`).
