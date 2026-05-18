---
status: 进行中
---

# Skill 懒加载与 Wake 上下文去重、封顶

**母本：** [`../长期需求/24 评论唤起过载与编排分层改版计划 2026-05-17.md`](../长期需求/24%20评论唤起过载与编排分层改版计划%202026-05-17.md) · **§B1–B3**

## 文书（按 [`016-实践-042至053编排开发收口套路`](../最佳实践/016-实践-042至053编排开发收口套路.md) 拆单）

| 步 | 产物 |
| --- | --- |
| ① 探查 | [`../探查/025-探查-045-Skill懒加载与上下文封顶-现状与落点.md`](../探查/025-探查-045-Skill懒加载与上下文封顶-现状与落点.md) |
| ② 技术设计 | [`045-Skill懒加载与上下文封顶-技术设计 2026-05-17.md`](../技术设计/045-Skill懒加载与上下文封顶-技术设计%202026-05-17.md) |
| ③ 评审 | [`045-Skill懒加载与上下文封顶-评审稿 2026-05-17.md`](../评审/045-Skill懒加载与上下文封顶-评审稿%202026-05-17.md) |

## 背景与范围

- **B1**：`Skill paperclip` 默认不得整条灌入会话；**目录 + 按需章节**，或服务端/`harness` 注入摘要版。
- **B2**：`fallbackFetchNeeded: false` 时勿重复装载与 Wake 重复的规程正文。
- **B3**：`AGENTS.md` / `codebuddyMd`：**token 预算**、`comment wake` 路径弱相关段落折叠策略。

## 适配器范围（已定案 · 本单）

本单**仅**修改以下三包，其余适配器（Claude、Codex、Gemini、`opencode-local`、`grok-local`、`pi-local`、`acpx-local` 等）**一律不动**，避免无效扩散与回归面浪费。

| 包路径 | 说明 |
| --- | --- |
| `packages/adapters/cursor-local` | Cursor |
| `packages/adapters/codebuddy-local` | CodeBuddy |
| `packages/adapters/qwen-local` | Qwen |

**已定案依据：** [`045` 评审稿](../评审/045-Skill懒加载与上下文封顶-评审稿%202026-05-17.md) **「已定案口径」**。

## 交付物（可验收）

1. CLI/harness/server 侧的加载钩子或裁剪策略设计与实现增量。
2. 前后对比：同类唤醒下 **`input_tokens` 或等价指标**下降的取证（可对齐 [`015-实践-CLI累计计量与成本控制面台账口径`](../最佳实践/015-实践-CLI累计计量与成本控制面台账口径.md)）。

## 依赖与并行

- **依赖**：[041](041-评论唤起策略分级与档位-已完成.md) 档位若包含「禁用全 Skill」则天然验收场景。
- **参考**：[`长期需求/08`](../长期需求/08%20关于技能的选型和配置.md)、[`08-技能选型与加载机制`](../长期需求/08-技能选型与加载机制-产品需求与技术设计.md)。

## 改代码原则（本单）

1. **字段与契约**：不纠结具体字段命名，以**语义清楚、跑通 shared / 服务端 / 适配器**为准；**优先复用**既有结构（如 `paperclipSkillSync`、`PaperclipSkillEntry` 等），**少造平行一套**。
2. **改动形态**：**最小增量**——在现有路径上增加可选字段、分支或钩子，避免大挪目录、全仓换抽象。
3. **与上游合流**：本 fork 须**持续可从上游合入/吸收补丁**；禁止为单点需求把核心目录改到「面目全非」、致使以后难以 merge。

---

## 验证证据（完成后填写）

### 2026-05-17（首轮 · stdin 技能说明封顶）

- **共享逻辑：** `packages/adapter-utils/src/server-utils.ts` 新增 `shouldMinimizeAdapterRuntimeSkillNotes(context, resumedSession)`：**接续会话** 或 **`commentWakeTier` ∈ `receipt_only` / `read_thread` / `allow_api_context`** 时，适配器侧技能提示走**单行精简**。
- **Qwen：** `packages/adapters/qwen-local/src/server/execute.ts` — `renderQwenSkillNote` 按上文精简 `skill_note`。
- **CodeBuddy：** `packages/adapters/codebuddy-local/src/server/execute.ts` — 新增与同口径的 `skill_note` 段；磁盘同步路径不变。
- **Cursor：** 本轮 **未改** stdin（技能仍以磁盘 symlink 注入为主，与 Qwen 的「显式 skill 段」不同层）；后续若需与低档对齐，可单列极小 `onLog` 或一行指针。
- **测试：** `packages/adapter-utils/src/server-utils.test.ts` — `shouldMinimizeAdapterRuntimeSkillNotes` 单测；`pnpm exec vitest run packages/adapter-utils/src/server-utils.test.ts -t shouldMinimizeAdapterRuntimeSkillNotes`。

### 2026-05-18（第二轮 · B1 首帧摘要 + B2 评论内联 wake + B3 说明书封顶 · 三适配器）

- **共享（adapter-utils）：**  
  - `shouldMinimizeAdapterRuntimeSkillNotes`：**`issue_commented` 且 wake `fallbackFetchNeeded === false`** 时亦 minimize（B2）。  
  - **`renderMinimizedPaperclipSkillNoteMarkdown`**：从各技能源目录读 `SKILL.md`，输出 **二级标题 + 短摘要 + 路径指针**（B1 思路 A）。辅助：`extractMarkdownH2Headings`、`excerptPaperclipSkillMarkdownBody`。  
  - **`capPaperclipInjectedAgentInstructions`** / `MAX_ADAPTER_AGENT_INSTRUCTIONS_CHARS_COMMENT_WAKE`（14000）：在 **`shouldCapPaperclipInjectedAgentInstructions`** 为真且非续跑时，将 Paperclip 注入的说明书**总产出**封顶（含脚注说明）（B3，仅控制面注入段）。  
- **Qwen：** minimize 时 `skill_note` 改为上述摘要 Markdown；读入 `instructionsFilePath` 后走封顶。  
- **CodeBuddy：** 同左；若封顶则写入临时 `--system-prompt-file`。  
- **Cursor：** stdin 增加 **`skill_note`** 段（minimize 时摘要）；`agent_instructions` 读入后封顶。  
- **测试：** `pnpm exec vitest run packages/adapter-utils/src/server-utils.test.ts -t "045 helpers|shouldMinimizeAdapter"`；`pnpm exec vitest run packages/adapters/codebuddy-local/src/server/execute.test.ts`；`pnpm exec vitest run packages/adapters/cursor-local/src/server/remote-command.test.ts`。

> **仍未当结案：** 与 wake 块「执行契约」字级 **去重**、**非 `issue_commented`** 链路的 B2 扩面、以及 **015 口径 input_tokens 前后对照**，需后续取证或再迭代。
