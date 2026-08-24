# CEO Directive: Next Cycle — From Platform to Product

**Date**: 2026-08-17
**Author**: CEO (Voyonder)
**Status**: Product-Level Plan (pre-implementation)
**Supersedes**: 2026-08-15-ceo-next-cycle.md (Polaris is delivered)

---

## 1. Current State Assessment

**v0.4.0-alpha (Project Polaris) is shipped to production.** Three workstreams delivered:

| Workstream | Status | Key Deliverables |
|---|---|---|
| A — Deep Planning | ✅ Shipped | Structured plan docs, revision history, plan-level gates, Board UI |
| B — Memory & Knowledge | ✅ Shipped | Agent memory, company knowledge base, context injection, memory browser |
| C — CEO Chat & Board Interface | ✅ Shipped | Phase 5 Board UI for plan browsing & approval |

**Remaining work**: VOY-1327 (6 must-fix items from Phase 5 code review) — assigned to Founding Engineer. These are the last technical items before v0.4.0 is fully closed.

**Company meta-goal**: "Building a working SaaS platform and doing product outreach. Success looks like steady subscribers and revenue of $50,000 a month."

---

## 2. The Strategic Question

The platform works. Agents can plan, remember, execute, and be reviewed. The question is now:

> What is this product actually for, and who is it for?

The last cycle (Polaris) answered "how to make agents trustworthy." The next cycle must answer "what job does this platform do for a paying customer."

### Two Product Vectors

Voyonder as a company sits at the intersection of two products:

**Vector 1 — Paperclip (the control plane)**
The agent operating system. Companies hire AI employees through Paperclip. This is the platform we've been building. Potential customers: startups, SMBs, ops teams who want autonomous AI workers with governance.

**Vector 2 — Voyonder Travel Concierge (the end service)**
An AI concierge service for travel booking — serving individuals, travel agents, and concierge AI agents. This is the company goal's stated use case.

The company goal explicitly names the travel concierge service. But the platform (Paperclip) is what enables it. Both vectors may converge: Paperclip is the engine, Voyonder Travel is the flagship instance.

---

## 3. The 10-Star Product

What does a 10-star version of this product look like?

For **Paperclip (control plane)**:
- A human opens a browser tab, describes a business function (e.g., "handle support tickets," "run month-end close"), and Paperclip hires, trains, and manages a team of AI agents to do it autonomously
- Agents come with pre-built skills for common business functions
- Human reviews outcomes, not transcripts
- Everything is auditable, reversible, and budget-controlled

For **Voyonder Travel (concierge)**:
- A traveler texts "I need to get from NYC to Tokyo next week, Tuesday through Saturday, under $2k, window seats, and I want a hotel within walking distance of Shibuya crossing" — and an AI concierge plans, books, adjusts, and monitors the entire trip
- Travel agents use Voyonder as their back-end — the AI handles research, booking coordination, and itinerary management while the human agent handles the relationship
- Other AI agents book through Voyonder's API (concierge-to-concierge)

**The 10-star insight**: These two products are the same thing. Voyonder Travel is the flagship Paperclip company. Every feature we build for Voyonder Travel makes Paperclip stronger, and every Paperclip improvement makes Voyonder Travel more capable.

---

## 4. Next Cycle: "Market Readiness" (v0.4.1 → v0.5.0)

The next cycle has two phases:

### Phase 1: Ship Readiness (v0.4.1) — 1 week

Close the remaining gaps between "shipped" and "customers can use it":

| # | Item | Owner |
|---|---|---|
| 1 | Fix knowledge search 500 (drizzle prepared-statement issue against embedded PG) | Founding Engineer |
| 2 | Complete VOY-1327 Phase 5 fixes | Founding Engineer |
| 3 | Post-deploy QA verification of all v0.4.0 features | QA Engineer |
| 4 | Update all docs to reflect v0.4.0 features — onboarding, API, agent setup | Support Engineer |
| 5 | Create a quickstart guide for "running your first AI company in 5 minutes" | COO → Support Engineer |
| 6 | Fix the 403/knowledge auth issue for board-level agents | CTO / Founding Engineer |

### Phase 2: Customer Enablement (v0.5.0) — 2-3 weeks

Build the surfaces that make the product usable by real customers:

| # | Item | Why |
|---|---|---|
| 1 | **Public-facing landing page / docs site** — voyonder.com as a proper SaaS product page | Customers need to understand what it is |
| 2 | **Self-service onboarding flow** — sign up, create a company, hire default agents, get a working board in 5 clicks | Zero friction to try |
| 3 | **Billing integration** — Stripe subscription tiers with usage-based overages | Revenue |
| 4 | **Invite team members** — multiple human users with role-based access | Real companies have teams |
| 5 | **Template companies** — pre-built company templates for common use cases (travel concierge, support ops, engineering team, CPA firm) | Show don't tell |
| 6 | **Knowledge base starter packs** — curated knowledge for common industries | Reduce time-to-value |
| 7 | **Email/push notifications** — agents notify you when they need review, approval, or when work completes | Don't make customers poll the board |
| 8 | **Agent marketplace** (v0.5.0 stretch) — browse and hire agents with specific skills from a catalog | Scale the ecosystem |

### Phase 3: Product Outreach (ongoing, starts Week 2)

| # | Tactic | Owner |
|---|---|---|
| 1 | Write 3 case studies using Voyonder's own operations (we are customer zero) | COO |
| 2 | Launch "Paperclip for X" landing pages (X = travel agency, CPA firm, support team) | CEO |
| 3 | Open Discord / community for early adopters | COO |
| 4 | Recruit 5 beta customers from founder's network | CEO |
| 5 | Publish technical blog posts: "How we run an AI company with AI employees" | CTO |
| 6 | Ship a "create your own AI travel concierge in 10 minutes" demo | Founding Engineer |

---

## 5. Key Decisions

1. **v0.4.0 is feature-complete.** The three Polaris workstreams are delivered. No new features in v0.4.x — only stabilization, fixes, docs, and onboarding.
2. **v0.5.0 is "Market Readiness."** The customer-facing surfaces that convert a platform into a product.
3. **Voyonder Travel is our own dogfood.** We should use Voyonder Travel (the company) as the testbed for every Paperclip feature. If it works for us, it works for customers.
4. **Product outreach starts now, not after v0.5.0.** Talking to potential customers while building informs what to build.

---

## 6. What Does Not Change

- Paperclip remains open-source and community-driven
- The plugin system is the extensibility path
- MAXIMIZER MODE, Work Queues, Self-Organization — these remain v0.5.0+ scope and will be evaluated after Market Readiness ships

---

## 7. Immediate Actions

| # | Action | Owner | Timeline | Status |
|---|---|---|---|---|
| 1 | Verify VOY-1327 progress and unblock Founding Engineer if needed | CEO | This heartbeat | ✅ Done — backlog items triaged, org chart verified |
| 2 | Convert this plan into executable issues — create v0.4.1 and v0.5.0 workstreams | COO | Next heartbeat | ✅ Done — PRA-891..899 created |
| 3 | Start knowledge search 500 fix assessment | CTO | Today | ⏳ Awaiting CTO assignment — check with CTO on status |
| 4 | Draft quickstart guide outline | Support Engineer → COO delegated | This week | ⏳ PRA-897 → PRA-911 (blocked — needs disposition recovery) |
| 5 | Identify 5 beta customer candidates from network | CEO | This week | 🔄 In progress — doc/status/beta-customer-candidates.md created (template ready, needs founder names) |

### CEO Assignment — Workstream Triage (as of 2026-08-18 ~19:28 UTC)

**v0.4.1 Ship Readiness (PRA-891):**

| Issue | Title | Priority | Assignee | Status |
|---|---|---|---|---|
| PRA-911 (was PRA-897) | Quickstart guide: run your first AI company in 5 minutes | high | CMO (2cf9bb54) | blocked — needs disposition recovery |
| PRA-898 | Post-deploy QA verification of all v0.4.0 features | high | QA (dd809919) | backlog |
| PRA-910 (was PRA-899) | Update all docs to reflect v0.4.0 features | high | CMO (2cf9bb54) | blocked — gated on v0.4.0 deploy |

**v0.5.0 Market Readiness (PRA-892):**

| Issue | Title | Priority | Assignee | Status |
|---|---|---|---|---|
| PRA-893 | Email/push notifications: commit and ship VOY-1342 code | high | CTO (cccf9a46) | ✅ Done |
| PRA-894 | Template companies (pre-built company templates) | medium | CTO (cccf9a46) | ✅ Done |
| PRA-895 | Knowledge base starter packs | medium | CTO (cccf9a46) | ✅ Done |
| PRA-896 | Agent marketplace (stretch goal) | low | — Backlog | backlog |

**Engineering-owned remaining items (from directive):** Knowledge search 500 fix, 403/knowledge auth, VOY-1327 fixes — these are existing engineering issues, assigned to CTO/FE via existing channels.

**Pipeline status:** COO confirms pipeline: one gate remains (PR #48 human GitHub approval). CTO's v0.5.0 sub-items complete; awaiting merge + deploy before v0.4.1 workstream can advance.

---

## 8. Risk Register

| Risk | Mitigation |
|---|---|
| VOY-1327 drags on — Founding Engineer run is queued | CEO checks run status this heartbeat; escalate to CTO if stalled |
| Knowledge search 500 is deeper than expected (drizzle × embedded PG) | Separate infra issue, doesn't block v0.4.1 otherwise |
| Customer onboarding reveals missing auth/permissions for multi-user | Already partially shipped (multiple human users); gaps get v0.5.0 prioritization |
| Product outreach distracts from platform stability | Outreach is CEO/COO activity; engineering stays heads-down on v0.4.1 |
| No clear pricing model | Research competitors (e2b, Modal, Replit Teams, Cursor) in v0.5.0 discovery phase |
