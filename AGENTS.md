# AGENTS.md

为在本仓库工作的人类和 AI 贡献者提供的指引。

## 1. 用途

Paperclip 是面向 AI Agent 公司的控制平面。
当前实现目标为 V1，定义在 `doc/04 实现规格 SPEC-implementation.md` 中。

## 2. 先读这里

变更代码前，按此顺序阅读（正文以中文为主；**路径文件名**保持英文以便工具与链接稳定）：

1. `doc/01 目标 GOAL.md`（目标与愿景）
2. `doc/02 产品定义 PRODUCT.md`（产品定义）
3. `doc/04 实现规格 SPEC-implementation.md`（V1 实现契约）
4. `doc/05 开发指南 DEVELOPING.md`（开发与本地运行）
5. `doc/06 数据库 DATABASE.md`（数据库与密钥相关）

`doc/03 规范 SPEC.md`：长周期产品上下文。
`doc/04 实现规格 SPEC-implementation.md`：具体 V1 构建契约。

## 3. 仓库结构

- `server/`：Express REST API 和编排服务
- `ui/`：React + Vite 看板 UI
- `packages/db/`：Drizzle schema、迁移、DB 客户端
- `packages/shared/`：共享类型、常量、校验器、API 路径常量
- `packages/adapters/`：Agent 适配器实现（Claude、Codex、Cursor 等）
- `packages/adapter-utils/`：共享适配器工具函数
- `packages/plugins/`：插件系统包
- `doc/`：运维和产品文档
- `skills/`：随仓库分发的智能体技能（每技能一个目录 + `SKILL.md`）；**集中说明与中文对照见 [`skills/README.md`](skills/README.md)**（此前易缺索引，以自我维护的该文件为准）

## 4. 开发环境（自动数据库）

开发时不设置 `DATABASE_URL`，将使用内嵌的 PGlite。

```sh
pnpm install
pnpm dev
```

启动后：

- API：`http://localhost:3100`
- UI：`http://localhost:3100`（开发中间件模式下由 API 服务器提供）

快速检查：

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

干净停止本地开发：在启动服务器的终端前台按 **Ctrl+C**，然后在仓库根目录执行 **`pnpm dev:list`** / **`pnpm dev:stop`**。若怀疑子进程泄漏（孤儿 `node` / 内嵌 `postgres` / Codebuddy CLI 等），可用一键 **`pnpm dev:nuke`**（预览：`pnpm dev:nuke -- -DryRun`；保留 Codebuddy：`pnpm dev:nuke -- -KeepCodebuddy`）。若端口 **3100** 仍被占用但注册表为空，请参阅 **`doc/05 开发指南 DEVELOPING.md`**（*停止开发服务*章节）以及中文运维文档 **`docs/项目计划/运维-回形针本地.md`**（*停止与查看状态*）。

重置本地开发数据库：

```sh
rm -rf data/pglite
pnpm dev
```

## 5. 核心工程规则

1. **变更保持在公司范围内。**
每个领域实体都应归属于某个公司，路由/服务层必须强制执行公司边界。

2. **保持契约同步。**
如果更改了 schema/API 行为，需更新所有受影响的层：
- `packages/db` schema 和导出
- `packages/shared` 类型/常量/校验器
- `server` 路由/服务
- `ui` API 客户端和页面

3. **维护控制平面不变量。**
- 单一负责人任务模型
- 原子性 issue 签出语义
- 受管操作的审批门控
- 预算硬停自动暂停行为
- 变更操作的活动日志

4. **除非明确要求，不要整体替换战略文档。**
优先增量更新。保持 `doc/03 规范 SPEC.md` 和 `doc/04 实现规格 SPEC-implementation.md` 一致。

5. **仓库计划文档保持日期化和集中化。**
在仓库中创建计划文件时，新计划文档应放在 `doc/plans/` 目录下，使用 `YYYY-MM-DD-slug.md` 文件名格式。这不替代 Paperclip issue 计划：如果 Paperclip issue 要求提供计划，请按 `paperclip` skill 更新 issue 的 `plan` 文档，而不是创建仓库 markdown 文件。

6. **未经显式行动许可不写代码。**
人类**未**给出可当轮执行的许可（如：**批准、干、做、改、实现、写入、落盘、开 PR** 等**同义行动指令**）时，仅凭**问句**或**叙述句**（讨论、背景、推测、brainstorm）**不得**改仓库：**禁止**擅自补丁核心实现（`server/`、`packages/`、适配器注册、控制平面编排等）及代跑会改写工作区的自动化；**可以**做只读检索、解释、方案与风险。**许可可与需求同条消息出现**；含糊的「看看吧」「你觉得呢」不算许可。

协作条文本质上常由**踩坑后补**、短期内会与 **`.cursor/rules/routic-project.mdc`** 等处**重复**，后续再**合并精简**；新增条文时仍遵守本条，避免继续无声膨胀。

7. **文档链接不随意挂载。**
Markdown 中的链接须与**该句正在说明的对象**或**读者按句意应有的下一步**一致；禁止在同一句、同一括号里「捎带」挂与主语无关的链。优先**单一权威落点**（专文、表格一行、已有索引）。**禁止零增量重复**：同篇里表格、目录等已为某目标挂过链后，后文若只是概括或点名类型，勿再贴同一 URL（用「见上表」、「§…」或 `adapterType`）；若后文是**新的步骤/独立段落**且第二次链能承接读者动线，可以保留。人类未要求补充交叉引用或导航时，不要为「看起来完整」自行加链。**文档规模一大（成百上千篇），链网膨胀会显著抬高检索噪声与 AI 上下文 token，等同给未来的自己埋雷；宁愿多写稳定路径名、索引入口，也不要在正文里摊「链海」。**

8. **`docs/` 域文书（对外资料库预备）。**
以 **`docs/` 下各二级主题目录**（入门、指南、适配器、API、CLI、部署等）为主：**中文正文为主**，将来给外部读者阅读与自己查阅**同一套稿**；篇幅与语气对齐 **`doc/`** 与上游 Paperclip **简洁产品说明**，写清「是什么、怎么用」；**配图与 UI 截图默认中文环境**。不出现「本 fork」「fork 习惯」「与上游对比」等协作黑话。已移除的是**本地文档站生成物**（不必保留站点工程），**不是**废弃 `docs/` 正文；真值以仓库内 Markdown 为准。**`docs/项目计划/`** 以内部协作为主（范围见该目录 `README`）。**例外**：主要为 AI 宿主/技能链路的短文（如 **`.agents/skills/**/SKILL.md`**、根目录 `CLAUDE.md` / `codebuddy.md` 等）**不要求**按对外资料库口吻改写；人类未点名时不要批量改动此类文稿。

9. **文档与代码双向真值。**
**文档指导代码**：产品能力、适配器行为、心搏/事务/技能等语义以 **`doc/`**、**`docs/`**（二级主题目录）及 **`docs/项目计划/01.项目需求说明.md`** 为**人类可用的真值线索**；实现不得在无需求或 SPEC 背书时擅自缩减到**与文档承诺相冲突的残缺实现**。**代码回写文档**：变更 `server/`、`packages/`、`ui/` 中影响操作者或可观测行为时，**须同步**受影响的 `doc/` / `docs/`（及需求说明中相关陈述），禁止长期维持「只有代码、没有中文说明」或「只有 UI 能猜」。操作者主要依赖中文资料指挥 AI；**文档未记载的语义不得假设人类已知**。

10. **适配器完整性与契约一致。**
禁止仅为过编译、赶进度或临时跑通而省略：已与 **`docs/适配器`** 专文、**`doc/04 实现规格 SPEC-implementation.md`** 或控制平面既定语义相冲突的字段、会话/技能/鉴权或错误路径处理。若确需收窄能力，**先**更新需求说明与文档、再改代码。详见 **`docs/项目计划/01.项目需求说明.md`**「文档与代码（双向真值）」节。

11. **默认技能包快照可恢复。**
仓库 **`skills/`** 的整包基线以 Git **孤立分支** `skills-baseline-8pack` 与注释标签 **`skills-baseline-8pack-v1`** 保存；从快照只恢复 `skills/` 目录的命令、推送远端与注意点见 **`docs/项目计划/最佳实践/实践-技能默认包快照与恢复.md`**。重做基线后应回写该文与标签说明。

## 6. 数据库变更流程

修改数据模型时：

1. 编辑 `packages/db/src/schema/*.ts`
2. 确保新表从 `packages/db/src/schema/index.ts` 导出
3. 生成迁移：

```sh
pnpm db:generate
```

4. 验证编译：

```sh
pnpm -r typecheck
```

注意：
- `packages/db/drizzle.config.ts` 从 `dist/schema/*.js` 读取编译后的 schema
- `pnpm db:generate` 会先编译 `packages/db`

## 7. 交接前的验证

默认的本地/Agent 测试路径：

```sh
pnpm test
```

这是低成本的默认选项，仅运行 Vitest 测试套件。浏览器测试套件默认不启用：

```sh
pnpm test:e2e
pnpm test:release-smoke
```

仅在变更涉及浏览器测试或明确需要验证 CI/发布流程时才运行浏览器测试套件。

对于常规 issue 工作，优先运行最小范围的相关验证。不要在每次检查时默认执行仓库级别的 typecheck/build/test，更窄范围的检查足以证明变更正确性时就用窄范围检查。

在 PR 就绪交接前声明仓库工作完成时，或变更范围足够广、针对性检查不足以覆盖时，运行完整检查：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

如果有任何检查未能运行，需明确报告哪些未运行及原因。

## 8. API 和认证预期

- 基础路径：`/api`
- 看板访问视为完全控制操作者上下文
- Agent 访问使用 Bearer API 密钥（`agent_api_keys`），存储时进行哈希处理
- Agent 密钥不得访问其他公司数据

添加端点时：

- 应用公司访问检查
- 强制执行参与者权限（看板 vs Agent）
- 为变更操作写入活动日志
- 返回一致的 HTTP 错误码（`400/401/403/404/409/422/500`）

## 9. UI 预期

- 保持路由和导航与可用 API 接口一致
- 公司范围页面使用公司选择上下文
- 清晰展示错误；不要静默忽略 API 错误

## 10. Pull Request 要求

创建 Pull Request 时（通过 `gh pr create` 或其他方式），**必须**阅读并填写 [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) 的每个章节。不要编写临时 PR 描述——使用模板作为 PR 描述的结构。必需章节：

- **思考路径** — 从项目上下文到此次变更的推理过程（示例见 `CONTRIBUTING.md`）
- **变更内容** — 具体变更的要点列表
- **验证方式** — 审阅者如何确认变更有效
- **风险** — 可能出现的问题
- **使用的模型** — 产生或辅助此次变更的 AI 模型（提供商、精确模型 ID、上下文窗口、能力）。如未使用 AI 则写"无——人工编写"
- **检查清单** — 所有项目已勾选

## 11. 完成定义

当以下全部满足时，变更才算完成：

1. 行为符合 `doc/04 实现规格 SPEC-implementation.md`
2. Typecheck、测试和构建通过
3. db/shared/server/ui 间的契约已同步
4. 行为或命令变更时文档已更新
5. PR 描述遵循 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)，所有章节已填写（包括使用的模型）

## 12. Fork 特定说明：HenkDz/paperclip

这是 `paperclipai/paperclip` 的 fork，包含生活质量改进补丁，以及在 `feat/externalize-hermes-adapter` 分支上的**纯外部** Hermes 适配器方案（[分支树](https://github.com/HenkDz/paperclip/tree/feat/externalize-hermes-adapter)）。

### 发版与上游

本 fork **不与**上游 `paperclipai/paperclip` **跟版、对表或联合发版**。交付节奏以本仓库为准；内置适配器等能力以本仓库文档与验证为真值，**不依赖**上游 release 对齐。

### 本 fork 自研的编码适配器（中文生态）

本仓库在 `packages/adapters/` **自行实现并维护**两类面向中文/国内编码工具链的适配器：**`qwen_local`**（Qwen Code CLI）、**`codebuddy_local`**（CodeBuddy）。二者均在 **`BUILTIN_ADAPTER_TYPES`** 中并由 **`registerBuiltInAdapters`** 内置注册；各自 `package.json` 含 **`paperclip.adapterServerEntry`** 与 **`createServerAdapter()`**，也可仅通过 **`adapter-plugins.json` 的 `file:`** 走插件加载（便于覆盖/对照联调）。

另有两个**仅占插件位、不内置**的示例类型 **`fork_plugin_demo_a`** / **`fork_plugin_demo_b`**（`packages/plugins/examples/adapter-fork-plugin-demo-*`），用于走通外部适配器安装与加载链路。

### 分支策略

- `feat/externalize-hermes-adapter` → 核心**不**依赖 `hermes-paperclip-adapter`，也**不**内置 `hermes_local` 注册。通过适配器插件管理器安装 Hermes（`@henkey/hermes-paperclip-adapter` 或 `file:` 路径）。
- 较旧的 fork 分支可能仍记录内置 Hermes；以此文件作为外部化分支的权威说明。

### Hermes（仅限插件）

- 通过 **Board → 适配器管理器** 注册（与 Droid 相同）。包加载后类型仍为 `hermes_local`。
- UI 使用包中的通用 **config-schema** + **ui-parser.js** — `server/` 或 `ui/` 源码中无 Hermes 导入。
- 可选：在 `~/.paperclip/adapter-plugins.json` 中添加 `file:` 条目用于适配器仓库的本地开发。

### 本地开发

- Fork 运行在端口 3101+（如果 3100 被上游实例占用则自动检测）
- `npx vite build` 在 NTFS 上会挂起 — 改用 `node node_modules/vite/bin/vite.js build`
- `pnpm dev` 在 NTFS 上会死锁 — `tsx watch`（chokidar）因 `fs.watch` 不稳定而无限挂起。改用 `pnpm dev:once`（跳过文件监听，同一服务器，变更时不自动重启）
- 启动前杀掉所有 paperclip 进程：`pkill -f "paperclip"; pkill -f "tsx.*index.ts"`
- Vite 缓存在 `rm -rf dist` 后仍保留 — 需同时删除：`rm -rf ui/dist ui/node_modules/.vite`

### Fork 生活质量改进补丁（不在上游）

这些是 fork UI 中的本地修改。如果重新复制源码，需要重新应用：

1. **stderr_group** — `RunTranscriptView.tsx` 中 MCP 初始化噪声的琥珀色手风琴组件
2. **tool_group** — 连续非终端工具（write、read、search、browser）的手风琴组件
3. **Dashboard 摘要** — `LatestRunCard` 去除 markdown 格式，显示前 3 行/280 字符

### 插件系统

PR #2218（`feat/external-adapter-phase1`）添加了外部适配器支持。完整详情见根目录 `AGENTS.md`。

- 适配器可通过 `~/.paperclip/adapter-plugins.json` 作为外部插件加载
- 插件加载器应**零**硬编码适配器导入 — 纯动态加载
- `createServerAdapter()` 必须包含所有可选字段（尤其是 `detectModel`）
- 内置 UI 适配器可能覆盖外部插件解析器 — 完全外部化时需移除内置
- 参考外部适配器：Hermes（`@henkey/hermes-paperclip-adapter` 或 `file:`）和 Droid（npm）
