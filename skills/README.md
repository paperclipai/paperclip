# 仓库内置技能说明

本目录是 Paperclip **随源码一起分发**的智能体技能包：每个子目录对应一个技能，**真值文件**是其中的 `SKILL.md`（YAML 头字段 + 正文）。适配器/本地 CLI 会把这些内容同步到智能体运行时；公司也可以在**公司技能库**里安装同名技能，并在雇佣智能体时用 `desiredSkills` 挂上（bundled key 常见形如 `paperclipai/paperclip/<技能名>`）。

**读技能的顺序：** 先看本页「一览」→ 再打开对应目录下的 `SKILL.md`；需要 API 细节时继续读该技能下的 `references/`（若有）。

---

## 一览（中文叫法 ← 目录名）

| 目录名（配置里用这个 id） | 中文叫法 | 一句话 |
|--------------------------|----------|--------|
| `paperclip` | 控制面协作 | 心跳里怎么调 Paperclip API、领活、签出、[→ SKILL.md](paperclip/SKILL.md) |
| `paperclip-dev` | 本地开发与运维 | 在本仓库跑实例、worktree、构建测试、PR 卫生、[→ SKILL.md](paperclip-dev/SKILL.md) |
| `paperclip-create-agent` | 雇佣/新建智能体 | 对齐适配器配置、起草 AGENTS.md、提交雇佣请求、[→ SKILL.md](paperclip-create-agent/SKILL.md) |
| `paperclip-create-plugin` | 写插件 | 脚手架、worker/UI、插件契约与验收、[→ SKILL.md](paperclip-create-plugin/SKILL.md) |
| `paperclip-converting-plans-to-tasks` | 规划→事务 | 把计划拆成可派单事务、依赖与并行（配合 `paperclip` 的 plan 机制），[→ SKILL.md](paperclip-converting-plans-to-tasks/SKILL.md) |
| `diagnose-why-work-stopped` | 停滞/循环诊断 | 对事务树取证、出契约级计划，默认不落代码，[→ SKILL.md](diagnose-why-work-stopped/SKILL.md) |
| `para-memory-files` | PARA 文件记忆 | 用文件夹+笔记做跨会话记忆（qmd 等），[→ SKILL.md](para-memory-files/SKILL.md) |
| `terminal-bench-loop` | Terminal-Bench 跑圈 | 有界迭代冒烟、董事会确认后再改产品，[→ SKILL.md](terminal-bench-loop/SKILL.md) |

---

## 和维护者技能目录的区别

- **`skills/`（本目录）**：产品默认随仓库走的**用户/智能体面**技能说明。
- **`.agents/skills/`**：更多是给**维护仓库**的人用的流程（发版、PR 报告、安全公告等），与「跑一家 Paperclip 公司」不一定同套语境。需要时在仓库根 `AGENTS.md` 里会点名引用。

---

## 与 HTTP API 的关系（别只靠这里）

控制面提供一些技能相关的 HTTP 接口（需登录/鉴权，见 `doc/05 开发指南 DEVELOPING.md` 等文档），例如：

- `GET /api/skills/index` — JSON 列表（历史上可能**未列全**本目录技能，以本 `skills/` 目录为准）
- `GET /api/skills/:name` — 返回**部分** `name` 的 Markdown；未覆盖的技能请**直接读**本仓库对应 `SKILL.md`
- `GET /api/skills/available` — 侧重本机 `~/.claude/skills` 的发现，并标记是否由本仓库 `skills/` 管理

因此：**技能正文与范围的真值 = 本仓库 `skills/*/SKILL.md`**，而不是某个 API 响应的子集。

---

## 快照与恢复

整包 `skills/` 的 Git 基线分支/标签说明见仓库根 **`AGENTS.md`**（技能基线与 `docs/项目计划/最佳实践/` 里相关实践文）。
