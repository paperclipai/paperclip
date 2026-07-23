# Tacit user patterns

- The user wants prompts rewritten into a stronger, more rigorous form before work proceeds.
- The user prefers autonomous continuation when possible, with concise progress updates and no unnecessary check-ins.
- The user is sensitive to external side effects, especially email. Do not send outbound mail unless explicitly authorized; if a test is unavoidable, keep it limited to `alan@treshermanos.ch`.
- The user wants power-user workflow checks: complete flows, redundant steps, failure paths, desktop/mobile UX, and live-runtime verification.
- Outreach drafts are not approval-ready merely because every sentence is grammatical and deterministic gates pass. The user rejects copy that is ingratiating, robotic, recognizably AI-written, or lacks natural sentence-to-sentence connection. Evaluate the message as one human thought sequence: motive, relevance, transitions, restraint, rhythm, and one credible purpose. Do not bulk-revise the pending approval queue until the underlying whole-message writing workflow is improved and the user requests a controlled rerun.
- The user values evidence-backed changes over speculative cleanup.
- Keep DeepSeek model names compact in the UI, and collapse legacy aliases to the same lane label as the runtime pricing contract.
- Breadcrumbs must match the active Agent Detail tab; deep-linked tab views should name the tab, not fall back to Dashboard.
- Live agent skill assignments on this fork can come from the legacy `env.CK_SKILLS` list as well as the structured `paperclipSkillSync.desiredSkills` field. Do not treat a GUI zero-attached count as proof that a skill is unused until both shapes are checked.
- Issue review flows must treat the newest pending confirmation-style interaction as the active decision. Comment events invalidate issue interactions immediately, and the issue detail page also polls them so older superseded cards stop looking actionable without a manual reload.
- Inbox mail threads should collapse older sibling issues when a newer reply card with the same subject exists. The live inbox should reflect the current conversation state, not list both sides of one CRM thread as separate active work.
- Before restoring a completed issue because it has a pending legacy decision, verify whether comments and downstream tasks show that the decision was already acted on. A stale card is not by itself unfinished business; resolving it should not leave an already-completed draft or triage task in the actionable inbox.
- For externally/manual-sent mail, distinguish operator report from CRM proof. If Espo has no matching Sent email record, close draft/triage work only when independently complete, record the evidence gap, and never resend merely to verify delivery.
- CK Office is the single owner of Espo mail ingestion. Keep the legacy
  `pc-mcp` inbound task poller disabled except as an explicit break-glass
  fallback. Automatic replies are no-action CRM events, not CEO inbox work.
- Assigned mail work must start as `todo`; assigning an agent while leaving the
  issue in `backlog` produces a misleading parked card and no execution.
- An Espo `@espo>` Message-Id does not prove Paperclip initiated the send.
  Classify system sends only from the durable pending-send/accepted-interaction
  ledger, and use the mail-sync cursor to avoid historical backfill.
- REV-06 owns exact post-approval execution. Its approval card must contain the
  complete recipient, subject, and body; `complete_approved_send` consumes it
  once and clears the linked outbox row. Never ask for another approval when a
  still-valid accepted decision already exists.
- Canonical owner fact: Tres Hermanos is a Swiss company with its own factory
  for cigar production in the Dominican Republic. Never describe the company,
  house, brand, or manufacturer as Dominican; production location is not
  company nationality.
- German outward copy uses `klassische Linie`, not the French catalogue label
  `Ligne classique`.
- Outreach quality gates apply to the subject and body as one artifact. German
  copy translates strength terms (`mittelkräftig`, `kräftig`, `vollmundig`);
  `medium`/`full` must not leak through, and forbidden dash punctuation in a
  subject is still a gate failure.
- A Hold with feedback is a revision instruction, not a terminal parked state.
  Outreach approvals must wake REV-06 on accept and reject: accept continues
  the exact single-use send; reject incorporates the reason and returns one
  corrected approval.
- A normal user comment on a pending outreach task is also revision feedback.
  It supersedes the stale approval and wakes REV-06; the user must not need to
  repeat the same correction through both Chat and Hold.
- A targeted comment/Hold wake carries `PAPERCLIP_TASK_ID` and may resume that
  specific `in_review` issue. Untargeted runs still exclude `in_review`, so a
  pending human decision cannot starve ordinary todo work. The queue's ledger
  touch then cancels the resolved linked row before duplicate detection.
- Every custom adapter must forward native wake context (`taskId`/`issueId`,
  reason, comment id) into the same `PAPERCLIP_*` environment variables as
  built-in adapters. Declaring context support without forwarding it makes the
  worker wake successfully while doing no work.
- The same targeted-review exception must reach checkout's compare-and-set
  statuses. Selecting an `in_review` feedback target but checking out only
  `todo,in_progress` converts the correct wake into a misleading 409 stand-down.
- Native task approval and Outreach outbox are two views of one decision.
  Accept/Send must atomically consume the linked editable pending row; Hold or
  Cancel on either surface must reject/cancel the other with no email.
- Agent delegation must be a visible issue tree. Child tasks inherit the
  current issue as parent, and real sequencing such as research before drafting
  must use `blockedByIssueIds`, never prose-only “wait” instructions.
- GOV-25 needs a deterministic CRM-wide candidate enumeration/ranking tool.
  Searching a few famous venues is not evidence that it selected the best of
  the open prospect pool. `espo_rank_prospects` is now the authoritative
  full-universe path and must report scan coverage plus suppression evidence.
- Every automatic dispatch path, including stranded-work recovery, must obey
  issue dependency readiness. A visible blocker relation is not sufficient
  evidence unless the recovery scheduler also gates on it.
- REV-04 must reuse an existing draft task that its research issue blocks.
  It creates a REV-06 task only when no dependent exists; one account/venue
  yields one canonical draft and one approval.
- REV-06 never drafts or claims a manual review pass when promised research is
  unavailable or a blocker is unresolved. It leaves the task pending and names
  the missing prerequisite.
- Reusable command approvals should be broad but project-scoped. Prefer the
  stable localhost-only `.ck-agent/pc-api.sh`, the existing `docker` category,
  and `systemctl --user` instead of requesting approval for individual issue
  IDs, API paths, test files, or process IDs.
- A healthy-process check is not a deployment. After server source changes,
  explicitly restart the live runtime before browser verification; the
  idempotent `pc-server-up.sh` intentionally does nothing while an old process
  is still healthy.
- Cost headlines must separate metered tokens, subscription-included usage, and
  legacy unknown/unverified telemetry. Cached input belongs in provider totals;
  subscription token share uses subscription tokens divided by total provider
  tokens without adding the same subscription tokens twice.
- Existing queued/running heartbeat rows may temporarily have no log metadata.
  Treat that startup state as an empty pending log, not a missing resource;
  retain 404 behavior for nonexistent runs and genuinely missing terminal logs.
- Visual order is not sufficient for accessibility claims. Inspect heading and
  focusable-control order in the live DOM, and give icon-only destructive or
  lifecycle controls explicit entity-specific `aria-label` values.
- Route-loading infrequent Markdown-heavy pages is a verified safe bundle
  boundary here. Preserve direct-route redirects and run browser smokes for
  every newly deferred route before accepting the size reduction.
- First-contact drafts may ask generally whether a visit or conversation is
  interesting, but may not assert a weekday/date, travel plan, or operator
  availability without calendar evidence. Concrete slots belong to REV-08 and
  the Espo meeting workflow.
- Outreach quality gates must run both when queuing and immediately before each
  send surface. Human edits and older pending rows can otherwise bypass rules
  added after queue time; a gate failure must release the send claim and keep
  the row editable.
- Use `.ck-agent/pc-server-up.sh --restart` to activate server source and
  `--stop` only for controlled watchdog tests. The non-root
  `paperclip-watchdog.timer` must remain enabled so a dead runtime is restored
  without sudo or user intervention.
- Plugin instance configuration may contain direct credential fallbacks.
  Reading it is an instance-admin action, not ordinary board access. Keep
  generated credential controls masked, programmatically labelled, and marked
  `autocomplete="new-password"`.
- A sensitive-name heuristic is only a display-safety signal; it must not imply
  that secret binding is supported. Show the company-secret picker only for an
  explicit schema `format: "secret-ref"`, and do not advertise such fields in
  a live plugin while the host resolution path is deliberately fail-closed.
- Do not enable plugin `ctx.secrets.resolve` merely because company-scoped
  settings records exist. Resolution remains unsafe until the plugin config,
  worker invocation, and secrets RPC all carry and validate the same explicit
  company identity. Audit secret presence through key names and booleans only;
  never print values.
- The current live agent/config/secret metadata contains no Claude or Anthropic
  credential. Treat older handoff text claiming a leftover Claude token as
  superseded evidence, not as an instruction to search logs or expose values.
- Continuously growing operator corpora such as CK Memory must use server-side
  filtering, search, and bounded pagination. Current live bounds are 25 rows on
  desktop and 10 stacked cards on mobile; retain corpus-wide counts separately
  so pagination does not make metrics lie.
- `remember` is not a task log. Durable facts require one stable, reusable key
  and independent verifiability; task IDs, queue/draft progress, localhost
  diagnostics, and timestamped heartbeat snapshots belong in issue output.
  Changing resumable state uses `mode:"checkpoint"` with one stable key, which
  overwrites rather than appending or contesting.
- Memory hygiene cleanup is reversible: batch
  `system:ck-memory-hygiene-v1` expired 91 transient records and wrote prior
  status/key/category to `ck_eval.memory_audit`; it did not delete records.
- Generate model labels from the live adapter type and top-level configured
  model. Do not infer that every non-Claude agent uses the same lane. REV-06
  currently uses DeepSeek Pro; cheaper recurring judgment paths may still use
  Flash.
- Plugin job reliability must be computed from complete time windows, never
  inferred from the ten most recent rows. Plugin Settings now exposes exact
  24-hour and seven-day succeeded/failed counts plus the latest failed job.
- Plugin operators must be able to discover every scheduled job, its cron,
  lifecycle state, next/last run, and the existing admin manual-trigger path
  from the GUI. Manual triggers require a side-effect warning and paused jobs
  remain disabled.
- On 2026-07-19 CK Office had 431 successes and zero failures in the preceding
  24 hours. Its 34 seven-day failures were older resolved invocation-scope
  deployment incidents; preserve the current-vs-history distinction.
- The admin manual-trigger path is live-tested with `ck.stall-watchdog`: first
  prove no issues are stale for more than 25 minutes, then a no-op trigger may
  verify scheduler dispatch without external side effects. The complete GUI
  flow (confirmation, dispatch, persisted run history) is verified on the live
  deployment.
- Inbox failed-run triage needs only active linked issues; never reload all
  terminal company history for that status lookup. On the 421-issue live
  company, active-only filtering cut initial Inbox issue JSON from about
  1.09 MB to 37,822 bytes while preserving server-side historical search.
- Do not render `ARCHIVED` or `OTHER RESULTS` Inbox section headers for empty
  search groups. Empty headings look like stale or missing state, especially on
  mobile.
- Daily sales capacity is 5–10 newly qualified prospects, followed by a
  replenished draft queue of up to 10 distance-prioritized accounts from
  Oberbuchsiten plus two exceptional Swiss accounts outside the active radius.
  Count active lane-tagged drafts before creating work; never add 12 blindly.
- Use real road distance/duration for outreach routing. Expand local search
  through 35, 70, and 120 km only as needed, retain a qualification floor, and
  let the exceptional lane optimize prospect quality rather than proximity.
- Every automatic outreach candidate must be represented by a deterministic
  research/draft pair with the research issue natively blocking the draft.
  Candidate enumeration creates internal work only; approval and sending remain
  separate stages.
- Dependency readiness and dependency context are separate requirements. When a
  blocker completes, the dependent agent must receive the resolved blocker ID
  and load its latest full work product; merely waking the dependent does not
  constitute a usable handoff.
- A schedule timestamp shown beside an explicit timezone must be formatted in
  that timezone. Never format in the browser timezone and then append a
  different trigger timezone label.
- Queueing an approval must also replace the issue's current deliverable with
  the exact bound `to/subject/body`; otherwise the task page can show a stale
  failure above a correct actionable card.
- First-contact sample/delivery guards must recognize both word orders and
  ordinary conjugations (for example `Muster senden` and `sende ... Muster`).
  A first contact may ask whether a visit is interesting but must not state
  `ich komme persönlich vorbei` before the prospect agrees.
- Mine/Needs-you must include active issues with pending human interactions
  even when the operator has never opened, commented on, or otherwise touched
  the issue. The Inbox badge, native decision count, and custom approval queue
  must reconcile.
- Superseded resolved decision cards remain auditable but collapse by default;
  pending cards remain expanded. Apply operator-facing lifecycle behavior to
  both the current and classic chat renderers while both exist.
- Never exercise production CRM create tools as diagnostics. Espo meetings
  require a real linked Account and evidence Email; placeholder/test/probe
  calendar records are refused structurally.
- Espo record IDs are native 17-character hex strings in this deployment, not
  RFC UUIDs. Tools accepting `account_id` must recognize the native format
  before falling back to a name search.
- A Hold reason is stored on the rejected interaction result, not necessarily
  as an issue comment. Any agent runner that wakes on Hold must inject the
  newest rejected interaction reason into the next model turn; waking without
  the reason creates repeated revisions that cannot follow Alan's feedback.
- Plugin launcher badges must read the same canonical data handler as the page
  they summarize. Outreach Outbox uses `ck-approvals.count`; do not introduce
  a separate SQL/count path for its sidebar badge.
- Alan confirmed Tres Hermanos cigars are already present at Bürgenstock Resort
  Lake Lucerne and Hotel Schweizerhof Bern. These may be named as restrained
  hotel references in suitable outreach. Do not expand that into exclusivity,
  sales-volume, endorsement, or guest-reaction claims.
- Research should shape the reason for writing, not become a venue description.
  A venue fact is optional in first contact. If used, it must connect naturally
  to the purpose; otherwise omit it. Never recite the recipient's hotel,
  restaurant, facilities, website, or CRM fields back to them merely to show
  personalization.
- Cold outreach to a general mailbox should normally begin `Mein Name ist Alan
  Christopherson und ich vertrete Tres Hermanos.` Then state the Swiss-company
  and own-Dominican-factory truth and move to one dossier-shaped purpose or
  question. Do not begin with `Sie führen ...`, `Ihr Hotel ...`, or a researched
  venue description.
- Branded venue names must remain grammatical in German (`in der Lounge The
  Council`, not `in Ihrer The Council Lounge`). Do not manufacture cadence with
  fragments or add catalogue filler such as `Handgerollte Premiumzigarren, von
  mild bis kräftig.`
- REV-06 Outreach-Drafter uses `deepseek-v4-pro`. Treat its live
  `adapter_config.model` and heartbeat `usage_json.model` as authoritative;
  regenerate `ck-org-map` after any model change so handoff documentation does
  not drift.
- Alan's canonical first-contact Muster is the owner-approved Bad Eptingen text
  dated 2026-07-23. Preserve its fixed paragraphs and order. Vary only the
  natural subject phrase, evidence-backed greeting, venue, one verified reason
  for writing, and the grammar required by those substitutions.
- In that Muster, offering a few samples during the requested presentation is
  allowed. A package, shipment, delivery promise/date, inventory, prices, and
  commercial terms remain forbidden in first contact.
- Bürgenstock Resort Lake Lucerne, Suvretta House, and Hotel Schweizerhof Bern
  are the approved fixed social-proof references in the Muster. Their mention
  is not cross-venue leakage, but other venue names remain blocked unless Alan
  approves them.
