# CodeBuddy 配置分层（项目 / 用户 / 会话）与回形针

> 官方机制摘要见本机调研 [摘录-CodeBuddy本机调研回写.md](../探查/011-摘录-CodeBuddy本机调研回写.md) §08.2、§08.7。此处对齐 **本仓库 + Paperclip `codebuddy_local`** 怎么叠。  
> **无头 stdin 拼块、厂商底稿、日志 vs 账单** 见 **[022-实践-无头编排提示词叠层与可观测性.md](022-实践-无头编排提示词叠层与可观测性.md)**（本文只管 **JSON settings / env / CLI 参数** 三层文件配置）。

---

## 1. 三层分别是什么

| 层 | 典型位置 | 谁改 | 主要作用 |
| --- | --- | --- | --- |
| **用户级（软件随用户）** | `%USERPROFILE%\.codebuddy\settings.json` | 个人全局 | 语言、默认模型、权限、`env`、hooks、memory 等 |
| **项目级（随仓库）** | **`<仓库根>/.codebuddy/settings.json`** | 团队可提交 | 覆盖用户默认值；与 **cwd** 绑在「材料化工作区根」时常与 **issue 工作目录** 一致 |
| **本地覆盖（不入库）** | `<仓库根>/.codebuddy/settings.local.json` | 个人实验 | gitignore；优先级与官方合并规则一致 |

另有一类 **「会话 / 编排级」**——不是 JSON 文件，而是 **每次启动 CLI 时的参数与环境**：

| 来源 | 说明 |
| --- | --- |
| **Paperclip 适配器** | `execute.ts` 传入 **`--print`、`--model`、`--max-turns`、`-y`** 等；**CLI 显式参数通常压过 settings 里的默认模型**（单次会话以官方 CLI 为准） |
| **智能体 `config.env`** | 与适配器注入的 `PAPERCLIP_*`、适配器**默认无头环境变量**合并；**显式配置的 key 覆盖适配器默认值** |

---

## 2. 本仓库项目级文件

- 路径：**`.codebuddy/settings.json`**（已允许提交；**`settings.local.json` / `worktrees/` 仍忽略**，见根目录 `.gitignore`）。
- 当前基线意图：**压掉无头批跑里最吵的默认行为**（如轮次后自动建议、记忆后台抽取）；可按团队需要再改。
- **计费 / 火山**：**勿**在本文件写 **`CODEBUDDY_API_KEY`**。走 **火山方舟** 时见专文 **[007-CodeBuddy-火山引擎端点与配额.md](007-CodeBuddy-火山引擎端点与配额.md)**（默认腾讯/CodeBuddy 额度与火山 **不是同一个钱包**，不配 BASE_URL 易 429）。

---

## 3. 模型列表与 Board 对齐

- Paperclip 里 **`codebuddy_local`** 可选模型由适配器 **`packages/adapters/codebuddy-local/src/index.ts`** 的 **`models`** 定义（`V-` / `D-` / `M-` 前缀系展示用）。
- 执行时适配器会转成 CodeBuddy 所需的 **`custom-local:<去前缀名>`**；**具体能否推理**仍取决于本机 CodeBuddy **`models.json` / 平台账号**是否包含该 id——缺模型时 CLI 报错，需在 **CLI 或用户 settings** 侧配齐，不单靠 Paperclip。
- **`V-`（火山）**：若未配置 **`CODEBUDDY_BASE_URL` + 火山 Key**，容易仍走 **腾讯/CodeBuddy 默认计费** 并 **429**；见 [007-CodeBuddy-火山引擎端点与配额.md](007-CodeBuddy-火山引擎端点与配额.md)。

---

## 4. 建议工作流（你提出的顺序）

1. **运维**：先按 [006-运维-回形针-并发与CodeBuddy兜底.md](006-运维-回形针-并发与CodeBuddy兜底.md) 收敛并发与收尾阶梯。  
2. **项目 settings**：本仓 `.codebuddy/settings.json` 作基线；个人用 `settings.local.json` 试。  
3. **验证哪层生效**：对同一 cwd 跑一次 **`codebuddy -p`**（或看适配器 onLog 里拼好的 args/env），改一层、观察一层。  
4. **适配器**：把**反复验证有效**、且适合全员默认的 env/行为写进 **`codebuddy_local`**（见 `agentConfigurationDoc` 与 `execute.ts`）；其余留在项目或用户 JSON。

---

*2026-05-15*
