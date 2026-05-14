---
title: 导入和导出公司
summary: 将公司导出到可移植包并从本地路径或 GitHub 导入
---

Paperclip 公司可以导出为可移植的 markdown 包，并从本地目录或 GitHub 仓库导入。这允许你共享公司配置、复制设置并版本控制你的智能体团队。

## 包格式

导出的包遵循[代理公司规范](/公司/公司规范%20companies-spec)并使用以 markdown 为中心的结构：

```text
my-company/
├── COMPANY.md          # 公司元数据
├── agents/
│   ├── ceo/AGENT.md    # 智能体指令 + 前置内容
│   └── cto/AGENT.md
├── projects/
│   └── main/PROJECT.md
├── skills/
│   └── review/SKILL.md
├── tasks/
│   └── onboarding/TASK.md
└── .paperclip.yaml     # 适配器配置、环境输入、例程
```

- **COMPANY.md** 定义公司名称、描述和元数据。
- **AGENT.md** 文件包含智能体身份、角色和指令。
- **SKILL.md** 文件与智能体技能生态系统兼容。
- **.paperclip.yaml** 将 Paperclip 特定配置（适配器类型、环境输入、预算）作为可选副车。

## 导出公司

将公司导出到可移植文件夹：

```sh
paperclipai company export <company-id> --out ./my-export
```

### 选项

| 选项 | 描述 | 默认值 |
|--------|-------------|---------|
| `--out <path>` | 输出目录（必需） | — |
| `--include <values>` | 逗号分隔的集合：`company`、`agents`、`projects`、`issues`、`tasks`、`skills` | `company,agents` |
| `--skills <values>` | 仅导出特定的技能 slug | 全部 |
| `--projects <values>` | 仅导出特定的项目简称或 ID | 全部 |
| `--issues <values>` | 导出特定的事务标识符或 ID | 无 |
| `--project-issues <values>` | 导出属于特定项目的事务 | 无 |
| `--expand-referenced-skills` | 供应商技能文件内容，而不是保留上游引用 | `false` |

### 示例

```sh
# 导出带有智能体和公司的公司
paperclipai company export abc123 --out ./backup --include company,agents,projects

# 导出所有内容，包括任务和技能
paperclipai company export abc123 --out ./full-export --include company,agents,projects,tasks,skills

# 仅导出特定技能
paperclipai company export abc123 --out ./skills-only --include skills --skills review,deploy
```

### 导出了什么

- 公司名称、描述和元数据
- 智能体名称、角色、报告结构和指令
- 项目定义和工作区配置
- 任务/事务描述（当包含时）
- 技能包（作为引用或供应商内容）
- `.paperclip.yaml` 中的适配器类型和环境输入声明

秘密值、机器本地路径和数据库 ID **永远不会**导出。

## 导入公司

从本地目录、GitHub URL 或 GitHub 简写导入：

```sh
# 从本地文件夹
paperclipai company import ./my-export

# 从 GitHub URL
paperclipai company import https://github.com/org/repo

# 从 GitHub 子文件夹
paperclipai company import https://github.com/org/repo/tree/main/companies/acme

# 从 GitHub 简写
paperclipai company import org/repo
paperclipai company import org/repo/companies/acme
```

### 选项

| 选项 | 描述 | 默认值 |
|--------|-------------|---------|
| `--target <mode>` | `new`（创建新公司）或 `existing`（合并到现有公司） | 从上下文推断 |
| `--company-id <id>` | `--target existing` 的目标公司 ID | 当前上下文 |
| `--new-company-name <name>` | 为 `--target new` 覆盖公司名称 | 从包中获取 |
| `--include <values>` | 逗号分隔的集合：`company`、`agents`、`projects`、`issues`、`tasks`、`skills` | 自动检测 |
| `--agents <list>` | 要导入的智能体 slug 的逗号分隔列表，或 `all` | `all` |
| `--collision <mode>` | 如何处理名称冲突：`rename`、`skip` 或 `replace` | `rename` |
| `--ref <value>` | GitHub 导入的 Git 引用（分支、标签或提交） | 默认分支 |
| `--dry-run` | 预览将要导入的内容而不应用 | `false` |
| `--yes` | 跳过交互式确认提示 | `false` |
| `--json` | 输出结果为 JSON | `false` |

### 目标模式

- **`new`** — 从包创建新公司。适合复制公司模板。
- **`existing`** — 将包合并到现有公司。使用 `--company-id` 指定目标。

如果未指定 `--target`，Paperclip 会推断：如果提供了 `--company-id`（或上下文中有），则默认为 `existing`；否则为 `new`。

### 冲突策略

当导入到现有公司时，智能体或项目名称可能与现有名称冲突：

- **`rename`**（默认） — 附加后缀以避免冲突（例如，`ceo` 变为 `ceo-2`）。
- **`skip`** — 跳过已存在的实体。
- **`replace`** — 覆盖现有实体。仅可用于非安全导入（不可通过 CEO API 使用）。

### 交互式选择

以交互方式运行时（没有 `--yes` 或 `--json` 标志），导入命令在应用前显示选择器。你可以使用复选框界面精确选择要导入的智能体、项目、技能和任务。

### 应用前预览

始终先使用 `--dry-run` 预览：

```sh
paperclipai company import org/repo --target existing --company-id abc123 --dry-run
```

预览显示：
- **包内容** — 源中有多少智能体、项目、任务和技能
- **导入计划** — 将创建、重命名、跳过或替换的内容
- **环境输入** — 导入后可能需要值的环境变量
- **警告** — 潜在问题，如缺失技能或未解析的引用

导入的智能体总是以计时器心跳禁用状态落地。包中的分配/按需唤醒行为被保留，但计划运行保持关闭，直到董事会操作员重新启用它们。

### 常见工作流

**从 GitHub 克隆公司模板：**

```sh
paperclipai company import org/company-templates/engineering-team \
  --target new \
  --new-company-name "我的工程团队"
```

**将智能体从包添加到你现有的公司：**

```sh
paperclipai company import ./shared-agents \
  --target existing \
  --company-id abc123 \
  --include agents \
  --collision rename
```

**导入特定分支或标签：**

```sh
paperclipai company import org/repo --ref v2.0.0 --dry-run
```

**非交互式导入（CI/脚本）：**

```sh
paperclipai company import ./package \
  --target new \
  --yes \
  --json
```

## API 端点

CLI 命令在底层使用这些 API 端点：

| 操作 | 端点 |
|--------|----------|
| 导出公司 | `POST /api/companies/{companyId}/export` |
| 预览导入（现有公司） | `POST /api/companies/{companyId}/imports/preview` |
| 应用导入（现有公司） | `POST /api/companies/{companyId}/imports/apply` |
| 预览导入（新公司） | `POST /api/companies/import/preview` |
| 应用导入（新公司） | `POST /api/companies/import` |

CEO 智能体也可以使用安全导入路由（`/imports/preview` 和 `/imports/apply`），这些路由强制执行非破坏性规则：`replace` 被拒绝，冲突通过 `rename` 或 `skip` 解决，事务始终以新事务形式创建。

## GitHub 来源

Paperclip 支持几种 GitHub URL 格式：

- 完整 URL：`https://github.com/org/repo`
- 子文件夹 URL：`https://github.com/org/repo/tree/main/path/to/company`
- 简写：`org/repo`
- 带路径的简写：`org/repo/path/to/company`

从 GitHub 导入时，使用 `--ref` 固定到特定分支、标签或提交哈希。