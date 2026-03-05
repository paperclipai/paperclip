# ClipHub: Marketplace for Paperclip Team Configurations

> The "app store" for whole-company AI teams — pre-built Paperclip configurations, agent blueprints, skills, and governance templates that ship real work from day one.

## 1. Vision & Positioning

**ClipHub** sells **entire team configurations** — org charts, agent roles, inter-agent workflows, governance rules, and project templates — for Paperclip-managed companies.

| Dimension | ClipHub |
|---|---|
| Unit of sale | Team blueprint (multi-agent org) |
| Buyer | Founder / team lead spinning up an AI company |
| Install target | Paperclip company (agents, projects, governance) |
| Value prop | "Skip org design — get a shipping team in minutes" |
| Price range | $0–$499 per blueprint (+ individual add-ons) |

---

## 2. Product Taxonomy

### 2.1 Team Blueprints (primary product)

A complete Paperclip company configuration:

- **Org chart**: Agents with roles, titles, reporting chains, capabilities
- **Agent configs**: Adapter type, model, prompt templates, instructions paths
- **Governance rules**: Approval flows, budget limits, escalation chains
- **Project templates**: Pre-configured projects with workspace settings
- **Skills & instructions**: AGENTS.md / skill files bundled per agent

**Examples:**
- "SaaS Startup Team" — CEO, CTO, Engineer, CMO, Designer ($199)
- "Content Agency" — Editor-in-Chief, 3 Writers, SEO Analyst, Social Manager ($149)
- "Dev Shop" — CTO, 2 Engineers, QA, DevOps ($99)
- "Solo Founder + Crew" — CEO agent + 3 ICs across eng/marketing/ops ($79)

### 2.2 Agent Blueprints (individual agents within a team context)

Single-agent configurations designed to plug into a Paperclip org:

- Role definition, prompt template, adapter config
- Reporting chain expectations (who they report to)
- Skill bundles included
- Governance defaults (budget, permissions)

**Examples:**
- "Staff Engineer" — ships production code, manages PRs ($29)
- "Growth Marketer" — content pipeline, SEO, social ($39)
- "DevOps Agent" — CI/CD, deployment, monitoring ($29)

### 2.3 Skills (modular capabilities)

Portable skill files that any Paperclip agent can use:

- Markdown skill files with instructions
- Tool configurations and shell scripts
- Compatible with Paperclip's skill loading system

**Examples:**
- "Git PR Workflow" — standardized PR creation and review (Free)
- "Deployment Pipeline" — Cloudflare/Vercel deploy skill ($9)
- "Customer Support Triage" — ticket classification and routing ($19)

### 2.4 Governance Templates

Pre-built approval flows and policies:

- Budget thresholds and approval chains
- Cross-team delegation rules
- Escalation procedures
- Billing code structures

**Examples:**
- "Startup Governance" — lightweight, CEO approves > $50 (Free)
- "Enterprise Governance" — multi-tier approval, audit trail ($49)

---

## 3. Data Schemas

### 3.1 Listing

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

### 3.2 Team Blueprint Bundle

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

### 3.3 Creator / Seller

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

### 3.4 Purchase / Install

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

### 3.5 Review

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

## 4. Pages & Routes

### 4.1 Public Pages

| Route | Page | Description |
|---|---|---|
| `/` | Homepage | Hero, featured blueprints, popular skills, how it works |
| `/browse` | Marketplace browse | Filterable grid of all listings |
| `/browse?type=team_blueprint` | Team blueprints | Filtered to team configs |
| `/browse?type=agent_blueprint` | Agent blueprints | Single-agent configs |
| `/browse?type=skill` | Skills | Skill listings |
| `/browse?type=governance_template` | Governance | Policy templates |
| `/listings/:slug` | Listing detail | Full product page |
| `/creators/:slug` | Creator profile | Bio, all listings, stats |
| `/about` | About ClipHub | Mission, how it works |
| `/pricing` | Pricing & fees | Creator revenue share, buyer info |

### 4.2 Authenticated Pages

| Route | Page | Description |
|---|---|---|
| `/dashboard` | Buyer dashboard | Purchased items, installed blueprints |
| `/dashboard/purchases` | Purchase history | All transactions |
| `/dashboard/installs` | Installations | Deployed blueprints with status |
| `/creator` | Creator dashboard | Listing management, analytics |
| `/creator/listings/new` | Create listing | Multi-step listing wizard |
| `/creator/listings/:id/edit` | Edit listing | Modify existing listing |
| `/creator/analytics` | Analytics | Revenue, installs, views |
| `/creator/payouts` | Payouts | Stripe Connect payout history |

### 4.3 API Routes

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/listings` | Browse listings (filters: type, category, price range, sort) |
| `GET` | `/api/listings/:slug` | Get listing detail |
| `POST` | `/api/listings` | Create listing (creator auth) |
| `PATCH` | `/api/listings/:id` | Update listing |
| `DELETE` | `/api/listings/:id` | Archive listing |
| `POST` | `/api/listings/:id/purchase` | Purchase listing (Stripe checkout) |
| `POST` | `/api/listings/:id/install` | Install to Paperclip company |
| `GET` | `/api/listings/:id/reviews` | Get reviews |
| `POST` | `/api/listings/:id/reviews` | Submit review |
| `GET` | `/api/creators/:slug` | Creator profile |
| `GET` | `/api/creators/me` | Current creator profile |
| `POST` | `/api/creators` | Register as creator |
| `GET` | `/api/purchases` | Buyer's purchase history |
| `GET` | `/api/analytics` | Creator analytics |

---

## 5. User Flows

### 5.1 Buyer: Browse → Purchase → Install

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

### 5.2 Creator: Build → Publish → Earn

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

### 5.3 Creator: Export from Paperclip → Publish

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

---

## 6. UI Design Direction

### 6.1 Visual Language

- **Color palette**: Dark ink primary, warm sand backgrounds, accent color for CTAs (Paperclip brand blue/purple)
- **Typography**: Clean sans-serif, strong hierarchy, monospace for technical details
- **Cards**: Rounded corners, subtle shadows, clear pricing badges
- **Org chart visuals**: Interactive tree/graph showing agent relationships in team blueprints

### 6.2 Key Design Elements

| Element | ClipHub |
|---|---|
| Product card | Org chart mini-preview + agent count badge |
| Detail page | Interactive org chart + per-agent breakdown |
| Install flow | One-click deploy to Paperclip company |
| Social proof | "X companies running this blueprint" |
| Preview | Live demo sandbox (stretch goal) |

### 6.3 Listing Card Design

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

### 6.4 Detail Page Sections

1. **Hero**: Title, tagline, price, install button, creator info
2. **Org Chart**: Interactive visualization of agent hierarchy
3. **Agent Breakdown**: Expandable cards for each agent — role, capabilities, model, skills
4. **Governance**: Approval flows, budget structure, escalation chain
5. **Included Projects**: Project templates with workspace configs
6. **README**: Full markdown documentation
7. **Reviews**: Star ratings + written reviews
8. **Related Blueprints**: Cross-sell similar team configs
9. **Creator Profile**: Mini bio, other listings

---

## 7. Installation Mechanics

### 7.1 Install API Flow

When a buyer clicks "Install to Company":

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

The install handler:

1. Validates buyer owns the purchase
2. Validates target company access
3. For each agent in blueprint:
   - `POST /api/companies/:id/agents` (if `paperclip-create-agent` supports it, or via approval flow)
   - Sets adapter config, prompt template, instructions path
4. Sets reporting chains
5. Creates projects and workspaces
6. Applies governance rules
7. Deploys skill files to configured paths
8. Returns summary of created resources

### 7.2 Conflict Resolution

- **Agent name collision**: Append `-2`, `-3` suffix
- **Project name collision**: Prompt buyer to rename or skip
- **Adapter mismatch**: Warn if blueprint requires adapter not available locally
- **Model availability**: Warn if required model not configured

---

## 8. Revenue Model

| Fee | Amount | Notes |
|---|---|---|
| Creator revenue share | 90% of sale price | Minus Stripe processing (~2.9% + $0.30) |
| Platform fee | 10% of sale price | ClipHub's cut |
| Free listings | $0 | No fees for free listings |
| Stripe Connect | Standard rates | Handled by Stripe |

---

## 9. Technical Architecture

### 9.1 Stack

- **Frontend**: Next.js (React), Tailwind CSS, same UI framework as Paperclip
- **Backend**: Node.js API (or extend Paperclip server)
- **Database**: Postgres (can share Paperclip's DB or separate)
- **Payments**: Stripe Connect (marketplace mode)
- **Storage**: S3/R2 for listing bundles and images
- **Auth**: Shared with Paperclip auth (or OAuth2)

### 9.2 Integration with Paperclip

ClipHub can be:
- **Option A**: A separate app that calls Paperclip's API to install blueprints
- **Option B**: A built-in section of the Paperclip UI (`/marketplace` route)

Option B is simpler for MVP — adds routes to the existing Paperclip UI and API.

### 9.3 Bundle Format

Listing bundles are ZIP/tar archives containing:

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

## 10. MVP Scope

### Phase 1: Foundation
- [ ] Listing schema and CRUD API
- [ ] Browse page with filters (type, category, price)
- [ ] Listing detail page with org chart visualization
- [ ] Creator registration and listing creation wizard
- [ ] Free installs only (no payments yet)
- [ ] Install flow: blueprint → Paperclip company

### Phase 2: Payments & Social
- [ ] Stripe Connect integration
- [ ] Purchase flow
- [ ] Review system
- [ ] Creator analytics dashboard
- [ ] "Export from Paperclip" CLI command

### Phase 3: Growth
- [ ] Search with relevance ranking
- [ ] Featured/trending listings
- [ ] Creator verification program
- [ ] Blueprint versioning and update notifications
- [ ] Live demo sandbox
- [ ] API for programmatic publishing
