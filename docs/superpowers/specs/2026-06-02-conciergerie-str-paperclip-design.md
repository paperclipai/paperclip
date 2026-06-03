# Design Spec — Seasonal STR Conciergerie Company on Paperclip (v1 PoC)

- **Date:** 2026-06-02
- **Status:** Draft v1.2 — product reframing: the conciergerie agent company is the main product; starterkit emerges post-v1 (spec-only, no code; see §15)
- **Target repo for build:** this Paperclip checkout (`packages/plugins/str-ops` + a `conciergerie-str` company package)
- **Author:** Oleg (with Claude)

## 1. Purpose & scope

Build a **working proof-of-concept** of a seasonal short-term-rental (Airbnb-style)
conciergerie operated as a Paperclip "company": a team of AI agents that handle
guest communication, bookings, turnover/maintenance, and pricing/owner reporting,
driven by Paperclip heartbeats.

**Product framing (important).** The **main product is the Paperclip Conciergerie
Agent Company** itself — the running team of agents that operates the STR business. A
starterkit/toolkit is **not** the starting product and is **not yet defined**. The
conciergerie company is its own **first internal client**: once it runs, its agents
will request the tools they need to do the job (website, mobile app, guest widget,
owner cockpit, admin dashboard, QR guidebook, voice assistant, reporting tools,
deployment tools). Those requested tools **may later** be extracted into a future
starterkit — see "Future Tooling / Starterkit Emergence." This spec uses neutral
language for that future: *future starterkit*, *reusable agency tools*, *conciergerie
tooling*, *STR agency toolkit*.

**v1 = PoC**, not a live business:
- Seeded demo data (2–3 properties, owners, guests).
- **Mock** external providers (channel manager, messaging, payments) behind a
  provider interface so real ones drop in later with no agent/skill/table change.
- Success = the full four-loop conciergerie cycle **demonstrably fires on the
  Paperclip heartbeat** end to end.

**Explicitly out of scope for v1:** real channel-manager/PMS/payment integrations,
secrets/credentials, long-term-rental and real-estate-sales segments, multi-company
portfolios, production deployment, billing of real money. **Also out of scope for v1:
any tooling/product build** — website, mobile app, guest widget, owner cockpit, admin
dashboard, QR guidebook, voice assistant, reporting tools, deployment tools — **and
any future-starterkit extraction**. v1 is the conciergerie company PoC only.

Later segments (long-term rental, real-estate sales), real integrations, and the
future tooling/starterkit are separate sub-projects layered on the same foundation.

## 2. Architecture — two artifacts

```
+---------------------------------------------------------------+
|  conciergerie-str  (agentcompanies/v1 package)                |
|  org chart + goals + human-facing agents that load STR skills |
|  -> portable, imported via `paperclipai company import`       |
+-----------------------------+---------------------------------+
                              | agents call plugin tools
+-----------------------------v---------------------------------+
|  str-ops  (Paperclip plugin = domain engine)                  |
|  - DB namespace `str_ops` (system-of-record tables)           |
|  - agent tools  - cron jobs  - inbound webhook  - UI dash     |
|  - managed skills (domain IP) + recurring routines            |
|  - provider interface: MOCK now -> Airbnb/Booking/Stripe later|
+---------------------------------------------------------------+
```

**Import (this checkout).** `paperclipai company import <path-or-url>` — the `cli/`
`paperclipai` binary (`cli/src/index.ts`, `cli/src/commands/client/company.ts`). The
external `companies.sh` CLI is an alternative for published packages and is **not**
part of this repo.

**Split rationale.** The plugin is the system-of-record for *domain records*
(bookings, guests, owners, money) and owns the *external edges* (channel poll,
inbound messages). Paperclip **issues** are the *actionable work* agents perform
(guest threads, turnover tasks, maintenance tickets, pricing reviews, owner
statements) so that the existing heartbeat, budget hard-stops, atomic issue
checkout, approval gates, and activity logging all apply for free. This is the
Paperclip-idiomatic shape and is still a "full domain plugin."

### Why a plugin (not zero-code issue overload)

The plugin SDK (`packages/plugins/sdk`, `doc/plugins/PLUGIN_*`) supports everything
the domain needs, verified against the cloned code:
- `database` namespace with `migrations/*.sql` + `coreReadTables`; capabilities
  `database.namespace.migrate|read|write`. Runtime `ctx.db.query()` allows SELECT
  from the namespace + whitelisted core tables; `ctx.db.execute()` allows
  INSERT/UPDATE/DELETE only in the namespace.
- Agent-callable `tools` (JSON-schema params, handler returns `{content, data}`),
  capability `agent.tools.register`.
- Cron `jobs` (`jobs.schedule`) registered via `ctx.jobs.register`.
- Inbound `webhooks` (`webhooks.receive`) handled in `onWebhook`.
- `events.subscribe` to core domain events (`issue.checked_out`, `issue.updated`, …).
- `ctx.issues.create` / `ctx.issues.requestWakeup` / `ctx.issues.relations.*` to
  spawn work and wake agents through the host (budget stops, execution locks,
  blocker checks, heartbeat policy still apply).
- Manifest-declared managed `agents`, `projects`, `skills`, `routines` (as in
  `plugin-llm-wiki`).
- UI slots (`page`, `dashboardWidget`).

## 3. `str-ops` plugin internals

### 3.1 Data store — CouchDB (database `str_ops`, reuse the existing instance)

System-of-record **CouchDB JSON documents** (one DB `str_ops`; every doc carries `type`
+ `companyId`). **No Postgres / no SDK DB namespace** — the plugin is a CouchDB client
over `ctx.http`. Natural-key docs use **deterministic `_id`s** so uniqueness + dedupe
come for free (replacing SQL `UNIQUE`):

- `owner:<uuid>` · `property:<companyId>:<externalCode>` · `guest:<companyId>:<contact>`
  · `booking:<companyId>:<channel>:<externalRef>` (dedupe = a plain GET).

List/overlap queries use **Mango `_find`** + indexes created on startup
(`{type,companyId}`, `{type,companyId,propertyId}`). Doc fields:

| Doc `type` | Fields |
|---|---|
| `property` | id, company_id, name, address, type, owner_id, base_price_cents, currency, ical_url(null in mock), season_ranges(jsonb), paperclip_project_id |
| `owner` | id, company_id, name, email, commission_pct, payout_method(mock) |
| `guest` | id, company_id, name, contact, locale(`fr`/`en`) |
| `booking` | id, company_id, property_id, guest_id, channel, status, check_in, check_out, nights, gross_cents, fees_cents, payout_cents, external_ref, paperclip_thread_issue_id |
| `message` | id, company_id, booking_id(null), guest_id, direction(`in`/`out`), channel, body, locale, status, paperclip_issue_id |
| `financial_event` | id, company_id, booking_id, owner_id, type(`revenue`/`fee`/`payout`/`commission`), amount_cents, currency, period(YYYY-MM) |
| `pricing_suggestion` | id, company_id, property_id, date_range, suggested_price_cents, occupancy_pct, reason |

**Actionable work items (turnover, maintenance, guest thread, pricing review,
owner statement) are Paperclip issues, NOT rows in this schema.** The plugin links
back via `paperclip_*_issue_id` columns.

### 3.2 Tools (agent-callable)

`list_properties`, `get_owner`, `upsert_booking`, `list_bookings`,
`check_availability` (double-booking guard), `list_messages`, `send_message`
(mock outbound), `record_financial_event`, `get_owner_statement` (query over
`financial_event`), `get_occupancy`, `suggest_price`.

All tools take `companyId` and validate it against the active invocation scope.

### 3.3 Cron jobs (worker code)

| jobKey | Schedule (5-field cron) | Action |
|---|---|---|
| `channel-poll` | `*/15 * * * *` | Pull new bookings from the mock channel provider; `upsert_booking` with availability guard; on a genuinely new booking, create the guest-welcome issue **and immediately `ctx.issues.requestWakeup` it**, and create + wake the turnover issue. |
| `pricing-sweep` | `0 6 * * 1` (weekly, Mon 06:00) | Write `pricing_suggestion` rows; optionally create + `requestWakeup` a pricing-review issue for Revenue. |

Plugin job schedules MUST be valid **5-field cron strings** — the manifest validator
rejects words like `weekly`/`monthly` (`packages/shared/src/validators/plugin.ts:71-86`).

Agent-reasoning recurring work that is not pure data-sync is modeled as Paperclip
**routines** (which create issues **and call assignment wakeup**), not plugin jobs, so
the heartbeat owns execution:

- `owner-statement` routine — cron `0 6 1 * *` (monthly, 1st 06:00): aggregate
  `financial_event` for the prior period and create a monthly statement work-product
  issue assigned to Owner-Relations.

### 3.4 Webhook

`inbound-message` (POST): store a `message` row, then either `ctx.issues.create`
a guest-thread issue or `ctx.issues.requestWakeup` the Guest-Comms agent on the
existing thread.

### 3.5 Subscribed events

`issue.checked_out`, `issue.updated` for turnover/maintenance lifecycle reflection
back into `booking`/work-item state.

### 3.6 Managed skills (the domain IP, provider-agnostic, authored once)

`guest-message-triage` (FR/EN; reuses the existing `deborah-concierge` routing),
`checkin-instructions` (incl. lock-code issuance — mock), `booking-intake`,
`availability-sync`, `turnover-schedule`, `maintenance-dispatch`,
`dynamic-pricing`, `owner-statement`.

### 3.7 Capabilities (manifest)

`http.outbound` (CouchDB + later real providers), `secrets.read-ref` (CouchDB creds),
`jobs.schedule`, `webhooks.receive`, `issues.create`, `issues.update`, `issues.wakeup`,
`issue.comments.create`, `issue.relations.read`, `issue.relations.write`,
`agent.tools.register`, `agents.managed`, `projects.managed`, `skills.managed`,
`routines.managed`, `events.subscribe`, `ui.page.register`, `ui.dashboardWidget.register`,
`activity.log.write`, `plugin.state.read|write`.
**No `database.namespace.*`** — records live in CouchDB, not the SDK Postgres namespace.

The managed-resource + relations capabilities are required because the manifest ships
managed agents/projects/skills/routines and the plugin calls `ctx.issues.relations.*`
(verified against `packages/shared/src/constants.ts:765-775` and the reference
`packages/plugins/plugin-llm-wiki/src/manifest.ts:97-117`). Omitting them makes the
host capability gate reject those calls.

## 4. Org chart (5 agents)

| Agent | reportsTo | Skills | Adapter |
|---|---|---|---|
| Concierge Manager (CEO) | null | issue-triage, task-planning | claude_local |
| Guest-Comms | concierge-manager | guest-message-triage, checkin-instructions | claude_local (Hermes optional later) |
| Reservations *(booking manager)* | concierge-manager | booking-intake, availability-sync | **hermes_local** (Hermes → MemoryOS) |
| Turnover & Maintenance | concierge-manager | turnover-schedule, maintenance-dispatch | claude_local |
| Revenue & Owner-Relations | concierge-manager | dynamic-pricing, owner-statement | claude_local |

Languages: **FR + EN**. Open option: split Revenue and Owner-Relations into two
agents if the demo needs it.

**Agent memory (Hermes MemoryOS).** The **Reservations** agent (the *booking manager*)
is the **first agent on the `hermes_local` adapter**, giving it Hermes's persistent
**MemoryOS**. Roll-out is phased: the other agents stay `claude_local` for now and adopt
Hermes/MemoryOS later as needed. Requires Hermes installed (`~/.hermes`) and the Hermes
adapter plugin registered (Board → Adapter manager; type `hermes_local`). Memory split is
defined in §9.1. *(If a literally-named "Booking Manager" agent is preferred over
"Reservations," that is a rename only.)*

These five operate the STR business in v1. Future **product/developer agents**
(Sales/Product, Product Owner, Architecture Guardian, and the builder/QA/deployment
agents) are **out of scope for v1** and defined in "Future Tooling / Starterkit
Emergence."

## 5. The four demo loops (data flow)

**Wakeup rule (critical).** `ctx.issues.create` only INSERTS an issue; it does **not**
enter the heartbeat. Every plugin-created actionable issue is immediately followed by
`ctx.issues.requestWakeup`. Verified: create-only insert in
`server/src/services/issues.ts`; plugin wakeups flow through `requestWakeup` in
`server/src/services/plugin-host-services.ts`; routines call assignment wakeup after
create in `server/src/services/routines.ts`. Budget stops, atomic checkout, approval
gates, and heartbeat policy apply via that wakeup path.

1. **Booking & calendar.** `channel-poll` job -> mock provider -> `upsert_booking`
   (availability guard) -> on new booking, plugin **creates child issues and
   `requestWakeup`s them**.
2. **Guest lifecycle.** Inbound webhook -> `message` row -> guest-thread issue
   **+ `requestWakeup`** -> Guest-Comms heartbeat -> triage + draft reply (FR/EN); at
   booking-start -> check-in instructions + lock code.
3. **Turnover & maintenance.** Booking checkout date -> plugin `ctx.issues.create`
   turnover issue (assignee Turnover) **+ `requestWakeup`** -> heartbeat claims & runs
   -> dispatch; guest- or owner-reported problem -> maintenance ticket issue
   (**+ `requestWakeup`**).
4. **Pricing & owner reporting.** `pricing-sweep` (cron `0 6 * * 1`) -> `pricing_suggestion`
   (+ optional review issue **+ `requestWakeup`**); `owner-statement` routine
   (cron `0 6 1 * *`) -> query `financial_event` -> owner statement work product
   assigned to Owner-Relations.

## 6. Seasonal / recurring scheduling

- Pure data syncs -> plugin **cron jobs** (`channel-poll`, `pricing-sweep`).
- Agent-reasoning recurring work -> Paperclip **routines / recurring tasks**
  (monthly statement, weekly pricing review, seasonal turnover cadence).
- "Season" is a property attribute (`season_ranges`) + date-ranged pricing, not a
  separate scheduler.

## 7. Governance & finance

- **Approvals.** Paperclip approval gates on sensitive issues (booking
  confirmation, refunds, spend over a threshold) -> Concierge Manager / board signs
  off before the action proceeds.
- **Money.** Paperclip "budget" tracks **LLM token spend only**. **Rental money is
  tracked in `str_ops.financial_event`** (revenue/fee/payout/commission); the owner
  statement is a real query, not agent guesswork. These two money concepts are kept
  strictly separate.

## 8. Mock -> real provider bridge

Define `ChannelProvider`, `MessagingProvider`, `PaymentProvider` interfaces. v1
ships `MockChannelProvider` (seeded JSON booking feed), `MockMessagingProvider`
(echo/log outbound, synthetic inbound), `MockPaymentProvider` (in-memory ledger).
Real Airbnb/Booking/Vrbo/Stripe/WhatsApp implementations drop in behind the same
interfaces later — agents, skills, tables, and issues are unchanged.

## 9. Reuse from existing stack

- `deborah-concierge` skill (FR/EN routing) -> source for `guest-message-triage`.
- `plugin-llm-wiki` (in this repo) -> house manuals / local-recommendations KB.
- `hermes-paperclip-adapter` -> run the **Reservations (booking manager)** agent as a
  Hermes employee (`hermes_local`) so it uses Hermes **MemoryOS** for location memory
  (v1; phased to other agents later). The adapter only *runs* Hermes — MemoryOS lives
  inside the Hermes runtime (`~/.hermes`), not in this repo.

### 9.1 Memory model — MemoryOS vs llm-wiki

Two memory stores, split by scope:

- **Hermes MemoryOS — location-touching memory.** Everything tied to a specific
  property / guest / owner: guest & owner **preferences**, **recurring-guest recall**,
  **behavioral memory**, and **house/property facts** (soft knowledge — gate quirks,
  owner do's/don'ts, best local taxi, quiet hours). Persisted inside the Hermes runtime
  by agents running on `hermes_local`. Paperclip / str-ops do **not** manage it.
- **llm-wiki — general company memory.** Company-wide, non-location knowledge (SOPs,
  policies, playbooks). Stays in the in-repo `plugin-llm-wiki` KB for now.

**MemoryOS ≠ str-ops records.** `str_ops.property/owner/guest/booking` hold the
**structured, queryable records** (address, dates, prices, commission) — the system of
record. MemoryOS holds **soft / preference / recall** knowledge keyed to those entities.
Keep them distinct: anything that must be queried or aggregated (money, availability)
lives in str-ops; preferences, recall, and behavioral notes live in MemoryOS. The
Reservations agent reads str-ops via plugin tools and reads/writes its MemoryOS by virtue
of running on Hermes.

**v1 boundary.** Only the Reservations (booking manager) agent uses MemoryOS in v1. This
is in the **agent layer** (Plan 2 onward); **Plan 1** (booking spine, relational records)
is unaffected.
- **CouchDB** (your existing instance, reusing the kit-store patterns) -> the str-ops
  **record store** (DB `str_ops`): owner/property/guest/booking docs. **Replaces the
  Postgres namespace.** See §3.1. MemoryOS (§9.1) and llm-wiki remain separate stores.

## 10. Constraints & risks (from SDK caveats)

- Plugin worker + UI are **trusted code** today; plugin UI is same-origin and not a
  security sandbox.
- Plugin install/activation is **instance-wide**; multi-owner isolation is by
  `company_id`-scoped rows, not separate installs. v1 uses a **single company**.
- `ctx.assets` is unsupported in the current runtime; do not depend on it.
- Local-path installs are a dev workflow; npm-packaged install is the deployed path.
- Risk: representing work as issues while records live in the plugin can drift;
  mitigated by `paperclip_*_issue_id` links + the `issue.updated` subscription.
- Risk: `agile-cycle` deep reviewers are Qt-specific and do not apply to TS
  (see §12).

## 11. Build sequence (slices)

- **S0** Scaffold the plugin (manifest, DB migration, worker, bundler presets) and
  the company-package skeleton; install locally; health green.
- **S1** Booking spine: `channel-poll` job + booking/guest/owner tables + tools;
  seed 2–3 properties/owners; verify bookings ingested.
- **S2** Guest lifecycle: inbound webhook + `message` table + Guest-Comms agent +
  triage/check-in skills; verify message -> issue -> drafted reply.
- **S3** Turnover & maintenance: on checkout, plugin spawns turnover issue +
  maintenance flow; verify the heartbeat fires the issue and the agent dispatches.
- **S4** Pricing & owner reporting: `pricing-sweep` + monthly `owner-statement`
  routine -> work product; verify recurring fire + statement math.
- **S5** Company package + org chart + goals + dashboard UI (properties / bookings /
  occupancy); end-to-end demo run.

## Future Tooling / Starterkit Emergence (post-v1 — NOT built in v1)

The starterkit is **not** the initial architecture. It **emerges** from repeated tool
requests made by the Paperclip conciergerie company as it operates. The company is the
first internal client; the toolkit is a by-product of serving it well.

**Workflow:**

1. Conciergerie agents operate the STR business (the four loops in §5).
2. Sales/Product agents identify missing tools from real operational friction.
3. Product Owner converts identified needs into a backlog (Paperclip issues/goals).
4. Architecture Guardian checks boundaries (scope, reuse, plugin-vs-package, security).
5. Developer agents implement the requested tools.
6. Reusable tools are extracted into a **future starterkit** (a.k.a. *reusable agency
   tools* / *conciergerie tooling* / *STR agency toolkit*). The starterkit is **not
   defined yet** and is **not** part of v1.

**Candidate tools the company may request (illustrative, not v1):** website, mobile
app, guest widget, owner cockpit, admin dashboard, QR guidebook, voice assistant,
reporting tools, deployment tools.

**Future developer/product agents (defined here, OUT OF SCOPE for v1):**

| Agent | Purpose | Status |
|---|---|---|
| Website Builder Agent | Build the public / property website | out of scope v1 |
| Mobile App Builder Agent | Build the guest / owner mobile app | out of scope v1 |
| Widget Builder Agent | Build the embeddable guest widget | out of scope v1 |
| QA Agent | Test / validate requested tools | out of scope v1 |
| Deployment Agent | Ship / deploy the tools | out of scope v1 |

Supporting roles referenced in the workflow — Sales/Product, Product Owner,
Architecture Guardian — are likewise post-v1.

**Human-in-the-loop & actor model (future — from discussion #3010 "Human Adapter", a
proposal, NOT yet shipped).** The Human Adapter would represent a human as a high-latency
agent node (tasks routed via Slack/webhook/ticket, resolved by a person). Future uses:
**per-owner human agents** + an **owner cockpit** (owners approve bookings/spend, view
statements); a **supervisor/president** human seat above the CEO; an **outsourcing /
vendor bridge** for human tasks (cleaning, maintenance, complex guest issues). **v1
substitute (shipped):** the **board user + approval gates** are the human
president/supervisor seat, and human/outsourced tasks are Paperclip **issues** a person
resolves via the board. **Owners stay records** (§3.1), served by the AI Owner-Relations
agent. All agent-layer / emergent — not v1, not Plan 1. **DB stays single `str_ops`** (no
per-owner/per-agent DB) so cross-owner queries work; per-owner DB is a future
hard-isolation option if owners get direct cockpit DB access.

**v1 boundary (restated).** v1 remains focused on the Paperclip STR conciergerie
company PoC. **No website / mobile app / starterkit implementation in v1.** This
section is roadmap context only; this update is **spec-only — no runtime code change.**

## 12. Delivery method — per-slice agile-cycle + codex review

Each slice S0–S5 is executed as one bounded `agile-cycle`:

```
agile-startworkflow   (freeze slice scope & success criteria)   <- gate per slice
  -> agile-impl       (smallest working change)
  -> review           (skeptical senior review)
  -> agile-qa         (build + worker tests via SDK createTestHarness)
  -> codex-critical-review   (independent paranoid pass on the git diff)  <- hard gate
  -> agile-judge      (score vs rubric -> DONE / retry <=2 / escalate)
```

A slice is DONE only when codex review + QA + judge all pass. Max 2 iterations,
then escalate to the human.

**Reviewer routing caveat.** `agile-cycle` routes its deep reviewers to
`/qt-qml-review` and `/qt-cpp-review`, which are Qt-specific. This project is
**TypeScript/Node**, so those Qt reviewers do not apply. `codex-critical-review`,
`agile-qa`, and `agile-judge` are language-agnostic and apply fully. The review
phase substitutes a generic TS reviewer (the `code-review` skill or
`feature-dev:code-reviewer`) in place of the Qt reviewers.

## 13. Verification (PoC acceptance)

- Worker unit/integration tests via `@paperclipai/plugin-sdk/testing`
  `createTestHarness`: migrations apply; each tool behaves; `channel-poll` ingests
  seeded bookings; webhook creates a thread issue; checkout spawns a turnover issue;
  owner-statement math is correct.
- Repo `pnpm test` (Vitest) stays green.
- Manual: run dev, trigger `channel-poll`, observe the Paperclip heartbeat claim and
  run the spawned turnover issue; observe a drafted FR/EN guest reply; observe a
  generated monthly owner statement work product.

## 14. Open questions / assumptions to confirm

1. Single company for v1 (owners = rows). [assumed yes]
2. `claude_local` for all agents; Hermes deferred. [assumed yes]
3. `project = property`; issues = work items; labels = type/status. [assumed yes]
4. 5 agents (Revenue + Owner-Relations merged). [assumed yes]
5. Spec + plugin live inside this Paperclip checkout. [assumed yes]

## 15. Review log

**2026-06-02 — codex-critical-review (gpt-5.5, read-only sandbox), verdict NEEDS FIX.**
Reviewed against this repo as ground truth. All findings applied:

- **P1** — `ctx.issues.create` does not trigger the heartbeat; must follow with
  `ctx.issues.requestWakeup`. Refs: `issues.ts:4826-4843`, `routines.ts:1303-1312`,
  `plugin-host-services.ts:1803-1825`. → Added the §5 wakeup rule and wired
  `requestWakeup` into every loop and job.
- **P2** — plugin job schedules must be valid 5-field cron, not `weekly`/`monthly`.
  Ref: `packages/shared/src/validators/plugin.ts:71-86`. → §3.3 now uses
  `0 6 * * 1` / `0 6 1 * *`; `owner-statement` moved to a routine.
- **P2** — missing manifest capabilities for managed resources + relations. Refs:
  `packages/shared/src/constants.ts:765-775`, `plugin-llm-wiki/src/manifest.ts:97-117`.
  → Added `agents.managed`, `projects.managed`, `skills.managed`, `routines.managed`,
  `issue.relations.read`, `issue.relations.write`.
- **P2** — wrong import command. Refs: `cli/src/index.ts:36-39`,
  `cli/src/commands/client/company.ts:1266-1281`. → §2 now uses
  `paperclipai company import`; `companies.sh` noted as external alternative.

codex simplicity check: no over-engineering flagged for the bounded PoC.

**2026-06-02 — product reframing (v1.2, spec-only, no code).** Direction change from
the user: the **Paperclip Conciergerie Agent Company is the main product**, not a
starterkit. The company is its own first internal client; a future starterkit
*emerges* from the company's own tool requests. Changes: reframed §1 (product framing
+ expanded out-of-scope to exclude all tooling/product builds and starterkit
extraction); added the "Future Tooling / Starterkit Emergence" section (emergence
workflow + candidate tools + future developer/product agents, all marked out of scope
v1); added an out-of-scope pointer in §4. The five conciergerie agents and the four
operational loops are unchanged. Any prior product codename is deliberately avoided;
neutral terms only. v1 scope unchanged: STR conciergerie company PoC, no
website/mobile/starterkit implementation.

**2026-06-03 — agent-memory decision (spec-only).** Adopt Hermes **MemoryOS** (via
`hermes-paperclip-adapter`, `hermes_local`) as the **location-touching** memory store
(guest/owner preferences, recurring-guest recall, behavioral memory, house/property
facts), **first used by the Reservations / booking-manager agent**; phased to other
agents later. **llm-wiki** keeps general company memory for now. Changes: §4 (Reservations
→ `hermes_local`; memory note), §9 (Hermes bullet now in-scope) + new §9.1 memory model
(MemoryOS vs llm-wiki; MemoryOS ≠ str-ops records). MemoryOS is internal to the Hermes
runtime (`~/.hermes`), not managed by str-ops. Agent-layer change → **Plan 1 (booking
spine) unaffected**; lands Plan 2 onward. Requires Hermes installed + Hermes adapter
plugin registered.

**2026-06-03 — record store → CouchDB (replaces Postgres).** User direction: do not use
the SDK Postgres namespace; persist str-ops records to **CouchDB** (reuse existing
instance, single DB `str_ops`, defaults). Deterministic `_id`s replace SQL `UNIQUE`;
Mango indexes replace SQL indexes; the plugin talks to CouchDB over `ctx.http`. Changes:
§3.1 (CouchDB doc store), §3.7 (caps: −`database.namespace.*`, +`http.outbound` /
`secrets.read-ref`), §9 (CouchDB = the record store). Also recorded as **deferred**:
Human Adapter (#3010, proposal-only) + per-owner human agents + owner cockpit +
supervisor/president seat + outsourcing bridge → Future Tooling; v1 uses board user +
approval gates; single DB (no per-owner/per-agent DB). **Plan Task 6 rewritten as Task 6R
(CouchStore) — the Postgres migration + pg-store are superseded.**
