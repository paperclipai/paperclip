# 2026-03-13 公司导入/导出 V2 计划

状态：拟议实施方案
日期：2026-03-13
受众：产品与工程团队
在包格式方向上取代以下文档：
- `doc/plans/2026-02-16-module-system.md` 中将公司模板描述为仅 JSON 的相关章节
- `docs/specs/cliphub-plan.md` 中与 markdown 优先包模型冲突的蓝图包结构假设

## 1. 目的

本文档定义 Paperclip 公司导入/导出的下一阶段计划。

核心转变包括：

- 从 Paperclip 专有的 JSON 优先可移植包转向 markdown 优先包格式
- 将 GitHub 仓库作为一级包来源
- 将公司包模型视为现有 Agent Skills 生态的扩展，而非另起炉灶创建独立的 skill 格式
- 支持公司、团队、agent 及 skill 的复用，无需中央注册中心

规范性包格式草案位于：

- `docs/companies/companies-spec.md`

本计划涉及 Paperclip 内部的实施与推广工作。

适配器层面的 skill 推广详情请参见：

- `doc/plans/2026-03-14-adapter-skill-sync-rollout.md`

## 2. 执行摘要

Paperclip 代码库中已具备可移植性基础原语：

- 服务端导入/导出/预览 API
- CLI 导入/导出命令
- 共享可移植性类型与验证器

这些基础原语将被切换到新包模型，而非为向后兼容性进行扩展。

新方向如下：

1. markdown 优先的包编写方式
2. GitHub 仓库或本地文件夹作为默认的真实来源
3. 面向 agent-company 运行时（而非仅限 Paperclip）的厂商中立基础包规范
4. 公司包模型明确作为 Agent Skills 的扩展
5. 未来不再依赖 `paperclip.manifest.json`
6. 针对常见场景按约定进行隐式文件夹发现
7. 始终生成 `.paperclip.yaml` 附加文件，用于存放高保真的 Paperclip 专有详情
8. 导入时进行包图谱解析
9. 支持依赖感知树形选择的实体级导入界面
10. `skills.sh` 兼容性是 V1 阶段对 skill 包及 skill 安装流程的硬性要求
11. 适配器感知的 skill 同步界面，使 Paperclip 能在适配器支持时读取、对比、启用、禁用并协调 skill

## 3. 产品目标

### 3.1 目标

- 用户可以将 Paperclip 指向本地文件夹或 GitHub 仓库，无需任何注册中心即可导入公司包。
- 包可由人工通过普通 git 工作流进行读写。
- 包可包含以下内容：
  - 公司定义
  - 组织子树/团队定义
  - agent 定义
  - 可选的初始项目和任务
  - 可复用的 skill
- V1 阶段的 skill 支持与现有 `skills.sh` / Agent Skills 生态兼容。
- 用户可以将内容导入：
  - 新建公司
  - 已有公司
- 导入预览展示：
  - 将会创建的内容
  - 将会更新的内容
  - 将被跳过的内容
  - 外部引用的内容
  - 需要密钥或审批的内容
- 导出保留归因、许可证信息及固定的上游引用。
- 导出产出一个干净的厂商中立包，以及一个 Paperclip 附加文件。
- `companies.sh` 未来可作为实现此格式的仓库的发现/索引层。

### 3.2 非目标

- 包的有效性不需要中央注册中心。
- 这不是完整的数据库备份/恢复方案。
- 不尝试导出以下运行时状态：
  - heartbeat 运行记录
  - API 密钥
  - 消耗总计
  - 运行会话
  - 临时工作空间
- 在团队可移植性发布之前，不需要优先建立运行时 `teams` 表。

## 4. 代码库现状

当前实现位于以下位置：

- 共享类型：`packages/shared/src/types/company-portability.ts`
- 共享验证器：`packages/shared/src/validators/company-portability.ts`
- 服务端路由：`server/src/routes/companies.ts`
- 服务端服务：`server/src/services/company-portability.ts`
- CLI 命令：`cli/src/commands/client/company.ts`

当前产品局限性：

1. 导入/导出界面仍需深化树形选择及 skill/包管理的精细度。
2. 适配器专属 skill 同步在各适配器之间仍不一致，在不支持时必须能优雅降级。
3. 项目和初始任务在导出时应保持为可选项，而非默认包内容。
4. 导入/导出在归因、固定验证和可执行包警告方面仍需更强的覆盖。
5. 当前的 markdown frontmatter 解析器有意保持轻量级，应限制在已记录的结构内。

## 5. 规范包方向

### 5.1 规范编写格式

规范编写格式采用以下文件之一为根的 markdown 优先包：

- `COMPANY.md`
- `TEAM.md`
- `AGENTS.md`
- `PROJECT.md`
- `TASK.md`
- `SKILL.md`

规范性草案位于：

- `docs/companies/companies-spec.md`

### 5.2 与 Agent Skills 的关系

Paperclip 不得重新定义 `SKILL.md`。

规则：

- `SKILL.md` 保持与 Agent Skills 兼容
- 公司包模型是 Agent Skills 的扩展
- 基础包为厂商中立，面向任何 agent-company 运行时
- Paperclip 专有的高保真内容位于 `.paperclip.yaml`
- Paperclip 可以解析并安装 `SKILL.md` 包，但不得要求 Paperclip 专有的 skill 格式
- `skills.sh` 兼容性是 V1 阶段的硬性要求，而非未来可选项

### 5.3 Agent 与 Skill 的关联

`AGENTS.md` 应通过 skill 短名称或 slug 关联 skill，而非在常见场景中使用冗长路径。

首选示例：

- `skills: [review, react-best-practices]`

解析模型：

- `review` 按包约定解析为 `skills/review/SKILL.md`
- 如果 skill 是外部引用的，由 skill 包自行处理该复杂性
- 导出器应在 `AGENTS.md` 中优先使用基于短名称的关联
- 导入器应优先将短名称解析为本地包中的 skill，然后再解析为已引用或已安装的公司 skill
### 5.4 基础包与 Paperclip 扩展

仓库格式应分为两层：

- 基础包：
  - 最小化、可读、社交友好、厂商中立
  - 按约定进行隐式文件夹发现
  - 默认不含 Paperclip 专有的运行时字段
- Paperclip 扩展：
  - `.paperclip.yaml`
  - 适配器/运行时/权限/预算/工作空间高保真信息
  - 由 Paperclip 工具以附加文件形式生成，同时保持基础包可读

### 5.5 与当前 V1 清单的关系

`paperclip.manifest.json` 不属于未来包方向的一部分。

这应被视为产品方向上的硬性切换。

- markdown 优先的仓库结构是目标
- 不应再对旧清单模型进行新的投入
- 未来的可移植性 API 和界面应仅面向 markdown 优先模型

## 6. 包图谱模型

### 6.1 实体类型

Paperclip 导入/导出应支持以下实体类型：

- company（公司）
- team（团队）
- agent
- project（项目）
- task（任务）
- skill

### 6.2 团队语义

`team` 首先是一个包概念，而非数据库表的要求。

在 Paperclip V2 可移植性中：

- 团队是一个可导入的组织子树
- 以一个管理者 agent 为根节点
- 可以挂载在已有公司的目标管理者节点之下

这避免了在未来运行时 `teams` 模型上阻塞可移植性。

导入团队的追踪最初应基于包/来源信息：

- 如果某个团队包已被导入，导入的 agent 应携带足够的来源信息以重建该分组
- Paperclip 可将”这组 agent 来自团队包 X”作为导入团队模型
- 来源分组是导入/导出近期和中期的预期团队模型
- 仅当产品需求超出来源分组所能表达的范围时，才添加一流的运行时 `teams` 表

### 6.3 依赖图谱

导入应在实体图谱上操作，而非原始文件选择。

示例：

- 选择一个 agent 会自动选中其所需的文档和 skill 引用
- 选择一个团队会自动选中其子树
- 选择一个公司默认自动选中所有包含的实体
- 选择一个项目会自动选中其初始任务

预览输出应明确反映图谱解析结果。

## 7. 外部引用、版本固定与归因

### 7.1 重要性

某些包将会：

- 引用我们不希望重新发布的上游文件
- 包含必须保持可见归因的第三方作品
- 需要防范分支热替换

### 7.2 策略

Paperclip 应在包元数据中支持以下来源引用字段：

- repo（仓库）
- path（路径）
- commit sha
- 可选的 blob sha
- 可选的 sha256
- attribution（归因）
- license（许可证）
- usage mode（使用模式）

使用模式：

- `vendored`（已内嵌）
- `referenced`（已引用）
- `mirrored`（已镜像）

针对第三方内容的默认导出器行为应为：

- 优先选择 `referenced`
- 保留归因信息
- 不得将第三方内容悄无声息地内联到导出包中

### 7.3 信任模型

导入的包内容应按信任等级分类：

- 仅 markdown
- markdown + 资源文件
- markdown + 脚本/可执行文件

界面和 CLI 应在应用前清晰展示此信息。

## 8. 导入行为

### 8.1 支持的来源

- 本地文件夹
- 本地包根文件
- GitHub 仓库 URL
- GitHub 子树 URL
- 直接指向 markdown/包根的 URL

基于注册中心的发现功能可在后续添加，但必须保持可选。

### 8.2 导入目标

- 新建公司
- 已有公司

对于导入到已有公司的情况，预览界面必须支持：

- 冲突处理
- 团队导入的挂载点选择
- 选择性实体导入

### 8.3 冲突策略

当前的 `rename | skip | replace` 支持保留，但匹配逻辑应随时间持续改进。

首选匹配顺序：

1. 先前安装的来源信息
2. 稳定的包实体标识
3. slug
4. 人类可读名称作为弱回退

仅使用 slug 匹配仅作为过渡策略可接受。

### 8.4 必需的预览输出

每次导入预览应展示：

- 目标公司操作
- 实体级创建/更新/跳过计划
- 引用的外部内容
- 缺失文件
- 哈希不匹配或版本固定问题
- 环境变量输入，包括必填项与可选项，以及存在时的默认值
- 不支持的内容类型
- 信任/许可证警告

### 8.5 适配器 Skill 同步界面

用户希望在界面中管理 skill，但 skill 依赖于适配器。

这意味着可移植性和界面规划必须包含适配器能力模型。

Paperclip 应围绕 skill 定义新的适配器接口范围：

- 列出 agent 当前已启用的 skill
- 报告适配器如何表示这些 skill
- 安装或启用某个 skill
- 禁用或移除某个 skill
- 报告期望包配置与实际适配器状态之间的同步状态

示例：

- Claude Code / Codex 风格的适配器可能将 skill 作为本地文件系统包或适配器自有的 skill 目录进行管理
- OpenClaw 风格的适配器可能通过 API 或反射配置界面暴露当前已启用的 skill
- 某些适配器可能是只读的，仅报告其所拥有的内容

规划中的适配器能力字段：

- `supportsSkillRead`
- `supportsSkillWrite`
- `supportsSkillRemove`
- `supportsSkillSync`
- `skillStorageKind`，如 `filesystem`、`remote_api`、`inline_config` 或 `unknown`

基础适配器接口：

- `listSkills(agent)`
- `applySkills(agent, desiredSkills)`
- `removeSkill(agent, skillId)` 可选
- `getSkillSyncState(agent, desiredSkills)` 可选

规划中的 Paperclip 行为：

- 如果适配器支持读取，Paperclip 应在界面中展示当前 skill
- 如果适配器支持写入，Paperclip 应允许用户启用/禁用已导入的 skill
- 如果适配器支持同步，Paperclip 应计算期望状态与实际状态之间的差异并提供协调操作
- 如果适配器不支持这些能力，界面仍应展示包级别的期望 skill，但标记为未托管

## 9. 导出行为

### 9.1 默认导出目标

默认导出目标应改为 markdown 优先的文件夹结构。

示例：

```text
my-company/
├── COMPANY.md
├── agents/
├── teams/
└── skills/
```

### 9.2 导出规则

导出应：

- 省略机器本地 ID
- 省略时间戳和计数器，除非明确需要
- 省略密钥值
- 省略本地绝对路径
- 当 `AGENTS.md` 已包含指令时，省略 `.paperclip.yaml` 中重复的内联提示内容
- 保留引用和归因信息
- 在基础包旁生成 `.paperclip.yaml`
- 将适配器环境变量/密钥表达为可移植的环境变量输入声明，而非导出的密钥绑定 ID
- 原样保留兼容的 `SKILL.md` 内容

项目和议题默认不应导出。

应通过如下选择器将其设为可选项：

- `--projects project-shortname-1,project-shortname-2`
- `--issues PAP-1,PAP-3`
- `--project-issues project-shortname-1,project-shortname-2`

这支持”干净的公开公司包”工作流，维护者可以在每次导出面向关注者的公司包时不捆绑当前活跃的工作项。

### 9.3 导出单元

初始导出单元：

- 公司包
- 团队包
- 单个 agent 包

后续可选单元：

- skill 包导出
- 种子项目/任务包

## 10. Paperclip 内部存储模型

### 10.1 短期方案

在第一阶段，导入的实体可以继续映射到当前运行时表：

- company -> companies
- agent -> agents
- team -> 导入的 agent 子树挂载加包来源分组
- skill -> 公司级可复用包元数据，加上在支持的情况下的 agent 级期望 skill 挂载状态

### 10.2 中期方案

Paperclip 应添加托管的包/来源记录，使导入不再是匿名的一次性副本。

所需能力：

- 记住安装来源
- 支持重新导入/升级
- 区分本地编辑与上游包状态
- 保留外部引用和包级元数据
- 在无需立即建立运行时 `teams` 表的情况下保留导入团队分组
- 将期望 skill 状态与适配器运行时状态分开保存
- 同时支持公司级可复用 skill 和 agent 级 skill 挂载

建议的未来数据表：

- package_installs
- package_install_entities
- package_sources
- agent_skill_desires
- adapter_skill_snapshots

这不是第一阶段界面的必要条件，但对于健壮的长期系统是必需的。

## 11. API 计划

### 11.1 初期保留现有端点

保留：

- `POST /api/companies/:companyId/export`
- `POST /api/companies/import/preview`
- `POST /api/companies/import`

但将请求载荷逐步演进为 markdown 优先的图谱模型。

### 11.2 新 API 能力

新增对以下功能的支持：

- 从本地/GitHub 输入进行包根解析
- 图谱解析预览
- 来源固定版本和哈希验证结果
- 实体级选择
- 团队挂载目标选择
- 来源感知的冲突规划

### 11.3 解析变更

将当前的临时 markdown frontmatter 解析器替换为能处理以下内容的真正解析器：

- 嵌套 YAML
- 可靠的数组/对象处理
- 一致的往返转换

这是新包模型的前置条件。

## 12. CLI 计划

CLI 应继续支持无需注册中心的直接导入/导出。

目标命令：

- `paperclipai company export <company-id> --out <path>`
- `paperclipai company import <path-or-url> --dry-run`
- `paperclipai company import <path-or-url> --target existing -C <company-id>`

规划中的新增参数：

- `--package-kind company|team|agent`
- `--attach-under <agent-id-or-slug>`，用于团队导入
- `--strict-pins`
- `--allow-unpinned`
- `--materialize-references`
- `--sync-skills`

## 13. 界面计划

### 13.1 公司设置的导入/导出

在公司设置中添加完整的导入/导出区块。

导出界面：

- 导出包类型选择器
- 包含选项
- 本地下载/导出目标位置说明
- 归因/引用摘要

导入界面：

- 来源输入：
  - 在支持的情况下上传/选择文件夹
  - GitHub URL
  - 通用 URL
- 预览面板，包含：
  - 已解析的包根
  - 依赖树
  - 按实体的复选框
  - 信任/许可证警告
  - 密钥要求
  - 冲突规划

### 13.2 团队导入体验

将团队导入已有公司时：

- 展示子树结构
- 要求用户选择挂载位置
- 在应用前预览管理者/汇报关系变更
- 保留导入团队的来源信息，以便界面后续可以显示”这些 agent 来自团队包 X”

### 13.3 Skill 体验

另请参见：

- `doc/plans/2026-03-14-skills-ui-product-plan.md`

导入 skill 时：

- 展示每个 skill 是本地的、已内嵌的还是已引用的
- 展示是否包含脚本/资源文件
- 在展示和导出中保持 Agent Skills 兼容性
- 在导入和安装流程中均保持 `skills.sh` 兼容性
- 以短名称/slug 而非冗长文件路径展示 agent skill 挂载情况
- 将 agent skill 视为专属的 agent 标签页，而非配置中的一个子章节
- 在支持的情况下展示适配器当前报告的 skill
- 将期望的包 skill 与实际适配器状态分开展示
- 在适配器支持同步时提供协调操作

## 14. Rollout Phases

### Phase 1: Stabilize Current V1 Portability

- add tests for current portability flows
- replace the frontmatter parser
- add Company Settings UI for current import/export capabilities
- start cutover work toward the markdown-first package reader

### Phase 2: Markdown-First Package Reader

- support `COMPANY.md` / `TEAM.md` / `AGENTS.md` root detection
- build internal graph from markdown-first packages
- support local folder and GitHub repo inputs natively
- support agent skill references by shortname/slug
- resolve local `skills/<slug>/SKILL.md` packages by convention
- support `skills.sh`-compatible skill repos as V1 package sources

### Phase 3: Graph-Based Import UX And Skill Surfaces

- entity tree preview
- checkbox selection
- team subtree attach flow
- licensing/trust/reference warnings
- company skill library groundwork
- dedicated agent `Skills` tab groundwork
- adapter skill read/sync UI groundwork

### Phase 4: New Export Model

- export markdown-first folder structure by default

### Phase 5: Provenance And Upgrades

- persist install provenance
- support package-aware re-import and upgrades
- improve collision matching beyond slug-only
- add imported-team provenance grouping
- add desired-vs-actual skill sync state

### Phase 6: Optional Seed Content

- goals
- projects
- starter issues/tasks

This phase is intentionally after the structural model is stable.

## 15. Documentation Plan

Primary docs:

- `docs/companies/companies-spec.md` as the package-format draft
- this implementation plan for rollout sequencing

Docs to update later as implementation lands:

- `doc/SPEC-implementation.md`
- `docs/api/companies.md`
- `docs/cli/control-plane-commands.md`
- board operator docs for Company Settings import/export

## 16. Open Questions

1. Should imported skill packages be stored as managed package files in Paperclip storage, or only referenced at import time?
   Decision: managed package files should support both company-scoped reuse and agent-scoped attachment.
2. What is the minimum adapter skill interface needed to make the UI useful across Claude Code, Codex, OpenClaw, and future adapters?
   Decision: use the baseline interface in section 8.5.
3. Should Paperclip support direct local folder selection in the web UI, or keep that CLI-only initially?
4. Do we want optional generated lock files in phase 2, or defer them until provenance work?
5. How strict should pinning be by default for GitHub references:
   - warn on unpinned
   - or block in normal mode
6. Is package-provenance grouping enough for imported teams, or do we expect product requirements soon that would justify a first-class runtime `teams` table?
   Decision: provenance grouping is enough for the import/export product model for now.

## 17. Recommendation

Engineering should treat this as the current plan of record for company import/export beyond the existing V1 portability feature.

Immediate next steps:

1. accept `docs/companies/companies-spec.md` as the package-format draft
2. implement phase 1 stabilization work
3. build phase 2 markdown-first package reader before expanding ClipHub or `companies.sh`
4. treat the old manifest-based format as deprecated and not part of the future surface

This keeps Paperclip aligned with:

- GitHub-native distribution
- Agent Skills compatibility
- a registry-optional ecosystem model
