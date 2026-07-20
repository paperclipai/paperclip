# Paperclip Operator Guide

| Field | Value |
|---|---|
| Version | 1 |
| Date | 2026-07-20 |
| Status | Active — primary QSL operational handbook |
| Maintainer | QSL operations (the Board) |
| Scope | How QuantumShield Labs operates Paperclip. This is **not** a Paperclip software manual. |
| Sources | `FOUNDING_PRINCIPLES_ABOVE_THE_DOOR.md`; `implementation/EMAIL_COMPANY_LIVE_ARCHITECTURE_AND_PLAN_2026-07-19.md`; `operations/PAPERCLIP_KNOWN_GOTCHAS.md`; `audits/EMA_1_CORRECTIVE_WAKE_AND_DISPOSITION_AUDIT_2026-07-19.md`; `PAPERCLIP_COMPREHENSIVE_SOURCE_REPORT_2026-07-20.md` (YT-Transcripts repo) |

**Reading tags used in this guide:**

- **[Doctrine]** — a QSL rule or decision. Binding on operators regardless of what Paperclip permits.
- **[Platform]** — verified Paperclip implementation behavior (confirmed against the running instance or upstream source on 2026-07-19).
- **[Field lesson]** — knowledge bought with an incident or debugging session. Treat as load-bearing.
- **[Source-only]** — from vendor/presenter material; not yet verified against the live system.

---

# The Operator's Promise

Before touching the system, the operator commits to:

1. Preserve evidence before drawing conclusions.
2. Grant authority explicitly, bound it tightly, and revoke it cleanly.
3. Treat no work as complete until it carries a valid disposition. Conversation is never a disposition.
4. Welcome review before automation; approve every expansion of the organization personally.
5. Keep the system safe by default and autonomous only by exception.
6. Leave every system — and every person — more capable than I found them.

If authority is unclear, stop and request direction. That is a correct operating state, not a failure.

---

# Purpose

This guide is the single operational reference for running QSL's Paperclip deployment day to day. It answers: *what do I do, in what order, under what rules, and where is the evidence?*

It is:

- **Operational** — procedures, checklists, and rules; not architecture theory.
- **Evidence-based** — every load-bearing claim traces to a live audit, an incident, or is tagged `[Source-only]`.
- **Reusable** — written so a second operator (or a future hire) can run the system without oral tradition.
- **Expandable** — new discoveries go to the appendices and the gotchas log; doctrine changes go through Board decision.

**Operational rule — evidence over speculation:** no major doctrine is added to this guide without operational evidence. Real operations improve the guide; speculation does not. Unproven ideas live in Appendix: Future Improvements until operations promote them.

It is not a Paperclip manual. Software behavior is described only where it changes what an operator must do. For architecture, see `implementation/EMAIL_COMPANY_LIVE_ARCHITECTURE_AND_PLAN_2026-07-19.md`. For discoveries, see `operations/PAPERCLIP_KNOWN_GOTCHAS.md`.

---

# Above the Door

QSL's founding principles (canonical: `FOUNDING_PRINCIPLES_ABOVE_THE_DOOR.md`). Technology changes; principles endure.

| Principle | Operational meaning |
|---|---|
| **Build for Trust** | Evidence before conclusions. Review before automation. Transparency over mystery. Systems make people more capable, not less responsible. |
| **Explicit Authority** | Authority is never assumed — it is granted, bounded, and revocable. Unclear authority → stop and ask. Autonomy is granted per objective, never the default mode. |
| **Completion Requires Governance** | Producing work is not completing work. Every meaningful action ends in an explicit state: **Done, In Review, Blocked, Delegated, or Continuation Queued.** Conversation alone is never a disposition. |
| **Human Judgment** | AI assists; humans decide. Evidence must always be capable of changing the plan. |
| **Operating Principle** | Safe by default. Autonomous by exception. Leave every system and person more capable than you found them. |

Every rule in this guide is one of these principles applied. When this guide is silent, decide from the principles, then write the decision down.

---

# Mental Model

Hold these six facts and most operator decisions become obvious:

1. **Paperclip is a control plane, not a chatbot** `[Platform]`. It orchestrates CLI agents (via adapters) around durable records. You do not converse with it; you create and disposition issues.
2. **Issues are the only unit of work** `[Platform]`. Agents, routines, plugins, and the Board all produce and consume issues. If it isn't an issue, it isn't tracked, budgeted, or auditable.
3. **Agents wake stateless.** Each run starts with no memory of prior runs (`freshSession: true` observed even within one incident). Identity and continuity come from the agent's instructions bundle, attached skills, and the issue record — not from the model remembering. `[Platform]` (EMA-1 audit)
4. **The human is the Board.** Agents propose; the Board approves hires, reviews work, unblocks, and owns every external effect. `[Doctrine]`
5. **The heartbeat connects assigned work to execution** `[Platform]`: a scheduler tick claims queued runs, checks per-agent concurrency and budget, atomically checks out the issue (single-assignee; a `409` means someone else holds it — never retry a `409`), runs the adapter, and records cost, logs, and activity.
6. **Budgets gate everything** `[Platform]`. At 100% of budget the platform auto-pauses. A budget of `0` means **no hard stop** — the EMA-1 incident (45 runs in 15 minutes) ran against exactly that configuration. `[Field lesson]`

The core operating loop, verified end-to-end on 2026-07-19:

```text
Issue created (Board / agent / routine / plugin)
  -> wake (assignment, @mention, schedule, manual, approval resolution, routine)
  -> scheduler claims run (concurrency + budget checks)
  -> atomic checkout -> in_progress (execution lock)
  -> adapter.execute()  (agent CLI runs: instructions + skills + scoped secrets)
  -> work product attached to the issue
  -> in_review -> done | blocked | cancelled   <- a disposition, always
  -> cost_events -> budget check -> activity_log
```

Four extension systems, kept orthogonal `[Platform]`: **routines** produce work (they never execute it), **skills** are doctrine delivered through adapters, **plugins** add capabilities (jobs, webhooks, tools, UI), **adapters** are the execution edge. When adding capability, choose in this order: company data (zero code) → native entities (pipelines/cases) → one plugin → approvals. Never modify core.

---

# The QSL Security Intelligence Model

QuantumShield Labs is not a scanner, and Paperclip is not the product.

- **QSL is a continuously operating, human-governed security intelligence platform.** That is the product.
- **Paperclip is the operational workflow engine** — the control plane that routes evidence, work, and approvals. It is replaceable tooling; the operating discipline is not.
- **Security tools are evidence sources.** They feed the loop; they are not the offering.

The intelligence cycle — continuous, not episodic:

```text
Observe
    ↓
Collect Evidence
    ↓
Correlate Intelligence
    ↓
Investigate
    ↓
Review & Challenge
    ↓
Human Decision
    ↓
Execute Approved Actions
    ↓
Capture Lessons Learned
    └───────────────► Observe
```

Evidence sources may include:

- Threat intelligence
- CVEs
- Vendor advisories
- Customer telemetry
- Infrastructure monitoring
- Cloud events
- Identity systems
- Security scanners
- Source-code analysis
- Customer reports

These are evidence sources. They are not the product. The product is continuous security intelligence with governed human decision making.

**Observation is continuous.** `[Doctrine]` Scanning is only one possible evidence source. QSL continuously observes security posture — evidence arrives through routines, connectors, and monitoring, not only through scheduled scans.

**How the cycle maps to the system:** every stage is an issue-driven workflow in Paperclip. Observe/collect: routines and connectors. Correlate/investigate: agents with bounded authority. Review & challenge: reviewer agents checking against explicit criteria. Human decision: Board disposition. Execute: approval-gated actions only. Capture lessons learned: gotchas log and doctrine updates — which change what we observe next. Future QSL Security companies may include specialized continuous Threat Intelligence agents that monitor external intelligence, detect patterns, correlate with customer environments, and report findings for human-governed review. These agents collect intelligence. They do not make final decisions. `[Doctrine]`

---

# QSL Organization

- **Board:** the human operator(s). Holds mission, goals, hiring, budgets, external effects, and final review. Currently a one-person Board; rituals below assume that. `[Doctrine]`
- **Companies:** one per venture or major function (see Companies).
- **CEO agent:** the Board's single point of contact inside each company.
- **Executive team / workers:** small specialist roster per company, hired only against an approved packet (see Agents).
- **Current deployment** `[Platform]` (2026-07-19 audit): instance `email-clean-20260719`, server `127.0.0.1:3100`, deployment mode `local_trusted`, embedded PostgreSQL, instance dir `~/.paperclip/instances/email-clean-20260719/`. Windows 11 host, PowerShell, Node 22, pnpm 9.15.4.
- **Instance-per-branch discipline** `[Field lesson]`: every branch/experiment gets its own instance (`PAPERCLIP_HOME` / `PAPERCLIP_INSTANCE_ID` or `paperclipai worktree init`). Never share a data directory across branches with divergent migration journals — fork migration `0182_qsl_findings` and upstream's numbering share one space.
- **Built-in agents** (`Reflection Coach`, `Summarizer`) are auto-provisioned. QSL keeps both **paused** until a role is defined for them. `[Doctrine]`

---

# Companies

A company is the governance boundary: mission, goals, agents, projects, issues, budgets, routines, skills — all company-scoped. `[Platform]`

**Create a company when** a venture needs a durable team with its own budget and audit trail. Do not create companies for one-off tasks; a project inside an existing company is cheaper.

**Baseline settings for every new company** `[Doctrine]`:

| Setting | Required value | Why |
|---|---|---|
| Monthly budget | Set a real number before first wake | Budget `0` = no hard stop; budgets are the last line of defense (EMA-1 lesson) |
| `requireBoardApprovalForNewAgents` | `true` | Organizational expansion is Board authority (shipped `false`; fix at creation) |
| Root goal | One specific, concise objective | Drives CEO triage and hiring proposals |
| Working directory | Dedicated, least-privilege path | Agent execution scope |
| Built-in agents | Paused | No unowned agents |

**Reference implementation:** the `Email` company (prefix `EMA`) — an AI-operated communications company. Its architecture and staged plan are verified in `implementation/EMAIL_COMPANY_LIVE_ARCHITECTURE_AND_PLAN_2026-07-19.md`. New companies copy its governance baseline, not its content.

**Reuse:** keep company structure, skills, and agent definitions in repo-tracked docs or export bundles so a clean instance can be re-populated without the old database. Instances are disposable; doctrine is durable. `[Field lesson]`

---

# CEO

The CEO is the first agent and the Board's interface to the company. The Board assigns work to the CEO; the CEO triages, delegates, and escalates.

**Configuration baseline** `[Doctrine]`:

- **Instructions must require disposition-ending runs.** One line, verbatim intent: *"Every run must end with a status transition (`in_review` at minimum), never with a question."* A conversational ending ("Let me know if you'd like to review…") caused the 45-run EMA-1 loop. `[Field lesson]`
- **Heartbeat:** start with the timer **off** (`runtimeConfig.heartbeat.enabled = false` — the audited Email Ops configuration) and wake manually. Enable a schedule only after the company runs clean for two weeks. Frequency trades directly against cost. `[Doctrine]`
- **Model tier:** the CEO is where a stronger model is justified. Cheap models are for triage/routine roles; the EMA-1 incident showed a cheap model following the operating procedure poorly. `[Field lesson]`
- **Permissions:** the CEO may *propose* hires and projects. It may not create agents unilaterally — Board approval gate stays on. `[Doctrine]`

**QSL heartbeat protocol** (install as the CEO's standing procedure once the timer is enabled) `[Doctrine]`:

1. Review: states of open issues, stale `in_review`/`blocked`, budget burn, anomalies.
2. Verify: completed runs carry evidence and valid dispositions.
3. Recommend: escalations, hires, or plan changes to the Board via inbox.
4. Execute only previously authorized work.
5. End every run with a disposition. If there is no authorized work, report `no action required` and stop. An idle CEO is a correct state.

---

# Executive Team

The proven minimum roster (Email company Stage 1):

| Role | Model tier | Job | Hard rule |
|---|---|---|---|
| CEO | Stronger (justified) | Triage, delegate, escalate, review | Proposes hires; never self-expands |
| Intake Triage | Cheapest | Classify inbound, create/route issues, suggest tasks | Read-only on external sources |
| Comms Drafter | Stronger | Draft outbound communications as work products | **Never sends.** Humans send. |
| Ops Analyst | Cheap | Summaries, metrics, weekly review inputs | Reports; does not act |

Rules `[Doctrine]`:

- Keep rosters small. 3–7 agents per company is the practical ceiling for a one-person Board; monitoring load, not software, is the constraint.
- Hire for a capability gap against an approved packet — never for activity.
- Every role with external effect (send, publish, merge, spend) pairs with a human approval gate.
- Review relationships beat hierarchies: drafter → reviewer → CEO → Board is enough depth for any current QSL company.

---

# Agents

**The only path to a new agent** `[Doctrine]`: capability gap identified → hiring packet drafted → Board approves → agent created with minimal access → supervised first runs → access widened on evidence.

**Hiring packet (required fields):** role; purpose/capability gap; mission; authority (may / may-not / prohibited); adapter + model; tools and access (least privilege, read-only first); skills (minimal, provenance-checked); reporting line; inputs; outputs; completion states + evidence required; budget; escalation conditions; review requirements; Board approver + review-by date. (Full template: `PAPERCLIP_COMPREHENSIVE_SOURCE_REPORT_2026-07-20.md` §10.2.)

**Per-agent configuration** `[Platform]`:

- `adapter_type` + `adapter_config.model` — the model id is **mandatory in `provider/model` format** for OpenCode. When routing through OpenRouter, always select the `openrouter/...` identifier (see Skills/Models gotcha below). Verify the exact string with `opencode models` before creating the agent. `[Field lesson]`
- Instructions bundle — managed by Paperclip; the agent's standing charter.
- `paperclipSkillSync.desiredSkills` — attach only what the role uses.
- `runtime_config` — heartbeat, concurrency.
- Per-agent budget — set at creation; this is what converts a runaway into an automatic pause.

**Config changes are revisioned** (`agent_config_revisions`) `[Platform]` — every change is auditable and rollback-able. Treat revisions as the change log during incident review.

**Revocation** `[Doctrine]`: pause the agent → revoke its credentials/tokens → export its issue history → record the reason in the company log. Revocation is a normal operation, rehearsed, not an emergency invention.

---

# Skills

Skills are reusable capabilities and standard procedures, materialized into the agent's CLI by the adapter at run time. `[Platform]` Doctrine: **skills are doctrine delivered through adapters.**

Rules:

- **Minimal per role.** Loading too many skills degrades model performance. Attach only what the role demonstrably uses. `[Source-only — consistent with observed model behavior; treat as an operating rule]`
- **Provenance before install.** Read the full skill (it is prompt text — treat it as code), pin the version, record source and hash in the hiring packet, sandbox the first run, re-review on update. `[Doctrine]`
- **Universal skills are the exception.** Default to role-specific attachment. `[Doctrine]`
- **QSL company SOP set** (Email company): `email-triage-sop`, `outbound-drafting-sop` (draft-only), `escalation-and-approval-rules`. Write SOPs as skills so every agent executes the same procedure. Catalog id format for bundled skills: `paperclipai/bundled/paperclip-operations/<slug>`; observed useful slugs: `issue-triage`, `task-planning`. `[Platform]`
- **Disposition discipline can be installed as a skill.** Attaching an operating skill is one of the EMA-1 corrective actions. `[Field lesson]`

---

# Issues

Issues are the sole unit of work and the audit trail. `[Platform]`

**States:** `backlog → todo → in_progress → in_review / blocked → done | cancelled`. Wakes fire on assignment, @mention, schedule, manual trigger, approval resolution, or routine. `[Platform]`

**Authoring standard** `[Doctrine]`: objective-level description (what outcome, what evidence), priority, assignee (CEO for triage; specific agent when known; unassigned is allowed — the CEO triages), project, due dates when real. Do not author micro-instructions; do author acceptance criteria.

**Dispositions — the core doctrine.** Every meaningful action ends in exactly one of:

| Disposition | Valid when |
|---|---|
| **Done** | Work complete, evidence attached, acceptance criteria met |
| **In Review** | Work product attached, named reviewer (Board or agent) assigned |
| **Blocked** | First-class blocker recorded: what is needed and who owns unblocking |
| **Delegated** | Follow-up issue(s) created and linked; ownership transferred |
| **Continuation Queued** | Explicit next step and wake path recorded |

**Conversation is never a disposition.** A run that ends with a question and no status transition is an operational defect, and the platform treats it as one: it posts "Paperclip needs a disposition before this issue can continue" and queues a corrective wake (bounded per source run). If the pattern repeats, the productivity-review service escalates (≥10 issue-linked runs/hour triggers a `Review productivity for <issue>` sub-task with a Manager Decision footer). These are native upstream safety nets working as designed. `[Platform]` (EMA-1 audit)

**Evidence rule** `[Doctrine]`: `done` and `in_review` require artifacts on the issue — work products, documents, or uploaded files. An agent claiming completion without linked evidence is returned.

**Operator rules** `[Field lesson]`:

- To stop a corrective-wake loop: record a valid disposition manually (the platform's own prescribed manager action). Then fix the cause.
- Never delete a productivity-review issue — resolve it via its Manager Decision (close as productive / snooze / decompose / stop source work). It is the incident's audit trail.
- Never retry a `409` on checkout — someone else holds the issue.
- Watch for `freshSession` re-work: agents repeating completed work from scratch is a signal that disposition or instructions are broken, not that the task is hard.

---

# Human Review

The Board's review load is designed to fit **15 focused minutes per day**. If it doesn't, the system is misconfigured — that is itself a finding.

Daily, in this order:

1. **Inbox** — hire requests, blocked escalations, review requests. Approve or reject with reasons; silence is not a decision.
2. **`in_review` queue** — check evidence, then disposition: accept (`done`), return (comment + `in_progress`), or escalate.
3. **`blocked` queue** — supply the missing input or re-route. Every blocker gets an owner.
4. **Hire approvals** — against the packet only. Reject packets with undefined authority, missing budget, or unprovenanced skills.
5. **Anomalies** — high run counts on one issue, repeated corrective wakes, budget burn rate. Any of these pauses normal operation until explained.

Review posture `[Doctrine]`: reviewer agents may pre-check against criteria, but an accountable human closes anything with external effect. Evidence must be capable of changing the plan — if reviews never change anything, review is theater; find out why.

---

# Governance

**Authority model** `[Doctrine]`: all authority flows from the Board, is written down (goal, packet, approval), is bounded (tools, budget, scope), and is revocable (tested procedure). Autonomy is enabled deliberately, per objective, and withdrawn on evidence.

**Company governance baseline** (enforced at creation — see Companies): budget set; `requireBoardApprovalForNewAgents: true`; root goal; built-in agents paused. `[Doctrine]`

**Approvals and the send-gate pattern** `[Platform]`: for any important outbound action — agent drafts → attaches draft as work product → `request_board_approval` → execution only on approval resolution. Fully audited in `activity_log`. Applies to: sending communications, publishing, merging, spending, external messages.

**Audit trail** `[Platform]`: `activity_log` (mutations), `cost_events` (spend), `heartbeat_run_events` (execution), `secret_access_events` (credential use), `agent_config_revisions` (config change). These are the evidence base for every review and incident response.

**Budgets** `[Platform]`: per-agent and per-company; 100% = auto-pause. Budgets are the last line of defense — the EMA-1 runaway ran with budget `0` and no hard stop. `[Field lesson]`

**Relationship to upstream positioning** `[Doctrine]`: Paperclip's marketing emphasizes "zero-human" companies. QSL deliberately diverges: human-governed operations, Board-approved expansion, evidence-backed dispositions, revocable autonomy, and stop-when-no-authorized-work. We use the platform's approval and audit machinery; we do not adopt the autonomy philosophy. (Full comparison: source report §20.)

---

---

# Daily Operations

The operating day has three fixed points: startup (5 min), mid-day spot check (optional, 5 min), end-of-day review (15 min max).

**Startup** — run the Startup Checklist below. Then queue the day's priorities as issues assigned to the CEO. Author for outcome and evidence, not process.

**During the day** — the company runs on wakes: assignment, routine, and (once enabled) the CEO heartbeat. The Board's job is decisions, not supervision: approve hires, disposition reviews, unblock blockers. Wake the CEO manually after queueing a batch of issues rather than waiting for a timer.

**Routines** (installed at Stage 2, once the base company is proven) `[Platform]`:

| Routine | Schedule | Produces | Consumer |
|---|---|---|---|
| `morning-ops-brief` | Weekday cron | Issue → CEO: status, anomalies, recommendations | Board at startup |
| `weekly-comms-review` | Weekly cron | Issue → Ops Analyst: metrics and review inputs | Board weekly review |

Routine rules `[Doctrine]`: every routine has a named consumer; a routine whose output nobody reads is paused; routines gather, summarize, and recommend — they never create unauthorized work; stop-and-notify on repeated failure or missing inputs. (Routines produce issues; they do not execute work. `[Platform]`)

**Routines are the minimum continuous-observation posture** `[Doctrine]`: the company keeps watching — evidence in, anomalies flagged — even when the Board is offline. Scanning is one possible evidence source; observation is continuous.

**End of day** — run the Shutdown Checklist. This is the human-review ritual from Human Review, timeboxed to 15 minutes.

**Cost discipline** `[Doctrine]`: check spend at startup against budget; investigate any day-over-day jump before queueing new work. Heartbeat frequency, parallel sessions, retries, and review loops are the cost levers — in that order.

---

# Security Operations

**Deployment posture** `[Platform]`: single host, server bound to `127.0.0.1:3100`, deployment mode `local_trusted`, embedded PostgreSQL under the instance directory. This is the approved QSL baseline. Do not expose the UI to a network interface without a Board-approved hardening review (auth strength, TLS, allowlisting, and a threat model are prerequisites — none exist today).

**Continuous posture, not point-in-time** `[Doctrine]`: QSL continuously observes security posture. Scanners and point-in-time assessments are evidence sources — inputs to the intelligence cycle (see The QSL Security Intelligence Model), never the whole of our coverage.

**Secrets** `[Doctrine]`:

- Credentials live in provider tooling or secret bindings — never in issues, comments, instructions, or this guide. (Pasting an API key into an issue is a documented industry anti-pattern; QSL treats it as an incident.)
- Operator credential files are out of scope for agents and audits. The EMA-1 audit deliberately did not inspect the OpenCode auth file, per credential-handling policy. Keep that boundary.
- Company secret bindings → project env → routine env overlay is the platform's layering order for run environments. `[Platform]`
- Anything ever shown on screen, pasted in an issue, or committed to a transcript is rotated.

**Runtime isolation** `[Platform]`: each run receives short-lived, scoped credentials (run JWT + per-run gateway tokens). Agents access only their own company's data. Preserve these invariants: single-assignee checkout, approval gates, budget hard-stop, activity logging. Do not disable them for convenience.

**Backups** `[Platform]`: hourly backup job runs automatically; a fresh instance shows a transient `database_backup_missing` warning until the first run — close it immediately with `paperclipai db:backup` on new instances. Verify backups exist during the Shutdown Checklist; test a restore quarterly.

**Host hygiene** `[Field lesson]`: on any new Windows machine, verify process spawning before installing anything (quoted PATH entries silently break `spawn` while interactive shells look healthy — Gotcha #2):

```powershell
node -e "require('child_process').spawn('node',['--version'],{stdio:'inherit'}).on('error',e=>console.log('ERR',e.message))"
```

If it prints a version, spawning is healthy. Inspect PATH for quoted entries after any Java/Maven/Helm installer runs.

**Revocation and incident response** `[Doctrine]`:

1. **Stop:** pause the agent/company; revoke adapter credentials; stop the server if host-level concern.
2. **Preserve:** export issues, runs, cost events, and activity logs before changing anything.
3. **Assess:** what acted, under whose authority, what evidence exists, what the blast radius is.
4. **Resolve:** fix cause, rotate exposed credentials, restore from backup if needed.
5. **Record:** incident note + gotchas entry + any doctrine change, approved by the Board.

---

# Client Operations

Rules for any client-facing use of this system `[Doctrine]`:

1. **Sandbox first.** Every client engagement begins in an isolated instance with synthetic or tightly-scoped data. No client production credentials, ever, in a sandbox.
2. **Separate instance per client.** No shared companies, credentials, memory, or budgets across clients.
3. **Read-only before write.** New connectors start read-only; write scopes are granted individually, on evidence, per integration.
4. **Draft-only outbound.** Agents draft; humans send. The send-gate pattern applies to every client communication without exception.
5. **Evidence-backed deliverables.** Every client-facing output ships with its evidence trail (issues, work products, approvals). We sell verifiable work, not activity.
6. **15-minute review ritual, demonstrated.** The client's own reviewers should be able to audit a week of operation in minutes. If they can't, our instrumentation is the defect.
7. **No zero-human promises.** We sell governed capability: bounded authority, human approval gates, complete audit trail. That is the differentiator and the truth.

What we offer clients is continuous observation with governed human decisions — not a scanner and not a scan report. A scanner is one evidence source among many; the product is the operating loop around it (see The QSL Security Intelligence Model).

Intake and lead handling use the platform's native **pipelines, stages, and cases** — do not build custom tables for lead qualification. `[Platform]`

---

# Revenue Workflow

Revenue work runs through the same governed loop as everything else; money does not bypass dispositions.

**Flow** `[Doctrine]`:

1. **Intake** — inbound interest becomes a **case** in the sales pipeline (native entity). Triage agent classifies and routes; no auto-replies to prospects.
2. **Qualify** — evidence gathered (need, budget, fit, security posture). Drafter prepares responses; the Board sends.
3. **Propose** — fixed-scope package from the offers below. Every proposal is a reviewed work product with an explicit Board disposition before sending.
4. **Deliver** — a client sandbox or governed deployment per Client Operations. Delivery work is issues with evidence, reviewed like everything else.
5. **Review & renew** — scheduled review with the client; renewals, expansions, and references tracked as cases.

**Offers (productized, fixed-scope):** secure installation + hardening; governance setup (baseline settings, CEO protocol, hiring packets, budgets); skills audit; cost-control setup; managed monitoring (the recurring offer); training/onboarding. Templates and exports productize last — only after they are proven internally and provenance-documented.

**Constraints** `[Doctrine]`: hourly installation labor alone does not scale — package it. Managed monitoring has the best recurring economics but the highest trust requirement; sell it only after our own house passes the Shutdown Checklist cleanly for a sustained period. No offer may promise autonomy outcomes we have not operated ourselves.

---

# Startup Checklist

Daily, before queueing work (≈5 minutes):

- [ ] Server healthy (`/api/health` → `ok`) and correct instance (`email-clean-20260719` or current designated instance)
- [ ] Backup present (no `database_backup_missing` warning; run `paperclipai db:backup` if new instance)
- [ ] Inbox triaged: hire requests, escalations, approvals
- [ ] `blocked` queue: every blocker has an owner and a next action
- [ ] `in_review` queue: dispositions recorded (accept / return / escalate)
- [ ] Overnight runs sane: no high-churn loops, no repeated corrective wakes, no `freshSession` re-work
- [ ] Spend vs. budget within expected band; anomalies explained before new work
- [ ] Routine outputs consumed (morning brief read) — pause any routine nobody consumed
- [ ] Day's priorities queued as issues to the CEO, with evidence expectations stated

---

# Shutdown Checklist

End of day (≤15 minutes):

- [ ] No issue sits `in_progress` without an owner and a next action
- [ ] Every completed run has a valid disposition (Done / In Review / Blocked / Delegated / Continuation Queued)
- [ ] Any corrective-wake or productivity-review activity resolved — never deleted, resolved via Manager Decision
- [ ] Costs reconciled against budgets; overruns explained in the company log
- [ ] Outbound items: nothing sent without approval; drafts queued for tomorrow where appropriate
- [ ] Backup job confirmed run
- [ ] Company log updated: decisions made, hires approved/rejected, incidents, anomalies
- [ ] Tomorrow's first three priorities queued as issues
- [ ] New discoveries written to `operations/PAPERCLIP_KNOWN_GOTCHAS.md` (Symptom → Cause → Fix → Prevention)
- [ ] Server stopped (or deliberately left running with reason logged)

---

# Growing the System

Growth follows the proven stage sequence; do not skip stages. `[Doctrine]`

| Stage | Content | Gate to advance |
|---|---|---|
| 0 — Prove the loop | One company, one CEO, one issue end-to-end (run, cost event, activity entry, work product, disposition) | Loop green with zero code written |
| 1 — Org + doctrine | Executive team hired via packets; SOP skills written; budgets set | Team runs clean for two weeks on manual wakes |
| 2 — Routines | `morning-ops-brief`, `weekly-comms-review` | Routine output consumed daily; cost understood |
| 3 — One plugin | Read-only capability only (e.g., mail intake → issues) | Read-only proven before any write path is designed |

**Adding agents:** only on a demonstrated capability gap, via hiring packet + Board approval. More agents ≠ more capability; monitoring load grows faster than output. (Source report: 7–15 agents strains even full-time oversight.)

**Adding companies:** copy the governance baseline (Companies section), not another company's content. Keep structures exportable so a clean instance can be re-populated — instances are disposable, doctrine is durable. `[Field lesson]`

**Extension order** `[Platform]`: company data (zero code) → native entities (pipelines/cases) → one plugin → approvals. Never modify core. The fork's QSL review bridge stays dormant; if needed, pluginize it (this also removes the `0182` migration-numbering collision with upstream).

**Institutional learning:** every time something costs you time, add a gotchas entry the same day. Every doctrine change is a Board decision backed by operational evidence (see Purpose: evidence over speculation), recorded in the company log, and reflected in this guide's next version.

---

# Appendix: Glossary

| Term | Meaning |
|---|---|
| **Adapter** | The execution edge: runs the agent CLI with instructions, skills, and scoped secrets; reports cost/session/logs back. `[Platform]` |
| **Agent** | A persistent, instruction-carrying worker executed through an adapter. Stateless at wake; identity comes from instructions + skills + issue record. |
| **Board** | The human operator(s) holding governing authority: hires, budgets, reviews, external effects. |
| **Budget** | Per-agent or per-company spend cap; 100% triggers platform auto-pause. `0` = no hard stop. `[Platform]` |
| **Case / Pipeline** | Native CRM-style entities for intake and lead tracking; use these, not custom tables. `[Platform]` |
| **CEO** | Top agent in a company; the Board's interface; triages, delegates, proposes hires. |
| **Company** | Governance boundary containing mission, goals, agents, projects, issues, budgets, routines, skills. |
| **Continuation Queued** | Valid disposition: explicit next step and wake path recorded. |
| **Corrective wake** | Platform-issued wake after a successful run ends without a valid disposition; bounded per source run. `[Platform]` |
| **Delegated** | Valid disposition: follow-up issue(s) created and linked; ownership transferred. |
| **Disposition** | The explicit operational end-state of work. Valid set: Done, In Review, Blocked, Delegated, Continuation Queued. Conversation is never a disposition. |
| **Execution lock / checkout** | Atomic single-assignee claim on an issue; a `409` means someone else holds it — never retry. `[Platform]` |
| **Heartbeat** | Scheduled wake that connects assigned work to execution. Only the CEO has one in QSL doctrine; timer starts disabled. |
| **Hiring packet** | Board-approved specification defining an agent's role, authority, tools, skills, budget, and review terms. |
| **Instance** | A Paperclip server + data directory. One per branch/experiment. Disposable; doctrine is durable. |
| **Issue** | The sole unit of work and the audit record. States: backlog, todo, in_progress, in_review, blocked, done, cancelled. |
| **`local_trusted`** | Deployment mode: single-operator, loopback-bound server. QSL's current baseline. `[Platform]` |
| **Productivity review** | Platform-generated review issue (e.g., `high_churn` trigger: ≥10 runs/1h on one issue) with a Manager Decision footer. Resolve, never delete. `[Platform]` |
| **Provider prefix** | The `provider/` portion of a model id that determines authentication (e.g., `openrouter/...` routes via OpenRouter). `[Field lesson]` |
| **Routine** | Scheduled trigger that creates issues (it produces work; it does not execute it). `[Platform]` |
| **Send-gate** | Pattern: agent drafts → draft attached as work product → Board approval → execution. Mandatory for outbound. |
| **Skill** | Reusable capability/SOP package materialized into the agent at run time by the adapter. Minimal per role; provenance-checked. |
| **Work product** | An artifact attached to an issue (draft, report, plan, file). Required evidence for `done`/`in_review`. |

---

# Appendix: Common Mistakes

Each entry: what it looks like → what to do. Details in the cited source.

1. **Run ends conversationally, no disposition.** Loop of corrective wakes; churn; cost. → Record a valid disposition manually; add "every run ends with a status transition" to the agent's instructions; attach an operating skill. (EMA-1 audit)
2. **Budget left at `0`.** No hard stop when something loops. → Set real budgets at company creation; per-agent budgets at hire. (EMA-1 audit)
3. **Model id without the `openrouter/` prefix.** Appears valid; executes and bills through the wrong provider. → Always select `openrouter/...` ids; verify with `opencode models` before creating the agent. (Gotcha #1)
4. **Repairing a stale/corrupt dev database.** Hours lost; migration journals diverge across branches. → Fresh instance; re-populate from tracked doctrine. Instance-per-branch. (Gotchas #3–4)
5. **Quoted entries in Windows PATH.** `pnpm dev` fails with spawn errors while interactive shells look fine. → Remove quoted entries via System Environment Variables GUI (never `setx PATH`); run the spawn health check. (Gotcha #2)
6. **Retrying a `409` checkout.** Fighting the single-assignee invariant. → Someone else holds the issue; inspect, don't retry. `[Platform]`
7. **Deleting a productivity-review issue.** Destroys the incident's audit trail. → Resolve via Manager Decision (close as productive / snooze / decompose / stop). (EMA-1 audit)
8. **Loading many skills "for capability."** Context degradation; worse outputs. → Minimal role-matched skills; universal skills by exception. (Source report §11)
9. **CEO instructed to "keep everyone busy."** Manufactured work, token burn, review overload. → QSL heartbeat protocol: review, verify, recommend; idle is acceptable. `[Doctrine]`
10. **Secrets in issues/comments.** Credential exposure in an auditable, agent-readable store. → Secret bindings/provider auth only; rotate anything exposed. `[Doctrine]`
11. **Enabling the heartbeat timer on day one.** Unobserved autonomous cycles before doctrine is proven. → Manual wakes until two clean weeks; then schedule, hourly or longer. `[Doctrine]`
12. **Hiring ahead of need.** Org charts that outgrow the Board's ability to review. → Capability gap → packet → approval. Small rosters. `[Doctrine]`
13. **Treating vendor/transcript claims as verified.** Commands, features, and roadmap items from videos may not match the running system. → The running instance is the source of truth; verify before relying. (Source report §25)

---

# Appendix: Future Improvements

Grounded items only — each has a trigger and an owner (the Board). No speculative architecture.

| # | Improvement | Trigger / condition | Source basis |
|---|---|---|---|
| 1 | `plugin-email` v1, read-only mail intake → issues in an Intake project | Stage 3 gate passed (loop + org + routines proven) | Architecture plan Part C |
| 2 | Approval-gated send tool (v2) | v1 read-only proven; send-gate pattern operating manually | Architecture plan Part C |
| 3 | Pluginize the fork's QSL review bridge (removes `0182` migration collision) | When QSL review findings are needed in production | Architecture plan A.8 |
| 4 | Company template export of the governance baseline (reusable new-company starter) | After second company runs clean | Architecture plan A.7; source report §17 |
| 5 | Calendar/scheduling via the tool gateway | After plugin-email v1; only if routines prove insufficient | Architecture plan Part B |
| 6 | Memory capability | Wait for upstream roadmap; do not pre-build | Architecture plan Part B |
| 7 | Per-role evaluation metrics (does review actually catch defects?) | Before scaling review loops | Source report §14 |
| 8 | Backup restore drill (quarterly) | Standing | This guide, Security Operations |
| 9 | Second-operator onboarding dry run using only this guide | Before first hire/delegation | This guide, Purpose |
| 10 | Specialized continuous Threat Intelligence agents in a future QSL Security company (monitor external intelligence, detect patterns, correlate with customer environments, report findings for human review) | When a QSL Security company is chartered; agents collect intelligence — they do not make final decisions | This guide, The QSL Security Intelligence Model |
| 11 | Version 2 of this guide | After any doctrine change, incident with new lessons, or Stage advance | This guide |

---

*Version 1 — 2026-07-20. Changes to this guide are Board decisions; record them in the company log and bump the version.*
