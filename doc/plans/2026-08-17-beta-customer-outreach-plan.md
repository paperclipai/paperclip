# Beta Customer Outreach Plan — 5 Beta Customers

**Date**: 2026-08-17
**Author**: CEO (Voyonder)
**Status**: In progress — outreach starting
**Goal**: 5 beta customers from the founder's network, signed and onboarded by end of Week 2 (2026-08-28)

---

## Why Beta Customers

The platform (Paperclip) is shipped and self-hostable. v0.4.0 is feature-complete. The company goal is $50k MRR. Beta customers are the first revenue signal AND the first product feedback loop: their usage will expose what real companies need from an agent operating system.

We are customer zero (see case studies VOY-1344). Beta customers are customers one through five.

## Target Profiles (in priority order)

| # | Profile | Why | Who to approach |
|---|---|---|---|
| 1 | **Travel agency / concierge business** | Company meta-goal is the AI travel concierge. A real travel business validates the flagship use case | Founder's travel-industry contacts; local WA agencies; AI-travel startups |
| 2 | **SaaS startup with ops overhead** | Ops teams are the natural buyers of autonomous AI workers with governance | Founder's startup network; YC/tech community contacts |
| 3 | **CPA / bookkeeping firm** | Financial workflows are document-heavy, review-gated, budget-controlled — Paperclip's strengths | Existing PraeSyn accounting relationships (Bluevine, Gusto ecosystem) |
| 4 | **Support-heavy SMB** | Ticket triage, KB management, escalation — the classic first AI hire | Local SMBs, e-commerce brands |
| 5 | **AI-native agency** | Builds AI products for clients; can resell/embed Paperclip | AI consulting shops, prompt-engineering agencies |

## Offer

- **Free 90-day beta license** (all v0.4.0 features; production self-hosted deploy on their infra or ours)
- **White-glove onboarding**: dedicated setup call, company template, starter skills, KB starter packs
- **Weekly check-in calls** for feedback (structured, 30 min)
- **NPS survey at 30 days**
- **Founding-betapartner pricing**: 40% off first 12 months post-beta, locked in
- **Publicity**: case study (with permission) at launch

## Outreach Playbook

### Step 1 — Build the list (this week)
- [ ] 20 warm prospects from founder's network (name, company, profile #, intro channel)
- [ ] 10 cold-ish prospects via LinkedIn/Discord/communities
- [ ] Track in `doc/status/beta-customer-pipeline.md` (table below)

### Step 2 — First touch (Week 1)
- Warm: personal intro message (draft below) — 3 per day max
- Cold: value-first DM via community/Discord where we're already present
- Always link: quickstart guide + 3-minute demo path (`npx paperclipai onboard`)

### Step 3 — Demo & qualification call (Week 1-2)
- 30-min screen: their workflow, pain point, fit against Paperclip features
- Show a live board with THEIR company name and 3 pre-hired agents
- Confirm: decision-maker present, budget exists, timeline to deploy

### Step 4 — Sign & onboard (Week 2)
- Send beta agreement (one-pager, no legalese)
- Schedule onboarding call; assign COO as onboarding lead
- Goal: working board within 24h of signature

## Draft Outreach Messages

### Warm intro (travel agency / concierge)

> Hi [Name],
>
> You know we've been building AI agent infrastructure for a while. We've now shipped the platform that runs our own company — it hires AI employees (agents), assigns them work, reviews their output, and keeps every action on a budget and an audit trail. Our own travel concierge is one of the flagship deployments.
>
> We're onboarding 5 beta customers this month: free 90-day license, white-glove setup, and founding-partner pricing locked in after. If you've ever wanted to see what a "digital operations team" looks like for your business, I'd love to show you ours first.
>
> 30 minutes this week or next? I'll bring a live demo set up for your company.
>
> — Ben (Voyonder)

### Warm intro (SaaS / ops)

> Hi [Name],
>
> Quick one: we run our whole company on software that hires AI agents as employees — they plan, execute, and get reviewed by us, with budgets and audit trails on everything. It's live, self-hostable, and we're looking for 5 beta partners this month.
>
> If your ops team is drowning in tickets/reports/review cycles, this is worth 30 minutes. Founding-partner pricing if you're one of the five.
>
> — Ben

### Cold-ish (community / Discord)

> Hey — we're the team behind Paperclip, an open-source agent operating system (we run our own AI company on it). We're picking 5 beta customers this month: free 90-day license + white-glove onboarding. If you run or work at a company that wants autonomous AI workers with real governance (budgets, reviews, audit), I'd love to talk. Link: [quickstart]

## Pipeline Tracker

| # | Prospect | Profile | Channel | First touch | Status | Notes |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |

Status: `listed → contacted → demo → signed → onboarded`

## Feedback Loop

- Weekly check-in call notes → `doc/status/beta-feedback/` (one file per customer)
- Feature requests → filed as issues with `customer-request` label, priority by signal
- NPS at 30 days → metric on the company goal dashboard

## Success Criteria

- [ ] 5 signed beta customers by 2026-08-28
- [ ] All 5 have a working board within 24h of signature
- [ ] ≥3 structured feedback sessions completed by 2026-09-11
- [ ] First 2 paying conversions (beta → paid) by 2026-10-01

---

## Notes for Founder

The outreach plan is drafted and the pipeline tracker is live at `doc/status/beta-customer-pipeline.md`. I (CEO agent) can:
- Draft and personalize outreach messages (done above — pick and customize)
- Maintain the pipeline tracker as prospects are added
- Prepare demo boards per prospect
- Handle onboarding logistics with COO once a prospect signs

What I need from you (human): the 20-30 warm prospect names from your network, or approval to message from any shared company account/email. If you give me names + intro channels, I'll populate the tracker and prepare per-prospect demo boards this week.