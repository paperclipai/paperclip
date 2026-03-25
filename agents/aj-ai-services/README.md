# AJ AI Services Pvt Ltd

> Build the #1 social media handling AI app to $1M MRR.

AJ AI Services is an AI-powered company focused on automating social media content creation and distribution, starting with a **LinkedIn post generator MVP** targeting ship-in-24-hours velocity.

## What This Company Does

The company builds and operates an AI-driven social media pipeline:

1. **Ideation** — IdeaSpark researches trends and generates content angles
2. **Design** — DesignPro creates on-brand visual assets and templates
3. **Approval** — SocialSage reviews and schedules content
4. **Publish** — PublishBot distributes across LinkedIn and other platforms
5. **Govern** — EthicsWatch reviews all AI-generated content for safety and bias

While the content team runs the pipeline, TechLead's engineering team builds the underlying post-generator engine and keeps it running reliably.

## Org Chart

| Agent | Title | Reports To | Role |
|---|---|---|---|
| AJ | Chief Executive Officer & Founder | — | CEO (Board Operator) |
| TechLead | Chief Technology Officer | AJ | Engineering lead |
| SocialSage | Social Media Manager | AJ | Content pipeline owner |
| EventMaster | Event Manager | AJ | Events and activations |
| ProjectPilot | Program Manager | AJ | Delivery and tracking |
| EthicsWatch | Responsible AI Officer | AJ | Ethics and compliance |
| IdeaSpark | Creative Director - Ideation | SocialSage | Content ideation |
| DesignPro | Visual Designer | SocialSage | Visual assets |
| PublishBot | Publishing Specialist | SocialSage | Scheduling and distribution |
| DevOpsEngine | DevOps Engineer | TechLead | CI/CD and infrastructure |
| SecureGuard | Security Engineer | TechLead | Security and compliance |

### Org Tree

```
AJ (CEO)
├── TechLead (CTO)
│   ├── DevOpsEngine (DevOps Engineer)
│   └── SecureGuard (Security Engineer)
├── SocialSage (Social Media Manager)
│   ├── IdeaSpark (Creative Director - Ideation)
│   ├── DesignPro (Visual Designer)
│   └── PublishBot (Publishing Specialist)
├── EventMaster (Event Manager)
├── ProjectPilot (Program Manager)
└── EthicsWatch (Responsible AI Officer)
```

## Teams

| Team | Manager | Members |
|---|---|---|
| Content | SocialSage | IdeaSpark, DesignPro, PublishBot |
| Engineering | TechLead | DevOpsEngine, SecureGuard |
| Governance | EthicsWatch | ProjectPilot |

## Projects

### LinkedIn MVP

The first project ships the LinkedIn post generator MVP within 24 hours. Seven seed tasks cover every aspect of the launch:

| Task | Assignee | Priority |
|---|---|---|
| Build LinkedIn post generator core module | TechLead | Critical |
| Wire up GitHub Actions for CI/CD pipeline | TechLead | High |
| Create initial content calendar and posting strategy | SocialSage | High |
| Establish content safety and AI ethics guardrails | EthicsWatch | High |
| Security baseline for social media app infrastructure | SecureGuard | High |
| Set up project tracking and delivery cadence | ProjectPilot | High |
| Design brand templates for LinkedIn posts | DesignPro | Medium |

## Recurring Tasks

| Task | Schedule | Assignee |
|---|---|---|
| Daily Standup | Daily at 09:00 IST | ProjectPilot |

## Getting Started

Import this company into your Paperclip instance:

```bash
paperclipai company import --from agents/aj-ai-services
```

Or from GitHub:

```bash
paperclipai company import --from https://github.com/paperclipai/paperclip/tree/main/agents/aj-ai-services
```

### Environment Secrets

Two agents need secrets configured after import:

| Agent | Secret | Requirement |
|---|---|---|
| DevOpsEngine | `GH_TOKEN` | Required — for GitHub Actions and CI/CD |
| PublishBot | `LINKEDIN_API_KEY` | Optional — for direct LinkedIn API publishing |

## References

- [Agent Companies Specification](https://agentcompanies.io/specification)
- [Paperclip](https://github.com/paperclipai/paperclip)
