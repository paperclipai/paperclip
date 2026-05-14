# 智能体公司规范

智能体技能规范的扩展

版本：`agentcompanies/v1-draft`

## 1. 目的

智能体公司包是一种文件系统和 GitHub 原生格式，用于使用带有 YAML 前置内容的 markdown 文件描述公司、团队、智能体、项目、任务和相关技能。

本规范是智能体技能规范的扩展，而不是替代。

它定义了公司、团队和智能体级别的包结构如何围绕现有的 `SKILL.md` 模型组合。

本规范是供应商中立的。它旨在可供任何智能体公司运行时使用，而不仅仅是 Paperclip。

格式设计为：

- 可由人类读写
- 直接从本地文件夹或 GitHub 仓库工作
- 不需要中央注册表
- 支持属性和固定引用到上游文件
- 扩展现有的智能体技能生态系统而不重新定义它
- 在 Paperclip 外部有用

## 2. 核心原则

1. Markdown 是规范的。
2. Git 仓库是有效的包容器。
3. 注册表是可选的发现层，而不是权威。
4. `SKILL.md` 仍由智能体技能规范拥有。
5. 外部引用必须可固定到不可变的 Git 提交。
6. 属性和许可证元数据必须在导入/导出中幸存。
7. slug 和相对路径是可移植的标识层，而不是数据库 ID。
8. 约定的文件夹结构应该无需冗长接线即可工作。
9. 供应商特定的保真度属于可选扩展，而不是基础包。

## 3. 包种类

包根由一个主要的 markdown 文件标识：

- `COMPANY.md` 用于公司包
- `TEAM.md` 用于团队包
- `AGENTS.md` 用于智能体包
- `PROJECT.md` 用于项目包
- `TASK.md` 用于任务包
- `SKILL.md` 用于智能体技能规范定义的技能包

GitHub 仓库可以在根目录包含一个包，或在子目录中包含多个包。

## 4. 保留文件和目录

常见约定：

```text
COMPANY.md
TEAM.md
AGENTS.md
PROJECT.md
TASK.md
SKILL.md

agents/<slug>/AGENTS.md
teams/<slug>/TEAM.md
projects/<slug>/PROJECT.md
projects/<slug>/tasks/<slug>/TASK.md
tasks/<slug>/TASK.md
skills/<slug>/SKILL.md
.paperclip.yaml

HEARTBEAT.md
SOUL.md
TOOLS.md
README.md
assets/
scripts/
references/
```

规则：

- 只有 markdown 文件是规范内容文档
- 允许非 markdown 目录，如 `assets/`、`scripts/` 和 `references/`
- 包工具可以生成可选的锁定文件，但锁定文件不是创作所必需的

## 5. 通用前置内容

包文档可能支持这些字段：

```yaml
schema: agentcompanies/v1
kind: company | team | agent | project | task
slug: my-slug
name: Human Readable Name
description: Short description
version: 0.1.0
license: MIT
authors:
  - name: Jane Doe
homepage: https://example.com
tags:
  - startup
  - engineering
metadata: {}
sources: []
```

注意：

- `schema` 是可选的，通常只应出现在包根目录
- 当文件路径和文件名已经使类型明显时，`kind` 是可选的
- `slug` 应该是 URL 安全且稳定的
- `sources` 用于来源和外部引用
- `metadata` 用于工具特定的扩展
- 导出器应省略空或默认值的字段

## 6. COMPANY.md

`COMPANY.md` 是整个公司包的根入口点。

### 必需字段

```yaml
name: Lean Dev Shop
description: Small engineering-focused AI company
slug: lean-dev-shop
schema: agentcompanies/v1
```

### 推荐字段

```yaml
version: 1.0.0
license: MIT
authors:
  - name: Example Org
goals:
  - Build and ship software products
includes:
  - https://github.com/example/shared-company-parts/blob/0123456789abcdef0123456789abcdef01234567/teams/engineering/TEAM.md
requirements:
  secrets:
    - OPENAI_API_KEY
```

### 语义

- `includes` 定义包图
- 本地包内容应通过文件夹约定隐式发现
- `includes` 是可选的，应主要用于外部引用或非标准位置
- 包含的项目可以是本地或外部引用
- `COMPANY.md` 可以直接包含智能体、团队、项目、任务或技能
- 公司导入器可以将 `includes` 渲染为树/复选框导入 UI

## 7. TEAM.md

`TEAM.md` 定义组织子树。

### 示例

```yaml
name: Engineering
description: Product and platform engineering team
schema: agentcompanies/v1
slug: engineering
manager: ../cto/AGENTS.md
includes:
  - ../platform-lead/AGENTS.md
  - ../frontend-lead/AGENTS.md
  - ../../skills/review/SKILL.md
tags:
  - team
  - engineering
```

### 语义

- 团队包是可重用的子树，不一定是运行时数据库表
- `manager` 标识子树的根智能体
- `includes` 可能包含子智能体、子团队或共享技能
- 团队包可以导入到现有公司中，并附加到目标经理下

## 8. AGENTS.md

`AGENTS.md` 定义智能体。

### 示例

```yaml
name: CEO
title: Chief Executive Officer
reportsTo: null
skills:
  - plan-ceo-review
  - review
```

### 语义

- 正文内容是智能体规范默认指令内容
- `docs` 指向同级 markdown 文档（如果存在）
- `skills` 通过**技能短名称**（skill short name）或 **slug**（URL 友好标识）引用可重用的 `SKILL.md` 包
- 像 `review` 这样的裸技能条目应按约定解析为 `skills/review/SKILL.md`
- 如果包引用外部技能，智能体仍应通过**短名称**（short name）引用技能；技能包本身拥有任何源引用、固定或属性详细信息
- 工具可能允许路径或 URL 条目作为逃生舱，但导出器应优先在 `AGENTS.md` 中使用基于**短名称**（short name）的技能引用
- 供应商特定的适配器/运行时配置不应位于基础包中
- 本地绝对路径、机器特定的 cwd 值和秘密值不得作为规范包数据导出

### 技能解析

- `AGENTS.md` 里的 `skills:` 列表首选只写**技能短名称**（skill short name），一般不要求写磁盘路径或 URL。
- **包内约定**：可移植仓库里，技能默认放在 `skills/<shortname>/SKILL.md`；`<shortname>` 就是该技能的短名称（例：短名称为 `review` 时，对应路径为 `skills/review/SKILL.md`）。
- **运行时侧**：具体产品可以把技能**导入**成「公司技能库」等托管条目；解析时用**相同的短名称**与包内 `skills:` 对齐。包内布局与库内条目是两种存放方式，短名称是共用键。
- 短名称与 **slug**（URL 友好标识）在实践上常一致；以包或工具声明的为准。

智能体技能条目的建议解析顺序：

1. 当前包内的 `skills/<shortname>/SKILL.md`
2. 由 `includes` 等纳入的其他包中，slug 或短名称匹配的技能包
3. 工具托管的**公司技能库**（或其它等价注册表）中，短名称匹配的条目

规则：

- 导出器应在 `AGENTS.md` 中尽可能发出**短名称**（short name）
- 导入器不应要求普通技能引用的完整文件路径
- 技能包本身应携带外部引用、供应商、镜像或固定上游内容的任何复杂性
- 这保持了 `AGENTS.md` 的可读性和与 `skills.sh` 风格共享的一致性

## 9. PROJECT.md

`PROJECT.md` 定义轻量级项目包。

### 示例

```yaml
name: Q2 Launch
description: Ship the Q2 launch plan and supporting assets
owner: cto
```

### 语义

- 项目包将相关的入门任务和支持的 markdown 分组
- 当有明确的项目所有者时，`owner` 应引用智能体 slug
- 约定的 `tasks/` 子文件夹应隐式发现
- 当需要显式接线时，`includes` 可能包含 `TASK.md`、`SKILL.md` 或支持文档
- 项目包旨在播种计划的工作，而不是表示运行时任务状态

## 10. TASK.md

`TASK.md` 定义轻量级入门任务。

### 示例

```yaml
name: Monday Review
assignee: ceo
project: q2-launch
recurring: true
```

### 语义

- 正文内容是规范的 markdown 任务描述
- `assignee` 应引用包内的智能体 slug
- 当任务属于 `PROJECT.md` 时，`project` 应引用项目 slug
- `recurring: true` 将任务标记为持续重复的工作，而不是一次性入门任务
- 任务有意是基本的种子工作：标题、markdown 正文、负责人、项目链接和可选的 `recurring: true`
- 工具可能还支持可选字段，如 `priority`、`labels` 或 `metadata`，但它们不应要求在基础包中

### 重复任务

- 基础包只需要说明任务是否重复
- 供应商可以在供应商扩展（如 `.paperclip.yaml`）中附加实际的计划/触发器/运行时保真度
- 这保持了 `TASK.md` 的可移植性，同时仍然允许更丰富的运行时系统往返它们自己的自动化详细信息
- 传统包在转换期间可能仍使用 `schedule.recurrence`，但导出器应优先使用 `recurring: true`

示例 Paperclip 扩展：

```yaml
routines:
  monday-review:
    triggers:
      - kind: schedule
        cronExpression: "0 9 * * 1"
        timezone: America/Chicago
```

- 供应商应忽略它们不理解的未知重复任务扩展
- 导入传统 `schedule.recurrence` 数据的供应商可以将其转换为它们自己的运行时触发器模型，但新的导出应优先使用更简单的 `recurring: true` 基础字段

## 11. SKILL.md 兼容性

技能包必须保持为有效的智能体技能包。

规则：

- `SKILL.md` 应遵循智能体技能规范
- Paperclip 不得要求额外的顶级字段来保证技能有效性
- Paperclip 特定的扩展必须位于 `metadata.paperclip` 或 `metadata.sources` 下
- 技能目录可能包括 `scripts/`、`references/` 和 `assets/`，正如智能体技能生态系统所期望的那样
- 实现此规范的工具应将 `skills.sh` 兼容性视为一流目标，而不是发明并行技能格式

换句话说，此规范将智能体技能向上扩展到公司/团队/智能体组合。它不重新定义技能包语义。

### 示例兼容扩展

```yaml
---
name: review
description: Paranoid code review skill
allowed-tools:
  - Read
  - Grep
metadata:
  paperclip:
    tags:
      - engineering
      - review
  sources:
    - kind: github-file
      repo: vercel-labs/skills
      path: review/SKILL.md
      commit: 0123456789abcdef0123456789abcdef01234567
      sha256: 3b7e...9a
      attribution: Vercel Labs
      usage: referenced
---
```

## 12. 源引用

包可以指向上游内容而不是供应商化。

### 源对象

```yaml
sources:
  - kind: github-file
    repo: owner/repo
    path: path/to/file.md
    commit: 0123456789abcdef0123456789abcdef01234567
    blob: abcdef0123456789abcdef0123456789abcdef01
    sha256: 3b7e...9a
    url: https://github.com/owner/repo/blob/0123456789abcdef0123456789abcdef01234567/path/to/file.md
    rawUrl: https://raw.githubusercontent.com/owner/repo/0123456789abcdef0123456789abcdef01234567/path/to/file.md
    attribution: Owner Name
    license: MIT
    usage: referenced
```

### 支持的类型

- `local-file`
- `local-dir`
- `github-file`
- `github-dir`
- `url`

### 使用模式

- `vendored`：字节包含在包中
- `referenced`：包指向上游不可变内容
- `mirrored`：字节在本地缓存，但上游属性保持规范

### 规则

- 在严格模式下，`github-file` 和 `github-dir` 需要 `commit`
- 强烈推荐 `sha256`，并且应在获取时验证
- 仅分支引用在开发模式下可能被允许，但必须警告
- 对于第三方内容，导出器应默认为 `referenced`，除非明确允许重新分发

## 13. 解析规则

给定包根目录，导入器按以下顺序解析：

1. 本地相对路径
2. 如果导入工具明确允许，本地绝对路径
3. 固定的 GitHub 引用
4. 通用 URL

对于固定的 GitHub 引用：

1. 解析 `repo + commit + path`
2. 获取内容
3. 如果存在，验证 `sha256`
4. 如果存在，验证 `blob`
5. 在不匹配时失败关闭

导入器必须显示：

- 缺失文件
- 哈希不匹配
- 缺失许可证
- 需要网络获取的已引用上游内容
- 技能或脚本中的可执行内容

## 14. 导入图

包导入器应从以下内容构建图：

- `COMPANY.md`
- `TEAM.md`
- `AGENTS.md`
- `PROJECT.md`
- `TASK.md`
- `SKILL.md`
- 本地和外部引用

建议的导入 UI 行为：

- 将图渲染为树
- 在实体级别复选框，而不是原始文件级别
- 选择智能体会自动选择所需文档和引用的技能
- 选择团队会自动选择其子树
- 选择项目会自动选择其包含的任务
- 选择重复任务应清楚地表明导入目标是例程/自动化，而不是一次性任务
- 选择引用的第三方内容显示属性、许可证和获取策略

## 15. 供应商扩展

供应商特定的数据应位于基础包形状之外。

对于 Paperclip，首选保真度扩展是：

```text
.paperclip.yaml
```

示例用途：

- 适配器类型和适配器配置
- 适配器环境输入和默认值
- 运行时设置
- 权限
- 预算
- 批准策略
- 项目执行工作区策略
- 问题/任务 Paperclip 仅元数据

规则：

- 基础包必须保持可读，无需扩展
- 不理解供应商扩展的工具应忽略它
- Paperclip 工具可能默认发出供应商扩展作为副车，同时保持基础 markdown 干净

建议的 Paperclip 形状：

```yaml
schema: paperclip/v1
agents:
  claudecoder:
    adapter:
      type: claude_local
      config:
        model: claude-opus-4-6
    inputs:
      env:
        ANTHROPIC_API_KEY:
          kind: secret
          requirement: optional
          default: ""
        GH_TOKEN:
          kind: secret
          requirement: optional
        CLAUDE_BIN:
          kind: plain
          requirement: optional
          default: claude
routines:
  monday-review:
    triggers:
      - kind: schedule
        cronExpression: "0 9 * * 1"
        timezone: America/Chicago
```

Paperclip 导出器的附加规则：

- 当 `AGENTS.md` 已包含智能体指令时，不要复制 `promptTemplate`
- 不要导出提供商特定的秘密绑定，如 `secretId`、`version` 或 `type: secret_ref`
- 将环境输入导出为具有 `required` 或 `optional` 语义和可选默认值的可移植声明
- 对系统相关值（如绝对命令和绝对 `PATH` 覆盖）发出警告
- 尽可能省略空和默认值的 Paperclip 字段

## 16. 导出规则

合规的导出器应：

- 发出 markdown 根目录和相对文件夹布局
- 省略机器本地 ID 和时间戳
- 省略秘密值
- 省略机器特定路径
- 导出任务时保留任务描述和重复任务声明
- 省略空/默认字段
- 默认为供应商中立的基础包
- Paperclip 导出器应默认发出 `.paperclip.yaml` 作为副车
- 保留属性和源引用
- 对于第三方内容，优先使用 `referenced` 而不是静默供应商化
- 导出兼容技能时原样保留 `SKILL.md`

## 17. 许可和属性

合规工具必须：

- 导入和导出时保留 `license` 和 `attribution` 元数据
- 区分供应商化与引用内容
- 导出时不要静默内联引用的第三方内容
- 将缺失许可证元数据显示为警告
- 在安装/导入前显示限制性或许可证未知，如果内容被供应商化或镜像

## 18. 可选锁定文件

创作不需要锁定文件。

工具可能生成可选的锁定文件，例如：

```text
company-package.lock.json
```

目的：

- 缓存已解析的引用
- 记录最终哈希
- 支持可复现的安装

规则：

- 锁定文件是可选的
- 锁定文件是生成的工件，而不是规范的创作输入
- markdown 包保持为真实来源

## 19. Paperclip 映射

Paperclip 可以将此规范映射到其运行时模型，如下所示：

- 基础包：
  - `COMPANY.md` -> 公司元数据
  - `TEAM.md` -> 可导入的组织子树
  - `AGENTS.md` -> 智能体身份和指令
  - `PROJECT.md` -> 入门项目定义
  - `TASK.md` -> 入门问题/任务定义，或当 `recurring: true` 时的重复任务模板
  - `SKILL.md` -> 导入的技能包
  - `sources[]` -> 来源和固定的上游引用
- Paperclip 扩展：
  - `.paperclip.yaml` -> 适配器配置、运行时配置、环境输入声明、权限、预算、例程触发器和其他 Paperclip 特定保真度

必须位于共享 markdown 文件内的内联 Paperclip 仅元数据应使用：

- `metadata.paperclip`

这保持了基础格式比 Paperclip 更广泛。

本规范本身保持供应商中立，适用于任何智能体公司运行时，而不仅仅是 Paperclip。

## 20. 切换

Paperclip 应切换到这种以 markdown 为中心的包模型作为主要的可移植格式。

`paperclip.manifest.json` 不需要作为未来包系统的兼容性要求保留。

对于 Paperclip，这应被视为产品方向中的硬切换，而不是长期的双格式策略。

## 21. 最小示例

```text
lean-dev-shop/
├── COMPANY.md
├── agents/
│   ├── ceo/AGENTS.md
│   └── cto/AGENTS.md
├── projects/
│   └── q2-launch/
│       ├── PROJECT.md
│       └── tasks/
│           └── monday-review/
│               └── TASK.md
├── teams/
│   └── engineering/TEAM.md
├── tasks/
│   └── weekly-review/TASK.md
└── skills/
    └── review/SKILL.md

可选：

```text
.paperclip.yaml
```
```

**建议**
这是我将采取的方向：

- 使其成为面向人类的规范
- 将 `SKILL.md` 兼容性定义为不可谈判的
- 将此规范视为智能体技能的扩展，而不是并行格式
- 使 `companies.sh` 成为实现此规范的仓库的发现层，而不是发布权威