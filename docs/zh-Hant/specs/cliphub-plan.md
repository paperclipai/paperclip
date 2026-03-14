# ClipHub：Paperclip 团队配置市场

> 適用於全公司 AI 團隊的「應用程式商店」—預先建置的 Paperclip 配置、智能體藍圖、技能和治理模板，從第一天起即可交付實際工作。

## 1. 愿景与定位

**ClipHub** 為 Paperclip 管理的公司銷售 **整個團隊配置** — 組織架構圖、智能體角色、智能體間工作流程、治理規則和專案範本。

|尺寸|剪辑中心 |
|---|---|
|銷售單位 |團隊藍圖（多智能體組織）|
|買家|創辦人工智慧公司的創辦人/團隊負責人 |
|安裝目標 | Paperclip公司（智能體、專案、治理）|
|價值支柱 | “跳過組織設計－在幾分鐘內建立一個運輸團隊”|
|價格範圍 |每個藍圖 $0–$499（+ 單獨的附加元件）|

---

## 2. 产品分类

### 2.1 團隊藍圖（主要產品）

一个完整的Paperclip公司配置：

- **組織架構圖**：具有角色、頭銜、報告鏈、能力的智能體
- **智能體程式配置**：適配器類型、型號、提示範本、指令路徑
- **治理規則**：審核流程、預算限制、升級鏈
- **專案範本**：具有工作區設定的預先配置項目
- **技能和說明**：AGENTS.md / 每個智能體程式捆綁的技能文件

**範例：**
-「SaaS 新創團隊」—執行長、技術長、工程師、行銷長、設計師（199 美元）
- “Content Agency”——主編、3 位作家、SEO 分析師、社交經理（149 美元）
- “Dev Shop”——CTO、2 名工程師、QA、DevOps（99 美元）
- 「獨立創辦人 + 團隊」—執行長智能體 + 3 個跨工程/行銷/營運的 IC（79 美元）

### 2.2 智能體藍圖（團隊環境中的單一智能體）

設計用於插入 Paperclip 組織的單一智能體配置：

- 角色定義、提示範本、適配器配置
- 報告鏈期望（向誰報告）
- 包含技能包
- 治理預設值（預算、權限）

**示例：**
- 「資深工程師」－發布生產代碼，管理 PR（29 美元）
- 「成長行銷人員」—內容管道、搜尋引擎優化、社交（39 美元）
- “DevOps Agent”——CI/CD、部署、監控（29 美元）

### 2.3 技能（模块化能力）

任何 Paperclip 智能體程式都可以使用的便攜式技能檔：

- 附說明的 Markdown 技能文件
- 工具配置和shell脚本
- 兼容Paperclip的技能加载系统

**示例：**
- “Git PR 工作流程” — 標準化 PR 創建和審核（免費）
- 「部署管道」－Cloudflare/Vercel 部署技能（9 美元）
- 「客戶支援分類」—工單分類與路由（19 美元）

### 2.4 治理模板

預先建構的審批流程和政策：

- 预算门槛和审批链
- 跨团队授权规则
- 升级程序
- 计费代码结构**範例：**
-「新創公司治理」－輕量級，CEO 核准 > 50 美元（免費）
- 「企業治理」—多層審批、審計追蹤（49 美元）

---

## 3. 資料模式

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

### 3.2 團隊藍圖包

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

### 3.3 創作者/賣家

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

### 3.4 購買/安裝

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

### 3.5 回顧

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

## 4. 頁面與路由

### 4.1 公頁

|路線 |頁 |說明 |
|---|---|---|
| `/` |首頁 |英雄、特色藍圖、熱門技能、操作方法 |
| `/browse` |市場瀏覽 |所有清單的可過濾網格|
| `/browse?type=team_blueprint` |團隊藍圖|篩選到團隊配置 |
| `/browse?type=agent_blueprint` |智能體藍圖|單一智能體設定 |
| `/browse?type=skill` |技能 |技能清單|
| `/browse?type=governance_template` |治理|政策範本|
| `/listings/:slug` |房源詳情 |完整產品頁面 |
| `/creators/:slug` |創作者簡介 |簡介、所有清單、統計資料 |
| `/about` |關於 ClipHub |使命，它是如何運作的|
| `/pricing` |定價與費用|創作者收入分成、買家資訊 |

### 4.2 經過驗證的頁面

|路線 |頁 |說明 |
|---|---|---|
| `/dashboard` |買家控制台|購買的物品，安裝的藍圖|
| `/dashboard/purchases` |購買歷史 |所有交易 |
| `/dashboard/installs` |裝置 |已部署的藍圖及狀態 |
| `/creator` |創作者控制台 |清單管理、分析 |
| `/creator/listings/new` |建立清單 |多步驟清單精靈 |
| `/creator/listings/:id/edit` |編輯清單 |修改現有清單 |
| `/creator/analytics` |分析|收入、安裝量、觀看次數 |
| `/creator/payouts` |付款| Stripe Connect 付款記錄 |

### 4.3 API 航線

|方法|端點|描述 |
|---|---|---|
| `GET` | `/api/listings` |瀏覽清單（過濾器：類型、類別、價格範圍、排序）|
| `GET` | `/api/listings/:slug` |取得清單詳細資訊 |
| `POST` | `/api/listings` |建立清單（建立者驗證）|
| `PATCH` | `/api/listings/:id` |更新清單 |
| `DELETE` | `/api/listings/:id` |檔案清單 |
| `POST` | `/api/listings/:id/purchase` |購買清單（Stripe 結帳）|
| `POST` | `/api/listings/:id/install` |安裝到Paperclip公司|
| `GET` | `/api/listings/:id/reviews` |獲取評論 |
| `POST` | `/api/listings/:id/reviews` |提交評論 |
| `GET` | `/api/creators/:slug` |創作者簡介 |
| `GET` | `/api/creators/me` |目前創建者簡介 |
| `POST` | `/api/creators` |註冊成為創建者 |
| `GET` | `/api/purchases` |買家的購買歷史 |
| `GET` | `/api/analytics` |創作者分析 |

---

## 5. 使用者流程

### 5.1 買家：瀏覽→購買→安裝

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

### 5.2 創建者：建置→發布→賺取

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

### 5.3 Creator：從Paperclip匯出→發布

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

---## 6.UI設計方向

### 6.1 視覺語言

- **調色盤**：深色墨水原色、暖沙色背景、CTA 強調色（Paperclip 品牌藍色/紫色）
- **排版**：乾淨的無襯線字體，很強的層次結構，技術細節的等寬字體
- **卡片**：圓角、微妙的陰影、清晰的定價徽章
- **組織架構圖視覺效果**：互動式樹/圖顯示團隊藍圖中的智能體關係

### 6.2 關鍵設計元素

|元素|剪輯中心 |
|---|---|
|產品卡|組織架構圖迷你預覽 + 智能體計數徽章 |
|詳情頁|互動式組織架構圖 + 每個座席細分 |
|安裝流程 |一鍵部署到Paperclip公司|
|社會證明| “運行此藍圖的 X 公司” |
|預覽 |現場示範沙箱（延伸目標）|

### 6.3 清單卡設計

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

### 6.4 詳細資訊頁面部分

1. **英雄**：標題、標語、價格、安裝按鈕、創作者訊息
2. **組織架構圖**：座席層級結構的互動式視覺化
3. **智能體細分**：每個智能體的可擴展卡 - 角色、能力、模型、技能
4. **治理**：審批流程、預算結構、升級鏈
5. **包含的項目**：具有工作區配置的專案模板
6. **自述文件**：完整的降價文檔
7. **評論**：星級評分+書面評論
8. **相關藍圖**：交叉銷售類似的團隊配置
9. **創作者簡介**：迷你生物，其他列表

---

## 7. 安裝機制

### 7.1 安裝API流程

當買家點選「安裝到公司」時：

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

安裝處理程序：

1. 驗證買家擁有購買的商品
2. 驗證目標公司存取權限
3. 對於藍圖中的每個智能體：
   - `POST /api/companies/:id/agents`（如果`paperclip-create-agent`支持，或透過審批流程）
   - 設定適配器配置、提示範本、指令路徑
4. 設定報告鏈
5. 建立專案和工作區
6. 應用治理規則
7. 將技能檔部署到配置的路徑
8. 返回建立資源的摘要

### 7.2 衝突解決

- **智能體名稱衝突**：追加 `-2`、`-3` 後綴
- **項目名稱衝突**：提示買家重新命名或跳過
- **適配器不符**：如果藍圖需要本地不可用的適配器，則發出警告
- **模型可用性**：如果未配置所需模型，則發出警告

---

## 8. 收入模式

|費用|金額 |筆記|
|---|---|---|
|創作者收入分成 |銷售價格的 90% |減去條紋處理（~2.9% + 0.30 美元）|
|平台費用|銷售價格的 10% | ClipHub 的剪輯 |
|免費清單 | 0 美元 |免費清單不收取任何費用 |
|條紋連接|標準費率|由 Stripe 處理 |

---

## 9. 技術架構

### 9.1 堆疊- **前端**：Next.js (React)、Tailwind CSS、與 Paperclip 相同的 UI 框架
- **後端**：Node.js API（或擴充Paperclip伺服器）
- **資料庫**：Postgres（可共享Paperclip的資料庫或單獨）
- **付款**：Stripe Connect（市場模式）
- **儲存**：S3/R2 用於列出捆綁包和映像
- **Auth**：與 Paperclip auth（或 OAuth2）共享

### 9.2 與 Paperclip 集成

ClipHub 可以是：
- **選項A**：一個單獨的應用程序，呼叫Paperclip的API來安裝藍圖
- **選項 B**：Paperclip UI 的內建部分（`/marketplace` 路線）

選項 B 對於 MVP 來說更簡單 - 新增到現有 Paperclip UI 和 API 的路由。

### 9.3 捆綁包格式

列表包是 ZIP/tar 存檔，其中包含：

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

## 10. MVP 範圍

### 第一階段：基礎
- [ ] 清單架構與 CRUD API
- [ ] 帶過濾器的瀏覽頁面（類型、類別、價格）
- [ ] 具有組織架構圖視覺化的清單詳細資訊頁面
- [ ] 創建者註冊和清單建立精靈
- [ ] 僅免費安裝（尚無付款）
- [ ] 安裝流程：藍圖 → Paperclip 公司

### 第 2 階段：付款與社交
- [ ] Stripe Connect 集成
- [ ] 購買流程
- [ ] 審核系統
- [ ] 創建者分析控制台
- [ ]「從Paperclip匯出」CLI指令

### 第三階段：成長
- [ ] 相關性排名搜索
- [ ] 精選/熱門列表
- [ ] 創建者驗證程序
- [ ] 藍圖版控制與更新通知
- [ ] 現場示範沙箱
- [ ] API 用於程式化發布