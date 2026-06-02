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

### 3.1 Database (namespace `str_ops`, own SQL migration)

System-of-record tables (all rows carry `company_id`):

| Table | Key columns |
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

`database.namespace.migrate|read|write`, `jobs.schedule`, `webhooks.receive`,
`issues.create`, `issues.update`, `issues.wakeup`, `issue.comments.create`,
`issue.relations.read`, `issue.relations.write`, `agent.tools.register`,
`agents.managed`, `projects.managed`, `skills.managed`, `routines.managed`,
`events.subscribe`, `ui.page.register`, `ui.dashboardWidget.register`,
`activity.log.write`, `plugin.state.read|write`.
Reserved for the real bridge (not used in v1): `http.outbound`, `secrets.read-ref`.

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
| Reservations | concierge-manager | booking-intake, availability-sync | claude_local |
| Turnover & Maintenance | concierge-manager | turnover-schedule, maintenance-dispatch | claude_local |
| Revenue & Owner-Relations | concierge-manager | dynamic-pricing, owner-statement | claude_local |

Languages: **FR + EN**. Open option: split Revenue and Owner-Relations into two
agents if the demo needs it.

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
- `hermes-paperclip-adapter` -> optionally run Guest-Comms as a Hermes employee
  (deferred past v1).
- CouchDB kit-store patterns -> reference only; the plugin uses the Postgres
  namespace.

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
