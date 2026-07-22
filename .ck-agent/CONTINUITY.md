# CK Paperclip Live Continuity

Last verified: 2026-07-22 (read-only live baseline, repository-state, and pending-review audit), Europe/Berlin

This is the canonical security-safe handoff for the live CK Paperclip fork. Read
it before operating the live instance. Update it after materially changing live
architecture, safety invariants, recovery procedures, or the operational
backlog. Never add passwords, API keys, tokens, cookies, or private message
content.

## Mission

Turn Paperclip into a production-grade, product-agnostic control plane for a
quasi-autonomous company. Audit it as a power user: exercise complete workflows,
inspect desktop and mobile UX, identify redundant or misleading states, test
failure/recovery behavior, and verify changes against the actual live runtime.
Prefer reversible, evidence-based changes and targeted tests.

## Non-negotiable safety

- Do not send test or real email to any external recipient. If an email test is
  truly necessary, the only permitted recipient is `alan@treshermanos.ch`;
  drafts or mocks are preferred.
- Do not trigger Telegram or other external notifications merely to test them.
- Do not make irreversible external business actions without explicit approval.
- Treat credentials as out-of-band secrets. Use existing runtime configuration
  or Paperclip secret facilities; never copy credential values into source,
  docs, logs, screenshots, issue comments, or memory.
- Preserve the dirty worktree and unrelated user changes. Never reset or delete
  them to simplify an implementation.
- Before restarting services, confirm there are no active agent runs.

## Live topology and source identity

- Host: Hetzner server `quita`.
- Repository: `/home/ckhermes/paperclip`.
- The `pc-build` container mounts this repository at `/work`. The laptop path in
  this session is therefore the source used by the live runtime, not a separate
  stale copy.
- Database: PostgreSQL database `ck_workforce` in container `pc-postgres`.
- HTTP service: `http://127.0.0.1:3100`.
- UI is served from `ui/dist`; source edits are not live until the UI is built.
- Server runs non-watch through `tsx src/index.ts`; server and adapter edits are
  not live until the server process is restarted.
- Normal server launcher: `bash .ck-agent/pc-server-up.sh`.
- Do not assume that a successful build activates code. Verify the live behavior
  after every restart.

## Current operational state

At the 2026-07-22 read-only baseline, CK IT Solutions had 513 issues: 414 done,
82 cancelled, 14 in review, 2 backlog, and 1 blocked. The company had 98
`ck_local` agents: 15 idle, 83 paused, and none running. Re-query before relying
on these counts because scheduled jobs and agents continue to change live state.

The outreach approvals are intentionally waiting. Alan found that repeated
draft iterations still produce copy that feels off: too ingratiating, too
robotic, recognizably AI-written, or composed of individually plausible
sentences that do not connect with natural human logic. Do not treat the queue
as ordinary approval latency and do not trigger another bulk rewrite. The next
writing change must address discourse-level coherence, human intent, restraint,
and transitions across the whole message, then prove the result on drafts
without sending or resolving the existing decisions.

The plugin worker has been healthy since the invocation-scope concurrency fix.
DeepSeek Pro and Flash have both produced real, correctly priced cost events.
The recurring UI build warnings about CSS `::highlight` and the approximately
4.8 MB bundle are known; they are not proof of a failed build.

## Verified improvements in this worktree

- Product-agnostic onboarding, navigation, deep links, page titles, dashboard
  attention rail, org chart, and mobile agent roster/search were improved.
- The CK Office Approvals surface was renamed to Outreach outbox.
- Plugin health now checks the actual worker, database, Espo, and Divino.
- DeepSeek model selection, fractional-cent accounting, retry idempotency,
  legacy/unpriced distinctions, and Pro/Flash labels were repaired. Database
  migrations 0103 through 0106 carry the accounting changes. The cost
  drilldown now normalizes `deepseek` to `DeepSeek` in the UI, with a
  regression test covering the label and sub-cent formatting.
- Plugin Manager now renders Installed Plugins before the bundled catalog in
  both the DOM and the live desktop/mobile layout, so keyboard and screen
  reader users encounter the active set first.
- Plugin Manager now hides already-installed bundled plugins from the bundled
  catalog, replacing the previous duplicate rows with a clear empty-state note
  when the catalog is fully covered by installed plugins.
- Plugin settings now treat obvious credential fields as sensitive even when a
  plugin schema forgets to mark them `secret-ref`, so the live UI renders them
  as masked secret inputs instead of plaintext. A regression test covers the
  heuristic.
- Plugin-ck-office now uses canonical DeepSeek V4 model ids, prices flash/pro
  correctly, and counts DeepSeek cache-hit vs cache-miss prompt tokens when
  computing cost. The plugin config now exposes a `DeepSeek model` selector so
  operators can choose flash or pro explicitly. Live API verification confirmed
  the new schema field is present.
- The DeepSeek pricing regression now has a durable server-suite test at
  `server/src/__tests__/deepseek-pricing.test.ts`, so the current pricing and
  cache-token accounting are covered by the normal workspace test path.
- The live Costs page now shows cached-input tokens explicitly in the Providers
  tab model breakdown, which makes DeepSeek cache behavior readable at a glance
  for power users. Live DOM and screenshot verification confirmed the new text.
- The live Costs page also compact-labels DeepSeek model rows as Flash/Pro
  instead of raw model ids, which matches the rest of the UI and makes the
  provider cards easier to scan. Live screenshot verification confirmed it.
- Agent Detail now uses the shared DeepSeek model display helper in its cost
  summary and run table, so the operator view stays consistent with the Costs
  and Provider surfaces. Live verification on GOV-25 Chief-of-Staff shows the
  expected `Pro` label in the page cost section and run rows.
- The shared DeepSeek model label helper now collapses the legacy
  `deepseek-reasoner` alias to `Flash`, matching the plugin runtime's pricing
  behavior and keeping DeepSeek lanes consistent everywhere the UI shows model
  names. A regression test covers the alias.
- Agent Detail now shows the correct `Skills` breadcrumb on the Skills tab
  instead of falling back to `Dashboard`, which makes deep-linking and
  navigation consistent with the visible tab state. Live verification on
  `/agents/GOV-25-Chief-of-Staff/skills` confirmed the breadcrumb and title.
- Company skill usage now recognizes the live `env.CK_SKILLS` adapter config
  shape in addition to `paperclipSkillSync.desiredSkills`, so skills such as
  `human-writing` show their attached agents correctly in the GUI. The shared
  reader has a regression test, and the live database contains agents whose
  `CK_SKILLS` env list includes that key.
- Skill settings now show legacy `public_link` as a distinct read-only state
  instead of silently flattening it to `company`. The dialog now tells the
  operator to migrate to `company` or `private` because reselecting public-link
  is not supported.
- Plugin settings status now collapses the Permissions section by default when
  capabilities exist, which keeps runtime/health information visible first on
  mobile. The regression test covers the disclosure behavior.
- The screenshot helper `.ckshots/shoot.mjs` now supports selecting mobile tab
  dropdowns via `SELECT_INDEX` + `SELECT`/`SELECT_VALUE`, which makes live UI
  verification reusable for tabbed mobile layouts.
- Issue priorities were normalized by migration 0107.
- Stale failed-run inbox cards are suppressed when their issue is done or
  cancelled.
- The personal inbox badge now uses the same active-status contract as the
  "Needs you" tab. Previously it counted 41 unread completed tasks while the
  actionable queue and server badge both had zero unread actions. Live desktop,
  mobile, network-request, and DOM checks now show no badge; completed history
  remains available through Tasks and Recent.
- Recurring CK digest issues now have guarded lifecycle handling. A new Daily
  Huddle completes older open huddles; a new Founder Brief completes older open
  briefs only when they have no pending decision interaction. A manual,
  internal-only Daily Huddle run succeeded in 142 ms and created CK-365 while
  completing the stale huddles. The Founder Brief path was not manually
  triggered because its configured Telegram notification is an external side
  effect; verify it on the next normal schedule instead.
- Evaluation passes now apply a durable watermark at the plugin tool boundary,
  avoid self-looping over evaluation work, and store checkpoint-shaped memory
  correctly.
- Plugin invocation scope is isolated across concurrent jobs.
- Routine cards show the next scheduled execution.
- Installed plugins appear before the experimental catalog visually.
- Decision requests made during a live run are anchored to the current issue,
  rather than trusting a model-supplied unrelated issue identifier.
- In-review tasks now show a prominent board decision bar on desktop and mobile.
  Approval completes the task with an audit comment; requesting changes requires
  specific feedback, returns the task to To do, and records that feedback for the
  assignee. When a pending thread interaction owns the decision, the bar instead
  names that decision and removes the conflicting generic completion action.
- The active issue decision must be the newest pending confirmation-style
  interaction, not the first pending record in thread order. Comment activity
  now invalidates issue interactions immediately, and the issue detail page also
  polls interactions so stale confirmations and cards clear without a reload.
- Inbox mail threads now collapse older sibling issues when a newer reply card
  for the same subject exists, so the inbox shows one live thread instead of
  both sides of one conversation as separate work items.
- The Beau-Rivage thread exposed a one-time restoration error: CK-235 and
  CK-245 had already been completed, but were restored to review solely because
  legacy decision cards remained pending. After the operator resolved those
  cards, both tasks were reconciled back to done with audit comments. Live
  desktop and mobile inbox checks removed both rows and reduced the actionable
  badge from five to three. Do not restore a terminal task merely because an
  old card is pending when comments and completed downstream work prove that
  the decision was already acted on.
- Espo contains `g.tricot@brp.ch` as an additional address on the Beau-Rivage
  account. Alan's accepted v3 courtesy reply was executed live on 2026-07-18
  and independently verified in Espo as Sent email `6a5ba31b090ca786f`,
  delivered to `g.tricot@brp.ch`. Do not resend it.
- Pending decisions can no longer become invisible on newly terminal tasks. The
  server returns HTTP 409 if a nonterminal task with a pending interaction is
  moved to done or cancelled. Five obsolete legacy prompts were rejected or
  cancelled without acceptance; CK-231, CK-235, and CK-245 were restored to
  in-review because their genuine business decisions remain pending. There are
  now zero terminal tasks with pending interactions. The inbox badge counts read
  in-review work as actionable, so desktop and mobile both show the five current
  reviews.
- Heavy detail routes and the MDX editor are now loaded on demand. The initial
  production JavaScript entry fell from 4,838,710 bytes to 3,102,425 bytes
  (35.9% smaller). Fresh-browser live checks loaded Dashboard and Inbox without
  the 1.15 MB editor chunk; an issue detail loaded it when its composer rendered,
  then showed one working contenteditable editor and no loading fallback.
- `server/src/index.ts` now requests an immediate scheduled database backup at
  startup and then continues the interval. Targeted typecheck and 13 backup /
  startup tests passed. Live activation was proved on 2026-07-17: the server was
  healthy about three seconds after restart and produced a gzip-valid 15.5 MB
  backup in 2.36 seconds.
- The live cost page has been re-verified after the latest rebuild. Desktop and
  mobile screenshots now show `DeepSeek` capitalized in the providers drilldown
  instead of the raw slug. The overview still surfaces legacy unpriced records
  explicitly as historical debt, which is the correct signal.
- A failed CK Office build exposed a dangerous partial-output mode: `tsc`
  emitted an unbundled `dist/ui/index.js` before stopping on a later type error.
  Paperclip imports plugin UI entries through a blob URL, so the emitted
  relative imports could not resolve and all six CK custom pages rendered only
  empty placeholders. The live plugin was rebuilt through its required esbuild
  step and CK Memory, CK Evaluation, Outreach outbox, Meeting Room, CRM, and
  Divino were verified with real desktop/mobile browser renders and no console
  or resource errors. The build now typechecks without emitting first, excludes
  UI from the worker `tsc` emission, bundles UI with esbuild, and fails unless a
  verifier proves the entry is self-contained and exports all six pages.
- CK-319 demonstrated that an agent could report `done` after failing to create
  its approval card. Its first retry also produced ASCII German substitutions,
  the wrong sender name, a misspelled product, and unsupported claims. The
  deterministic draft gate now blocks those errors, tool-loop recovery refuses
  to turn partial output into success, and queue arguments bind to the executing
  issue UUID. CK-319 was reconciled to `in_review` with pending outbox row
  `6bc8c434-7d1a-4270-b776-1d0127ddfe6e` and pending interaction
  `da1d66a9-6561-45c8-95d4-5c28c3664d37`; the corrected German draft is
  editable in Outreach outbox. No email was sent during this repair.
- The 2026-07-18 live GOV-25 power-user run (CK-403) selected Gstaad Palace and
  delegated research (CK-404) plus drafting (CK-405). It exposed three workflow
  defects: delegated work was not parented to the originating issue, the draft
  task expressed its research dependency only in prose and therefore ran
  before the dossier, and accepting the native task card could not reconstruct
  the queue-style Markdown body. Alan accepted the Gstaad card; Espo records
  sent email `6a5be99e8d3932e40` to `info@palace.ch`. Do not resend it.
- `create_task` now parents delegated issues to the current run issue by
  default and accepts first-class `blockedByIssueIds`. GOV-25's live
  instructions require creating research first and blocking dependent drafting
  on its returned issue id. CK-404/CK-405 were reconciled under CK-403, and
  CK-405 records CK-404 as its completed prerequisite.
- Native task approvals and Outreach outbox now share one atomic send owner.
  Task-card acceptance claims and uses the linked pending row (including Alan's
  latest outbox edits) instead of reparsing Markdown. Outbox send marks the
  linked interaction consumed; outbox Cancel records a human-readable rejected
  task card; native Hold/reject cancels the linked outbox row. The outbox
  refreshes every three seconds so a decision in another tab clears without a
  manual reload.
- Live Alan-only regression fixtures CK-406 and CK-407 proved both rejection
  directions through the GUI: task Hold removed the outbox item, and outbox
  Cancel rendered the native task interaction rejected. Both fixtures were
  cancelled afterward. Espo had zero emails with either fixture subject.
  Focused approval/send-guard tests passed (4/4), the plugin typecheck/build
  passed, the self-contained UI bundle verifier passed, and the local plugin
  manifest/worker were upgraded and reloaded.
- CK-413 exposed a broader recipient-identity and approval-lifecycle failure.
  Research named Susanne Schild from ART CIGAR's public team page, but the only
  verified recipient was the general `lenzburg@artcibar.ch` branch mailbox.
  REV-06 incorrectly addressed her by name, repeatedly replaced its pending
  approval, ignored Alan's Hold reason, and the stall watchdog treated human
  review as agent inactivity. A second task, CK-421, also created a parallel
  approval for the same CRM account. The live workflow now rejects a named
  salutation unless the exact recipient address belongs to that Espo Contact
  (or the person identified themselves in a reply), including a final send-time
  check; general mailboxes require a neutral greeting. Queueing is idempotent
  while a decision is pending, the database enforces one live approval per
  issue and per CRM account, duplicate account tasks cancel in favor of the
  canonical approval, native Hold is reconciled without requiring the outbox
  page to be opened, queued work moves to `in_review`, runner work stops at the
  approval boundary, and the watchdog skips approval-waiting issues. CK-421
  and all invalid ART CIGAR approval rows were removed. At Alan's explicit
  request, the incorrect CK-413 comments, documents, interactions, approval
  rows, and task activity were deleted rather than retained as visible audit
  history. A clean REV-06 rerun then created exactly one new approval with
  `Sehr geehrte Damen und Herren` on both the task and Outreach outbox and
  stopped without a work-product comment. Desktop, 390-pixel mobile, API, and
  database checks passed with no browser errors. No email was sent during this
  repair.

## Disaster-recovery evidence

Backups live under:

`/home/ckhermes/paperclip/.home/.paperclip/instances/default/data/backups`

On 2026-07-17 there were 127 artifacts (about 1.9 GB), with the oldest retained
artifact dated 2026-07-05. The then-newest backup,
`paperclip-20260717-035358.sql.gz`, passed `gzip -t`.

That artifact was restored into an isolated temporary database. It contained 2
companies, 101 agents, 355 issues, 2,751 heartbeat runs, 1,025 cost events, 11
routines, and 1 plugin. All five migrations missing at backup time applied
successfully, bringing it from 103 to 108 migrations with no invalid indexes.
The temporary restore database was then dropped. This proves the artifact is
readable and migratable; it does not replace recurring restore drills.

## Safe verification recipes

Use container-provided credentials without printing them:

```sh
docker exec pc-postgres sh -c \
  'psql -U "$POSTGRES_USER" -d ck_workforce -Atc "select status,count(*) from issues group by status order by status"'
curl -fsS http://127.0.0.1:3100/api/health
find .home/.paperclip/instances/default/data/backups -type f -printf '%T@ %p\n' \
  | sort -nr | head
gzip -t .home/.paperclip/instances/default/data/backups/NAME.sql.gz
git diff --check
```

Before a restart, query active heartbeat runs through the API or database. If
the count is zero, the established activation sequence is:

```sh
docker restart pc-build
bash .ck-agent/pc-server-up.sh
```

Afterward, prove HTTP health, inspect `.ck-agent/pc-server.log`, confirm plugin
health and job success, and verify that a new gzip-valid backup was created
after the server start time.

For UI changes, build the existing workspace and use `.ckshots/shoot.mjs` to
inspect important routes at desktop and mobile widths. Route/API success alone
is not UX verification.

## CK-359 send-loop + GOV-25 routing (2026-07-17)

**Symptom:** Alan clicked Send on GOV-25 Philippe cards; cards re-spawned.

**Root causes:** CoS did specialist work with request_decision and no send path;
`send_used_at` was stripped by the confirmation result schema.

**Fixed (send plumbing):** schema keeps `send_used_at`; tool
`complete_approved_send` (plugin ≥0.42); runner can complete accepted sends.

**Fixed (routing — Alan):** GOV-25 must **delegate**, not draft/send. Plugin
0.43: `espo_create_account kind=partner` + `espo_create_contact`. Live CRM:
Account **Tres Hermanos** `6a59d20fa8304dbb3` + Contact **Philippe Dubois**
`6a59d214d09b8be34` (philippe@treshermanos.ch). GOV-25 tools: create
account/contact + create_task; **no** send tools. Mail tasks → ensure CRM →
`create_task` REV-06 (queue for Approvals).

## Inbox + Espo reconciliation (2026-07-18)

- A full visible-inbox audit found three shared failures: accepted send cards
  were assigned to agents without `complete_approved_send`; manually composed
  Espo messages were treated as CK-system mail merely because their Message-Id
  ended in `@espo>`; and the legacy `pc-mcp` 60-second poller created every
  incoming mail as a high-priority `backlog` issue, which displayed as parked
  and never woke its assignee.
- REV-06 now has `complete_approved_send` live and in
  `.ck-agent/provision-org.py`. Its managed instructions require
  `queue_email_for_approval` to bind the exact recipient, subject, body, account,
  and issue. Accepting that card means send the bound copy once; Outreach outbox
  is the edit-before-send alternative. Completing either surface resolves the
  same pending row, preventing a second-send action.
- The CK plugin has a persisted `liveVenueSend` instance setting. Plugin workers
  do not inherit arbitrary server environment variables, so host
  `CK_ESPO_SEND_LIVE=1` alone was never sufficient. Live sends remain
  single-use-approval gated, CRM-recipient verified, and test-content blocked.
- Two accepted sends were executed and verified in Espo:
  Beau-Rivage / Guillaume Tricot → `6a5ba31b090ca786f`;
  Restaurant Ö / Salon du Cigare → `6a5ba331d04d40a46`.
  Two repair diagnostics were test-lock redirected only to
  `alan@treshermanos.ch`; no diagnostic content reached a venue.
- B2B mail-sync now treats the durable pending-send / accepted-interaction
  ledger as authoritative. An Espo-generated Message-Id alone is not a system
  marker. A persisted created-at cursor prevents enabling or changing the
  classifier from backfilling historical Sent mail into the inbox.
- `pc-mcp`'s legacy inbound task poller is OFF by default; CK Office is the
  single owner of Espo ingestion and routing. Its break-glass flag is
  `LEGACY_MAIL_TASK_POLLER_ENABLED=1`.
- Multilingual automatic/out-of-office replies are deterministically marked
  `automatic_reply` and do not create REV-07 or CEO work. CK-380 and its
  duplicate CK-401 were reconciled done. The historical cutover cards CK-381
  through CK-400 were also closed.
- New agent-routed mail issues are created as `todo`, not `backlog`, so genuine
  work wakes the assignee instead of showing the misleading “Parked” state.
- Focused plugin tests: six passing cases across live-send routing and
  test-content blocking, system-send classification and cursor cutover, and
  multilingual automatic-reply suppression. The plugin built successfully and
  hot-reloaded. Final desktop and 390 px mobile vision checks both showed
  `Inbox zero` with no console or failed-resource errors.

## Power-user prospect + approval audit (2026-07-18)

- A real UI-created GOV-25 objective became CK-403. GOV-25 selected Gstaad
  Palace, created CK-404 research and CK-405 drafting, but initially omitted
  parent links and encoded the research dependency only in prose. REV-06
  therefore drafted before REV-04 finished. `create_task` now defaults children
  to the current run issue and supports explicit `parentIssueId` plus
  `blockedByIssueIds`; GOV-25 instructions require a real blocker.
- The same draft correctly appeared on CK-405 and in Outreach outbox, but
  task-side acceptance tried to reparse queue-style Markdown and failed before
  the pending row was later sent. The real Espo email
  `6a5be99e8d3932e40` went to `info@palace.ch` at 21:01:19 UTC; never resend it.
- Approval execution now atomically claims the exact linked editable pending
  row. Task Accept and outbox Send cannot race into duplicate sends. Task Hold
  and outbox Cancel synchronize rejection/cancellation in both directions.
  CK-406 and CK-407 exercised both directions live with Alan-only fixture data;
  Espo contained zero fixture messages.
- CK-404 and CK-405 are now visible children of CK-403, with CK-405 blocked by
  the completed research task. The outbox has no pending rows.
- New Task now focuses its empty description editor from a normal visual click,
  and a successful create always shows a toast with an `Open CK-…` action.
  The production UI was rebuilt; a no-force coordinate click typed successfully
  without creating a task. The transient heartbeat-log 404 found during this
  flow is resolved and live-verified in CK-418 (details below).
- GOV-25's Gstaad choice was not a defensible global ranking: it manually
  inspected seven well-known hotels rather than enumerating and scoring all
  eligible open CRM prospects. This is superseded by the 2026-07-19
  deterministic ranker and live ART CIGAR audit below.

## CRM-wide ranking + ART CIGAR live audit (2026-07-19)

- Espo contains 509 Accounts, while the old pipeline tool silently stopped at
  Espo's 200-row cap. `espo_pipeline` now reports complete paginated coverage,
  and `espo_rank_prospects` ranks the full CRM-authoritative universe while
  suppressing existing contact, pending sends/opportunities, active and
  historical Paperclip drafts, DNC classes/statuses, and accounts without a
  verified email. The live scan covered 509/509 across three pages and selected
  ART CIGAR AG from 189 eligible prospects; 320 were suppressed with reasons.
- A real New Task UI run created CK-409 for GOV-25. GOV-25 created CK-411
  research and CK-412 drafting with a real blocker. The stranded-assignment
  recovery sweep nevertheless ran CK-412 before CK-411 completed. Core recovery
  now calls `getDependencyReadiness` before any dispatch/requeue; the focused
  embedded-Postgres regression passed for both normal unblocked dispatch and
  unresolved-blocker suppression. Server typecheck passed.
- The premature CK-412 draft was unsourced, contained invented claims and a
  false manual gate-pass assertion, and created no approval. It is cancelled
  with an audit comment; no email was sent.
- REV-04 then completed a sourced dossier but created duplicate CK-413 instead
  of handing back to the existing dependent. REV-04 instructions now inspect
  `blocks` and reuse a canonical dependent; REV-06 instructions explicitly
  prohibit blind drafting, manual gate-pass claims, completion, or approval
  when a blocker/dossier is unresolved.
- CK-413 has one current research-grounded draft. Alan asked that the prior bad
  attempts not remain visible, so their comments, documents, activity,
  interactions, and approval records were purged before a clean rerun. The
  current pending row `2f6b77f0-cbda-45c9-a568-0478ba984df8` is linked to
  native interaction `6547a461-4337-40fe-9e7c-e299a7630932`. Desktop task,
  390px task, and desktop outbox vision confirmed exactly one pending decision,
  no later agent output, and no browser failures. Leave it pending for Alan; do
  not approve or send it autonomously.
- Approval synchronization, full-universe ranking, and send-guard tests pass
  8/8. Task Hold/outbox Cancel cross-surface behavior was already exercised
  live with Alan-only fixtures CK-406/CK-407; the ART CIGAR card is deliberately
  left untouched because it is real outreach.

## DeepSeek costs + live log startup (2026-07-19)

- Official DeepSeek V4 Flash/Pro prices are encoded in
  `.ck-agent/deepseek-costing.mjs`. The local runner now reports a validated
  per-model `costBreakdown`; the adapter preserves it, heartbeat persistence
  writes one idempotent ledger row per model, and migration 0108 makes the
  uniqueness key run/provider/biller/billing type/model. Aggregate mismatch
  safely falls back to the single-row contract.
- Live CK-416 proved a Pro heartbeat can post separate Pro and Flash rows while
  retaining the exact aggregate cost. Focused adapter, DB, server typecheck,
  and cost-service tests passed. MTD spend is approximately $0.34; do not
  mutate the old unknown rows because their reported token counts cannot be
  reconstructed safely.
- Costs now headlines 16.2M metered MTD tokens, tracks subscription usage
  separately, and labels 75.3M old unknown tokens as legacy/unverified rather
  than adding them to the headline. Provider totals now include cached input,
  and subscription-share percentages no longer double-count their tokens.
  UI regression tests pass 3/3; desktop and 390px live pages have no console or
  resource failures.
- A fresh task could request its heartbeat log after the run row existed but
  before log metadata was initialized, causing a false 404. Active queued or
  running rows now return an empty pending-log response; nonexistent runs and
  missing terminal logs remain errors. Route tests pass 10/10. CK-418 exercised
  New Task -> assigned run -> immediate task open through the real desktop UI
  with zero failed log requests and zero console errors.

## Prioritized continuation

1. Stabilize the development baseline: preserve the dirty worktree, reconcile
   the detached `HEAD` and intended fork/branch/remotes, inventory the current
   changes, run risk-based verification, and split the work into reviewable
   commits before adding another broad feature. Do not push or merge without
   explicit operator authorization.
2. Diagnose outreach writing as a whole-message coherence problem before
   revising pending copy. Build evaluation criteria around natural motive,
   sentence-to-sentence causality, restraint, human rhythm, and the absence of
   flattery/template residue. Use drafts or fixtures only; leave current live
   approvals untouched until Alan requests a controlled revision pass.
3. Continue end-to-end power-user testing of task creation, delegation,
   recovery, review/approval, routines, costs, plugins, mobile navigation, and
   empty/error/loading states. Prefer safe read-only smoke issues and drafts.
   The plugin settings status tab currently has a better mobile layout, but the
   page should still be checked on desktop and with more plugin types.
4. Continue exercising new mail after the 2026-07-18 cursor: a genuine manual
   Espo send should create one actionable `todo` reconciliation issue; a
   multilingual automatic reply should create none. Do not generate external
   mail merely for this test—use naturally arriving mail or Alan-only test
   delivery.
5. Address remaining security debt: the CK plugin still uses direct configured
   credentials because the worker secret-resolution RPC does not carry an
   explicit company scope. Company-scoped plugin settings now exist, but that
   alone is insufficient to authorize a plugin worker to resolve a
   company-owned secret safely. Keep resolution fail-closed until both config
   and runtime RPC carry and validate company identity. The live/current agent
   table, agent config revisions, and company-secret metadata contain no
   Claude/Anthropic adapter, key, or named secret; the older Claude-token note
   was stale and there is nothing to remove. Never print credential values
   while auditing this.
6. Continue bundle profiling: the initial entry is down from 4.84 MB to 2.87 MB,
   but it remains large. Preserve the new route/editor boundaries while finding
   the next safe shared dependency to defer.

## Plugin semantics + route loading (2026-07-19)

- The installed-first Plugin Manager source is now confirmed in the live DOM,
  not merely through CSS: desktop and 390px both expose `Installed Plugins`
  before `Available Plugins`, and already-installed bundled entries are not
  duplicated below.
- Icon-only lifecycle controls now have plugin-specific accessible names (for
  example, `Disable CK Evaluation Office` and `Uninstall CK Evaluation
  Office`). The focused UI test passes, and a live DOM/vision audit on both
  viewports found no console or resource errors. No plugin state was changed.
- Team catalog, approval detail, board chat, company skills, company export,
  and company import are now route-loaded. The production initial JS entry fell
  from 3.107 MB / 837 KB gzip to 2.871 MB / 776 KB gzip. Direct loads of team
  catalog, skills, export, import, and the gated board-chat redirect all
  returned 200 with correct destinations and no browser failures; mobile
  skills and desktop export were also visually captured.
- Removed one identical duplicate `company/settings/cloud-upstream` route
  declaration. The remaining duplicate-looking routes in `App.tsx` are mostly
  intentional prefixed/unprefixed redirect surfaces or the documented
  conference-room gate.

## Inbox approval safety + watchdog recovery (2026-07-19)

- The Inbox badge of one is legitimate CK-413 work, not stale mail: the native
  task and Outreach outbox are synchronized to one pending decision.
- A superseded CK-413 revision had invented that Alan would be in Lenzburg on
  Tuesday or Wednesday. `reviewDraft` now rejects specific weekday/date
  availability or travel commitments in first contact; concrete slots require
  the meeting-booking/calendar workflow. The exact bad pattern fails live and
  the corrected general-interest/degustation copy passes all checks. A second
  live rerun exposed an English strength adjective (`full`) inside otherwise
  German copy; the gate now rejects that mixed-language pattern and the clean
  rerun produced `kräftig`.
- The gate now runs again at both actual send boundaries: native-card
  `complete_approved_send` and outbox `Approve & Send`. A failing edited or
  legacy draft releases its atomic claim and remains pending/editable instead
  of sending. Focused CK Office build and safety tests pass 9/9. No mail was
  sent while fixing or verifying this.
- `.ck-agent/pc-server-up.sh` now has reusable `--restart` and recovery-test
  `--stop` modes, avoiding one-off PID approval requests. The missing
  `paperclip-watchdog.service` and `.timer` were linked into the non-root user
  systemd manager and enabled. A controlled stop followed by the watchdog
  service restored Paperclip to healthy in about three seconds; the recurring
  timer is active.

## Plugin credential boundary + form accessibility (2026-07-19)

- A metadata-only audit found 100 `ck_local` agents and one `process` agent,
  with zero Claude/Anthropic adapters or config references and no
  Claude/Anthropic company-secret metadata. Do not reintroduce the stale claim
  that an unused Claude token remains.
- CK Evaluation Office still has direct database, Espo, and DeepSeek fallback
  credentials because plugin secret references intentionally fail closed.
  `ctx.secrets.resolve` currently receives plugin identity plus a secret UUID,
  but no company identity; enabling it would permit ambiguous cross-company
  resolution. Do not bypass
  `PLUGIN_SECRET_REFS_DISABLED_MESSAGE` until the worker/config/RPC path is
  company-scoped end to end.
- Live desktop and 390px Plugin Settings checks confirmed all three populated
  credential fallbacks render as password fields. The shared schema form now
  gives every generated scalar control a unique programmatic label association,
  and credential inputs use `autocomplete="new-password"` with spelling and
  capitalization assistance disabled. Both viewports had zero console errors
  and zero failed responses.
- The masking heuristic previously reused the full `secret-ref` widget, so
  direct fallback fields advertised “Select an existing secret” even though
  the server would reject that selection. Heuristic-only credentials now render
  as direct masked inputs; only an explicit schema `format: "secret-ref"` can
  show a company-secret picker. CK Office's three currently unusable `*Ref`
  fields are absent from its operator form until company-scoped resolution
  exists. The upgraded live manifest exposes six useful settings, zero secret
  pickers, and three masked populated credentials on both desktop and mobile.
- The plugin-config read endpoint previously allowed an ordinary board user to
  retrieve instance configuration even though writes required an instance
  admin. It now requires instance-admin authorization because direct fallback
  credentials can be present. The focused route authorization suite passes
  36/36, the schema-form/plugin-settings suite passes 16/16, both server and UI
  typechecks pass, and the production UI build plus live browser audit pass.

## CK custom-page + Memory scale regression (2026-07-19)

- After each live CK Office upgrade, all six custom routes were exercised
  directly: CK Memory, CK Evaluation, CK Meeting Room, Outreach outbox, CRM,
  and Divino. Every route returned 200, rendered non-placeholder content, and
  produced zero console errors or failed resources. Representative desktop and
  390px screenshots confirm the pages are not blank.
- CK Memory previously sent and rendered the newest 400 records at once. With
  368 needing review, the live main DOM contained about 136,752 characters and
  every curation row, making the page slow and unscannable.
- CK Memory now queries server-side by status/search/page, returns corpus-wide
  status counts separately, clamps page size to 10–50, and never ships the full
  corpus to the browser. Desktop renders 25 rows and 5,504 characters; mobile
  renders 10 stacked cards and 2,612 characters. Search for `ART CIGAR`
  returned exactly five records. Mobile keeps Scope, Status, Confidence,
  Source, and all three curation actions visible without horizontal scrolling.
- The page-parameter regression suite passes 3/3, plugin typecheck/build passes,
  the self-contained UI bundle verifier still sees all six exports, and the
  live desktop/mobile verifier reports zero console errors or failed responses.

## CK Memory write quality + reversible hygiene (2026-07-19)

- The live corpus had 386 records: 16 verified, 363 unverified, 5 contested,
  and 2 already expired. Metadata/pattern review showed that agents had used
  `remember` for task IDs, queue attempts, draft progress, localhost/API
  diagnostics, and a new timestamped heartbeat key on nearly every wake.
- The live `remember` tool now requires both `key` and `value`, exposes
  `mode: fact|checkpoint` consistently in the runtime and static manifest, and
  applies a deterministic write policy. Facts reject missing/unstable/date-
  stamped keys and transient workflow prose. Resumable changing state must use
  one stable checkpoint key; new checkpoints start verified because they are
  self-owned state, while new facts remain unverified pending corroboration.
- Eight focused memory pagination/write-policy tests pass. The CK Office
  typecheck/build and six-export self-contained UI verifier pass, the plugin
  was upgraded live, and `/api/plugins/tools` confirms the deployed remember
  schema requires `key,value` and advertises `fact|checkpoint`.
- A conservative cleanup expired, but did not delete, 91 objectively transient
  records: 60 heartbeat/board snapshots and 31 task-ID, queue, localhost, or
  progress notes. Every row has a `system:ck-memory-hygiene-v1` audit entry
  preserving its prior status, key, category, and cleanup version. Post-cleanup
  state is 16 verified, 274 unverified, 3 contested, and 93 expired; zero
  targeted transient rows remain active. The live review queue is 277 and the
  `ART CIGAR` search now returns one durable result instead of five mixed
  workflow notes.
- Operational handoff drift was also corrected. The org map and its generator
  derive provider/model from the live adapter configuration. GOV-11 and REV-06
  now both use DeepSeek Pro; REV-06's recent run usage independently records
  `deepseek-v4-pro`. Toolsmith/sync/REV-06 documents no longer assume a Claude
  subscription. Native company skills are synchronized and the generated map
  no longer carries the obsolete Flash label for REV-06.

## Handoff discipline

Lead with verified outcomes, distinguish source changes from live activation,
and record exact tests plus known gaps. Do not claim a workflow works because a
unit test passed: exercise it through the same API/UI/runtime path a power user
uses. When a new operational fact supersedes this file, update the old statement
instead of appending contradictory history.

## Scheduled-job reliability visibility (2026-07-19)

- CK Evaluation Office has 14 active scheduled jobs. At live audit time its
  exact SQL-backed windows showed 431 succeeded and 0 failed runs in the last
  24 hours; the seven-day window showed 3,024 succeeded and 34 failed. The
  older failures were invocation-scope deployment incidents, with the latest
  on 2026-07-17, not current failures.
- Plugin Settings previously displayed only ten recent runs, which could make
  historical incidents invisible or encourage operators to infer reliability
  from a tiny sample. The Status tab now shows exact 24-hour and seven-day
  counts plus the most recent failed job and time.
- The same page previously hid the complete job inventory and an existing
  admin-only manual-trigger API. It now lists every configured job with
  lifecycle state, cron expression, next/last execution, and a `Run now`
  control. Paused jobs cannot be dispatched. Manual dispatch always opens a
  confirmation warning that plugin jobs may write data or contact connected
  systems.
- The focused server route suite passes 37/37 and the Plugin Settings suite
  passes 8/8. Server/UI typechecks and the production UI build pass. After a
  live server restart, desktop and 390px browser checks rendered the summary
  with no console errors or failed resources.
- The live GUI rendered all 14 jobs on desktop and 390px mobile. Active and
  paused lifecycle colors are distinct, historical error text is visually
  bounded, and the confirmation dialog remains readable. A manual
  `ck.stall-watchdog` run through the new GUI exercised the real admin trigger,
  worker, and run-history path. It safely no-op'd because zero issues were stale
  for more than 25 minutes, and completed successfully in 74 ms.

## Inbox history-payload + empty-section cleanup (2026-07-19)

- The live company has 421 issues: 344 done, 66 cancelled, and 11 active. Inbox
  loaded all 421 full issue records on every visit solely to suppress failed
  runs whose linked work was already terminal. That redundant request was
  1,084,112 bytes even though the visible `Needs you` tab contained one issue.
- Failed-run triage now requests only active company issues
  (`backlog,todo,in_progress,in_review,blocked`). The equivalent live response
  is 28,633 bytes. Across all four initial Inbox issue requests, transferred
  JSON fell from about 1.09 MB to 37,822 bytes, a 96.5% reduction. Dedicated
  server-side search remains responsible for historical results.
- Desktop verification searched for `Gourmet` and still found the completed
  Gourmet & Cigar Club Lucerne history. Desktop and 390px mobile each showed
  the current ART CIGAR work item with zero console errors or failed resources.
- Vision also exposed empty `ARCHIVED` and `OTHER RESULTS` headers on mobile
  without a search. Search sections are now created only when they contain
  results, so no stale-looking empty headings remain.
- Inbox component/library regression coverage passes 69/69, UI typecheck and
  production build pass, and the live network/screenshot verifier is
  `.ckshots/verify-inbox-active-index.mjs`.

## Clean rerun + non-actionable brief lifecycle (2026-07-19)

- Alan explicitly rejected retaining the bad CK-413 attempts as visible audit
  history. The task's incorrect comments, documents, activity, interactions,
  and obsolete approval rows were deleted, its execution linkage was reset,
  and REV-06 was run again from the corrected dossier. After the feedback
  lifecycle fixes documented below, Alan explicitly clicked `Approve & send`
  on the final neutral-address card. Exactly one message was sent to
  `lenzburg@artcibar.ch`; Espo email id `6a5cb8090bd9db687`. CK-413 is `done`.
- Power-user vision covered the task at 1440px and 390px plus the desktop
  Outreach outbox. The clean pre-accept evidence remains
  `.ckshots/ck413-final-desktop.png` and
  `.ckshots/ck413-final-mobile.png`; the owner-authorized send later removed
  CK-413 from the Outbox as intended.
- The first clean rerun exposed `full` leaking into otherwise German copy even
  though the language gate passed. `reviewDraft` now rejects that mixed-language
  strength term; focused tests and the full plugin build pass. The second clean
  run produced `mild bis kräftig`.
- CK-419 exposed a separate actionable-state defect: today's Founder Brief said
  `FYI — internal, nothing to tap` but stayed `todo` in the owner Inbox. The job
  now derives issue status from the current brief's live pending interactions:
  zero means `done`, one or more means `in_review`. The focused status regression
  tests pass 2/2, the full plugin build passes, the plugin was upgraded live,
  and manual run `565bd935-2411-462f-8847-3a7d1b7d058b` succeeded in 146 ms.
  The real CK-419 is now `done`; desktop task and 390px Inbox vision returned
  200 with no browser failures, and `Needs you` contains only the legitimate
  CK-413 approval. Evidence: `.ckshots/ck419-fyi-done-desktop.png` and
  `.ckshots/inbox-after-ck419-lifecycle.png`.

## Founder Brief cost coverage (2026-07-19)

- CK-419 previously rendered `$0.37 (1053 cost events)`, mixing priced DeepSeek
  API usage with 623 subscription-included Anthropic rows and 371 legacy/stub
  unpriced rows. That denominator made the spend figure look more complete than
  the ledger evidence supported.
- The Founder Brief cost query now sums and counts only positive
  `metered_api` rows as recorded spend, then reports every other row separately
  as subscription-included or unpriced coverage. The live ledger at activation
  contained 59 priced DeepSeek events costing 37.110118 cents and 994 excluded
  rows.
- Focused cost/status tests pass 4/4, the full CK Office build and six-page
  self-contained UI bundle verifier pass, and the plugin was upgraded live.
  Manual Founder Brief run `a0e7a3e7-2157-4f39-9957-5b1e6da44e49`
  succeeded in 103 ms. CK-419 now states `$0.37 across 59 priced event(s)` plus
  the 994-row coverage note and remains correctly `done`.
- Desktop and expanded 390px mobile vision returned 200 with no console errors
  or failed resources. Evidence: `.ckshots/ck419-cost-separated-desktop.png`
  and `.ckshots/ck419-cost-separated-mobile-expanded.png`.

## Recurring reports + end-to-end Weekly Tactical (2026-07-19)

- Active-board inspection found CK-422 Daily Huddle and CK-323 Weekly Tactical
  stranded in `backlog` despite having no assignee or interaction. Daily Huddle
  is now always a completed informational snapshot. Weekly Tactical now runs the
  full live lifecycle in its native scheduled plugin job: deterministic
  pre-read, budget-gated IDS only when SPC promotes an issue, meeting grading,
  conclusion, and a completed board snapshot. A clean week no longer invents a
  decision; zero promoted issues is a valid 10/10, zero-spend meeting.
- IDS cost writes now preserve fractional cents and label DeepSeek calls
  `metered_api` with the provider as biller. This prevents the meeting path from
  recreating the cost-tracker defect where inexpensive model calls disappeared
  or remained `unknown`.
- The first live cleanup still missed CK-323. Root cause was in Paperclip core:
  the plugin host passed `limit/offset` into `issueService.list` (which paginates
  in SQL) and then applied the same window again. Every plugin page after offset
  zero was empty. The second host-side slice was removed and a non-skipped
  boundary regression now passes; server typecheck passes. After a graceful
  live server restart, the paginated CK Office scan reached all 423 issues and
  completed CK-323.
- CK Office issue scans now page until exhaustion rather than assuming a
  100/200-row company. The focused pagination/lifecycle/meeting-selection suite
  passes 6/6 and the full plugin build plus six-page bundle verifier pass.
- Live Daily Huddle run `da787e99-20da-44c2-90a3-e317fdb2f333` succeeded in
  81 ms and CK-422 is `done`. Final Weekly Tactical run
  `dac6b157-e8d1-4ae8-ada8-0f7be111bf23` completed a zero-promoted, zero-spend
  live meeting. CK-423 is `done`, CK-323 is superseded `done`, and the active
  board now contains only real outreach work plus CK-413's human approval.
- Vision exposed that Meeting Room defaulted to an older meeting merely because
  it had more issues. It now opens the newest run while retaining historical
  selection. Desktop and mobile routes returned 200 without browser failures;
  the final desktop view shows July 19, 16 units, 9 red, 0 promoted, 10/10, and
  a finished zero-spend conclusion. Evidence:
  `.ckshots/ck423-weekly-complete-desktop.png`,
  `.ckshots/ck423-weekly-complete-mobile.png`,
  `.ckshots/inbox-after-recurring-cleanup-mobile.png`,
  `.ckshots/meeting-room-latest-clean-mobile.png`, and
  `.ckshots/meeting-room-latest-counts-final.png`.

## Approval feedback lifecycle + outward identity gates (2026-07-19)

- Real 390px GUI use reproduced both ordinary CK-413 feedback paths. A normal
  task reply now expires the pending approval, wakes REV-06, targets the same
  `in_review` issue, cancels the stale Outbox row, and creates one replacement.
  Hold with a reason now performs the same revision loop. Old/rejected cards and
  their duplicate CRM notes were removed after verification.
- Four independent defects caused the original apparent no-op: outreach cards
  used an accept-only continuation policy; normal comments did not supersede
  them; the custom CK adapter discarded Paperclip's native issue/wake context;
  and the runner would not select or check out a targeted `in_review` issue.
  New outreach cards use `wake_assignee` plus
  `supersedeOnUserComment: true`; the adapter forwards task, wake, and comment
  context; targeted feedback runs may select/check out only their requested
  `in_review` issue. Normal untargeted work selection remains limited to
  `todo` and `in_progress`.
- CK-316 contained one legacy accept-only card, so its first Hold correctly
  recorded feedback but could not wake. It was resumed once during migration.
  Its replacement and all future cards use the corrected policy. A second Hold
  on the new card woke REV-06 automatically and returned one replacement,
  proving the live corrected lifecycle.
- The outward quality gate now reviews subject and body as one artifact and
  rejects: named salutations on unowned generic mailboxes; Dominican
  company/house/brand positioning; `Ligne classique` or English strength terms
  in German; em/en dashes and spaced subject separators; English `cigars` in
  French; incomplete sender signatures; and first-contact promises to send
  samples or goods. Canonical outward identity is:
  Tres Hermanos is a Swiss company with its own cigar factory in the Dominican
  Republic. Managed REV-06 instructions, local product facts, memory, and the
  live agent bundle all carry this fact. A stale managed `draft.txt` was
  removed.
- Regression coverage passes 42/42 across 11 CK Office test files; the plugin
  TypeScript build and self-contained six-page UI verifier pass. The custom
  adapter tests pass 7/7 and runner-selection tests pass 5/5.
- Alan later approved CK-316 through Outreach outbox. Exactly one Hangar41
  message was sent to the CRM-verified address; Espo email id
  `6a5cbadd7ecb5ec9e`. The first implementation marked the linked card expired
  but left the issue `in_review`, exposing a second generic completion bar.
  Outbox send now resolves the shared interaction as accepted and completes the
  task; an idempotent read-side repair finishes interrupted synchronization
  without calling Espo again. CK-316 is `done`, its interaction is `accepted`,
  and Outbox has zero pending rows.
- Identifier-based task pages were also polling the UUID-only interaction
  endpoint with refs such as `CK-316`, producing repeated HTTP 400 responses.
  Issue Detail now waits for and uses the canonical issue UUID for listing,
  accepting, rejecting, answering, and cancelling interactions. The focused UI
  suite passes 28/28. Live desktop and 390px checks show no actionable button,
  console error, or failed response. Evidence:
  `.ckshots/ck316-after-outbox-sync-fixed-desktop.png`,
  `.ckshots/ck316-after-outbox-sync-fixed-mobile.png`, and
  `.ckshots/outbox-after-hangar-send-sync-v2.png`.

## Distance-ranked daily outreach queue (2026-07-19)

- Alan approved a daily target of 5–10 newly qualified prospects and a
  replenished draft queue capped at 10 distance-prioritized prospects plus two
  exceptional Swiss prospects that may fall outside the active radius. The
  queue is a capacity target, not 12 blind additions every day.
- `espo_rank_prospects` now scans the full CRM universe, suppresses accounts
  already represented by active outreach work, geocodes from Oberbuchsiten,
  uses OSRM road distance/duration, expands through 35/70/120 km bands, and
  applies a minimum qualification score of 60. Street geocoding is cached;
  validated Swiss locality fallback keeps cold scans bounded.
- With `create_task_pairs:true`, the tool deterministically creates one REV-04
  research task and one blocked REV-06 draft task for each refill candidate.
  Each draft carries an explicit `[OUTREACH_LANE:local|exceptional]` marker,
  account identity, score, distance evidence, and a native blocker relation.
  No approval or email is created at this stage.
- The live queue contains exactly 10 local and two exceptional draft tasks.
  Database verification found all 12 with exactly one research blocker. GUI
  checks on CK-434 showed the blocker, road distance, and lane clearly on
  desktop and 390px mobile; the mobile page includes the explicit blocked-work
  warning. Both routes returned 200 with no console errors or failed resources.
  Evidence: `.ckshots/ck434-desktop.png` and
  `.ckshots/ck434-mobile.png`.
- The daily prospecting routine runs at 07:00 Europe/Zurich and adds 5–10
  verified CRM prospects. The draft-queue routine runs at 08:15
  Europe/Zurich, after discovery, and calls the deterministic fanout once.
  Its duplicate evening trigger is disabled.
- Vision found that Routines formatted `nextRunAt` in the browser timezone but
  displayed the trigger's Europe/Zurich label. Schedule summaries and trigger
  cards now format the instant in the trigger timezone, with regression
  coverage. The live Routines page now shows 08:15 AM and 07:00 AM correctly,
  with no browser failures. Evidence:
  `.ckshots/routines-timezone-fixed.png`.
- Live progression exposed a second handoff defect: dependency scheduling
  waited correctly, but CK's custom adapter discarded
  `resolvedBlockerIssueId`, so REV-06 could not read the dossier just delivered
  on the completed research issue. The adapter now forwards that ID and the
  runner loads the completed blocker's latest full work-product as
  authoritative handoff context. Adapter tests pass 7/7. CK-446 and CK-448,
  the two runs affected before activation, were recovered with their real
  dossiers and now each has exactly one pending approval. Their erroneous
  prerequisite comments were removed. The next native dependency wake,
  Viktoria Jungfrau, logged `loaded completed blocker handoff` before drafting,
  proving the source fix live. No email was sent.
- Approval queuing previously returned before replacing the issue's deliverable
  document. This left an old failure document visible above a correct approval
  card. The runner now persists the exact queued `to/subject/body` as the
  canonical deliverable before ending the run. Existing live pending approvals
  were rebuilt from their bound outbox rows; CK-446 mobile now shows the same
  correct draft in the deliverable and approval card. Evidence:
  `.ckshots/ck446-approval-repaired-mobile.png`.
- Power-user review caught one Lenkerhof draft that promised to send samples
  because the German gate matched `Muster ... senden` but not
  `sende ... Muster`. The gate now catches German conjugations in either order
  and explicit commitments to come personally. The invalid Lenkerhof approval
  was cancelled without sending. Its automatic revision passed the strengthened
  gate, restored exactly one pending approval, contains neither forbidden
  commitment, and wrote the same copy to the deliverable. Plugin 0.43.1 is
  live; the complete CK Office suite passes 57/57.
- Distance/priority/plugin coverage passes 55/55; the focused Routines suite
  passes 11/11 and UI typecheck passes. No email was sent.

## Live approval power-user audit, model routing, and CRM write safety (2026-07-19)

- Alan's live CK-448 Hold/revision cycle proved REV-06 now runs
  `deepseek-v4-pro`; the 14:07 cost event is 1.043997 cents. REV-06 has all five
  required runtime and GUI-listed skills: disclosure guard, product facts,
  do-not-contact, human writing, and sales style/templates.
- Approval deliverables now update with optimistic concurrency. Existing
  documents include `baseRevisionId` and retry once after a 409 race. CK-448,
  CK-453, and CK-454 each have byte-for-byte equality between the current
  Deliverable and pending Outbox row. Helper/adapter coverage passes 11/11.
- Hold reasons are saved once as verified drafting feedback, test wording is
  excluded from style learning, and polluted test/dossier memories were
  quarantined. The outward language gate now also rejects generic
  sender-centred openings, English product terms, wrong canonical product
  names, weak German grammar patterns, premature commercial/delivery promises,
  and inflated fit claims. CK Office coverage passes 78/78.
- Resolved interaction cards are compact by default in both current and classic
  task chat renderers and remain expandable for audit. This removes multiple
  screens of superseded Hold cards on mobile while keeping the current pending
  card fully actionable. Focused UI coverage passes 16/16. Evidence:
  `.ckshots/ck448-final-collapsed-mobile.png`.
- The Mine inbox previously selected only issues the operator had already
  touched. Four untouched pending approvals were therefore visible in Outreach
  Outbox but absent from Needs you. The server now includes any active issue
  with a pending human interaction in Mine. The embedded-Postgres regression
  passes. Live desktop/mobile now show nine Needs-you rows, badge 9, nine native
  pending decisions, and nine pending Outbox rows. Evidence:
  `.ckshots/inbox-final-nine-desktop.png`,
  `.ckshots/inbox-final-nine-mobile.png`, and
  `.ckshots/outbox-final-desktop.png`.
- Obsolete CK-424 and CK-425 decisions were resolved through the native
  interaction API and both tasks remain cancelled. Their cleanup wake exposed
  a serious production-write defect: GOV-25 used `espo_create_meeting` to make
  a `placeholder-check` calendar record as a diagnostic. Both agent runs were
  stopped and Espo meeting `6a5cdb1fa31149cd2` was soft-deleted.
- Meeting creation now rejects test/placeholder/probe/diagnostic names and
  requires `account_id` plus a real `evidence_email_id` linked to that Account.
  The manifest and runtime schema agree, so agents see the guard before calling
  the tool. `espo_get_account` also recognizes Espo's native 17-character IDs
  instead of misrouting them as venue-name searches.
- Plugin `0.43.2` is live and ready. Server/plugin/UI builds and typechecks
  pass, there are no active runs, and no mail was sent after Alan's Lenkerhof
  approval at 13:38:45 UTC.

## Outbox badge and Hold-feedback writing loop (2026-07-19)

- Plugin launchers now support a generic live badge declaration. Outreach
  Outbox uses the canonical `ck-approvals.count` data source, so its sidebar
  badge and the Outbox page cannot calculate different pending totals. The
  launcher badge polls every three seconds and has a reusable value-path
  validator/helper with focused regression coverage.
- Live desktop vision shows `Outreach outbox 9` alongside `Inbox 9`; the 390px
  Outbox page shows `PENDING 9`. Evidence:
  `.ckshots/ck448-final-desktop.png` and
  `.ckshots/outbox-final-mobile.png`.
- REV-06's GUI metadata and runtime both assign `human-writing`. Live run
  stdout proves the skill is injected with the other four drafting skills.
  The style instructions now require one sourced venue fact, direct company
  identity, one low-pressure question, no catalogue copy, and no synthetic
  sales bridges. The deterministic gate rejects the known synthetic phrases
  and multi-format first-contact catalogues.
- Power-user testing exposed the deeper reason Hold revisions still repeated:
  the UI stored a Hold reason in the rejected interaction result, but the CK
  runner sent only issue comments to the model. The agent was woken yet could
  not see Alan's actual reason. `latestHumanRevisionFeedback` now selects the
  newest rejected decision reason and injects it verbatim as authoritative
  acceptance criteria before model work. Regression coverage proves ordering
  and empty-state behavior.
- The repaired flow was verified live on CK-448. Two pre-fix revisions ignored
  the requested Bärenstube/Weinkeller fact. After activation, run
  `1a7fbb76-5ca8-4895-b274-0f8305079449` logged both the updated
  `human-writing` skill and `loaded latest Hold feedback`, then created exactly
  one pending replacement using the requested sourced fact, correct Swiss
  company/own Dominican production identity, and one degustation question.
  The same exact editable copy appears first in mobile Outbox. It remains
  pending for Alan; nothing was sent.
- Plugin `0.43.3` is live and ready. The runner/approval focused suite passes
  11/11, the badge validator/helper tests and CK Office suite pass, and the
  server returned healthy after a controlled source restart.

## Accepted-copy gate failure and hotel social proof (2026-07-19)

- Alan approved CK-453's Bellevue Palace copy after the outreach gate had been
  strengthened. The current gate correctly refused the obsolete copy because
  it used synthetic sales bridges and listed multiple formats, so no email was
  sent.
- The failure lifecycle was defective: the interaction remained accepted and
  unused while its Outbox row returned to pending. That made the runner retry
  the same unsendable authorization and eventually triggered recovery. A gate
  failure on an accepted exact copy now rejects that interaction, stores the
  violations as revision feedback, cancels the linked Outbox row, and continues
  the same runner turn toward one newly reviewed approval. Infrastructure
  failures still stop without redrafting.
- Focused lifecycle/language coverage passes 37/37. The obsolete Bellevue
  decision `e7372b62-d841-4968-8e05-af42d72b3fb5` was repaired through the
  strengthened tool: interaction rejected, linked Outbox row cancelled.
- Alan confirmed Tres Hermanos cigars are already present at Bürgenstock Resort
  Lake Lucerne and Hotel Schweizerhof Bern. Product-facts v8 records both as
  permitted hotel references, with explicit guards against invented
  endorsements, exclusivity, volumes, or guest reactions. CRM independently
  supports Bürgenstock with supplier onboarding, cigar orders, an active
  opportunity, and event correspondence; the owner statement is authoritative
  for current Schweizerhof presence.
- CK-453 was returned to REV-06 with the new social-proof brief. Live run
  `2d4e5d36-02d9-4e43-a7e2-67ebcced9251` loaded the human-writing/product
  skills, passed the current gate, and created exactly one replacement
  approval. Task deliverable and mobile Outbox show the same copy. It remains
  pending; nothing was sent. Evidence:
  `.ckshots/ck453-replacement-desktop.png` and
  `.ckshots/outbox-bellevue-replacement-mobile.png`.
- Plugin `0.43.4` is live and ready, CK-453 is `in_review` with REV-06, its
  stale recovery action is cleared, and no agent runs remain active.

## Human-writing relevance bridge (2026-07-19)

- Alan identified that otherwise-correct first contacts still felt cold when a
  venue observation was followed by an unrelated `Tres Hermanos ist ...`
  paragraph. The defect is a non sequitur: decorative personalization followed
  by a reset into the company template.
- `human-writing` and `sales-style-and-templates` now require a small causal
  arc: one sourced observation, one plain sentence explaining why it makes Tres
  Hermanos relevant, then the company truth in first-person language (`Wir
  sind ...`). The rule explicitly rejects both disconnected fact stacks and
  inflated perfect-fit bridges.
- Live CK-453 was put on Hold through the GUI and regenerated under the new
  rule. A first replacement established the right connection but leaked the
  English adjective `prime`; the deterministic German-language gate now rejects
  that leakage, with regression coverage. Plugin `0.43.5` is live.
- The final Bellevue replacement has exactly one pending approval and uses:
  `Ich denke, Tres Hermanos könnte für diese Auswahl interessant sein.` It then
  continues in first person, retains the two verified hotel references, and
  ends with one direct degustation question. No email was sent. Evidence:
  `.ckshots/ck453-relevance-bridge-desktop.png` and
  `.ckshots/outbox-relevance-bridge-mobile.png`.
- Alan then identified one earlier conversational gap: even the connected
  version began by describing the recipient (`Sie führen ...`) before any
  person appeared. The writing skills now require a one-sentence sender anchor
  for cold mail to a general mailbox. CK-453 was revised again through the live
  Hold flow and now begins `Ich bin Alan Christopherson von Tres Hermanos`
  before the venue observation and relevance bridge. Exactly one pending card
  remains; nothing was sent. Evidence:
  `.ckshots/ck453-sender-anchor-desktop.png` and
  `.ckshots/outbox-sender-anchor-mobile.png`.

## Existing outreach queue migrated to the human sequence (2026-07-19)

- Alan requested that the sender-anchor/relevance-bridge fix apply to every
  existing open outreach approval, not only future drafts. All seven then-open
  cards were audited through their bound Outbox copy and source dossiers.
- Two cards were invalid prospects rather than writing revisions:
  - CK-438 Hotel Schweizerhof Bern was cancelled because Alan confirmed Tres
    Hermanos is already present there. Espo status is now `Kunde` and an audit
    note prevents future first-contact selection.
  - CK-450 Viktoria Jungfrau was cancelled because the target is the
    producer-branded `Victoria Bar & Salon Davidoff`, which falls under the
    do-not-contact competitor class. Espo status is now `Konkurrenz` with an
    audit note.
- The five legitimate prospects were put on Hold through the live GUI and
  regenerated from their own dossiers: CK-454 Habanito, CK-437 Les Trois Rois,
  CK-436 Hotel Euler, CK-455 Gasthaus zur Blume, and CK-446 Hotel Bad
  Eptingen. Every replacement now has a sender anchor, a sourced venue fact, a
  natural relevance bridge, first-person Swiss-company/own-Dominican-production
  language, restrained references where suitable, and one question. Catalogue
  lists, promised visits/goods, website-research language, guest assumptions,
  and synthetic fit/event phrases were removed.
- Bad Eptingen, Gasthaus zur Blume, and Les Trois Rois each received an
  additional live Hold because their first revision still contained polished
  assumptions, explicit website-research wording, or mechanically assembled
  transitions.
- Final reconciliation shows exactly five pending decisions and five matching
  pending Outbox rows, one per valid issue; both invalid issues have zero.
  There were zero sends during the queue migration and zero active runs at
  handoff. Desktop/mobile Outbox loaded without console or network errors and
  visibly shows `PENDING 5`. Evidence:
  `.ckshots/outbox-all-revised-desktop.png` and
  `.ckshots/outbox-all-revised-mobile.png`.

## Purpose-led outreach and DeepSeek Pro verification (2026-07-19)

- Alan rejected `Ich bin Alan Christopherson von Tres Hermanos. Sie führen in
  Eptingen ein Hotel ...` as unnatural. The root defect was broader than that
  sentence: the skills and deterministic gate still rewarded agents for
  converting dossier/CRM facts into prose.
- `human-writing` and `sales-style-and-templates` now put a person and a purpose
  first. Venue facts are optional and research normally shapes the proposal
  without being repeated to the recipient. The normal introduction is `Mein
  Name ist Alan Christopherson und ich vertrete Tres Hermanos.`
- The live `review_draft` gate now rejects `Sie führen ...`, `Ihr Hotel bietet
  ...`, `ist mir ... bekannt/aufgefallen`, assumed guest interest, the malformed
  `Ihrer The Council Lounge`, and the catalogue fragment `Handgerollte
  Premiumzigarren, von mild bis kräftig.` The old gate message telling agents
  to open with a sourced observation was removed. The focused suite passes
  35/35 and CK Evaluation Office `0.43.7` is live/ready.
- REV-06 was already configured as `deepseek-v4-pro`; every revision run in
  this pass independently recorded `usage_json.model=deepseek-v4-pro`. The
  stale org-map Flash label came from documentation drift. `gen_org_map.py`
  now handles both structured and plain environment values, regenerated the
  live map, and synchronized the company skill.
- Four drafts remain legitimately pending: CK-436 Euler, CK-437 Les Trois
  Rois, CK-446 Bad Eptingen, and CK-454 Habanito. CK-455 had already been sent
  by Alan's user workflow and was not reopened. Each pending issue is
  `in_review` with exactly one pending task interaction and one pending Outbox
  row. The Pro rewrite for Les Trois Rois now uses `in der Lounge The Council`
  and no dossier recital. No email was sent during this rewrite and no agent
  run remains active.
- Desktop and 390px mobile Outbox views show `PENDING 4`, synchronized sidebar
  badges, usable controls, and no console/network failures. Evidence:
  `.ckshots/outbox-purpose-pro-desktop.png` and
  `.ckshots/outbox-purpose-pro-mobile.png`. The Bad Eptingen task itself renders
  its revised copy, though a historical heartbeat-log request returns a
  non-blocking 404; keep that stale-log defect for the next task-history pass.

## Baseline stabilization and pending-review audit (2026-07-22)

- The checkout began as a one-commit shallow clone detached at release commit
  `83a293b` (`v2026.618.0`). Full ancestry is now available. The original work
  is preserved as logical commits on `ck/live-baseline-2026-07-22`, with local
  merge target `ck/integration-2026-07-22` rooted at the exact release base.
  The `fork` remote points to `HenkDz/paperclip`, but its `master` is an older,
  independently advanced history and the historical
  `feat/externalize-hermes-adapter` branch is no longer advertised. Do not use
  either as an integration target without an explicit reconciliation pass.
- Source changes were separated into repository hygiene, cost accounting,
  plugin infrastructure, runtime liveness, operator UI, CK Office, guarded CK
  operations, and continuity/playbook commits. Runtime state, credentials,
  logs, core dumps, generated screenshots, temporary API payloads, and the
  generated `pnpm-lock.yaml` remain outside these commits. No branch was pushed,
  no deployment was built, and no live review item was changed.
- Risk-based verification passed: CK Office 88/88 tests; focused server,
  recovery, plugin, and cost coverage 132/132; focused UI coverage 101/101;
  adapter utilities 41/41. DB, shared, adapter-utils, server, UI, and CK Office
  typechecks passed. `git diff --check` passed. The UI suite still emits React
  `act(...)`, leaked test-prop, and dialog accessibility warnings; passing tests
  do not make those warnings clean. A full build was intentionally not run
  because this checkout is mounted into the live runtime and building `ui/dist`
  would also change the served deployment.
- The live review audit found twelve outreach issues with exact one-to-one
  synchronization between a pending native interaction and a pending
  `ck_eval.pending_send` row. None was in `sending`, edited, or orphaned. CK-490
  and CK-500 are separate evaluation decisions with pending native interactions
  and no outreach row. Leave all fourteen decisions untouched.
- CK-443 is the only blocked issue. Its July 19 recovery run failed with
  `adapter_failed`, and active recovery action
  `ce533b40-baf6-41bd-b5d6-d66e979766ed` still assigns GOV-11 to restore or
  resolve it. The original dependent CK-444 ended without drafting because the
  dossier was missing, while later duplicate CK-468 completed a real dossier
  for the same CRM account. CK-443 now blocks two terminal issues and has no
  active execution. This is stale liveness/recovery state, not missing research.
  Do not wake it or create another Les Amis draft during the writing-quality
  hold; resolve the obsolete recovery lineage deliberately in a controlled
  maintenance change.
