# TheBinMap Intelligence — Founding Constitution

> **Status:** Founding document (v0.1.0)
> **Date:** 2026-07-08
> **Authors:** Founding Technical Advisory Board (Chief Systems Architect, Chief Product Officer, Chief Security Architect, AI Systems Architect, Operations Director, Startup CTO, Knowledge Management Architect, Information Security Lead)
> **Runs on:** [Paperclip](../GOAL.md) — the control plane for autonomous AI companies
> **Classification:** Internal / Governing

This document is the founding constitution of **TheBinMap Intelligence**. It supersedes ad-hoc decisions. Where this document and a later decision conflict, this document wins unless it is formally amended (see §43 governance note). It is written to be operated for years, not for a single sprint.

---

## 0. Reading Order & How to Use This Document

1. Read §1–§6 to understand *why we exist and how we behave*.
2. Read §7–§10 before proposing any subsystem — **new code is the last option**.
3. Read §11–§14 to understand *who does what and who approves it*.
4. Read §15–§18 to understand *how raw signal becomes trusted intelligence*.
5. Read §19–§28 for the *product and platform surface*.
6. Read §29–§38 for the *operational and engineering guardrails*.
7. Read §39–§43 for *sequencing, risk, and the open frontier*.

Every section that proposes capability must pass **The Data Moat Test** (§ Preamble below). If it fails, it does not get built.

---

## The Data Moat Test (applies to every feature, forever)

No feature, subsystem, dashboard, or product enters the roadmap until it answers all four questions in writing:

1. **What proprietary data powers this?** — If the answer is "public web content anyone can scrape today," it is not a moat; it is a commodity.
2. **Why can't ChatGPT or Claude reproduce this from public knowledge?** — A general model can describe *what a bin store is*. It cannot know that *the store on Route 9 restocks Thursday at 8am, drops to $1.00 by Sunday, and has been declining in quality since March* — because that is ground-truth, local, time-varying, and verified.
3. **Does this become more valuable every month?** — If the value is static, it decays relative to competitors. Our data must compound: more visits, more corrections, more history, more trend resolution.
4. **Does each new user strengthen the system?** — Every haul report, correction, check-in, and photo must feed the verification network. If a user can consume without contributing signal, we have a leak.

A feature that passes all four is a **moat feature** and gets priority. A feature that fails is either commodity (buy/reuse, never build) or dead.

---

## 1. Mission

**Build the world's most trusted intelligence platform for the secondary-retail treasure economy** — bin stores, Amazon return stores, liquidation stores, overstock stores, and the resellers, treasure hunters, and store owners who live in it.

We do not sell a website. We sell **trust in continuously verified ground-truth intelligence** that cannot be reproduced from public knowledge and that gets more valuable every month.

## 2. Vision

A world where every person hunting value in the secondary-retail economy — from a weekend hobbyist to a full-time reseller running six-figure inventory — checks TheBinMap the way a driver checks a map app. Where store owners *want* to be on TheBinMap because it drives qualified foot traffic. Where the data is so trusted, current, and provenance-backed that it becomes the reference layer other tools build on top of.

TheBinMap.com is the public interface. **The intelligence corpus is the company.**

## 3. Core Values

1. **Trust is the product.** A single confidently-wrong data point costs more than ten missing ones. We would rather say "we don't know" with a low confidence score than assert something false.
2. **Provenance always.** Every fact traces to a source, a time, and a verification path. No orphan claims.
3. **Compounding over speed.** We optimize for a corpus that is worth more each month, not for shipping fast this week.
4. **Reuse before build.** Capabilities are assets; repositories are containers. We assemble; we rarely invent.
5. **Human oversight is a feature, not a bottleneck.** Autonomy is earned per action class, never assumed.
6. **Auditability by default.** If it mutated state, it left a log. If it can't be explained, it didn't happen.
7. **The community is a sensor network.** Each user strengthens the corpus or we redesign the feature.
8. **Safety is non-negotiable and read-only until proven otherwise.**

## 4. Engineering Doctrine

**New code is the LAST option.** Before any subsystem is proposed, the proposer must answer *"Can this already exist?"* and search, in this strict preference order:

| Priority | Option | Rule |
| --- | --- | --- |
| 1 | **Existing capability** | Already owned and running. Reuse as-is. |
| 2 | **Existing fork** | We already forked something close. Reuse the fork. |
| 3 | **Existing open-source project** | Mature, licensed compatibly, maintained. Adopt. |
| 4 | **Extension** | Extend an owned capability with a thin, documented seam. |
| 5 | **New subsystem** | Only when 1–4 are proven insufficient, in writing, with review. |

Corollaries:

- **Think in capabilities, not repos.** A repo is a box; the reusable asset is the capability inside it. Register capabilities (§8), not repos.
- **Every proposal carries a capability status flag** (see §8 taxonomy): `existing` / `unknown` / `needs-investigation` / `needs-extension` / `needs-build`.
- **A `needs-build` flag requires a rejection note for options 1–4.** "I didn't check" is not a rejection note.
- **Thin core, rich edges.** Mirror Paperclip's own doctrine: keep the intelligence core small and put optionality into plugins/extensions.

## 5. Safety Doctrine

**The company begins READ-ONLY.** This is a hard constraint of the founding phase, not a suggestion.

**Agents MAY:** read, analyze, summarize, classify, recommend, and create markdown reports.

**Agents MAY NOT (Phase 1, without escalation):** modify code, delete files, push commits, deploy, install unknown packages, access secrets, execute unknown shell scripts, or use production credentials.

Autonomy is expanded **per action class, deliberately, after the read-only phase has demonstrated reliability**, and only through the trust model in §6. There is no blanket "graduate to write access" event.

## 6. Trust Model — Green / Yellow / Red

Every action an agent can take is classified into exactly one tier. Classification is by **action class**, not by agent seniority — a CEO agent attempting a Red action is still blocked.

### 🟢 Green — Autonomous (no human in the loop)
Read-only, non-destructive, reversible-by-nature work.
- Read repos, docs, public web (within crawl policy §15), and the intelligence corpus.
- Analyze, classify, score, summarize.
- Produce markdown reports, recommendations, and draft artifacts held in a review queue.
- Propose capability-registry entries (proposal, not commit).

### 🟡 Yellow — Gated (requires human approval before effect)
State-changing but bounded and reversible.
- Publish verified data to the corpus or the public site.
- Promote a data point's confidence tier past a threshold.
- Run a **new or modified** ingestion source / crawler.
- Any outbound call to a non-allowlisted external API.
- Create or modify a subscription, price, or store-owner listing state.
- Merge to a protected branch.

Yellow actions **must** create a Paperclip approval gate (an approval issue) with: the proposed change, its provenance, a diff/preview, a confidence assessment, and a one-click revert path. Nothing takes effect until a human operator approves.

### 🔴 Red — Forbidden / Human-only + escalation
Irreversible, credential-bearing, or externally-consequential.
- Modify or deploy production code; push to production.
- Access, print, or transmit secrets or production credentials.
- Delete data or history (we don't hard-delete; see §32).
- Execute unknown/unsanctioned shell scripts or install unknown packages.
- Move money, sign contracts, or transact on behalf of the company.
- Anything touching a store owner's or user's payment or PII beyond the minimum documented flow.

Red actions are blocked at the tooling layer. A human performs them directly, or explicitly and traceably delegates a single instance with a logged, time-boxed grant. **A Red action is never silently escalated by an agent.**

## 7. Sandbox Strategy

- **Default execution is sandboxed and network-restricted.** Agents run in isolated worktrees with an **outbound allowlist** (crawl targets, owned services) and no ambient credentials.
- **Three sandbox rings:**
  - *Ring 0 — Analysis sandbox (Green):* read-only mounts of repos and a read replica of the corpus; no write path; no secrets; outbound restricted to allowlisted read sources.
  - *Ring 1 — Staging sandbox (Yellow):* can write to a **staging** copy of the corpus and a preview of the public site; changes require an approval gate to promote to production. Owned-service credentials only, scoped and short-lived.
  - *Ring 2 — Privileged (Red):* not available to agents. Human-operated, fully audited.
- **No production credentials in any agent-reachable ring.** Secrets are brokered (§30), never handed to agents.
- **Ephemeral by default.** Sandboxes are torn down after a task; nothing persistent leaks between tasks except through the logged corpus/staging layers.
- **Reuse first:** the sandbox/isolation layer is a *capability to source*, not to invent — candidate owner is **QuantumShield Core** (see §8/§29). Flag: `needs-investigation`.

## 8. Capability Registry

The Capability Registry is the single source of truth for *what we can already do*. It is owned by the **Knowledge Management Architect** and is the first thing consulted for any proposal (§4).

Each registry entry records:

| Field | Meaning |
| --- | --- |
| `capability` | The reusable ability (e.g., "sandboxed web crawl", "secrets brokering", "directory site generation"). |
| `owner-source` | The container(s) that provide it (QuantumShield Core, Paperclip, Selarix-Lattice, Directory Factory, CrawDaddy/OpenClaw, a fork, an OSS project). |
| `status` | `existing` / `unknown` / `needs-investigation` / `needs-extension` / `needs-build`. |
| `access-tier` | Green / Yellow / Red surface it touches. |
| `maturity` | proven / partial / prototype / unverified. |
| `interfaces` | How we call it (API, CLI, library, service). |
| `data-provenance` | If it produces data, where that data comes from. |
| `owner-agent` | Which agent/team is accountable for it. |
| `last-verified` | Date the capability was last confirmed to work. |

**Registry is capability-first.** We do not register "the CrawDaddy repo"; we register "sandboxed, robots-respecting web crawl (provided by CrawDaddy/OpenClaw)".

### 8.1 Initial Capability Audit (candidate assets → likely capabilities)

These are **hypotheses to be verified**, not confirmed facts. The Operations Director must convert each `unknown`/`needs-investigation` into a verified status within the first 90 days (§40).

| Candidate asset | Likely capability | Maps to | Status (initial) |
| --- | --- | --- | --- |
| **Paperclip** | Agent org, task hierarchy, budgets, approval gates, heartbeats, activity logging | §11–§14, §31 | `existing` |
| **QuantumShield Core** | Secrets brokering, sandbox isolation, security controls, audit primitives | §7, §29–§31 | `needs-investigation` |
| **CrawDaddy / OpenClaw** | Sandboxed web crawl + agent execution runtime | §15 ingestion, agent adapter | `needs-investigation` |
| **Directory Factory** | Directory/website generation (the public interface) | §19, §24, §27 | `needs-investigation` |
| **Selarix-Lattice** | Knowledge graph / data lattice / relationship store | §16–§18, historical knowledge | `unknown` |
| **Existing dashboards** | Ops/observability surfaces | §27–§28 | `needs-investigation` |
| **Existing monitoring tools** | Freshness/decay/health monitoring | §18, §28 | `needs-investigation` |

> **Doctrine reminder:** every one of the above is a reason *not* to write new code. The default assumption is that ingestion, crawling, secrets, sandboxing, directory generation, and knowledge storage **already exist**. The burden of proof is on anyone claiming otherwise.

## 9. Capability Harvest Process

"Harvest" is how a raw candidate asset becomes a trusted registry entry.

1. **Discover** — a candidate source is named (asset, fork, or OSS project).
2. **Probe (Green, read-only)** — an analyst agent reads the source, docs, and interfaces; produces a markdown *Capability Brief*.
3. **Classify** — assign status flag, access tier, maturity, and provenance.
4. **Verify** — in the Ring 0/1 sandbox, exercise the capability against a known input; record what actually worked (not what the README claims).
5. **Register** — commit the entry to the Capability Registry with `last-verified`.
6. **Wrap** — if reused, define a thin, documented interface seam (adapter) so the rest of the company depends on the *capability*, not the *repo's internals*.
7. **Re-harvest on decay** — capabilities expire. Any entry not verified in N months reverts to `needs-investigation`.

## 10. Existing Capability Audit Workflow (per-proposal gate)

Before any subsystem is approved, the proposer completes and attaches this checklist to the Paperclip issue:

- [ ] Searched the Capability Registry for an `existing` match. Result: ______
- [ ] Checked for an existing **fork** that covers it. Result: ______
- [ ] Checked for a mature **OSS** project. Result: ______
- [ ] Determined whether an **extension** of an owned capability suffices. Result: ______
- [ ] If proposing `needs-build`: attached a written rejection note for options 1–4.
- [ ] Ran The Data Moat Test (four questions) and attached answers.
- [ ] Classified every new action into Green/Yellow/Red.

An audit that ends in `needs-build` without the rejection note is rejected by the reviewer automatically.

## 11. Paperclip Company Structure

TheBinMap Intelligence is a **Paperclip company** — a first-order object with a goal, employees (all AI agents), an org chart, budgets, and approval gates. It conforms to the Agent Companies spec (`agentcompanies/v1`).

- **Company goal (top of the task hierarchy):** *"Build and maintain the most trusted, continuously-verified intelligence corpus for the secondary-retail treasure economy — where every published fact carries provenance and confidence, the corpus compounds monthly, and each user strengthens it."*
- **All work traces to the goal.** Per Paperclip doctrine, every task must answer "why am I doing this?" up the chain to the company goal.
- **Workflow pattern:** **Hub-and-spoke with an intelligence pipeline inside it.** The CEO delegates to executive spokes (Engineering, Intelligence, Product, Security, Ops); *within* Intelligence, work flows as a strict pipeline (ingest → verify → enrich → score → publish, §14).
- **Package layout** (Agent Companies spec):

```
thebinmap-intelligence/
├── COMPANY.md
├── agents/
│   ├── ceo/AGENTS.md
│   ├── cto/AGENTS.md
│   ├── chief-intelligence-officer/AGENTS.md
│   ├── chief-security-architect/AGENTS.md
│   ├── chief-product-officer/AGENTS.md
│   ├── operations-director/AGENTS.md
│   ├── knowledge-architect/AGENTS.md
│   ├── ingestion-engineer/AGENTS.md
│   ├── verification-analyst/AGENTS.md
│   ├── enrichment-analyst/AGENTS.md
│   ├── confidence-scorer/AGENTS.md
│   ├── historian-analyst/AGENTS.md
│   └── infosec-lead/AGENTS.md
├── teams/
│   ├── engineering/TEAM.md
│   ├── intelligence/TEAM.md
│   ├── security-governance/TEAM.md
│   └── product-growth/TEAM.md
├── projects/
│   └── read-only-corpus-foundation/PROJECT.md
├── skills/               # referenced, not vendored, wherever possible
└── .paperclip.yaml
```

- **Adapters:** default runtime unless a role demands otherwise. Crawl/ingestion agents target the CrawDaddy/OpenClaw runtime once verified; analysis agents use the company default. We do **not** hardcode an adapter we haven't verified.

## 12. Agent Hierarchy

```
CEO (reportsTo: null)
├── CTO / Chief Systems Architect            → Engineering & Platform
│   ├── Ingestion Engineer                   (data collection, crawl orchestration)
│   └── Platform/Directory Engineer          (public site, API, staging)
├── Chief Intelligence Officer (AI Systems)  → Intelligence pipeline
│   ├── Verification Analyst                 (corroboration, provenance)
│   ├── Enrichment Analyst                   (normalize, categorize, relate)
│   ├── Confidence Scorer                    (scoring model, decay)
│   └── Historian Analyst                    (trends, store-health-over-time)
├── Chief Product Officer                    → Product, segments, monetization
├── Chief Security Architect                 → Security architecture & trust model
│   └── Information Security Lead             (secrets, audit, incident response)
├── Operations Director                      → HITL queues, data QA, capability harvest
└── Knowledge Management Architect           → Capability Registry, docs, knowledge base
```

Rules (per Agent Companies spec): every non-CEO agent has `reportsTo` set; the CEO is `reportsTo: null`. Each agent's `AGENTS.md` body states **where work comes from, what it produces, who it hands off to, and what triggers it** — plus the standard execution contract (start actionable work in the same heartbeat, leave durable progress with a next action, use child issues for parallel work, mark blockers with owner + action, respect budget/approval/company boundaries).

Start lean where possible: the founding read-only phase can run with CEO, CTO, CIO, Ops Director, Verification Analyst, and Security. The rest are hired as the corpus and load justify them (§39).

## 13. Human Approval Workflow

Humans govern at the board level. The approval workflow is built on Paperclip's native approval gates:

1. An agent completes a **Yellow** action's preparation and stops at the gate.
2. It opens an **approval issue** containing: intent, provenance chain, preview/diff, confidence assessment, affected records, and a **one-click revert** reference.
3. A human operator reviews on the Paperclip board and **approves / rejects / requests changes**.
4. Approval unlocks the effect; the effect is executed and **logged** (§31).
5. Rejection routes back with reasoning captured as a comment.

Governance defaults:
- **Read-only phase:** *publishing* and *any external write* are Yellow. Nothing reaches the public corpus without human approval.
- **Budget hard-stop:** per Paperclip, budget exhaustion auto-pauses the company. Hidden token burn is forbidden; auto-mode is allowed only with visible spend.
- **Red actions never enter this queue** — they are human-performed, not agent-approved.

## 14. Intelligence Lifecycle

The core loop the whole company exists to run. It is a **closed, compounding loop**, not a one-shot pipeline:

```
INGEST → NORMALIZE → VERIFY → ENRICH → SCORE → PUBLISH → MONITOR/DECAY → RE-VERIFY ↺
```

1. **Ingest** (§15) — pull raw signal from sources; stamp source + time; never trust on arrival.
2. **Normalize** — coerce to canonical entities (store, location, restock event, price cadence, category, quality report).
3. **Verify** (§16) — corroborate across sources; require ≥N independent signals or human spot-check for high-stakes facts.
4. **Enrich** — relate entities (store ↔ restock schedule ↔ pricing cadence ↔ quality trend ↔ category ROI). This is where **Selarix-Lattice** (knowledge lattice) is the reuse candidate.
5. **Score** (§17) — assign confidence; below threshold stays private/flagged.
6. **Publish** (Yellow gate) — surface to the public site/API with visible confidence and freshness.
7. **Monitor / Decay** — confidence decays with time; freshness monitors detect staleness; user contradictions re-open records.
8. **Re-verify** — decayed or contradicted facts re-enter the loop.

**Every stage is provenance-preserving and append-only.** We never overwrite a fact; we supersede it and keep the history (§18, §32).

## 15. Data Ingestion Architecture

**Reuse target: CrawDaddy/OpenClaw** for sandboxed crawl + execution (`needs-investigation`). Do not build a crawler until this is proven insufficient.

**Sources (all read-only, policy-bound):**
- Public store presence: store websites, Google/Apple Maps, hours, social posts (restock announcements are gold).
- Community submissions: haul reports, check-ins, corrections, photos (the compounding sensor network).
- Partner/store-owner feeds: claimed listings, official restock/pricing calendars.
- Field observations: structured visit reports.

**Layered storage (medallion pattern):**
- **Bronze (raw):** exactly as ingested, immutable, with `source`, `fetched_at`, `raw_hash`. Never shown to users.
- **Silver (normalized):** canonical entities, deduplicated, still unverified.
- **Gold (verified + scored):** publishable, provenance-linked, confidence-scored.

**Ingestion policy (hard rules):**
- Respect `robots.txt`, rate limits, and Terms of Service. Crawling that violates a source is a Red action.
- No scraping behind auth, no PII harvesting, no circumventing access controls.
- Every fetch is logged with source, timestamp, and outcome.
- New or changed ingestion sources are **Yellow** (human-approved) before first run.

## 16. Verification Pipeline

Trust is the product, so verification is the heart of the machine.

- **Multi-source corroboration:** a fact's strength rises with independent, agreeing sources. A single unverified source yields low confidence, never a published "truth."
- **Recency weighting:** newer signals outweigh older ones; a 2-year-old restock day is a hypothesis, not a fact.
- **Community confirmation:** user check-ins and haul reports act as live corroboration — the network-effect flywheel.
- **Contradiction handling:** conflicting signals *lower* confidence and can auto-reopen a record; they never silently pick a winner.
- **Human spot-check:** high-stakes or low-confidence facts route to a human QA queue (Operations Director) before promotion — a Yellow gate.
- **Provenance graph:** every verified fact links to the exact signals that produced it. No orphan claims, ever.

## 17. Confidence Scoring

Every published data point carries a **visible confidence score** and a **freshness timestamp**. This transparency *is* the trust product.

Confidence is a function of:

```
confidence = f(source_reliability, corroboration_count, recency, human_verification, contradiction_penalty)
```

- **Source reliability:** learned weight per source class (official > partner feed > multi-user community > single social post > single scrape).
- **Corroboration count:** independent agreeing signals.
- **Recency:** time-decay curve; different facts decay at different rates (a store's *existence* decays slowly; its *restock day* decays faster; its *current pricing* decays fastest).
- **Human verification:** a spot-checked fact gets a durable boost.
- **Contradiction penalty:** unresolved conflicts subtract.

Tiers surfaced to users: **Verified**, **Likely**, **Reported**, **Stale**. Nothing below a floor is published as fact; it may appear as "reported, unverified."

## 18. Historical Knowledge

History is a first-class moat asset — it is exactly what a general LLM cannot have.

- **Append-only event log:** every fact change is an event, never an overwrite. The corpus is a temporal database.
- **Snapshots:** periodic materialized views enable "what did we know on date X."
- **Trend detection (Historian Analyst):** store-health-over-time, quality decline/improvement, seasonal restock patterns, category ROI shifts.
- **Why it compounds:** every month of history sharpens trend resolution, seasonality models, and decline detection. Month 24 of history is worth vastly more than month 2. This directly satisfies Data Moat Test #3.

## 19. Product Architecture

Four surfaces over **one shared intelligence corpus**. The corpus is the product; these are its faces.

1. **Public site — TheBinMap.com** (reuse: **Directory Factory**). SEO-driven discovery, store profiles, maps, confidence-labeled facts. Free tier is the top of the funnel and a **contribution surface** (each visit can yield a check-in/correction).
2. **Intelligence API** (§25). Programmatic access to verified, scored, provenance-linked data.
3. **Store-Owner Platform** (§24). Claim, verify, and manage a listing; analytics; promotion.
4. **Reseller Tools** (§22–§23). Alerts, ROI intelligence, route planning.

Architectural rule: **surfaces read from Gold; only the pipeline writes.** No surface mutates verified data directly; contributions enter as Bronze signals and re-run the loop.

## 20. Customer Segments

| Segment | Need | Willingness to pay | Contribution to corpus |
| --- | --- | --- | --- |
| **Treasure hunters / hobbyists** | "Where's a good bin store near me, and when does it restock?" | Low (free/ad) | High volume of check-ins & haul reports |
| **Serious resellers** | Restock timing, pricing cadence, category ROI, route planning | High (subscription) | High-quality structured reports |
| **Store owners** | Foot traffic, listing accuracy, promotion, analytics | Medium–High (platform) | Authoritative first-party data |
| **Enterprise / data buyers** | Market-level intelligence, trends, feeds | Highest (API/licensing) | None — pure consumers (priced accordingly) |

Every consuming segment must either contribute signal or pay a premium that funds verification — closing the Data Moat Test #4 leak.

## 21. Monetization Strategy

Layered, corpus-funded:

1. **Freemium public directory** — free discovery; funds top-of-funnel + contribution.
2. **Reseller subscriptions** (§22) — the recurring core.
3. **Store-owner platform** (§24) — claim + analytics + promotion.
4. **One-time software** (§23) — tools that ride the corpus.
5. **API / data licensing** (§25) — highest-margin, enterprise.

Principle: **price consumption in proportion to how little a segment contributes.** Contributors subsidize their access with signal; pure consumers pay in cash.

## 22. Subscription Model

Tiers (illustrative; validated in first 90 days):

- **Hunter (free):** map, basic store profiles, confidence labels, ability to contribute.
- **Reseller (paid monthly):** restock alerts, pricing-cadence models, saved routes, historical trend views for saved stores.
- **Pro Reseller (paid monthly):** category ROI intelligence, multi-region route optimization, freshness-guaranteed alerts, API rate allowance.
- **Team/Enterprise:** seats, bulk exports, priority verification, SLA on freshness.

Every paid feature must be a **moat feature** — powered by proprietary verified/historical data, not repackaged public info.

## 23. One-Time Software Products

Standalone tools that create pull toward the corpus and can be bought outright:

- **Route Planner** — optimize a hunting circuit across stores by restock day + pricing cadence.
- **Haul Logger / Inventory tool** — resellers log finds; logs (opt-in, anonymized) become high-quality corroboration signal.
- **Store Scorecard exports** — printable/exportable store-health reports.

Design rule: one-time tools should **feed the corpus** (opt-in) so they satisfy Data Moat Test #4 even at a one-time price point.

## 24. Store-Owner Platform

- **Claim & verify a listing** (identity check; Yellow gate).
- **First-party data:** official restock/pricing calendars, hours, load sources — the highest-reliability signal class (§17).
- **Analytics:** views, saves, foot-traffic proxies, confidence of their own listing.
- **Promotion:** featured placement, restock announcements pushed to nearby resellers.
- **Governance:** owners can *propose* corrections; they cannot silently overwrite community-verified facts. Owner claims are weighed heavily but remain in the provenance graph and subject to contradiction.

## 25. API Opportunities

- **Verified store data API** — locations, attributes, confidence, freshness.
- **Restock & pricing-cadence API** — the highest-value proprietary feed.
- **Trends/analytics API** — market-level movement (enterprise).
- **Contribution API** — partners submit signal back (strengthens corpus; may earn rate credits).

API governance: keyed, rate-limited, provenance/confidence included in every response, ToS forbidding re-publication that would let a buyer reconstruct the corpus. Outbound-only from Gold.

## 26. Future AI Opportunities

Each must pass the Data Moat Test — i.e., be powered by *our* corpus, not general knowledge:

- **Predictive restock modeling** — forecast the next drop from historical cadence per store.
- **Quality-decline early warning** — detect a store trending down before users notice.
- **Personalized route/deal recommendations** — from a reseller's own opt-in history + corpus.
- **Natural-language corpus assistant** — "which stores near me restock electronics on weekends and have improving quality?" — answerable *only* because we hold the ground truth.
- **Photo-based haul valuation** — estimate flip value from a haul photo + category ROI data.

None of these are viable for a general model precisely because they require our verified, local, temporal corpus.

## 27. Dashboard Architecture

- **Board (Paperclip):** company-level view — what agents are doing, spend/budget, pending approvals, goal alignment. Progressive disclosure: human summary on top, raw logs beneath.
- **Corpus Health dashboard:** freshness distribution, confidence-tier mix, coverage by region, decay/staleness alerts, contradiction backlog.
- **Verification Queue dashboard:** human QA workload (Operations Director), oldest low-confidence facts, high-stakes items awaiting spot-check.
- **Product dashboards:** funnel, subscriptions, store-owner claims, API usage.

Reuse target: **existing dashboards/monitoring tools** before building (`needs-investigation`).

## 28. Internal Tooling

- Capability Registry browser (§8).
- Provenance explorer (trace any published fact to its signals).
- Ingestion source manager (with Yellow-gate for new/changed sources).
- Sandbox launcher (Ring 0/1) with credential brokering.
- All internal tools default read-only; writes are gated.

## 29. Security Controls

**Reuse target: QuantumShield Core** for security primitives (`needs-investigation`).

- **Least privilege:** agents get the narrowest scope for the task; no ambient credentials.
- **Network allowlists:** outbound restricted per ring (§7).
- **Action-class enforcement:** Green/Yellow/Red enforced at the tooling layer, not by convention.
- **No secrets in agent context** (§30).
- **Supply-chain hygiene:** no installing unknown packages (Red); dependency review for anything adopted under doctrine option 3.
- **Input distrust:** all ingested data is untrusted until verified; treat crawled content as hostile (no eval, no shell injection surfaces).

## 30. Secrets Management

- **Brokered, never handed.** Agents request a scoped, short-lived credential from a broker (QuantumShield Core candidate); they never see long-lived secrets.
- **No secrets in repos, prompts, logs, configs, or `.paperclip.yaml` defaults.** (Mirrors Paperclip's rule: never export secrets; API keys only where a role requires, marked as secret inputs.)
- **Production credentials are Ring 2 / Red** — unreachable by agents.
- **Rotation & revocation** are standard operations; a leaked credential is an incident (§31 audit trail supports forensics).

## 31. Audit Logging

- **Every mutating action logs** an entry (Paperclip activity-log invariant): actor, action, target, before/after reference, timestamp, approval reference (for Yellow), and provenance.
- **Read actions on sensitive surfaces** (secrets broker, PII) are also logged.
- **Logs are append-only and tamper-evident** (QuantumShield audit primitives candidate).
- **"If it can't be explained, it didn't happen"** — an unlogged mutation is treated as an incident and rolled back.

## 32. Rollback Strategy

- **No hard deletes in the corpus.** Facts are superseded, not destroyed; history is preserved (§18). This makes "rollback" a first-class, safe operation.
- **Every Yellow action ships with a revert reference** captured at approval time.
- **Publishing is reversible:** a bad publish can be un-published and the prior Gold state restored from the event log.
- **Code/deploy rollback** is a Red, human operation with a documented runbook.
- **Budget/pause rollback:** a runaway agent is stopped by budget hard-stop and its staged (non-published) work discarded without corpus impact.

## 33. Git Workflow

- **Trunk-based with protected `main`.** Agents work in feature branches / worktrees.
- **Merges to `main` are Yellow** (human approval / PR review).
- **No force-push, no history rewrite on shared branches** (Red).
- **Conventional, reviewable commits** scoped to a single change; secrets never committed.
- **PRs follow the repository PR template** (Thinking Path, What Changed, Verification, Risks, Model Used, Checklist) — this constitution inherits that requirement from the host repo's `AGENTS.md`.

## 34. Branch Strategy

- `main` — always releasable, protected.
- `feature/<slug>` — one change, short-lived, sandboxed.
- `fix/<slug>` — targeted fixes.
- `spike/<slug>` — throwaway investigation (never merged as-is; findings become a Capability Brief).
- Long/parallel work is decomposed into **child issues**, not long-lived divergent branches.

## 35. Testing Philosophy

- **Trust demands tests.** The verification pipeline, confidence scoring, and provenance graph are the highest-risk code and get the most coverage.
- **Golden datasets:** curated known-good and known-bad signals to regression-test verification and scoring.
- **Property tests** for scoring monotonicity (more corroboration never lowers confidence; older never outranks newer, all else equal).
- **Run the smallest relevant check first** (host-repo doctrine); full typecheck/test/build before a PR-ready hand-off.
- **No feature is "done" until its data-moat claim is testable and tested.**

## 36. Deployment Philosophy

- **Read-only first.** The founding phase deploys analysis and reporting only; publishing to production is gated.
- **Staging always precedes production** (Ring 1 → Ring 2 promotion via approval).
- **Deploys are Red** (human-executed) in the founding phase.
- **Local-first, cloud-ready** — the mental model doesn't change between local and deployed (mirrors Paperclip).
- **Progressive exposure:** internal → private beta → public, each a deliberate, approved step.

## 37. Documentation Standards

- **Docs are dated and centralized.** Plans live in `doc/plans/YYYY-MM-DD-slug.md` (this file follows that convention).
- **Every capability has a Capability Brief** (§9); every published-fact class has a provenance/decay spec.
- **Contracts stay synchronized** — schema, shared types, services, and UI/API clients update together (host-repo invariant).
- **Additive over wholesale rewrites** for strategic docs; this constitution is amended, not silently replaced.
- **Every agent's `AGENTS.md`** documents its workflow role (inputs, outputs, handoffs, triggers).

## 38. Folder Structure

```
thebinmap-intelligence/
├── COMPANY.md                     # Agent Companies root
├── agents/                        # one dir per agent role
├── teams/                         # engineering, intelligence, security, product
├── projects/                      # planned work groupings
├── skills/                        # referenced skills (vendored only if required)
├── doc/
│   ├── constitution.md            # this document (source of truth)
│   ├── capability-registry/       # registry entries + Capability Briefs
│   ├── provenance/                # per-fact-class provenance & decay specs
│   ├── plans/                     # dated plan docs (YYYY-MM-DD-slug.md)
│   └── runbooks/                  # Red-action human runbooks
├── corpus/                        # (service) bronze/silver/gold layers + event log
├── ingestion/                     # crawl/source adapters (reuse CrawDaddy/OpenClaw)
├── pipeline/                      # verify / enrich / score
├── site/                          # public interface (reuse Directory Factory)
├── api/                           # intelligence API
└── .paperclip.yaml                # Paperclip vendor extension (no secrets)
```

## 39. Development Roadmap

Sequenced by **trust and compounding**, not by feature count.

- **Phase 0 — Foundation (read-only):** stand up the Paperclip company; run the capability audit (§8.1) to verified status; define provenance/confidence specs; ingest a seed region into Bronze/Silver; produce markdown intelligence reports only. No public publishing.
- **Phase 1 — First Gold, gated:** verification pipeline + confidence scoring online; human QA queue; publish a **single seed region** to a private preview behind Yellow gates.
- **Phase 2 — Public seed launch:** Directory Factory public site for the seed region; contribution surfaces (check-ins, corrections) live; the network-effect flywheel begins.
- **Phase 3 — Reseller subscriptions:** restock alerts + pricing cadence + trends for regions with sufficient history/coverage.
- **Phase 4 — Store-owner platform & API:** claims, analytics, licensed feeds.
- **Phase 5 — Predictive AI:** restock forecasting, decline early-warning, personalized recommendations.

Gate between phases: each requires the prior phase's corpus to meet **coverage + freshness + confidence** thresholds. We do not add surface faster than we can keep it trusted.

## 40. First 90 Days

**Days 1–30 — Verify the ground we stand on.**
- Instantiate the Paperclip company (CEO, CTO, CIO, Ops Director, Verification Analyst, Security).
- Convert every `unknown`/`needs-investigation` capability (§8.1) to a verified status via Capability Harvest (§9). Especially: QuantumShield (secrets/sandbox), CrawDaddy/OpenClaw (crawl), Directory Factory (site), Selarix-Lattice (knowledge).
- Write provenance + confidence-decay specs. Stand up Bronze/Silver storage.
- All work read-only; outputs are markdown reports.

**Days 31–60 — First trusted facts.**
- Verification pipeline + confidence scorer on golden datasets.
- Ingest a seed region; produce a private Gold slice behind Yellow gates.
- Human QA queue operational; audit logging verified end-to-end.

**Days 61–90 — Prove the flywheel.**
- Private preview of the seed region (Directory Factory).
- Contribution loop prototype (check-in/correction → Bronze → re-verify).
- Measure: does each contribution measurably raise confidence/coverage? (Data Moat Test #4, empirically.)
- Go/no-go review for Phase 2 public launch.

## 41. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Commodity data / no moat** | Fatal | Data Moat Test on every feature; invest in verification + history, not scraping. |
| **Publishing wrong facts** | Erodes trust (the product) | Confidence floors, Yellow publish gates, human QA, contradiction handling. |
| **Source ToS / legal exposure** | Legal + reputational | Strict crawl policy; robots/ToS respected; new sources Yellow-gated; no PII/auth circumvention. |
| **Assumed capabilities don't exist** | Schedule + scope shock | 90-day forced verification of all `unknown` flags; rejection notes required for new builds. |
| **Autonomy overreach** | Security incident | Green/Yellow/Red enforced at tooling layer; secrets brokered; Red unreachable by agents. |
| **Community abuse / poisoning** | Corpus corruption | Source reliability weighting, corroboration requirements, human spot-check, provenance graph. |
| **Cold-start (empty corpus)** | No value at launch | Seed one region deeply before expanding; contribution surfaces early. |
| **Runaway token spend** | Budget blowout | Paperclip budget hard-stop auto-pause; visible spend; no hidden burn. |

## 42. Open Questions

1. What *exactly* do QuantumShield Core, Selarix-Lattice, Directory Factory, and CrawDaddy/OpenClaw provide today, and at what maturity? (Blocks §8.1 verification.)
2. What is the legally-cleared crawl surface per source class? (Blocks §15.)
3. Which seed region maximizes density × contribution likelihood?
4. What are the real decay rates per fact class (existence vs. restock day vs. current pricing)? (Calibrates §17.)
5. What identity-verification standard gates store-owner claims? (§24.)
6. What contribution incentives are strong enough to sustain the flywheel without gaming?
7. Where is the line between "helpful owner correction" and "owner manipulating their own listing"?

## 43. Future Research Backlog

- Predictive restock modeling accuracy vs. history depth.
- Photo-based haul valuation feasibility.
- Cross-store category-ROI graph (Selarix-Lattice) as a licensable enterprise asset.
- Anti-poisoning / Sybil-resistance for community contributions.
- Confidence-model learning: automatically tuning source reliability weights from observed correctness.
- Seasonality and macro (retail-returns-volume) signals as corpus enrichers.
- Federated contribution (partner tools submitting signal) governance and economics.

---

### Governance note (amendment)

This constitution is amended additively and with review, never silently replaced. Any change touching the **Safety Doctrine (§5)**, **Trust Model (§6)**, or **Data Moat Test** requires explicit human board approval and a dated entry in `doc/plans/`. The founding read-only posture holds until a formal, logged decision expands it — per action class, never in bulk.

*Trust is the product. Provenance always. Reuse before build. Each user strengthens the system, or we redesign the feature.*
