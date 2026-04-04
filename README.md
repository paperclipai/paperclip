<p align="center">
  <img src="doc/assets/header.png" alt="IronWorks - AI Workforce Management" width="720" />
</p>

<p align="center">
  <a href="https://ironworksapp.ai"><strong>Website</strong></a> &middot;
  <a href="https://ironworksapp.ai/docs"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/VetSecItPro/ironworks"><strong>GitHub</strong></a>
</p>

<p align="center">
  <a href="https://github.com/VetSecItPro/ironworks/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/VetSecItPro/ironworks/stargazers"><img src="https://img.shields.io/github/stars/VetSecItPro/ironworks?style=flat" alt="Stars" /></a>
</p>

<br/>

## What is IronWorks?

**Run a company staffed entirely by AI agents. You are the board.**

IronWorks is an AI workforce management platform where you create a company, hire AI agents into roles (CEO, CTO, CFO, engineers, marketers, legal counsel), assign them goals, and manage their work from a single dashboard. The agents work autonomously, build institutional knowledge, file reports, and escalate decisions to you.

Think of it as the operating system for an AI-powered company.

<br/>

## Key Features

### Workforce Management
- **12 specialized agent roles** with distinct personalities, skills, and responsibilities (CEO, CTO, CFO, CMO, VP of HR, Legal Counsel, engineers, designers, content marketers, compliance, security, DevOps)
- **Full-time and contractor agents** with different lifecycle management, memory persistence, and auto-termination
- **Hire Agent dialog** with talent pool templates and department provisioning
- **Performance scoring** (0-100) computed from completion rate, budget efficiency, and activity level
- **Achievement badges** (6 types) tracked and awarded automatically

### Executive Dashboard
- **Board Briefing** page with company health score (0-100, 5 pillars), pending decisions, risk register
- **War Room** with real-time SSE live feed showing agent activity as it happens
- **DORA metrics** (deployment frequency, lead time, failure rate, MTTR) on Board Briefing
- **SLA compliance** tracking per issue priority
- **Velocity charts** (12-week trend) and goal burndown charts

### Agent Intelligence
- **Three-tier memory** (working memory, full-text search, pgvector similarity)
- **Session persistence** across heartbeats with morning briefing injection
- **Post-task reflection** and mistake learning from rejected approvals
- **Karpathy-inspired self-optimization** analyzing success rates and suggesting prompt improvements
- **Context drift detection** every 5th run with automatic refocus
- **Agent chat/DM** to talk to any agent directly

### Token and Cost Management
- **Model routing cascade** (routine tasks use cheap models, complex tasks use capable models)
- **Output token caps** by task type (generous for real work, tight for overhead)
- **Progressive budget gates** (sandbox $10/day, pilot $100/day, production unlimited)
- **Circuit breaker** auto-pauses agents that exceed 3x normal token usage
- **CFO kill switch** to emergency-pause all agents
- **Token analytics dashboard** with per-agent waste detection and savings recommendations
- **Prompt audit** reduced all role prompts by 21.4%

### HR and Compliance
- **VP of HR personnel files** auto-generated on hire, termination, and performance review
- **Employment history** documents tracking every lifecycle event
- **Onboarding checklists** for newly hired agents
- **Compliance export** (JSON + CSV) for SOC 2 evidence collection
- **SHA-256 signed audit log** with hash chain integrity verification
- **HR document immutability** (auto-generated records cannot be edited)

### Knowledge and Documentation
- **Role-specific workspaces** in the Library (CEO gets strategy/, CTO gets architecture/, etc.)
- **Weekly reports** auto-generated Sunday 6 PM CT (per-agent + company aggregate + VP HR + CFO variants)
- **Daily standups** at 8 AM CT logged to activity feed
- **Board meeting packet** auto-compiled weekly
- **Sprint retrospectives**, post-mortems, and decision records auto-filed
- **Multi-tier Knowledge Base** with Agent/Department/Company scoping and search

### Security
- **Least-privilege enforcement** (agents start with zero permissions)
- **Unauthorized access alerts** surfaced in dashboard
- **Human Agency Slider** (H1-H5 autonomy levels with heartbeat enforcement)
- **Smart alerts** with risk-scored feed and configurable thresholds
- **Per-agent security profiles** showing permissions, data scopes, and access logs

### Infrastructure
- **BYOK** (Bring Your Own Key) for Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama
- **5-step onboarding wizard** with LLM provider setup and official brand logos
- **Production Postgres 18** with pgvector 0.8.2 (graceful degradation on embedded PG)
- **Docker deployment** with Caddy HTTPS and GitHub Actions auto-deploy
- **Multi-company isolation** with complete data separation
- **Unlimited agents** on all pricing tiers

<br/>

## Quickstart

```bash
git clone https://github.com/VetSecItPro/ironworks.git
cd ironworks
pnpm install
pnpm dev
```

Server starts at `http://localhost:3100` with embedded PostgreSQL. No external database required for development.

> **Requirements:** Node.js 20+, pnpm 9.15+

### Production Deployment

```bash
# Docker with separate Postgres + pgvector
docker compose -f docker-compose.production.yml up -d
```

<br/>

## Agent Roles

| Role | Icon | Department | Level |
|------|------|-----------|-------|
| CEO | Crown | Executive | Executive |
| CTO | Code | Engineering | Executive |
| CFO | DollarSign | Finance | Executive |
| CMO | Megaphone | Marketing | Executive |
| VP of HR | Users | HR | Management |
| Legal Counsel | Gavel | Compliance | Management |
| Compliance Director | Scale | Compliance | Management |
| Senior Engineer | Terminal | Engineering | Staff |
| DevOps Engineer | Server | Engineering | Staff |
| Security Engineer | Shield | Security | Staff |
| UX Designer | Palette | Design | Staff |
| Content Marketer | PenLine | Marketing | Staff |

Each role includes a custom SOUL.md (personality and directives) and AGENTS.md (collaboration rules and tool access). Roles are visually distinguished with color-coded icons: amber for executives, blue for management, muted for staff, dashed borders for contractors.

<br/>

## Pricing

IronWorks is open-source (MIT). The hosted version at [app.ironworksapp.ai](https://app.ironworksapp.ai) offers three tiers:

| Starter | Growth | Business |
|---------|--------|----------|
| $79/mo | $199/mo | $599/mo |
| 5 projects | 25 projects | Unlimited |
| 5GB storage | 15GB storage | 50GB |
| Unlimited agents | Unlimited agents | Unlimited agents |

All tiers include unlimited agents. BYOK means you pay your own LLM provider costs directly.

<br/>

## Tech Stack

- **Runtime:** Node.js 20+ with TypeScript
- **Frontend:** React 19, Vite, Tailwind CSS v4
- **Database:** PostgreSQL 18 with pgvector (embedded for dev, standalone for production)
- **ORM:** Drizzle
- **Auth:** Better Auth
- **State:** TanStack React Query
- **Icons:** Lucide React
- **Font:** Geist + Geist Mono

<br/>

## License

MIT - see [LICENSE](LICENSE).

<br/>

---

<sub>Built on [Paperclip](https://github.com/paperclipai/paperclip), an open-source AI workforce orchestration framework.</sub>
