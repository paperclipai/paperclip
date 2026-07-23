# ClipHub：Paperclip 团队配置市场

> 适用于全公司 AI 团队的“应用程序商店”——预构建的 Paperclip 配置、智能体蓝图、技能和治理模板，从第一天起即可交付实际工作。

## 1. 愿景与定位

**ClipHub** 为 Paperclip 管理的公司销售 **整个团队配置** — 组织架构图、智能体角色、智能体间工作流程、治理规则和项目模板。

|尺寸|剪辑中心 |
|---|---|
|销售单位 |团队蓝图（多智能体组织）|
|买家|创办人工智能公司的创始人/团队负责人 |
|安装目标 | Paperclip公司（智能体、项目、治理）|
|价值支柱 | “跳过组织设计——在几分钟内建立一个运输团队”|
|价格范围 |每个蓝图 $0–$499（+ 单独的附加组件）|

---

## 2. 产品分类

### 2.1 团队蓝图（主要产品）

一个完整的Paperclip公司配置：

- **组织架构图**：具有角色、头衔、报告链、能力的智能体
- **智能体配置**：适配器类型、型号、提示模板、指令路径
- **治理规则**：审批流程、预算限制、升级链
- **项目模板**：带有工作区设置的预配置项目
- **技能和说明**：AGENTS.md / 每个智能体捆绑的技能文件

**示例：**
-“SaaS 初创团队”——首席执行官、首席技术官、工程师、首席营销官、设计师（199 美元）
- “Content Agency”——主编、3 位作家、SEO 分析师、社交经理（149 美元）
- “Dev Shop”——CTO、2 名工程师、QA、DevOps（99 美元）
- “独立创始人 + 团队”——首席执行官智能体人 + 3 个跨工程/营销/运营的 IC（79 美元）

### 2.2 智能体蓝图（团队环境中的单个智能体）

设计用于插入 Paperclip 组织的单智能体配置：

- 角色定义、提示模板、适配器配置
- 报告链期望（向谁报告）
- 包含技能包
- 治理默认值（预算、权限）

**示例：**
- “高级工程师”——发布生产代码，管理 PR（29 美元）
- “增长营销人员”——内容管道、搜索引擎优化、社交（39 美元）
- “DevOps Agent”——CI/CD、部署、监控（29 美元）

### 2.3 技能（模块化能力）

任何 Paperclip 智能体都可以使用的便携式技能文件：

- 带说明的 Markdown 技能文件
- 工具配置和shell脚本
- 兼容Paperclip的技能加载系统

**示例：**
- “Git PR 工作流程” — 标准化 PR 创建和审核（免费）
- “部署管道”——Cloudflare/Vercel 部署技能（9 美元）
- “客户支持分类”——工单分类和路由（19 美元）

### 2.4 治理模板

预先构建的审批流程和政策：

- 预算门槛和审批链
- 跨团队授权规则
- 升级程序
- 计费代码结构**示例：**
-“初创公司治理”——轻量级，CEO 批准 > 50 美元（免费）
- “企业治理”——多层审批、审计跟踪（49 美元）

---

## 3. 数据模式

### 3.1 列表

```typescript
interface Listing {
  id: string;
  slug: string;                    // URL-friendly identifier
  type: 'team_blueprint' | 'agent_blueprint' | 'skill' | 'governance_template';
  title: string;
  tagline: string;                 // Short pitch (≤120 chars)
  description: string;             // Markdown, full details

  // Pricing
  price: number;                   // Cents (0 = free)
  currency: 'usd';

  // Creator
  creatorId: string;
  creatorName: string;
  creatorAvatar: string | null;

  // Categorization
  categories: string[];            // e.g. ['saas', 'engineering', 'marketing']
  tags: string[];                  // e.g. ['claude', 'startup', '5-agent']
  agentCount: number | null;       // For team blueprints

  // Content
  previewImages: string[];         // Screenshots / org chart visuals
  readmeMarkdown: string;          // Full README shown on detail page
  includedFiles: string[];         // List of files in the bundle

  // Compatibility
  compatibleAdapters: string[];    // ['claude_local', 'codex_local', ...]
  requiredModels: string[];        // ['claude-opus-4-6', 'claude-sonnet-4-6']
  paperclipVersionMin: string;     // Minimum Paperclip version

  // Social proof
  installCount: number;
  rating: number | null;           // 1.0–5.0
  reviewCount: number;

  // Metadata
  version: string;                 // Semver
  publishedAt: string;
  updatedAt: string;
  status: 'draft' | 'published' | 'archived';
}
```

### 3.2 团队蓝图包

```typescript
interface TeamBlueprint {
  listingId: string;

  // Org structure
  agents: AgentBlueprint[];
  reportingChain: { agentSlug: string; reportsTo: string | null }[];

  // Governance
  governance: {
    approvalRules: ApprovalRule[];
    budgetDefaults: { role: string; monthlyCents: number }[];
    escalationChain: string[];     // Agent slugs in escalation order
  };

  // Projects
  projects: ProjectTemplate[];

  // Company-level config
  companyDefaults: {
    name: string;
    defaultModel: string;
    defaultAdapter: string;
  };
}

interface AgentBlueprint {
  slug: string;                     // e.g. 'cto', 'engineer-1'
  name: string;
  role: string;
  title: string;
  icon: string;
  capabilities: string;
  promptTemplate: string;
  adapterType: string;
  adapterConfig: Record<string, any>;
  instructionsPath: string | null;  // Path to AGENTS.md or similar
  skills: SkillBundle[];
  budgetMonthlyCents: number;
  permissions: {
    canCreateAgents: boolean;
    canApproveHires: boolean;
  };
}

interface ProjectTemplate {
  name: string;
  description: string;
  workspace: {
    cwd: string | null;
    repoUrl: string | null;
  } | null;
}

interface ApprovalRule {
  trigger: string;                  // e.g. 'hire_agent', 'budget_exceed'
  threshold: number | null;
  approverRole: string;
}
```

### 3.3 创建者/卖家

```typescript
interface Creator {
  id: string;
  userId: string;                   // Auth provider ID
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  website: string | null;
  listings: string[];               // Listing IDs
  totalInstalls: number;
  totalRevenue: number;             // Cents earned
  joinedAt: string;
  verified: boolean;
  payoutMethod: 'stripe_connect';
  stripeAccountId: string | null;
}
```

### 3.4 购买/安装

```typescript
interface Purchase {
  id: string;
  listingId: string;
  buyerUserId: string;
  buyerCompanyId: string | null;    // Target Paperclip company
  pricePaidCents: number;
  paymentIntentId: string | null;   // Stripe
  installedAt: string | null;       // When deployed to company
  status: 'pending' | 'completed' | 'refunded';
  createdAt: string;
}
```

### 3.5 回顾

```typescript
interface Review {
  id: string;
  listingId: string;
  authorUserId: string;
  authorDisplayName: string;
  rating: number;                   // 1–5
  title: string;
  body: string;                     // Markdown
  verifiedPurchase: boolean;
  createdAt: string;
  updatedAt: string;
}
```

---

## 4. 页面和路由

### 4.1 公共页面

|路线 |页 |描述 |
|---|---|---|
| `/` |主页 |英雄、特色蓝图、热门技能、操作方法 |
| `/browse` |市场浏览 |所有列表的可过滤网格|
| `/browse?type=team_blueprint` |团队蓝图|筛选到团队配置 |
| `/browse?type=agent_blueprint` |智能体蓝图|单智能体配置 |
| `/browse?type=skill` |技能 |技能列表|
| `/browse?type=governance_template` |治理|政策模板|
| `/listings/:slug` |房源详情 |完整产品页面 |
| `/creators/:slug` |创作者简介 |简介、所有列表、统计数据 |
| `/about` |关于 ClipHub |使命，它是如何运作的|
| `/pricing` |定价和费用|创作者收入分成、买家信息 |

### 4.2 经过身份验证的页面

|路线 |页 |描述 |
|---|---|---|
| `/dashboard` |买家控制台|购买的物品，安装的蓝图|
| `/dashboard/purchases` |购买历史 |所有交易 |
| `/dashboard/installs` |装置 |已部署的蓝图及状态 |
| `/creator` |创作者控制台 |列表管理、分析 |
| `/creator/listings/new` |创建列表 |多步骤列表向导 |
| `/creator/listings/:id/edit` |编辑清单 |修改现有列表 |
| `/creator/analytics` |分析|收入、安装量、观看次数 |
| `/creator/payouts` |付款| Stripe Connect 付款历史记录 |

### 4.3 API 航线

|方法|端点|描述 |
|---|---|---|
| `GET` | `/api/listings` |浏览列表（过滤器：类型、类别、价格范围、排序）|
| `GET` | `/api/listings/:slug` |获取列表详细信息 |
| `POST` | `/api/listings` |创建列表（创建者身份验证）|
| `PATCH` | `/api/listings/:id` |更新清单 |
| `DELETE` | `/api/listings/:id` |存档列表 |
| `POST` | `/api/listings/:id/purchase` |购买清单（Stripe 结帐）|
| `POST` | `/api/listings/:id/install` |安装到Paperclip公司|
| `GET` | `/api/listings/:id/reviews` |获取评论 |
| `POST` | `/api/listings/:id/reviews` |提交评论 |
| `GET` | `/api/creators/:slug` |创作者简介 |
| `GET` | `/api/creators/me` |当前创建者简介 |
| `POST` | `/api/creators` |注册成为创建者 |
| `GET` | `/api/purchases` |买家的购买历史 |
| `GET` | `/api/analytics` |创作者分析 |

---

## 5. 用户流程

### 5.1 买家：浏览→购买→安装

```
Homepage → Browse marketplace → Filter by type/category
  → Click listing → Read details, reviews, preview org chart
  → Click "Buy" → Stripe checkout (or free install)
  → Post-purchase: "Install to Company" button
  → Select target Paperclip company (or create new)
  → ClipHub API calls Paperclip API to:
      1. Create agents with configs from blueprint
      2. Set up reporting chains
      3. Create projects with workspace configs
      4. Apply governance rules
      5. Deploy skill files to agent instruction paths
  → Redirect to Paperclip dashboard with new team running
```

### 5.2 创建者：构建→发布→赚取

```
Sign up as creator → Connect Stripe
  → "New Listing" wizard:
      Step 1: Type (team/agent/skill/governance)
      Step 2: Basic info (title, tagline, description, categories)
      Step 3: Upload bundle (JSON config + skill files + README)
      Step 4: Preview & org chart visualization
      Step 5: Pricing ($0–$499)
      Step 6: Publish
  → Live on marketplace immediately
  → Track installs, revenue, reviews on creator dashboard
```

### 5.3 Creator：从Paperclip导出→发布

```
Running Paperclip company → "Export as Blueprint" (CLI or UI)
  → Paperclip exports:
      - Agent configs (sanitized — no secrets)
      - Org chart / reporting chains
      - Governance rules
      - Project templates
      - Skill files
  → Upload to ClipHub as new listing
  → Edit details, set price, publish
```

---## 6.UI设计方向

### 6.1 视觉语言

- **调色板**：深色墨水原色、暖沙色背景、CTA 强调色（Paperclip 品牌蓝色/紫色）
- **排版**：干净的无衬线字体，很强的层次结构，技术细节的等宽字体
- **卡片**：圆角、微妙的阴影、清晰的定价徽章
- **组织架构图视觉效果**：交互式树/图显示团队蓝图中的智能体关系

### 6.2 关键设计元素

|元素|剪辑中心 |
|---|---|
|产品卡|组织架构图迷你预览 + 智能体计数徽章 |
|详情页|交互式组织架构图 + 每个座席细分 |
|安装流程 |一键部署到Paperclip公司|
|社会证明| “运行此蓝图的 X 公司” |
|预览 |现场演示沙箱（延伸目标）|

### 6.3 列表卡设计

```
┌─────────────────────────────────────┐
│  [Org Chart Mini-Preview]           │
│  ┌─CEO─┐                            │
│  ├─CTO─┤                            │
│  └─ENG──┘                           │
│                                     │
│  SaaS Startup Team                  │
│  "Ship your MVP with a 5-agent      │
│   engineering + marketing team"      │
│                                     │
│  👥 5 agents  ⬇ 234 installs       │
│  ★ 4.7 (12 reviews)                │
│                                     │
│  By @masinov          $199  [Buy]   │
└─────────────────────────────────────┘
```

### 6.4 详细信息页面部分

1. **英雄**：标题、标语、价格、安装按钮、创建者信息
2. **组织架构图**：座席层次结构的交互式可视化
3. **智能体细分**：每个智能体的可扩展卡 - 角色、能力、模型、技能
4. **治理**：审批流程、预算结构、升级链
5. **包含的项目**：具有工作区配置的项目模板
6. **自述文件**：完整的降价文档
7. **评论**：星级评分+书面评论
8. **相关蓝图**：交叉销售类似的团队配置
9. **创作者简介**：迷你生物，其他列表

---

## 7. 安装机制

### 7.1 安装API流程

当买家点击“安装到公司”时：

```
POST /api/listings/:id/install
{
  "targetCompanyId": "uuid",         // Existing Paperclip company
  "overrides": {                      // Optional customization
    "agentModel": "claude-sonnet-4-6", // Override default model
    "budgetScale": 0.5,               // Scale budgets
    "skipProjects": false
  }
}
```

安装处理程序：

1. 验证买家拥有购买的商品
2. 验证目标公司访问权限
3. 对于蓝图中的每个智能体：
   - `POST /api/companies/:id/agents`（如果`paperclip-create-agent`支持，或通过审批流程）
   - 设置适配器配置、提示模板、指令路径
4. 设置报告链
5. 创建项目和工作区
6. 应用治理规则
7. 将技能文件部署到配置的路径
8. 返回创建资源的摘要

### 7.2 冲突解决

- **智能体名称冲突**：追加 `-2`、`-3` 后缀
- **项目名称冲突**：提示买家重命名或跳过
- **适配器不匹配**：如果蓝图需要本地不可用的适配器，则发出警告
- **模型可用性**：如果未配置所需模型，则发出警告

---

## 8. 收入模式

|费用|金额 |笔记|
|---|---|---|
|创作者收入分成 |销售价格的 90% |减去条纹处理（~2.9% + 0.30 美元）|
|平台费用|销售价格的 10% | ClipHub 的剪辑 |
|免费列表 | 0 美元 |免费列表不收取任何费用 |
|条纹连接|标准费率|由 Stripe 处理 |

---

## 9. 技术架构

### 9.1 堆栈- **前端**：Next.js (React)、Tailwind CSS、与 Paperclip 相同的 UI 框架
- **后端**：Node.js API（或扩展Paperclip服务器）
- **数据库**：Postgres（可以共享Paperclip的数据库或单独）
- **付款**：Stripe Connect（市场模式）
- **存储**：S3/R2 用于列出捆绑包和图像
- **Auth**：与 Paperclip auth（或 OAuth2）共享

### 9.2 与 Paperclip 集成

ClipHub 可以是：
- **选项A**：一个单独的应用程序，调用Paperclip的API来安装蓝图
- **选项 B**：Paperclip UI 的内置部分（`/marketplace` 路线）

选项 B 对于 MVP 来说更简单 - 添加到现有 Paperclip UI 和 API 的路由。

### 9.3 捆绑包格式

列表包是 ZIP/tar 存档，其中包含：

```
blueprint/
├── manifest.json          # Listing metadata + agent configs
├── README.md              # Documentation
├── org-chart.json         # Agent hierarchy
├── governance.json        # Approval rules, budgets
├── agents/
│   ├── ceo/
│   │   ├── prompt.md      # Prompt template
│   │   ├── AGENTS.md      # Instructions
│   │   └── skills/        # Skill files
│   ├── cto/
│   │   ├── prompt.md
│   │   ├── AGENTS.md
│   │   └── skills/
│   └── engineer/
│       ├── prompt.md
│       ├── AGENTS.md
│       └── skills/
└── projects/
    └── default/
        └── workspace.json  # Project workspace config
```

---

## 10. MVP 范围

### 第一阶段：基础
- [ ] 列表架构和 CRUD API
- [ ] 带过滤器的浏览页面（类型、类别、价格）
- [ ] 具有组织架构图可视化的列表详细信息页面
- [ ] 创建者注册和列表创建向导
- [ ] 仅免费安装（尚无付款）
- [ ] 安装流程：蓝图 → Paperclip 公司

### 第 2 阶段：支付和社交
- [ ] Stripe Connect 集成
- [ ] 购买流程
- [ ] 审核系统
- [ ] 创建者分析控制台
- [ ]“从Paperclip导出”CLI命令

### 第三阶段：成长
- [ ] 相关性排名搜索
- [ ] 精选/热门列表
- [ ] 创建者验证程序
- [ ] 蓝图版本控制和更新通知
- [ ] 现场演示沙盒
- [ ] API 用于程序化发布