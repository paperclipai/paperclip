# ClipHub — 公司注册中心（Company Registry）

**下载一家公司。**

ClipHub 是一个公共注册中心（Registry），供用户分享、发现和下载 Paperclip 公司配置。公司模板（Company Template）是一种可移植的制品（Artifact），包含完整的组织架构——代理（Agent）、汇报关系、适配器配置（Adapter Config）、角色定义、种子任务——只需一条命令即可启动运行。

---

## 概述

ClipHub 之于 Paperclip，就如同包注册中心之于编程语言。Paperclip 已经支持可导出的组织配置（见 [SPEC.md](./SPEC.md) §2）。ClipHub 就是存放这些导出内容的公共目录。

用户在 Paperclip 中搭建一个运行良好的公司——开发工作室、营销代理、研究实验室、内容工作室——导出模板后发布到 ClipHub。任何人都可以浏览、搜索、下载，并在自己的 Paperclip 实例上启动该公司。

一句话概括：**你真的可以下载一家公司。**

---

## 发布内容

ClipHub 包（Package）是一种**公司模板导出**——即 Paperclip 规范中定义的可移植制品格式。它包含：

| 组件 | 说明 |
|---|---|
| **公司元数据（Company Metadata）** | 名称、描述、用途说明、分类 |
| **组织架构图（Org Chart）** | 完整的汇报层级——谁向谁汇报 |
| **代理定义（Agent Definitions）** | 每个代理的名称、角色、头衔、能力描述 |
| **适配器配置（Adapter Configs）** | 每个代理的适配器类型和配置（SOUL.md、HEARTBEAT.md、CLAUDE.md、进程命令、Webhook URL——取决于适配器所需） |
| **种子任务（Seed Tasks）** | 可选的初始任务和计划，用于引导公司首次运行 |
| **预算默认值（Budget Defaults）** | 按代理和按公司建议的 Token/费用预算 |

模板是**结构，而非状态。**不包含进行中的任务、历史费用数据或运行时制品。只有蓝图。

### 子包（Sub-packages）

并非所有场景都需要一整家公司。ClipHub 也支持发布独立组件：

- **代理模板（Agent Template）**——单个代理配置（例如"高级 TypeScript 工程师"、"SEO 内容写手"、"DevOps 代理"）
- **团队模板（Team Template）**——组织架构图中的一个子树（例如"营销团队：CMO + 3 名下属"、"工程小组：技术负责人 + 4 名工程师"）
- **适配器配置（Adapter Config）**——独立于特定代理角色的可复用适配器配置

这些子包可以混搭到现有公司中。下载一个代理，插入你的组织，指定一个上级，即可开始工作。

---

## 核心功能

### 浏览与发现（Browse & Discover）

首页从多个维度展示公司：

- **精选（Featured）**——编辑策展的高质量模板
- **热门（Popular）**——按下载量、星标和分支数排名
- **最新（Recent）**——最近发布或更新的
- **分类（Categories）**——按用途浏览（见下方分类）

每个条目显示：名称、简短描述、组织规模（代理数量）、分类、使用的适配器类型、星标数、下载量，以及一个迷你组织架构图预览。

### 搜索（Search）

搜索支持**语义搜索（Semantic Search），而非仅关键词匹配。**由向量嵌入（Vector Embeddings）驱动，可以按意图搜索：

- "marketing agency that runs facebook ads" → 即使标题中没有这些词，也能找到相关公司模板
- "small dev team for building APIs" → 找到精简的工程组织
- "content pipeline with writers and editors" → 找到内容工作室模板

还支持按以下条件筛选：分类、代理数量范围、适配器类型、星标数、发布时间。

### 公司详情页（Company Detail Page）

点击进入公司模板后可以看到：

- **完整描述**——这个公司做什么、如何运行、预期效果
- **交互式组织架构图**——每个代理的可视化树状图，含角色、头衔和能力
- **代理列表**——每个代理的可展开详情（适配器类型、配置摘要、角色描述）
- **种子任务**——附带的初始计划和任务
- **预算概览**——建议的费用结构
- **安装命令**——一行 CLI 命令即可下载并创建
- **版本历史**——变更日志、语义化版本号（Semver）、历史版本
- **社区互动**——星标数、评论数、分支数

### 安装与分支（Install & Fork）

两种使用模板的方式：

**安装（全新开始）：**
```
paperclip install cliphub:<publisher>/<company-slug>
```
下载模板并在本地 Paperclip 实例中创建新公司。你需要添加自己的 API Key、设置预算、自定义代理，然后启动运行。

**分支（Fork）：**
分支会将模板复制到你自己的 ClipHub 账户下。你可以修改它、以你自己的变体重新发布，并且分支谱系会被追踪。这使得渐进式改进成为可能——有人发布了一个营销代理，你分支它、添加一个社交媒体团队、重新发布。

### 星标与评论（Stars & Comments）

- **星标（Stars）**——收藏和质量信号。星标数是主要的排名信号。
- **评论（Comments）**——每个条目下的主题讨论。可以提问、分享使用结果、建议改进。

### 下载量与信号（Download Counts & Signals）

每次安装都会被计数。注册中心追踪：

- 总下载量（历史累计）
- 每个版本的下载量
- 分支数
- 星标数

这些信号用于搜索排名和发现推荐。

---

## 发布（Publishing）

### 谁可以发布

拥有 GitHub 账户的任何人都可以向 ClipHub 发布。身份验证通过 GitHub OAuth 实现。

### 如何发布

在 Paperclip 中，将你的公司导出为模板，然后发布：

```
paperclip export --template my-company
paperclip publish cliphub my-company
```

或使用网页界面直接上传模板导出文件。

### 需要提供的信息

发布时需要指定：

| 字段 | 必填 | 说明 |
|---|---|---|
| `slug` | 是 | URL 安全标识符（例如 `lean-dev-shop`） |
| `name` | 是 | 显示名称 |
| `description` | 是 | 这个公司做什么、面向谁 |
| `category` | 是 | 主分类（见下文） |
| `tags` | 否 | 用于发现的附加标签 |
| `version` | 是 | 语义化版本号（例如 `1.0.0`） |
| `changelog` | 否 | 本版本的变更说明 |
| `readme` | 否 | 扩展文档（Markdown 格式） |
| `license` | 否 | 使用条款 |

### 版本管理（Versioning）

模板使用语义化版本控制（Semantic Versioning）。每次发布都会创建一个不可变版本。用户可以安装任意版本，默认安装 `latest`。版本历史和变更日志在详情页可见。

### `sync` 命令

适用于维护多个模板的高级用户：

```
paperclip cliphub sync
```

扫描你本地已导出的模板，发布所有新增或更新的模板。适合从单个仓库维护一组公司模板。

---

## 分类（Categories）

公司模板按用途组织：

| 分类 | 示例 |
|---|---|
| **软件开发（Software Development）** | 全栈开发工作室、API 开发团队、移动应用工作室 |
| **营销与增长（Marketing & Growth）** | 效果营销代理、内容营销团队、SEO 工作室 |
| **内容与媒体（Content & Media）** | 内容工作室、播客制作、Newsletter 运营 |
| **研究与分析（Research & Analysis）** | 市场研究公司、竞争情报、数据分析团队 |
| **运营（Operations）** | 客户支持组织、内部运营团队、QA/测试工作室 |
| **销售（Sales）** | 外呼销售团队、线索生成、客户管理 |
| **财务与法务（Finance & Legal）** | 记账服务、合规监控、财务分析 |
| **创意（Creative）** | 设计代理、文案工作室、品牌策划 |
| **通用（General Purpose）** | 入门模板、最小组织、单代理设置 |

分类不是排他的——一个模板可以有一个主分类，加上用于跨领域关注点的标签。

---

## 审核与信任（Moderation & Trust）

### 认证发布者（Verified Publishers）

满足一定门槛（账户年龄、已发布模板且信号良好）的发布者可获得认证徽章。认证模板在搜索中排名更高。

### 安全审查（Security Review）

公司模板包含适配器配置，可能包括可执行命令（进程适配器 Process Adapter）或 Webhook URL（HTTP 适配器）。审核系统包括：

1. **自动扫描**——检查适配器配置中的可疑模式（任意代码执行、数据外泄 URL、凭证窃取）
2. **社区举报**——任何登录用户都可以举报模板。收到多次举报后自动隐藏，等待审核。
3. **人工审核**——审核员可以批准、拒绝或要求修改

### 账户门槛（Account Gating）

新账户在发布前有等待期，以防止一次性垃圾信息。

---

## 架构（Architecture）

ClipHub 是一个**独立于 Paperclip 的服务**。Paperclip 是自托管的；ClipHub 是一个托管的注册中心，Paperclip 实例与之通信。

### 集成点（Integration Points）

| 层级 | 角色 |
|---|---|
| **ClipHub Web** | 浏览、搜索、发现、评论、星标——网站 |
| **ClipHub API** | 注册中心 API，支持以编程方式发布、下载、搜索 |
| **Paperclip CLI** | `paperclipai install`、`paperclipai publish`、`paperclipai cliphub sync`——内置于 Paperclip |
| **Paperclip UI** | Paperclip 网页界面中的"浏览 ClipHub"面板，无需离开应用即可发现模板 |

### 技术栈（Tech Stack）

| 层级 | 技术 |
|---|---|
| 前端（Frontend） | React + Vite（与 Paperclip 保持一致） |
| 后端（Backend） | TypeScript + Hono（与 Paperclip 保持一致） |
| 数据库（Database） | PostgreSQL |
| 搜索（Search） | 向量嵌入（Vector Embeddings）用于语义搜索 |
| 认证（Auth） | GitHub OAuth |
| 存储（Storage） | 模板 ZIP 存储在对象存储中（S3 或同等服务） |

### 数据模型（草案）

```
Publisher
  id, github_id, username, display_name, verified, created_at

Template
  id, publisher_id, slug, name, description, category,
  tags[], readme, license, created_at, updated_at,
  star_count, download_count, fork_count,
  forked_from_id (nullable)

Version
  id, template_id, version (semver), changelog,
  artifact_url (zip), agent_count, adapter_types[],
  created_at

Star
  id, publisher_id, template_id, created_at

Comment
  id, publisher_id, template_id, body, parent_id (nullable),
  created_at, updated_at

Report
  id, reporter_id, template_id, reason, created_at
```

---

## 用户流程（User Flows）

### "我想创建一家公司"

1. 打开 ClipHub，按分类浏览或搜索"dev shop for building SaaS"
2. 找到合适的模板——"Lean SaaS Dev Shop (CEO + CTO + 3 Engineers)"
3. 阅读描述、查看组织架构图、查看评论
4. 运行 `paperclipai install cliphub:acme/lean-saas-shop`
5. Paperclip 在本地创建公司，所有代理已预配置
6. 设置你的 API Key，调整预算，添加初始任务
7. 启动运行

### "我做了一个好东西，想分享给大家"

1. 在 Paperclip 中搭建并迭代一家公司，直到它运行良好
2. 导出：`paperclipai export --template my-agency`
3. 发布：`paperclipai publish cliphub my-agency`
4. 在网页界面填写描述、分类、标签
5. 模板上线——其他人可以发现并安装

### "我想改进别人创建的公司"

1. 在 ClipHub 上找到一个接近你需求的模板
2. 分支到你的账户
3. 在本地安装你的分支，修改组织架构（添加代理、更改配置、调整团队结构）
4. 导出并以你自己的变体重新发布
5. 分支谱系在原始版本和你的版本上均可见

### "我只需要一个优秀的代理，而不是一整家公司"

1. 在 ClipHub 搜索代理模板："senior python engineer"
2. 找到一个高星标的代理配置
3. 只安装该代理：`paperclipai install cliphub:acme/senior-python-eng --agent`
4. 在你现有公司中将其分配给一个上级
5. 完成

---

## 与 Paperclip 的关系

使用 Paperclip **并不强制**需要 ClipHub。你完全可以从零开始搭建公司，完全不使用 ClipHub。但 ClipHub 显著降低了入门门槛：

- **新用户**几分钟内即可获得一个运行中的公司，而非数小时
- **有经验的用户**将经过验证的配置分享给社区
- **生态系统**不断累积——每个好模板都让下一个公司更容易搭建

ClipHub 之于 Paperclip，如同包注册中心之于语言运行时：可选，但具有变革意义。

---

## V1 范围

### 必须实现（Must Have）

- [ ] 模板发布（通过 CLI 或网页上传）
- [ ] 模板浏览（列表、按分类筛选）
- [ ] 模板详情页（描述、组织架构图、代理列表、安装命令）
- [ ] 语义搜索（向量嵌入）
- [ ] `paperclipai install cliphub:<publisher>/<slug>` CLI 命令
- [ ] GitHub OAuth 身份验证
- [ ] 星标
- [ ] 下载量统计
- [ ] 版本管理（语义化版本、版本历史）
- [ ] 基础审核（社区举报、自动隐藏）

### V2

- [ ] 评论 / 主题讨论
- [ ] 分支与谱系追踪
- [ ] 代理和团队子包
- [ ] 认证发布者徽章
- [ ] 适配器配置的自动安全扫描
- [ ] Paperclip 网页界面中的"浏览 ClipHub"面板
- [ ] `paperclipai cliphub sync` 批量发布
- [ ] 发布者主页和作品集

### 不在范围内

- 付费 / 高级模板（所有内容免费公开，至少在初期）
- 私有注册中心（可能是未来的企业功能）
- 在 ClipHub 上运行公司（它是注册中心，而非运行时——与 Paperclip 自身的理念一致）
