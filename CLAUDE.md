# Paperclip Development Guide

## gstack — AI-Powered Development Workflow

gstack is installed at `~/.claude/skills/gstack` and provides a full software factory workflow.

**IMPORTANT:** Use the `/browse` skill from gstack for ALL web browsing. Never use `mcp__claude-in-chrome__*` tools.

### Available Skills

| Phase | Skill | Purpose |
|-------|-------|---------|
| **Think** | `/office-hours` | Challenge assumptions before coding |
| **Plan** | `/plan-ceo-review` | CEO-level scope & vision validation |
| | `/plan-eng-review` | Engineering architecture review |
| | `/plan-design-review` | Design system review |
| | `/autoplan` | Automated planning workflow |
| **Design** | `/design-consultation` | Design system consultation |
| | `/design-shotgun` | Rapid design iteration |
| | `/design-review` | Design audit |
| **Build & Browse** | `/browse` | Headless browser for testing & dogfooding |
| | `/connect-chrome` | Connect to running Chrome instance |
| | `/setup-browser-cookies` | Configure browser cookie access |
| **Review** | `/review` | Staff-engineer-level code review with auto-fix |
| | `/investigate` | Deep code investigation |
| | `/codex` | Cross-model second opinion (OpenAI) |
| | `/cso` | Security audit (OWASP + STRIDE) |
| **Test** | `/qa` | Full QA: browser testing + bug discovery |
| | `/qa-only` | QA without planning phase |
| | `/benchmark` | Performance measurement |
| **Ship** | `/ship` | Automated deployment with verification |
| | `/land-and-deploy` | Land PR and deploy |
| | `/canary` | Canary deployment monitoring |
| | `/setup-deploy` | Configure deployment pipeline |
| **Reflect** | `/retro` | Shipping velocity & test health analysis |
| | `/document-release` | Automated release documentation |
| **Safety** | `/careful` | Enable extra caution mode |
| | `/freeze` | Freeze destructive operations |
| | `/guard` | Guard against risky changes |
| | `/unfreeze` | Remove freeze protection |
| **Maintenance** | `/gstack-upgrade` | Upgrade gstack installation |

## Paperclip Companies & Agents (56 total)

### AmparoIA (13 agents) — Anti-mobbing labor platform, B2C + B2B
| Agent | Role | Skills Profile |
|-------|------|---------------|
| CEO | Strategy, delegation | built-in only |
| CFO | Finance, budgets | built-in + finance-analysis |
| CMO | Marketing, growth | built-in only |
| CTO | Technical leadership | gstack + superpowers |
| Chief International Tax Officer | Tax compliance 11 countries | built-in only |
| Compliance Officer | Legal compliance | built-in only |
| Founding Engineer | Core development | gstack + superpowers |
| Frontend Lead | UI/UX development | gstack + superpowers |
| GEO-SEO Specialist | SEO, international | built-in only |
| Head of AI | AI/ML strategy | gstack + superpowers |
| Head of Localization | i18n, l10n | built-in only |
| Legal Director | Legal strategy | built-in only |
| Sales Lead | Sales operations | built-in only |

### CriptoIus (11 agents) — Crypto legal/compliance
| Agent | Role | Skills Profile |
|-------|------|---------------|
| AutoResearch | Autonomous research | gstack + superpowers |
| CEO | Strategy | built-in only |
| CFO | Finance | built-in + finance-analysis |
| CMO | Marketing | built-in only |
| CTO | Technical leadership | gstack + superpowers |
| Compliance | Regulatory compliance | built-in only |
| Founding Engineer | Core development | gstack + superpowers |
| Frontend Lead | UI development | gstack + superpowers |
| GEO-SEO Specialist | SEO | built-in only |
| Legal | Legal counsel | built-in only |
| Sales Lead | Sales | built-in only |

### IntegridAI (11 agents) — AI integrity platform
| Agent | Role | Skills Profile |
|-------|------|---------------|
| AutoResearch | Autonomous research | gstack + superpowers |
| CEO | Strategy | built-in only |
| CFO | Finance | built-in + finance-analysis |
| CMO | Marketing | built-in only |
| CTO | Technical leadership | gstack + superpowers |
| Compliance | Regulatory compliance | built-in only |
| Founding Engineer | Core development | gstack + superpowers |
| Frontend Lead | UI development | gstack + superpowers |
| GEO-SEO Specialist | SEO | built-in only |
| Legal | Legal counsel | built-in only |
| Sales Lead | Sales | built-in only |

### Lerer AI (11 agents) — AI consulting/services
| Agent | Role | Skills Profile |
|-------|------|---------------|
| AutoResearch | Autonomous research | gstack + superpowers |
| CEO | Strategy | built-in only |
| CFO | Finance | built-in + finance-analysis |
| CMO | Marketing | built-in only |
| CTO | Technical leadership | gstack + superpowers |
| Compliance | Regulatory compliance | built-in only |
| Founding Engineer | Core development | gstack + superpowers |
| Frontend Lead | UI development | gstack + superpowers |
| GEO-SEO Specialist | SEO | built-in only |
| Legal | Legal counsel | built-in only |
| Sales Lead | Sales | built-in only |

### Lerer Research (10 agents) — Academic research
| Agent | Role | Skills Profile |
|-------|------|---------------|
| AutoResearch | Autonomous experiments | gstack + superpowers |
| Comparative Scholar | Cross-field analysis | built-in only |
| Devil's Advocate | Challenge assumptions | built-in only |
| Empiricist | Data-driven research | built-in only |
| GEO-SEO Specialist | Research visibility | built-in only |
| Methodologist | Research methodology | built-in only |
| Principal Investigator | Lead researcher | built-in only |
| Steelman | Strongest argument builder | built-in only |
| Theoretical Physicist | Physics research | built-in only |
| Writing Coach | Academic writing | built-in only |

## Technical Agents (receive gstack + superpowers as customSkillsDirs)
Exact names: CTO, Founding Engineer, Frontend Lead, Head of AI, AutoResearch

## Database
- Host: 127.0.0.1, Port: 54329, User: paperclip, DB: paperclip
- Column: `adapter_type` (NOT `adapter_config->>'adapter'`)
