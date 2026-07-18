# EMAIL COMPANY RECOVERY AND PORT AUDIT

**Date:** 2026-07-17
**Status:** READ-ONLY AUDIT — complete, awaiting human review
**Scope:** Reconstruct the exact state of the QSL Paperclip "email company" and its agents; classify every asset for selective port onto current upstream Paperclip.
**Constraint honored:** No implementation, modification, deletion, migration, commit, or push was performed. The only filesystem writes were (a) this report and (b) read-only extractions of legacy SQL backups into the temp working directory (`%LOCALAPPDATA%\Temp\opencode\email-audit`).

---

## 1. Executive Summary

**The central finding is corrective: no email-focused Paperclip company ever existed in any recoverable Paperclip state.**

Across three independent SQL snapshots spanning the full lifetime of the legacy instance (day-one 2026-03-27, 2026-04-09, final 2026-06-22), the Paperclip database only ever contained two companies:

1. **QSL Security Ops** (`839bfea4-f16b-448b-9b1a-d040aededb90`, prefix `QSL`) — created 2026-03-27, the **first** Paperclip company. Purpose: autonomous security scanning (CrawDaddy on Virtuals ACP), not email.
2. **SELARIX Operations** (`11dc08e7-2135-4c0f-a605-034285555d8e`, prefix `SEL`) — created 2026-03-30. Purpose: swarm/infrastructure monitoring. Not email.

**What the "email company" actually was:** the email operation lived *outside* Paperclip, in the QSL "Cabinet" architecture — a designed 15-agent org documented in the `QSL PAPERCLIP CONTEXT` company document (v1.0, 2026-03-27) and the `QSL_Agentic_Economy_Blueprint_v1_MAR2026.md`. Its email agent was **OutreachBot** ("Chief Marketing Officer — TherapistIndex email sequences, LinkedIn automation, lead generation"), status **PARTIAL**, with the explicit pending spawn condition *"Wire Brevo sequences."* OutreachBot was never instantiated in Paperclip (it appears in none of the 13 agent rows) and its Brevo automation was never wired. Real email sends happened only twice — two manual Brevo campaigns on 2026-03-24 (~440 contacts, ~870 sends, 0.7% reaction rate) sent from the Brevo console, not by any agent.

**Answer to the key question (A/B/C/D):** **D — a mixture, with C dominant.**
- **C (dominant):** Email was an external bot system (OutreachBot, Brevo, Hostinger mailboxes) *intended to be governed later by Paperclip* — the Paperclip board was explicitly designated "the Board" over Cabinet agents.
- **A (partial):** SELARIX Operations was the Paperclip mirror of the EC2 swarm — its OpsBot/SalesBot/TreasuryBot agents were Paperclip proxies that SSH'd to EC2 to drive the real Python bots. SalesBot's pipeline was email-adjacent (consulting leads later contacted by email), but no Paperclip agent or routine ever read or sent email.
- **B (true for OutreachBot itself):** a company/agent *designed but never instantiated*.

**Port recommendation in one line:** port the two real companies, their 13 agent definitions (sanitized), doctrine documents, and the QSL bridge/review/export services per the existing `PAPERCLIP_UPSTREAM_INTEGRATION_PLAN_2026-07-16.md`; treat the email capability as **archive + human-review-only**, because upstream Paperclip has no email capability (verified: zero SMTP/IMAP/mailbox references in `server/src`), and the architectural constraint in force is *no outbound email without explicit human approval*.

---

## 2. Evidence Sources Inspected

| # | Source | What it yielded |
|---|--------|-----------------|
| E1 | `paperclip/PAPERCLIP_*.md` (10 handoff/audit docs, 2026-07-16) | Instance inventory, runtime map, DB map, isolation execution, canonical-instance decision |
| E2 | `paperclip/LEGACY_POSTGRES_STATE_2026-07-16.txt` | Legacy embedded-PG state (port 54329, data dir) |
| E3 | `paperclip/doc/plans/` (incl. `PAPERCLIP_UPSTREAM_INTEGRATION_PLAN_2026-07-16.md`, `PRE_PORT_BASELINE_2026-07-16.md`, divergence/rollback/preservation-matrix docs) | Existing approved-path integration plan; upstream verified bootable (172 migrations) |
| E4 | `paperclip/board_exports/` (agents/company_map/issues/governance exports, generated 2026-05-13T02:06Z) | Full 13-agent roster with adapter configs, heartbeats, capabilities; 2 companies; governance state |
| E5 | `C:\Users\mikeb\.paperclip\instances\` | 4 instances: `default` (legacy), `default-backup-20260716-104332` (verified copy), `sprint5-clean`, `upstream-clean-test` |
| E6 | `.paperclip\instances\default\companies\<id>\agents\<id>\instructions\` (on-disk) | AGENTS.md for 13 agents; CEOs also have SOUL.md / HEARTBEAT.md / TOOLS.md; one agent `.env` (Security Engineer 035e05af) |
| E7 | `.paperclip\instances\default\data\backups\paperclip-20260622-114344.sql.gz` (1.1 GB decompressed, read-only stream scans) | Final DB state: 2 companies, 13 agents (12 `error`, 1 `terminated`), 1 goal, 3 projects, 10 routines, 11 approvals, 4 company secrets (EC2_HOST/SSH_KEY ×2 — **no email secrets**), 2 environments, documents (QSL PAPERCLIP CONTEXT ×2 revisions + per-issue Continuation Summaries), 10 company skills |
| E8 | `C:\Users\mikeb\.paperclip.zip` (2026-04-16, 421 MB) — file listing + extracted `paperclip-20260327-131548.sql` (day-one) and `paperclip-20260409-083336.sql` | Proof the same two companies were the only companies from day one; hourly backup chain 3/27→4/9 |
| E9 | `C:\Users\mikeb\paperclip.zip` (2026-04-16, 257 MB) — listing only | Repo snapshot (contains `.git`), not an instance; no additional evidence |
| E10 | `qsl-reference-archive\blueprints\QSL_Agentic_Economy_Blueprint_v1_MAR2026.md` | Cabinet table: OutreachBot row "PARTIAL — Brevo + Manus"; per-agent email-address requirement; `crawdaddy@quantumshieldlabs.dev` identity row |
| E11 | `selarix-lattice\operating\INFRASTRUCTURE_REGISTRY.md` (2026-04-25) | **The mailbox/infrastructure source of truth**: 6 @thebinmap.com mailboxes + forwarders, Brevo account facts, VPS Paperclip deployment (`paperclip.quantumshieldlabs.dev`, PM2 `selarix` user), EC2/VPS access maps |
| E12 | `Downloads\HOSTINGER_MAIL_COMPLETE_INBOX_SPAM_AUDIT_2026-07-14.md` | Complete state of `michael@quantumshieldlabs.dev` (684 messages; receipts, WP Mail SMTP summaries, Gumroad sale 7/14; 9 junk incl. the Gumroad sale notification) |
| E13 | `Downloads\QSL_MASTER_REFERENCE.md` (2026-03-06) | Pre-Paperclip master context: "Email outreach: Brevo active — 300/day, DKIM/DMARC configured" for TherapistIndex; QSL consulting outreach from `michael@quantumshieldlabs.dev` |
| E14 | `thebinmap\docs\architecture\email-flow.md` + `thebinmap\docs\products\CUSTOMER_INTAKE_QUEUE.md` (2026-07-13) | TheBinMap's two email paths (Web3Forms→gmail direct; Hostinger forwarders); 7 intake channels, all 🔴/🟡 — no subscriber storage, no auto-responder, no payment/delivery |
| E15 | `quantumshield-core\` (QSC_SOURCE_OF_TRUTH.md, bridge/, approval_gate.py, hermes.py, paperclip_bridge.py, qsl_paperclip_adapter.py, safety/) | Hermes runtime, 3-tier permission system, 6 blocked actions, hard human-in-the-loop gate, bridge emitter → `bridge/output/{manifest,state,issues,approvals,confidence-snapshots}.json` |
| E16 | `qsl-selarix\` (README, INQUIRY_REVIEW_2026-06-18, ECOSYSTEM_MAPPING_FINDINGS, TODAY, EMERGING_ARCHITECTURE) | Doctrine repo; Inquiry-as-first-class-object findings; "Paperclip becomes an Inquiry surface" direction |
| E17 | `qsl\` (handoffs/MASTER_CONTEXT.md, docs/, operations/DISCOVERY_INDEX_2026_07_05.md, docs/audits/2026-06/THEBINMAP_WORKFLOW_ACTIVATION_AUDIT.md) | Product identity (Chronicle, governance continuity); discovery index pointing to E11; June finding: "send_email — Missing — No email service integration (no SMTP, SendGrid, Resend, etc.)" |
| E18 | `graphify\` (tool repo), `quantumshield-core\graphify-out\` (empty), `qsl\docs\graphify\GRAPHIFY_INGESTION_SPEC.md`, `qsc-graphify-test\` | Graphify is a comprehension/navigation tool; no runtime mapping output survives locally except the ingestion spec |
| E19 | `SESSION_HANDOFF_MAY7.md`, `SYSTEM_RECOVERY_LOG_MAY7_2026.md`, `SELARIX_DAILY_BRIEF.md` (home dir) | EC2 bot stack recovery history; ResearchBot brief (references QSL-ZAP LinkedIn pipeline, disk space, issue backlog) |
| E20 | `paperclip\server\src` grep for `smtp|imap|mailbox|send_email|inbound email` | **Zero matches** — Paperclip (this fork state) has no email capability |
| E21 | `paperclip\.env.legacy` (key names only, values not read into report) | `DATABASE_URL` (dead port 5432), `BETTER_AUTH_SECRET`, `QSL_BRIDGE_PATH=C:/Users/mikeb/quantumshield-core/bridge/output`, commented `DISCORD_WEBHOOK_URL`; **no email keys** |
| E22 | `board_exports` grep for email/outreach/brevo/mailbox/smtp/imap | Only incidental mentions inside issue JSON (outreach-campaign issues) |
| E23 | `qsl-knowledge-base`, `qsl-knowledge`, `qsl-new`, `qsl-fresh`, `QSL-Business`, `qsl-workspace`, `qsl-morning-brief` (greps) | No email-company design; `selarix-nexus\docs\harvest\AGENT_REGISTRY.md` mentions OutreachBot as planned downstream consumer of ResearchBot |

**Deliberately not inspected:** the 174 MB `server.log` (per instruction — the email-company question was resolved by higher-value sources; narrow greps remain available), agent workspace directories, secret *values* anywhere.

---

## 3. Existing Company Identity

### 3.1 Direct answer to "What was the exact name and purpose of the original email-focused Paperclip company?"

**No such company existed in Paperclip.** The premise is a composite memory of three real things:

| Real asset | What it actually was | Evidence |
|---|---|---|
| **QSL Security Ops** (first Paperclip company) | Autonomous security scanning company; its shared context document *described* a 15-agent Cabinet including an email agent | E7 companies row; E10 |
| **OutreachBot** | The Cabinet's email/lead-gen agent — *designed, partially built, never instantiated in Paperclip, Brevo sequences never wired* | E10 (blueprint line 146: "Chief Marketing Officer — OutreachBot — TherapistIndex email sequences, LinkedIn automation, lead generation — PARTIAL — Brevo + Manus"); E7 documents table (QSL PAPERCLIP CONTEXT v1.0) |
| **Hostinger/Brevo email estate** | Real mailboxes and 2 manual campaigns, operated by Mike directly | E11, E12, E13 |

### 3.2 The two companies that do exist

| Field | QSL Security Ops | SELARIX Operations |
|---|---|---|
| ID | `839bfea4-f16b-448b-9b1a-d040aededb90` | `11dc08e7-2135-4c0f-a605-034285555d8e` |
| Prefix / counter | `QSL`, counter 5 (day-one) | `SEL`, counter 311 (by 4/9), ~7225+ by May |
| Created | 2026-03-27T16:05:35Z | 2026-03-30T16:50:44Z |
| Status (June 22) | active (server down) | active (server down) |
| Purpose | CrawDaddy ACP security scans ($0.49/scan), north star $500/mo USDC; THREE LAWS; GOTCHA framework | Swarm monitoring division: EC2 health, seller/bastion process watch, Telegram alerts, sales/treasury/ops bots |
| `require_board_approval_for_new_agents` | true | true |
| Goal | 1 company goal: "Autonomous security scanning company… Agents earn their existence" | (none) |
| Projects | Onboarding (in_progress), Content Pipeline (backlog) | Swarm Monitoring (backlog) |
| Budget | 0 cents monthly cap / 0 spent | 0 / 0 |
| Environment | "Local" (driver=local, active) | "Local" (driver=local, active) |

---

## 4. Existing Agent Roster and Hierarchy

13 agents total (June 22 final state; 12 in `error` status at shutdown — the server had been degrading; 1 terminated). All `claude_local` adapters with `--dangerously-skip-permissions`, models `claude-sonnet-4-6` where set. Skills on all agents: `paperclip`, `paperclip-dev`, `paperclip-create-agent`, `paperclip-create-plugin`, `para-memory-files`.

### QSL Security Ops (8 agents — flat, all report to CEO)

| Agent | ID | Role/Title | Reports to | Heartbeat | Status (final) |
|---|---|---|---|---|---|
| **CEO** | `3c03fead-…-b5c1` | ceo | — | 3600s, wakeOnDemand, maxConcurrent 1 | error |
| Security Engineer (monitor) | `035e05af-…-088e` | general — "EC2 & CrawDaddy Health Monitor" | CEO | 3600s | error |
| Security Engineer (scanner) | `1d62eeb0-…-b8c2c` | engineer — CrawDaddy/PQC scans, ACP billing | CEO | 3600s | **terminated 2026-03-29** |
| Content Strategist | `b5495be0-…-83e2dac` | general — CrawDaddy public presence (Moltbook) | CEO | 3600s | error |
| QA Engineer | `e60f4c00-…-c148e` | qa — scan report reviewer; cwd `C:\Users\mikeb\crawdaddy-automation` | CEO | 3600s | error |
| GateKeeper | `74009544-…-f432b` | general — pre-transaction security validator | CEO | 3600s | error |
| TrustScore | `b47ac8bf-…-ab756` | general — agent reputation evaluator | CEO | 3600s | error |
| WatchDog | `d10b2494-…-db3cfa` | general — wallet risk assessor | CEO | 3600s | error |

### SELARIX Operations (5 agents — flat, all report to CEO)

| Agent | ID | Role/Title | Reports to | Heartbeat | Status (final) |
|---|---|---|---|---|---|
| **CEO** | `cb09ca53-…-f047e` | ceo — "Swarm Monitor & Infrastructure Intelligence" | — | 86400s | error |
| OpsBot | `73c8c13d-…-dfff3abe` | devops / COO — task queue + swarm health via `~/qsl-swarm/CABINET/opsbot/src/opsbot.py` | CEO | (runtime_config empty) | error |
| SalesBot | `2731be18-…-4b7d8476` | cfo-title CRO — consulting pipeline via `CABINET/salesbot/src/salesbot.py` | CEO | (empty) | error |
| TreasuryBot | `e1ca6965-…-84335f` | cfo — wallets, $500/mo Bastion gate via `CABINET/treasurybot/src/treasurybot.py` | CEO | (empty) | error |
| Security Engineer | `0a6e95c3-…-852af` | engineer — `CABINET/security_engineer/scripts/health-check.sh` | CEO | (empty) | error |

### Routines (10, all `active`, coalesce_if_active / skip_missed)

QSL: GateKeeper Daily Heartbeat, TrustScore Daily Heartbeat, WatchDog Daily Heartbeat (SSH→EC2, count job types in seller.log, Telegram to chat 6712910089), Weekly LinkedIn Posts (Content Strategist).
SELARIX: 30-Minute Swarm Check, Daily Swarm Health Check, Hourly Health Check (high), Daily Pipeline Review (SalesBot), Daily Revenue Report (TreasuryBot), Weekly Treasury Report + Action Plan.
**None touch email.**

### Governance evidence (approvals table, 11 rows)

4× `hire_agent` (all approved → the QSL hires above), 6× `request_board_approval` for EC2 port-8091/TAO-funding (5 approved, 1 test rejected, 1 duplicate auto-cancelled with "duplicate detection" note). Human approval gates were live and used for hiring and infrastructure changes.

---

## 5. Agent-by-Agent Asset Inventory

Storage locations per agent (all paths under `C:\Users\mikeb\.paperclip\instances\default\`):

| Agent | Instructions on disk (portable Markdown) | DB-only state | Workspace | Notes |
|---|---|---|---|---|
| QSL CEO | `companies\839bfea4…\agents\3c03fead…\instructions\{AGENTS.md, HEARTBEAT.md, SOUL.md, TOOLS.md}` | adapter/runtime config, runtime state, cost events, runtime errors | `workspaces\3c03fead…` (contains `life/`, `memory/` — PARA memory) | AGENTS.md mandates reading **`QSL_CONFIG.md` (missing)** and references `QSL_Blueprint_v3.1_….docx` (missing); April-14 "failure reporting protocol" amendment |
| SELARIX CEO | same 4-file bundle under `11dc08e7…\cb09ca53…` | same classes | `workspaces\cb09ca53…` | Daily SSH→Telegram routine definition; roster rule "CEO only for now" |
| OpsBot | `AGENTS.md` | config, runs, sessions | `workspaces\73c8c13d…` | Drives EC2 `opsbot.py`; seeded 61-task queue warning |
| SalesBot | `AGENTS.md` | … | `workspaces\2731be18…` | Drives EC2 `salesbot.py`; MedStar Health proposal issue evidence |
| TreasuryBot | `AGENTS.md` | … | `workspaces\e1ca6965…` | Drives EC2 `treasurybot.py` |
| SEL Security Engineer | `AGENTS.md` | … | `workspaces\0a6e95c3…` | health-check.sh |
| QSL Sec Engineer (monitor) | `AGENTS.md` + **agent-level `.env`** | … | `workspaces\035e05af…` | Only agent with a private `.env` — must not be ported with contents |
| QSL Sec Engineer (scanner) | `AGENTS.md` | … | `workspaces\1d62eeb0…` | Terminated; cwd `crawdaddy-automation`; do not revive |
| Content Strategist | `AGENTS.md` | … | `workspaces\b5495be0…` | Moltbook posting via @blocdev_bot |
| QA Engineer | `AGENTS.md` | … | `workspaces\e60f4c00…` | cwd `crawdaddy-automation` |
| GateKeeper / TrustScore / WatchDog | `AGENTS.md` each | … | `workspaces\{74009544,b47ac8bf,d10b2494}…` | Tier-2 Conway cluster, "funded into existence by CrawDaddy revenue" |

Also per-company: `claude-prompt-cache\<hash>\agent-instructions.md` snapshots (rendered prompts — regenerable, archive-only), and `data\storage\839bfea4…\assets\companies\` uploads.

**Portable (files):** all instruction bundles, workspaces' `life/`+`memory/`, board_exports.
**DB-only:** agent rows/configs, runtime state, cost events, heartbeat runs, issues/comments/documents/approvals/activity log, company secrets (EC2_HOST/SSH_KEY ×2), routine definitions + triggers.

---

## 6. Email Integration Inventory

### 6.1 Providers and mailboxes (from INFRASTRUCTURE_REGISTRY E11 + audit E12 + master reference E13)

| Mailbox | Provider | Config | State |
|---|---|---|---|
| info@, michael@, privacy@, legal@, support@, hello@ **@thebinmap.com** | Hostinger Free Business Email (expires **2027-04-17**) | All forward → mikebennett637@gmail.com, "save copies" ON | <1% storage used; verified 2026-04-25 |
| **michael@quantumshieldlabs.dev** | Hostinger (on VPS domain) | Human operator mailbox; Brevo sender identity | 684 msgs audited 2026-07-14 (675 inbox / 9 junk; 607+9 unread) |
| **selarix@quantumshieldlabs.dev** | Hostinger | exists (sent item 2026-04-12) | minimal |
| **crawdaddy@quantumshieldlabs.dev** | Hostinger | per-agent identity per blueprint | referenced, unverified |
| **info@therapistindex.com** | Hostinger WordPress + WP Mail SMTP | Sends site mail (weekly SMTP summaries, registration notices) | live, sending |

### 6.2 APIs, connectors, credentials

| Integration | Detail | Where credentials live |
|---|---|---|
| **Brevo** (campaigns + SMTP) | Free tier 300 emails/day; 441 contacts in CRM; DKIM/DMARC configured; 2 campaigns sent 2026-03-24 (~870 sends; 3 claims, 3 unsubscribes, 0.7%) | "Hostinger email dashboard" per E13; **no Brevo key in Paperclip company_secrets** (E7: only EC2_HOST/SSH_KEY) |
| **Web3Forms** | TheBinMap forms → direct to gmail (bypasses Hostinger mailboxes); access key hardcoded in 3 Astro sources (`contact/submit/claim.astro`); free 250 submissions/mo | key `d05298bf-…` is public-in-source by design (origin-locked); noted in E14 |
| **Telegram** (not email, but the actual alerting channel) | @blocdev_bot, @BastionQSL_bot, @SelarixBoard_bot → chat 6712910089 | `~/.selarix.env` on EC2/VPS; rotated 4/24 after chat-leak |
| Hostinger account | recovery codes at `C:\Users\mikeb\hostinger-recovery-codes.txt` and `qsl\hostinger-recovery-codes.txt`; `qsl\hostinger_sshkey.txt` | **sensitive — archive only, never port into repo** |

### 6.3 Local scripts expected

`~/qsl-swarm/CABINET/{opsbot,salesbot,treasurybot,security_engineer}/…` on **EC2** (not present locally — local `C:\Users\mikeb\qsl-swarm` has 1 item only; local `C:\Users\mikeb\Hostinger` has 2 items). **No `outreachbot` implementation was found anywhere locally** — consistent with "PARTIAL — wire Brevo sequences" never being completed.

### 6.4 What was functional vs. broken/incomplete

**Functional (manually operated):** Hostinger mailboxes + forwarders; Web3Forms form intake; WP Mail SMTP sending; 2 Brevo campaigns (March); TheBinMap Gumroad sale (July 14 receipt).
**Incomplete/broken:** OutreachBot never instantiated; Brevo automation never wired (known gotcha: "automation doesn't fire for existing contacts — re-import after activation"); TheBinMap subscriber storage nonexistent (P1); paid-brief delivery pipeline nonexistent (P0); no auto-responder/double opt-in (P2); June audit: `send_email` capability "Missing — no email service integration" (E17); TherapistIndex outreach paused pending "traffic-first" strategy (E11).

---

## 7. QSL and QuantumShield Core Dependency Map

```
┌────────────────────────────────────────────────────────────────────┐
│ PAPERCLIP (control plane — owns companies/agents/issues/approvals) │
│  • 2 companies, 13 agents (claude_local)                           │
│  • server/src/routes/qsl-bridge.ts  ──reads──► QSL_BRIDGE_PATH     │
│  • server/src/services/qsl-review.ts (qsl_findings review states)  │
│  • server/src/services/board-export.ts (+ routes, CLI script)      │
│  • .env.legacy: QSL_BRIDGE_PATH=C:/Users/mikeb/quantumshield-core/ │
│                 bridge/output                                      │
└──────────────▲─────────────────────────────────────────────────────┘
               │ file-watch bridge (manifest/state/issues/approvals/
               │ confidence-snapshots JSON)
┌──────────────┴─────────────────────────────────────────────────────┐
│ QUANTUMSHIELD CORE (execution controls — Hermes runtime)           │
│  • hermes.py (event ingestion), qsl.py (orchestrator)              │
│  • approval_gate.py — HARD human gate ("No gate, no action")       │
│  • safety/permissions.yaml — 3 tiers; 6 blocked actions            │
│    (delete_files, modify_firewall, run_exploit,                    │
│     execute_shell_command, access_secrets, push_to_main)           │
│  • bridge/emitter.py → bridge/output/*.json (last emit 6/25)       │
│  • events.jsonl / approvals.jsonl (append-only)                    │
│  • paperclip_bridge.py — risk→priority mapping, issue-worthiness   │
└────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────┐
│ QSL / qsl-selarix / selarix-lattice (doctrine & knowledge)         │
│  • qsl: Chronicle, timeline-ui, mock-connector, governance docs    │
│  • qsl-selarix: constitutional layer; Inquiry findings (6/18)      │
│  • selarix-lattice: INFRASTRUCTURE_REGISTRY (mailboxes, VPS, EC2)  │
│  • qsl-reference-archive: Cabinet blueprint (OutreachBot design)   │
└────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────┐
│ GRAPHIFY — comprehension/navigation only. NOT in live runtime.     │
│ Local artifacts: tool repo, empty graphify-out, ingestion spec.    │
└────────────────────────────────────────────────────────────────────┘
External estate: EC2 3.20.79.143 (CrawDaddy seller, qsl-swarm CABINET,
  SESSION_HANDOFF.md), Hostinger VPS 69.62.69.140 (quantumshieldlabs.dev,
  **a second Paperclip via PM2 as user `selarix`** — see §9),
  Brevo, Web3Forms, Telegram bots, Virtuals ACP, Base L2 wallets.
```

**Hard dependencies to preserve:** QSL_BRIDGE_PATH contract (file-watch JSON), `qsl_findings` schema, Three Laws + GOTCHA doctrine in company descriptions, approval-gate semantics (Paperclip approvals ↔ QSC approval_gate).

---

## 8. Legacy vs. Upstream Capability Comparison

| Capability | Legacy local fork (archived) | Current upstream (`upstream/master`, verified 2026-07-16) | Port implication |
|---|---|---|---|
| Core runtime | Broken (embedded PG init fails; DB 30+ migrations stale) | Boots clean; 172 migrations auto-apply; PGlite/embedded PG OK | Use upstream as-is |
| Companies/agents/goals/projects/issues | Present (2 companies, 13 agents) | Same model, evolved (environments, workspaces, issue inbox) | Recreate entities on upstream |
| Routines + triggers | 10 routines, cron-ish | Routines + `routine_triggers` (cron/webhook, signing, replay window) | Recreate; upstream is superset |
| Approvals | Working (hire + board approvals, dup detection) | Approval system evolved (idempotency fixes upstream) | Use upstream; port history as archive |
| **Email (SMTP/IMAP/inbound)** | **None** (verified zero refs in server/src) | **None** | **Nothing to port; any email feature is NEW work requiring human approval (§11)** |
| QSL bridge (`qsl-bridge.ts`) + `qsl_findings` + review UI | Custom, working against QSC bridge/output | Absent | Port per existing integration plan (Phases 2–4) |
| Board intelligence export (`board-export` service/routes/CLI) | Custom, produced board_exports/ | Absent | Port per existing plan |
| Python guardian scripts (`scripts/*.py`) | Custom | Absent | Port as-is (low coupling) per plan |
| Secrets | `company_secrets` local_encrypted (EC2_HOST/SSH_KEY only) | Secrets vault + provider vault branches; dynamic secrets runtime | Re-create secrets on upstream; do not move material in bulk |
| Adapters | `claude_local` only; `--dangerously-skip-permissions` | External adapter plugins (PR #2218), hermes externalized, sandboxing improved | Keep claude_local; **drop skip-permissions** on port |
| Skills | 5 paperclipai skills per company | Skills catalog + store evolved | Re-attach from catalog |
| Documents | QSL PAPERCLIP CONTEXT (2 revs) + continuation summaries | Documents w/ revisions, locking, diff | Port doctrine doc (adapted); drop continuation summaries |
| Memory | PARA files in workspaces | Memory service surface API | Keep PARA files as agent-home convention |
| Budgets | 0-config; budget_policies table present | Upgraded costs/budgeting | Recreate policies if desired |
| Company import/export | Export exists (board export); upstream PAP-9380 fixed company-export | Present upstream | Prefer upstream export for future backups |

**Duplicates/obsolete/conflicting:** legacy fork's heartbeat/recovery/provider-routing work is superseded by 798 upstream commits (per divergence report) — do **not** port fork runtime code. The two "Security Engineer" agents in QSL (monitor vs terminated scanner) are a deliberate dedup outcome, not a conflict. `qsl-swarm` local dir and `Hostinger` local dir are near-empty shells — obsolete copies of EC2/VPS material.

---

## 9. Missing or Inaccessible Evidence

| # | Evidence | Impact | Disposition |
|---|---|---|---|
| M1 | **`QSL_CONFIG.md` / `SELARIX_CONFIG.md`** — mandated first-read for every agent; absent from repo | Agents' infra context (IPs/keys/wallets) unrecoverable from repo; must be reconstructed from E11 | Requires human review (Mike may hold copies) |
| M2 | `QSL_Blueprint_v3.1_Claude_Code_Integration.docx` | Full blueprint text unavailable | Archive search / human review |
| M3 | **Hostinger VPS Paperclip** (`69.62.69.140`, `paperclip.quantumshieldlabs.dev`, PM2 user `selarix`, `/opt/start-paperclip.sh`) — never inspected | **Could contain additional companies/state (possibly the missing "email company")** | **Requires human review — SSH read-only survey before any port is declared complete** |
| M4 | EC2 `~/qsl-swarm/CABINET/` actual source (incl. any outreachbot code) | Cannot confirm OutreachBot implementation status on EC2 | Human review via SSH |
| M5 | Brevo account current state (lists, templates, automations, logs) | Unknown whether drafts/sequences exist | Human review via console |
| M6 | 174 MB `server.log` | Runtime forensics (skipped per instruction; narrow greps available) | Available on demand |
| M7 | 12 agent workspaces' uncommitted state | Possible unrecovered agent work | Inventory before any deletion (do not delete) |
| M8 | `.paperclip.zip` / `paperclip.zip` full contents beyond listings | Unlikely to hold new company data (same 2 IDs seen) | Preserve as-is |
| M9 | `CrawDaddy-Credentials-Reference.docx` (gitignored, local) | Credential inventory | Human-only |
| M10 | Agent `.env` for 035e05af (QSL monitor) | Unknown secret material | Human review; never port contents |
| M11 | Graphify mapping output | Only ingestion spec survives | Regenerate if needed |

---

## 10. Preservation Classification Table

| Asset | Classification | Rationale / notes |
|---|---|---|
| Agent instruction bundles (13× AGENTS.md; CEOs' SOUL/HEARTBEAT/TOOLS) | **Port with adaptation** | Update dead refs (QSL_CONFIG/SELARIX_CONFIG/Blueprint docx), fix EC2 IP (3.20.79.143, never 172.31.1.13), strip `--dangerously-skip-permissions`, re-scope cwd paths |
| Company identities, Three Laws, GOTCHA, descriptions | **Port unchanged** | Core QSL IP; recreate verbatim on upstream |
| QSL PAPERCLIP CONTEXT document (Cabinet doctrine) | **Port with adaptation** | Refresh stale infra facts; keep Cabinet design incl. OutreachBot as *documented design* |
| 13 agent definitions (roles, reports_to, heartbeats, budgets=0) | **Port with adaptation** | Recreate via upstream API/UI; keep hierarchy; do not resurrect terminated scanner |
| 1 goal, 3 projects | **Port unchanged** | Trivial recreation |
| 10 routines | **Port with adaptation** | Recreate on upstream routines/triggers; keep disabled until SSH/secrets re-provisioned; none email-related |
| Company secrets (EC2_HOST, SSH_KEY ×2) | **Requires human review** | Re-enter fresh on upstream secrets provider; verify key validity (clawdbot-clean.pem replaced a compromised key 4/8) |
| `qsl_findings` schema + `qsl-review.ts` + `qsl-bridge.ts` + `QslReview.tsx` + `ui/src/api/qsl.ts` | **Port with adaptation** | Per existing integration plan Phases 2–4; renumber migrations via `pnpm db:generate` |
| `board-export.ts` (+routes, CLI) | **Port unchanged** (minor API-compat checks) | Proven exporter of this very audit's evidence |
| `scripts/*.py` guardians, `templates/QSL_PAPERCLIP_CONTEXT.md`, `docs/constitution/*` | **Port unchanged** | Already in plan Phase 5 |
| QSC bridge file-watch contract (`bridge/output/*.json`) | **Port with adaptation** | Keep QSL_BRIDGE_PATH contract; bridge emitter stays in quantumshield-core (its repo, not Paperclip's) |
| quantumshield-core runtime (hermes, approval_gate, safety/) | **Archive only** (own repo, active development 6/25) | Not a Paperclip asset; integration via bridge only |
| QSC `bridge/output/*` current JSON state | **Archive only** | Point-in-time runtime state |
| Hostinger mailbox configs, forwarders, DNS | **Archive only** | External SaaS config; documented in E11/E14 |
| Brevo account/campaigns/templates | **Requires human review** | Any re-activation = outbound email → explicit human approval gate |
| OutreachBot design (blueprint rows) | **Archive only** | Preserve as doctrine; do not build without human decision (§11) |
| Web3Forms flows + TheBinMap intake docs | **Archive only** | Outside Paperclip; track in thebinmap repo (E14 queue) |
| SQL backups, server.log, prompt caches, workspaces, zips | **Archive only** | Forensic preservation; never migrate |
| Legacy fork runtime code (heartbeat/recovery/provider-routing patches) | **Archive only** | Superseded by upstream |
| Continuation Summary documents (hundreds, per-issue) | **Archive only** | Runtime residue |
| `hostinger-recovery-codes.txt`, `hostinger_sshkey.txt`, `.env.legacy`, agent `.env`, `secrets/master.key` | **Requires human review** | Secret material; human decides rotation/storage; never commit |

---

## 11. Security and Approval Requirements

1. **No outbound email without explicit human approval (hard invariant).** No Paperclip agent, routine, or plugin may send email. If an email capability is ever approved: inbound-read first, outbound as *draft-only with per-send approval*, enforced via upstream approvals + QSC approval_gate pattern. This matches both the project constraint and QSC doctrine ("No gate, no action"; `send_external_alert` is approval_required tier in QSC).
2. **Drop `--dangerously-skip-permissions`** from every ported agent config (present on all 13 legacy agents).
3. **Secrets handling:** Brevo/Telegram/SSH/Hostinger materials never enter the repo or agent instruction markdown (legacy instructions embed key paths and chat IDs — sanitize on port). Use upstream company secrets (local_encrypted). Rotate before reuse where compromise history exists (Layemor incident 4/3; clawdbot-key.pem replaced 4/8; Telegram token rotated 4/24).
4. **Preserve approval gates:** `require_board_approval_for_new_agents=true` on both companies; hire_agent and infrastructure approvals remain human-decided (legacy evidence shows the gates worked, including duplicate detection).
5. **Company scoping:** agent API keys company-bound; QSL bridge endpoints must keep company-boundary enforcement on upstream auth model.
6. **Three Laws + GOTCHA travel with the companies** as immutable doctrine in company descriptions and agent context.
7. **Legacy data is read-only:** no migration of the stale DB; backups/instance preserved; the June dump extraction used for this audit lives only in temp and may be deleted after review.
8. **Activity logging** for every mutating action during the port (per AGENTS.md invariants).
9. **Outbound channels inventory before go-live:** Telegram bots remain the only sanctioned agent alerting channel; email sending stays disabled by default.

---

## 12. Recommended Port Sequence (smallest safe path)

**Phase 0 — Human decisions (gate everything below):** (a) approve this audit; (b) approve executing the existing `PAPERCLIP_UPSTREAM_INTEGRATION_PLAN_2026-07-16.md`; (c) decide explicitly whether any email capability may exist (default: NO).

**Phase 1 — Foundation (existing plan, unchanged):** create `feat/qsl-upstream-integration` from `upstream/master`; `pnpm install`; build UI (`node node_modules/vite/bin/vite.js build` per NTFS note); `pnpm dev`; verify `/api/health`. (Pre-port baseline shows this already verified in a disposable worktree.)

**Phase 2–5 — Existing plan execution:** port `qsl_findings` schema+migration, qsl-review/qsl-bridge/board-export services+routes, QslReview UI, scripts/templates/constitution docs. Validate per plan Phase 7.

**Phase 6 — Company resurrection (new, additive):** on the running upstream instance, recreate **QSL Security Ops** and **SELARIX Operations** (descriptions with Three Laws/GOTCHA verbatim, `require_board_approval_for_new_agents=true`); recreate the 12 non-terminated agents with adapted instruction bundles (§10); recreate 1 goal / 3 projects / 10 routines (**routines created disabled**); re-enter EC2 secrets after human verification; attach the 5 company skills; create the QSL PAPERCLIP CONTEXT company document (adapted).

**Phase 7 — Email decision checkpoint (human-only):** review §6 inventory; if any email function is wanted, specify it as a *new, governed* Paperclip feature proposal (plugin or routine with approval gates) — never as a revival of OutreachBot automation. Brevo/Hostinger changes happen in their consoles by the human, not by agents.

**Phase 8 — VPS/EC2 survey (human-approved, read-only):** resolve M3/M4 before declaring the recovery complete; if the VPS Paperclip holds additional companies, extend this audit before any further porting.

---

## 13. Verification Checklist

- [ ] Upstream instance healthy: `GET /api/health` 200; UI loads; fresh PG/embedded DB with all migrations
- [ ] Both companies exist with verbatim doctrine text; board approval flags on
- [ ] 12 agents present, correct hierarchy, `idle` (not `error`), heartbeats configured as ported
- [ ] No agent has `--dangerously-skip-permissions`; no instruction file contains secrets/IPs beyond sanctioned references
- [ ] 10 routines exist and are **disabled** until secrets verified; zero routines reference email
- [ ] **No code path can send email** (grep: no smtp/imap/mail/sendgrid/brevo/resend in server, plugins, agent configs)
- [ ] Approvals: hire-agent and board-approval flows tested end-to-end with human decision
- [ ] QSL findings page renders against QSC bridge output; company-scoped access enforced
- [ ] Board export regenerates cleanly from upstream DB
- [ ] Activity log records all port mutations
- [ ] Legacy instance dir, backups, and zips untouched (hash spot-check); legacy PG remains stopped
- [ ] Secrets present only in upstream secrets provider; `.env.legacy` not reused
- [ ] Human sign-off recorded for Phase 7 email decision

---

## 14. Files That Would Change During the Implementation Phase

(Explicit list for review — **nothing below has been created or modified by this audit.**)

**From the existing integration plan (Phases 2–5):**
- `packages/db/src/schema/qsl_findings.ts` (new on upstream branch) + `packages/db/src/schema/index.ts` (export) + generated migration via `pnpm db:generate`
- `server/src/services/qsl-review.ts`, `server/src/routes/qsl-bridge.ts`, `server/src/services/board-export.ts`, `server/src/routes/board-export.ts`, `server/scripts/generate-board-export.ts` (new on branch)
- `server/src/app.ts` (route wiring)
- `ui/src/pages/QslReview.tsx`, `ui/src/api/qsl.ts` (new), `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/lib/company-routes.ts`, `ui/src/lib/queryKeys.ts` (edits)
- `scripts/*.py` (7 guardian scripts, copied), `templates/QSL_PAPERCLIP_CONTEXT.md` (copied), `docs/constitution/*.md` (copied), `docs/audits/**` (docs-only copies)

**New for the company/email recovery (Phase 6+):**
- `doc/plans/2026-07-17-email-company-port-plan.md` (implementation plan, if approved)
- `templates/companies/qsl-security-ops/` + `templates/companies/selarix-operations/` — sanitized instruction bundles + company profile docs (new directory; exact location TBD in plan)
- `board_exports/` — regenerated exports from upstream (refresh, not edit of legacy files)
- `.env` / instance config on the new runtime only (fresh; never `.env.legacy`)
- Optional, only if Phase 7 approves email: a new plugin package `packages/plugins/*email*` (design doc first) — **not scoped by this audit**

**Explicitly NOT to be changed:** anything under `.paperclip\instances\default*`, legacy backups/zips, `.env.legacy`, legacy `master` and `docs/paperclip-operational-audit-2026` branches, quantumshield-core/qsl/qsl-selarix/selarix-lattice repos (doctrine changes are separate human processes).

---

## Closing Record

- **Files inspected:** ~45 documents/listings + 3 SQL snapshots (E1–E23 above)
- **Commands run:** read-only PowerShell (`Get-ChildItem`, `Get-Content`, `Test-Path`, `Select-String`, stream-based `StreamReader` scans of the 1.1 GB dump, `tar -tf`/single-file `tar -xf` zip listing+extraction, .NET GzipStream decompress-to-temp); no mutations of repo, DB, processes, or archives
- **Files created:** this report; temp working copies `…\Temp\opencode\email-audit\paperclip-20260327-131548.sql`, `…\paperclip-20260409-083336.sql`, `…\paperclip-20260622.sql` (read-only extractions; safe to delete)
- **Uncertainties:** M1–M11 (§9), above all the **un-surveyed VPS Paperclip (M3)** and EC2 CABINET source (M4)
- **Single recommended next implementation step:** **Human approval to execute Phase 1 of the existing `PAPERCLIP_UPSTREAM_INTEGRATION_PLAN_2026-07-16.md`** — create `feat/qsl-upstream-integration` from `upstream/master` and verify clean boot — with the explicit side-decision recorded that *no email capability is restored* at this stage
- **git status:** clean except pre-existing untracked handoff/audit docs (unchanged by this audit; this report adds one new untracked file: `doc/plans/EMAIL_COMPANY_RECOVERY_AND_PORT_AUDIT.md`)

*Audit complete. Stopping here for review — no port implemented.*
