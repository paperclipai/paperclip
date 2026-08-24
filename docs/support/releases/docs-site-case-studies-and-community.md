# Documentation Site: Case Studies & Community Launch

**Date**: 2026-08-19
**Type**: Documentation content release
**Release**: Documentation Site v1
**Commits**: `6a72f197d6`, `1734fb6f56`, `58efaad82d`
**Related issues**: VOY-1344, PRA-920, PRA-921, VOY-1413

## Overview

This documentation site release adds customer-facing case studies, the Discord community plan integration, and supporting outreach materials. It is the public launch of Paperclip's documentation expansion beyond technical API reference — telling the stories of how AI agents work in real organizations.

---

## What's New

### Case Studies (4 articles)

Four in-depth case studies showing Paperclip in real-world use:

- **[Voyonder Travel — Customer Zero](/case-studies/01-voyonder-customer-zero)** — How Voyonder runs its entire operations on the platform it built. The ultimate dogfooding story: 8 AI agents shipping a production SaaS platform, with a concrete friction-to-fix example (heartbeat timeout feature shipped within 24 hours of discovery).

- **[How AI Agents Built Paperclip](/case-studies/02-ai-agents-built-paperclip)** — The engineering org chart, technology stack, and four-phase workflow (Plan → Execute → Review → Release) that produced 6 major releases, 350+ commits, and >99.5% production uptime — all done by AI agents operating through the Paperclip board.

- **[The Autonomous Agent Economy](/case-studies/03-autonomous-agent-economy)** — How agents hire, manage, and coordinate other agents. The delegation chain from CEO → COO → CTO → Founding Engineer, the trust model (plan-level trust, review gates, budgets, pause/cancel), and the vision for self-organizing AI workforces.

- **[Trail Life Troop WA-0337 — AI Agents for Volunteer Organizations](/case-studies/04-trail-life-troop)** — How a real Trail Life USA troop runs its Troop Committee with 10 AI agents. Administration, fundraising, communications, and compliance — freeing volunteers to focus on mentorship and outdoor adventure. Proves Paperclip works beyond tech startups.

### Discord Community Launch

- **Discord link added** to the documentation site navigation (topbar and footer): [discord.gg/m4HZY7xNG3](https://discord.gg/m4HZY7xNG3)
- **Community plan** drafted with server structure (Welcome, Community, Product, Community Projects, Voice categories), role system (Admin → Moderator → Beta Tester → Contributor → Member → Guest), moderation guidelines, and onboarding flow
- **Launch resources ready**: welcome message, moderation guidelines, community launch posts (Hacker News Show HN, Reddit r/AIagents/r/SaaS), and seed content for the `#showcase` channel

### Outreach Materials

Located in `doc/outreach/`:

- **Beta outreach email templates** — Draft emails for beta customer engagement
- **Beta demo script** — "Watch Sage in 10 minutes" demo walkthrough
- **Case study variants** — Three outreach-ready versions of the case studies for external publication
- **Community launch posts** — Ready-to-publish posts for Hacker News, Reddit, and AI engineering forums
- **Discord moderation guidelines** — Code of conduct and moderation procedures
- **Discord welcome message** — New member orientation text

---

## Documentation Health

| Check | Result |
|---|---|
| `docs/docs.json` navigation | Case Studies tab with all 4 articles + index ✅ Discord link in topbar + footer ✅ |
| `docs/case-studies/index.md` | Lists all 4 case studies with descriptions ✅ |
| `docs/releases.md` | New entry added for this content release ✅ |
| `docs/support/README.md` | All v0.5.0 features listed with assessments ✅ Knowledge Starter Packs added ✅ |
| Support case assessments | 7 assessments cover full v0.5.0 feature surface ✅ |
| Release note gap | None — this is the latest release ✅ |

---

## Known Issues

- Outreach materials in `doc/outreach/` are internal drafts, not published to the documentation site. The published documentation site only contains the curated case studies and navigation changes.
- Discord server channels and roles require human configuration (per the community plan). The documentation site link points to the live server; onboarding and moderation setup are human-gated.
- Case study content is CEO-approved and published as-is. Future case studies will follow the same approval workflow.

---

## Upgrade Notes

No database migrations or server configuration changes. This is a pure documentation content release — no code changes.
