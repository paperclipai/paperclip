# 2026-03-13 公司导入/导出 V2 计划

状态：提议的实现计划
日期：2026-03-13
受众：产品和工程
在包格式方向上取代：
- `doc/plans/2026-02-16-module-system.md` 中将公司模板描述为仅 JSON 的部分
- `docs/specs/cliphub-plan.md` 中关于蓝图包形态的假设（与 markdown 优先的包模型冲突的部分）

## 1. 目的

本文档定义了 Paperclip 公司导入/导出的下一阶段计划。

核心转变是：

- 从 Paperclip 专有的 JSON 优先可移植包转向 markdown 优先的包格式
- 将 GitHub 仓库作为一等包源
- 将公司包模型视为现有 Agent Skills 生态系统的扩展，而不是发明单独的技能格式
- 支持公司、团队、智能体和技能的复用，无需中央注册中心

规范的包格式草案在：

- `docs/companies/companies-spec.md`

本计划关于 Paperclip 内部的实现和推出。

适配器范围的技能推出细节在：

- `doc/plans/2026-03-14-adapter-skill-sync-rollout.md`

## 2. 执行摘要

Paperclip 仓库中已有可移植性原语：

- 服务器导入/导出/预览 API
- CLI 导入/导出命令
- 共享的可移植性类型和验证器

这些原语正被切换到新的包模型，而不是为向后兼容而扩展。

新方向是：

1. markdown 优先的包编写
2. GitHub 仓库或本地文件夹作为默认的事实来源
3. 一个厂商中立的基础包规范，面向智能体公司运行时，而不仅是 Paperclip
4. 公司包模型明确是 Agent Skills 的扩展
5. 未来不依赖 `paperclip.manifest.json`
6. 通用场景通过约定的隐式文件夹发现
7. 始终生成的 `.paperclip.yaml` 附属文件用于高保真的 Paperclip 特定细节
8. 导入时的包图解析
9. 带依赖感知树选择的实体级导入 UI
10. `skills.sh` 兼容性是技能包和技能安装流程的 V1 要求
11. 适配器感知的技能同步界面，使 Paperclip 能在适配器支持的情况下读取、对比、启用、禁用和协调技能

## 3. 产品目标

### 3.1 目标

- 用户可以将 Paperclip 指向本地文件夹或 GitHub 仓库，无需注册中心即可导入公司包。
- 包对人类可读可写，使用正常的 git 工作流。
- 包可以包含：
  - 公司定义
  - 组织子树 / 团队定义
  - 智能体定义
  - 可选的启动项目和任务
  - 可复用的技能
- V1 技能支持与现有的 `skills.sh` / Agent Skills 生态系统兼容。
- 用户可以导入到：
  - 新公司
  - 现有公司
- 导入预览显示：
  - 将要创建的内容
  - 将要更新的内容
  - 跳过的内容
  - 外部引用的内容
  - 需要密钥或审批的内容
- 导出保留归属、许可证和固定的上游引用。
- 导出产生干净的厂商中立包加上 Paperclip 附属文件。
- `companies.sh` 后续可作为实现此格式的仓库的发现/索引层。

### 3.2 非目标

- 包有效性不需要中央注册中心。
- 这不是完整的数据库备份/恢复。
- 这不尝试导出运行时状态，如：
  - 心跳运行
  - API 密钥
  - 花费总额
  - 运行会话
  - 临时工作区
- 这不要求在团队可移植性发布前有一等运行时 `teams` 表。

## 4. 仓库中的当前状态

当前实现位于：

- 共享类型：`packages/shared/src/types/company-portability.ts`
- 共享验证器：`packages/shared/src/validators/company-portability.ts`
- 服务器路由：`server/src/routes/companies.ts`
- 服务器服务：`server/src/services/company-portability.ts`
- CLI 命令：`cli/src/commands/client/company.ts`

当前产品限制：

1. 导入/导出 UX 仍需更深层的树选择和技能/包管理打磨。
2. 适配器特定的技能同步在不同适配器间仍不均匀，且必须在不支持时优雅降级。
3. 项目和启动任务应在导出时保持可选，而不是默认包内容。
4. 导入/导出仍需在归属、固定验证和可执行包警告方面加强覆盖。
5. 当前的 markdown frontmatter 解析器有意保持轻量，应保持受限于文档化的形态。

## 5. 规范包方向

### 5.1 规范编写格式

规范编写格式变为以 markdown 优先的包，根文件为以下之一：

- `COMPANY.md`
- `TEAM.md`
- `AGENTS.md`
- `PROJECT.md`
- `TASK.md`
- `SKILL.md`

规范草案为：

- `docs/companies/companies-spec.md`

### 5.2 与 Agent Skills 的关系

Paperclip 不得重新定义 `SKILL.md`。

规则：

- `SKILL.md` 保持 Agent Skills 兼容
- 公司包模型是 Agent Skills 的扩展
- 基础包是厂商中立的，面向任何智能体公司运行时
- Paperclip 特定的高保真信息存放在 `.paperclip.yaml` 中
- Paperclip 可以解析和安装 `SKILL.md` 包，但不得要求 Paperclip 专有的技能格式
- `skills.sh` 兼容性是 V1 要求，而不是未来的锦上添花

### 5.3 智能体到技能的关联

`AGENTS.md` 应通过技能简称或 slug 关联技能，而不是在通用场景下使用冗长的路径。

首选示例：

- `skills: [review, react-best-practices]`

解析模型：

- `review` 按包约定解析为 `skills/review/SKILL.md`
- 如果技能是外部的或被引用的，技能包负责处理该复杂性
- 导出器应在 `AGENTS.md` 中优先使用简称关联
- 导入器应先在本地包技能中解析简称，然后是引用的或已安装的公司技能

### 5.4 基础包与 Paperclip 扩展

仓库格式应有两层：

- 基础包：
  - 最小化、可读、社交化、厂商中立
  - 按约定的隐式文件夹发现
  - 默认无 Paperclip 专有运行时字段
- Paperclip 扩展：
  - `.paperclip.yaml`
  - 适配器/运行时/权限/预算/工作区的高保真信息
  - 由 Paperclip 工具作为附属文件生成，同时基础包保持可读

### 5.5 与当前 V1 清单的关系

`paperclip.manifest.json` 不属于未来包方向。

这应被视为产品方向的硬切换。

- markdown 优先的仓库布局是目标
- 新工作不应加深对旧清单模型的投入
- 未来的可移植性 API 和 UI 应仅面向 markdown 优先模型

## 6. 包图模型

### 6.1 实体类型

Paperclip 导入/导出应支持以下实体类型：

- 公司
- 团队
- 智能体
- 项目
- 任务
- 技能

### 6.2 团队语义

`团队` 首先是一个包概念，而不是数据库表的要求。

在 Paperclip V2 可移植性中：

- 团队是一个可导入的组织子树
- 它以一个经理智能体为根
- 它可以挂载到现有公司中的目标经理下

这避免了将可移植性阻塞在未来的运行时 `teams` 模型上。

导入团队的跟踪应初始基于包/来源追溯：

- 如果导入了团队包，导入的智能体应携带足够的来源信息以重建该分组
- Paperclip 可以将"这组智能体来自团队包 X"作为导入团队模型
- 来源追溯分组是导入/导出的近期和中期团队模型
- 仅在产品需求超出来源追溯分组表达能力时，才添加一等运行时 `teams` 表

### 6.3 依赖图

导入应操作实体图，而不是原始文件选择。

示例：

- 选择一个智能体自动选择其所需文档和技能引用
- 选择一个团队自动选择其子树
- 选择一个公司默认自动选择所有包含的实体
- 选择一个项目自动选择其启动任务

预览输出应明确反映图解析结果。

## 7. 外部引用、固定和归属

### 7.1 为什么这很重要

某些包会：

- 引用我们不想重新发布的上游文件
- 包含必须保持归属可见的第三方作品
- 需要防止分支热切换的保护

### 7.2 策略

Paperclip 应支持包元数据中的源引用，包含：

- 仓库
- 路径
- commit sha
- 可选的 blob sha
- 可选的 sha256
- 归属
- 许可证
- 使用模式

使用模式：

- `vendored`
- `referenced`
- `mirrored`

第三方内容的默认导出行为应为：

- 优先 `referenced`
- 保留归属
- 不静默地将第三方内容内联到导出中

### 7.3 信任模型

导入的包内容应按信任级别分类：

- 仅 markdown
- markdown + 资源文件
- markdown + 脚本/可执行文件

UI 和 CLI 应在应用前清楚地展示这一信息。

## 8. 导入行为

### 8.1 支持的源

- 本地文件夹
- 本地包根文件
- GitHub 仓库 URL
- GitHub 子树 URL
- markdown/包根的直接 URL

基于注册中心的发现可在后续添加，但必须保持可选。

### 8.2 导入目标

- 新公司
- 现有公司

对于现有公司的导入，预览必须支持：

- 冲突处理
- 团队导入的挂载点选择
- 选择性实体导入

### 8.3 冲突策略

当前的 `rename | skip | replace` 支持保留，但匹配应随时间改进。

首选匹配顺序：

1. 先前安装来源追溯
2. 稳定的包实体标识
3. slug
4. 人类名称作为弱后备

仅 slug 匹配仅作为过渡策略可接受。

### 8.4 必需的预览输出

每次导入预览应展示：

- 目标公司操作
- 实体级别的创建/更新/跳过计划
- 引用的外部内容
- 缺失的文件
- 哈希不匹配或固定问题
- 环境输入，包括必需与可选以及存在时的默认值
- 不支持的内容类型
- 信任/许可证警告

### 8.5 适配器技能同步界面

用户希望在 UI 中管理技能，但技能是适配器相关的。

这意味着可移植性和 UI 规划必须包含技能的适配器能力模型。

Paperclip 应围绕技能定义新的适配器表面区域：

- 列出智能体当前启用的技能
- 报告这些技能在适配器中的表示方式
- 安装或启用技能
- 禁用或移除技能
- 报告期望包配置与实际适配器状态之间的同步状态

示例：

- Claude Code / Codex 风格的适配器可能将技能管理为本地文件系统包或适配器拥有的技能目录
- OpenClaw 风格的适配器可能通过 API 或反射的配置界面暴露当前启用的技能
- 某些适配器可能是只读的，仅报告其拥有的内容

计划的适配器能力形态：

- `supportsSkillRead`
- `supportsSkillWrite`
- `supportsSkillRemove`
- `supportsSkillSync`
- `skillStorageKind` 如 `filesystem`、`remote_api`、`inline_config` 或 `unknown`

基线适配器接口：

- `listSkills(agent)`
- `applySkills(agent, desiredSkills)`
- `removeSkill(agent, skillId)` 可选
- `getSkillSyncState(agent, desiredSkills)` 可选

计划的 Paperclip 行为：

- 如果适配器支持读取，Paperclip 应在 UI 中显示当前技能
- 如果适配器支持写入，Paperclip 应让用户启用/禁用导入的技能
- 如果适配器支持同步，Paperclip 应计算期望与实际状态并提供协调操作
- 如果适配器不支持这些能力，UI 仍应显示包级别的期望技能，但标记为未托管

## 9. 导出行为

### 9.1 默认导出目标

默认导出目标应变为 markdown 优先的文件夹结构。

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

- 省略机器本地 id
- 省略时间戳和计数器，除非明确需要
- 省略密钥值
- 省略本地绝对路径
- 当 `AGENTS.md` 已携带指令时，省略 `.paperclip.yaml` 中重复的内联 prompt 内容
- 保留引用和归属
- 在基础包旁生成 `.paperclip.yaml`
- 将适配器环境/密钥表示为可移植的环境输入声明，而不是导出的密钥绑定 id
- 按原样保留兼容的 `SKILL.md` 内容

项目和任务默认不应导出。

它们应通过选择器选择加入，如：

- `--projects project-shortname-1,project-shortname-2`
- `--issues PAP-1,PAP-3`
- `--project-issues project-shortname-1,project-shortname-2`

这支持"干净的公开公司包"工作流，维护者可以导出面向关注者的公司包而不必每次都捆绑活跃的工作项。

### 9.3 导出单元

初始导出单元：

- 公司包
- 团队包
- 单个智能体包

后续可选单元：

- 技能包导出
- 种子项目/任务捆绑

## 10. Paperclip 内部的存储模型

### 10.1 短期

在第一阶段，导入的实体可以继续映射到当前运行时表：

- 公司 -> companies
- 智能体 -> agents
- 团队 -> 导入的智能体子树挂载加上包来源追溯分组
- 技能 -> 公司范围的可复用包元数据加上适配器支持情况下的智能体范围期望技能挂载状态

### 10.2 中期

Paperclip 应添加托管的包/来源追溯记录，使导入不再是匿名的一次性复制。

需要的能力：

- 记住安装来源
- 支持重新导入 / 升级
- 区分本地编辑和上游包状态
- 保留外部引用和包级元数据
- 保留导入团队分组而不要求立即有运行时 `teams` 表
- 将期望技能状态与适配器运行时状态分开保留
- 支持公司范围的可复用技能和智能体范围的技能挂载

建议的未来表：

- package_installs
- package_install_entities
- package_sources
- agent_skill_desires
- adapter_skill_snapshots

这对第一阶段 UI 不是必需的，但对健壮的长期系统是必需的。

## 11. API 计划

### 11.1 初始保留现有端点

保留：

- `POST /api/companies/:companyId/export`
- `POST /api/companies/import/preview`
- `POST /api/companies/import`

但将负载向 markdown 优先的图模型演进。

### 11.2 新 API 能力

添加支持：

- 从本地/GitHub 输入的包根解析
- 图解析预览
- 源固定和哈希验证结果
- 实体级选择
- 团队挂载目标选择
- 来源追溯感知的冲突规划

### 11.3 解析变更

将当前临时的 markdown frontmatter 解析器替换为能处理以下内容的真正解析器：

- 嵌套 YAML
- 数组/对象可靠解析
- 一致的往返转换

这是新包模型的先决条件。

## 12. CLI 计划

CLI 应继续支持无需注册中心的直接导入/导出。

目标命令：

- `paperclipai company export <company-id> --out <path>`
- `paperclipai company import --from <path-or-url> --dry-run`
- `paperclipai company import --from <path-or-url> --target existing -C <company-id>`

计划添加：

- `--package-kind company|team|agent`
- `--attach-under <agent-id-or-slug>` 用于团队导入
- `--strict-pins`
- `--allow-unpinned`
- `--materialize-references`
- `--sync-skills`

## 13. UI 计划

### 13.1 公司设置导入/导出

在公司设置中添加真正的导入/导出部分。

导出 UI：

- 导出包类型选择器
- 包含选项
- 本地下载/导出目标指引
- 归属/引用摘要

导入 UI：

- 源输入：
  - 支持上传/文件夹
  - GitHub URL
  - 通用 URL
- 预览面板包含：
  - 解析的包根
  - 依赖树
  - 按实体的复选框
  - 信任/许可证警告
  - 密钥要求
  - 冲突计划

### 13.2 团队导入 UX

如果将团队导入到现有公司：

- 显示子树结构
- 要求用户选择挂载位置
- 在应用前预览经理/汇报关系更新
- 保留导入团队来源追溯，以便 UI 后续可以说"这些智能体来自团队包 X"

### 13.3 技能 UX

另请参见：

- `doc/plans/2026-03-14-skills-ui-product-plan.md`

如果导入技能：

- 显示每个技能是本地的、vendored 的还是引用的
- 显示是否包含脚本/资源文件
- 在展示和导出中保留 Agent Skills 兼容性
- 在导入和安装流程中保留 `skills.sh` 兼容性
- 通过简称/slug 显示智能体技能挂载，而不是嘈杂的文件路径
- 将智能体技能作为专用的智能体标签页，而不仅是配置的一个子部分
- 在支持的情况下显示当前适配器报告的技能
- 将期望包技能与实际适配器状态分开显示
- 在适配器支持同步时提供协调操作

## 14. 推出阶段

### 第一阶段：稳定当前 V1 可移植性

- 为当前可移植性流程添加测试
- 替换 frontmatter 解析器
- 为当前导入/导出能力添加公司设置 UI
- 开始向 markdown 优先包读取器的切换工作

### 第二阶段：Markdown 优先包读取器

- 支持 `COMPANY.md` / `TEAM.md` / `AGENTS.md` 根检测
- 从 markdown 优先包构建内部图
- 原生支持本地文件夹和 GitHub 仓库输入
- 支持通过简称/slug 引用智能体技能
- 按约定解析本地 `skills/<slug>/SKILL.md` 包
- 支持 `skills.sh` 兼容的技能仓库作为 V1 包源

### 第三阶段：基于图的导入 UX 和技能界面

- 实体树预览
- 复选框选择
- 团队子树挂载流程
- 许可证/信任/引用警告
- 公司技能库基础工作
- 专用智能体 `Skills` 标签页基础工作
- 适配器技能读取/同步 UI 基础工作

### 第四阶段：新导出模型

- 默认导出 markdown 优先的文件夹结构

### 第五阶段：来源追溯和升级

- 持久化安装来源追溯
- 支持包感知的重新导入和升级
- 改进超越仅 slug 的冲突匹配
- 添加导入团队来源追溯分组
- 添加期望与实际技能同步状态

### 第六阶段：可选种子内容

- 目标
- 项目
- 启动任务

此阶段有意安排在结构模型稳定之后。

## 15. 文档计划

主要文档：

- `docs/companies/companies-spec.md` 作为包格式草案
- 本实现计划用于推出排序

随实现落地后续更新的文档：

- `doc/SPEC-implementation.md`
- `docs/api/companies.md`
- `docs/cli/control-plane-commands.md`
- 面向 board 操作者的公司设置导入/导出文档

## 16. 开放问题

1. 导入的技能包应作为托管包文件存储在 Paperclip 存储中，还是仅在导入时引用？
   决定：托管包文件应同时支持公司范围的复用和智能体范围的挂载。
2. 使 UI 在 Claude Code、Codex、OpenClaw 和未来适配器间有用所需的最小适配器技能接口是什么？
   决定：使用第 8.5 节中的基线接口。
3. Paperclip 是否应该在 Web UI 中支持直接本地文件夹选择，还是初始保持仅 CLI？
4. 我们是否希望在第二阶段使用可选的生成锁文件，还是推迟到来源追溯工作？
5. GitHub 引用的固定默认应多严格：
   - 对未固定的发出警告
   - 还是在正常模式下阻止
6. 包来源追溯分组对导入团队是否足够，还是我们预期很快会有产品需求来证明一等运行时 `teams` 表的合理性？
   决定：对于当前的导入/导出产品模型，来源追溯分组足够。

## 17. 建议

工程团队应将此视为公司导入/导出在现有 V1 可移植性功能之后的当前记录计划。

立即的下一步：

1. 接受 `docs/companies/companies-spec.md` 作为包格式草案
2. 实现第一阶段稳定工作
3. 在扩展 ClipHub 或 `companies.sh` 之前构建第二阶段 markdown 优先包读取器
4. 将旧的基于清单的格式视为已弃用且不属于未来表面

这使 Paperclip 保持与以下方向对齐：

- GitHub 原生分发
- Agent Skills 兼容性
- 注册中心可选的生态系统模型
