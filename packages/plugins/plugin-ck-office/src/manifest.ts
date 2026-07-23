import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

// CK Evaluation Office — the proper way to put CK's plan on Paperclip (ADR-015: extend, don't fork).
// v0.2 adds the CK Evaluation UI page on top of the operating cadence (Daily Huddle).
export const PLUGIN_ID = "ck.evaluation-office";
export const JOB_DAILY_HUDDLE = "ck.daily-huddle";
export const JOB_WEEKLY_TACTICAL = "ck.weekly-tactical";
export const JOB_FOUNDER_BRIEF = "ck.founder-brief";
export const JOB_GOV_REGRESSION = "ck.gov-regression";
export const JOB_GOV_META_EVAL = "ck.gov-meta-eval";
export const JOB_LOOP_INGEST = "ck.loop-ingest";
export const JOB_LOOP_QUALIFY = "ck.loop-qualify";
export const JOB_LOOP_QUALIFY_EVAL = "ck.loop-qualify-eval";
export const JOB_LOOP_DRAFT = "ck.loop-draft";
export const JOB_ESPO_SMOKE = "ck.espo-smoke";
export const JOB_B2B_REPLY_ESCALATE = "ck.b2b-reply-escalate";
export const JOB_B2B_MAIL_SYNC = "ck.b2b-mail-sync";
export const JOB_CRM_ADDRESS_SELFHEAL = "ck.crm-address-selfheal";
export const JOB_STALL_WATCHDOG = "ck.stall-watchdog";
export const DATA_EVAL_OVERVIEW = "ck-eval-overview";
export const DATA_MEETING_ROOM = "ck-meeting-room";
export const DATA_ORG = "ck-org";
export const PAGE_EVAL = "ck-evaluation-page";
export const PAGE_EVAL_EXPORT = "CkEvaluationPage";
export const PAGE_EVAL_ROUTE = "ck-evaluation";
export const PAGE_MEETING = "ck-meeting-room-page";
export const PAGE_MEETING_EXPORT = "MeetingRoomPage";
export const PAGE_MEETING_ROUTE = "ck-meeting-room";
export const PAGE_ORG = "ck-org-page";
export const PAGE_ORG_EXPORT = "CkOrgPage";
export const PAGE_ORG_ROUTE = "ck-org";
// Embedded external apps (iframe pages) — a unified cockpit so Alan doesn't switch web apps.
export const PAGE_CRM = "ck-crm-page";
export const PAGE_CRM_EXPORT = "CkCrmPage";
export const PAGE_CRM_ROUTE = "ck-crm";
export const PAGE_DIVINO = "ck-divino-page";
export const PAGE_DIVINO_EXPORT = "CkDivinoPage";
export const PAGE_DIVINO_ROUTE = "ck-divino";
// CK Memory — see + curate what the agents have learned (ck_eval.memory_record).
export const DATA_MEMORY = "ck-memory";
export const ACTION_MEMORY_CURATE = "ck-memory-curate";
// Divino Marketplace Cockpit — live data pulled from the host-side divino-ops bridge (:8899).
export const DATA_DIVINO_STATUS = "ck-divino-status";
export const DATA_DIVINO_LISTINGS = "ck-divino-listings";
export const DATA_DIVINO_JOBS = "ck-divino-jobs";
export const ACTION_DIVINO_RUN = "ck-divino-run"; // trigger a machine tool (health-check/refresh/post-next)
export const ACTION_DIVINO_ASK = "ck-divino-ask"; // chat with the warm Divino agent via its gateway api_server
export const DATA_DIVINO_ACCESS = "ck-divino-access"; // persona/browser/exit-node/blocked-platform health
export const DATA_DIVINO_MONEY = "ck-divino-money"; // webshop revenue tied to the marketplace effort
export const DATA_DIVINO_MAIL = "ck-divino-mail"; // info@divinocigars.ch inbox (IMAP via divino-ops)
export const DATA_DIVINO_MAIL_MSG = "ck-divino-mail-msg"; // one message body
export const DATA_DIVINO_MAIL_FOLDERS = "ck-divino-mail-folders"; // mailbox folders (Inbox/Sent/…)
export const ACTION_DIVINO_MAIL_SEND = "ck-divino-mail-send"; // send/reply as info@divinocigars.ch
export const PAGE_MEMORY = "ck-memory-page";
export const PAGE_MEMORY_EXPORT = "CkMemoryPage";
export const PAGE_MEMORY_ROUTE = "ck-memory";
// Approvals / Outbox — pending outreach emails Alan can EDIT + Approve&Send (panel sends directly) or Cancel.
export const DATA_APPROVALS = "ck-approvals";
export const ACTION_APPROVAL_SEND = "ck-approval-send";
export const ACTION_APPROVAL_CANCEL = "ck-approval-cancel";
export const PAGE_APPROVALS = "ck-approvals-page";
export const PAGE_APPROVALS_EXPORT = "CkApprovalsPage";
export const PAGE_APPROVALS_ROUTE = "ck-approvals";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.43.7",
  displayName: "CK Evaluation Office",
  description:
    "Runs CK's operating cadence and governance. Daily Huddle (ADR-018), the Weekly Tactical / Level-10 meeting (SPC-filtered pre-read + IDS with a mandated Red-Team + golden-case write-back), governance regression/meta-eval, the Founder Brief, plus a CK Evaluation UI page.",
  author: "CK IT Solutions",
  categories: ["automation", "ui"],
  capabilities: [
    "companies.read",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "issue.interactions.create",
    "issues.orchestration.read",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "jobs.schedule",
    "activity.log.write",
    "ui.page.register",
    "ui.sidebar.register",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  // The worker reads the `ck_eval` schema via a direct Postgres connection, which
  // requires a connection string. The plugin worker is sandboxed without env
  // secrets (the host strips DATABASE_URL), so the operator supplies it here.
  // Secret-reference runtime keys remain supported by the worker for a future
  // company-scoped host contract, but are intentionally absent from this form:
  // the current host fails their resolution closed and must not advertise a
  // configuration path that cannot succeed.
  instanceConfigSchema: {
    type: "object",
    properties: {
      databaseUrl: {
        type: "string",
        title: "Postgres connection URL",
        description:
          "Connection string for the ck_workforce database used to read the ck_eval schema (the same DATABASE_URL the server uses). Local/tailnet only.",
        default: "",
      },
      telegramChatId: {
        type: "string",
        title: "Telegram chat id (optional)",
        description:
          "If set, the Founder Brief pushes a short notification to this Telegram chat. Leave empty to keep Telegram push OFF (nothing is sent).",
        default: "",
      },
      espoBaseUrl: {
        type: "string",
        title: "EspoCRM API base URL",
        description:
          "Base URL of the Divino/TH EspoCRM REST API (the revenue loop's system-of-record + effector). Local/tailnet only.",
        default: "http://127.0.0.1:8085/api/v1",
      },
      divinoOpsUrl: {
        type: "string",
        title: "Divino ops bridge URL",
        description:
          "Base URL of the host-side divino-ops service that reads the marketplace machine's state and (Phase 2) triggers its tools. Local loopback only.",
        default: "http://127.0.0.1:8899",
      },
      espoApiKey: {
        type: "string",
        title: "EspoCRM API key (fallback)",
        description:
          "Direct EspoCRM X-Api-Key. Used only if espoApiKeyRef is empty (mirrors how databaseUrl is supplied). Local/tailnet only.",
        default: "",
      },
      deepseekApiKey: {
        type: "string",
        title: "DeepSeek API key (fallback)",
        description:
          "Direct DeepSeek API key. Used only if deepseekApiKeyRef is empty. When both are empty the Qualifier uses the free stub. Local/tailnet only.",
        default: "",
      },
      deepseekModel: {
        type: "string",
        title: "DeepSeek model",
        description:
          "Select the DeepSeek lane for judgment runs. deepseek-v4-flash is the cheaper/faster default; deepseek-v4-pro is the higher-capacity option. Legacy aliases deepseek-chat and deepseek-reasoner map to flash pricing.",
        enum: ["deepseek-v4-flash", "deepseek-v4-pro"],
        default: "deepseek-v4-flash",
      },
      liveVenueSend: {
        type: "boolean",
        title: "Deliver accepted venue mail live",
        description:
          "When enabled, an accepted, single-use Paperclip decision may deliver to the CRM-verified venue address. Test/experiment wording remains hard-blocked. When disabled, venue mail is redirected to Alan.",
        default: false,
      },
    },
  },
  tools: [
    {
      name: "espo_log_call",
      displayName: "Espo: log/plan a phone call",
      description: "Record a Held or Planned phone call on Alan's CRM calendar (Swiss time, optional venue link + outcome notes).",
      parametersSchema: { type: "object", properties: { name: { type: "string" }, when: { type: "string" }, minutes: { type: "integer" }, status: { type: "string" }, account_id: { type: "string" }, notes: { type: "string" } }, required: ["name"] },
    },
    {
      name: "espo_create_crm_task",
      displayName: "Espo: create a CRM task for Alan",
      description: "Create a due-dated CRM Task on Alan's list (Swiss time, optional venue link).",
      parametersSchema: { type: "object", properties: { name: { type: "string" }, due: { type: "string" }, account_id: { type: "string" }, notes: { type: "string" } }, required: ["name", "due"] },
    },
    {
      name: "espo_update_account",
      displayName: "Espo: update account contact data (guarded)",
      description: "Fix/backfill a venue's website/phone/address incl. city + canton, with mandatory evidence; never email, never delete.",
      parametersSchema: { type: "object", properties: { account_id: { type: "string" }, website: { type: "string" }, phone: { type: "string" }, street: { type: "string" }, city: { type: "string" }, canton: { type: "string" }, postal_code: { type: "string" }, evidence: { type: "string" } }, required: ["account_id", "evidence"] },
    },
    {
      name: "record_finance_event",
      displayName: "Record a finance event (CHF)",
      description: "Log real evidenced money movements (credit=in, debit=out) on the company scoreboard.",
      parametersSchema: { type: "object", properties: { direction: { type: "string" }, amount_chf: { type: "number" }, biller: { type: "string" }, description: { type: "string" } }, required: ["direction", "amount_chf", "biller", "description"] },
    },
    {
      name: "espo_create_account",
      displayName: "Espo: add Account (prospect or partner, deduped)",
      description: "Create or return CRM Account. kind=prospect (default) for venues; kind=partner for suppliers/trade partners (e.g. Tres Hermanos). Dedupes by UID/domain/name. source required.",
      parametersSchema: { type: "object", properties: { name: { type: "string" }, kind: { type: "string" }, website: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, street: { type: "string" }, postal_code: { type: "string" }, city: { type: "string" }, canton: { type: "string" }, description: { type: "string" }, uid: { type: "string" }, source: { type: "string" } }, required: ["name", "source"] },
    },
    {
      name: "espo_create_contact",
      displayName: "Espo: add Contact on Account (deduped by email)",
      description: "Create or return a Contact under an Account so outbound mail can be CRM-verified (e.g. Philippe Dubois on Tres Hermanos). Requires account_id, email, last_name.",
      parametersSchema: { type: "object", properties: { account_id: { type: "string" }, email: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, title: { type: "string" }, phone: { type: "string" }, source: { type: "string" } }, required: ["account_id", "email", "last_name"] },
    },
    {
      name: "espo_send_email",
      displayName: "Espo: send B2B outreach email (approval-gated)",
      description: "Send B2B outreach via EspoCRM as alan@treshermanos.ch. TEST-LOCKED by default (→ alan@treshermanos.ch); live venue delivery requires CK_ESPO_SEND_LIVE=1. Test/experiment content refused to non-Alan addresses. CRM-verified recipients + approval gate.",
      parametersSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, account_id: { type: "string" }, approval_id: { type: "string" } }, required: ["to", "subject", "body", "account_id", "approval_id"] },
    },
    {
      name: "zefix_search",
      displayName: "Zefix: Swiss commercial register search",
      description: "Search the Swiss commercial register (zefix.ch) by name terms; UID-deduped results with name, seat, legal form, UID, status. Read-only.",
      parametersSchema: { type: "object", properties: { terms: { type: "array", items: { type: "string" } }, max_per_term: { type: "integer" } }, required: ["terms"] },
    },
    {
      name: "queue_email_for_approval",
      displayName: "Queue an outreach email for Alan's approval",
      description: "Hand a finished B2B outreach email to Alan: it appears in Outreach outbox and as a task card where he can edit, Approve & Send, or Hold. Verifies the recipient, rejects a named salutation unless the exact address belongs to that CRM Contact, applies do-not-contact, and runs review_draft. The first queue ends the agent run; repeat calls preserve the same pending decision instead of replacing it.",
      parametersSchema: { type: "object", properties: { issue_id: { type: "string", description: "Optional fallback outside a live task; Paperclip resolves the current task automatically." }, account_id: { type: "string" }, to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, from_name: { type: "string" }, in_reply_to: { type: "string", description: "Espo Email id being answered, for reply threading." } }, required: ["account_id", "to", "subject", "body"] },
    },
    {
      name: "find_and_enrich_prospects",
      displayName: "Find + enrich prospect Accounts (deterministic)",
      description: "The deterministic prospect engine. mode:'enrich' (default) fills missing street/PLZ from the search.ch directory + the account's own website, GATED (found town must equal the known city AND the name must pass an identity gate — a wrong address is impossible); returns {enriched, residual} where residual is the work-list the scripts couldn't verify. mode:'find' sweeps Zefix for tobacco/cigar retailers by `terms` and dedup-creates them (do-not-contact + register-purpose gated). Idempotent, free, never guesses.",
      parametersSchema: { type: "object", properties: { mode: { type: "string", enum: ["enrich", "find"] }, limit: { type: "integer" }, terms: { type: "array", items: { type: "string" } } } },
    },
    {
      name: "schedule_followup",
      displayName: "Schedule follow-up (self-reminder)",
      description: "Set a follow-up timer on a task (defaults to the current one). When it fires, Paperclip wakes the task's assignee. Use whenever a plan says 'check/retry/verify later'.",
      parametersSchema: { type: "object", properties: { days: { type: "number" }, note: { type: "string" }, issue_id: { type: "string" } }, required: ["days", "note"] },
    },
    {
      name: "web_search",
      displayName: "Web search",
      description: "Search the web (DuckDuckGo) and return real result links {title,url}. Use to find a website-less venue's site/socials, then pass a URL to web_fetch. Never invents.",
      parametersSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
    },
    {
      name: "send_email",
      displayName: "Send email (TEST-LOCKED)",
      description: "Send via CK mail relay. TEST MODE (default): delivered to alan@treshermanos.ch. Test/experiment content refused to other addresses. Human-gated via approval_id.",
      parametersSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, from_name: { type: "string" }, approval_id: { type: "string" } }, required: ["to", "subject", "body", "approval_id"] },
    },
    {
      name: "complete_approved_send",
      displayName: "Complete an approved send (Espo)",
      description: "After Alan accepts a request_decision Send card, call with approval_id to send via Espo as alan@treshermanos.ch and mark the approval used. Parses to/subject/body from the card when omitted. NEVER re-create request_decision for the same send.",
      parametersSchema: { type: "object", properties: { approval_id: { type: "string" }, to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, account_id: { type: "string" } }, required: ["approval_id"] },
    },
    {
      name: "review_draft",
      displayName: "Review draft (CK quality gate)",
      description: "Deterministically check an outward draft against CK's hard disclosure/quality rules incl. invented prices, cross-venue mixing, and evidence-backed named salutations. Pass account_id and to for recipient-aware checks. Returns pass/fail + violations.",
      parametersSchema: { type: "object", properties: { text: { type: "string" }, context: { type: "string" }, account_id: { type: "string" }, to: { type: "string" } }, required: ["text"] },
    },
    {
      name: "list_recent_work",
      displayName: "List recent agent work products",
      description: "List recent work products worker agents posted, so an evaluator can grade them. Evaluation-pass runs automatically apply the durable eval-watermark when `since` is omitted. Read-only.",
      parametersSchema: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          since: {
            type: "string",
            description: "ISO timestamp; only return work newer than this. Evaluation passes default to the stored eval-watermark.",
          },
        },
      },
    },
    {
      name: "list_open_tasks",
      displayName: "List recent delegated tasks (to-do review)",
      description: "List recent tasks assigned to worker agents with their status + age, so a meeting can review whether last cycle's to-dos were completed. Read-only.",
      parametersSchema: { type: "object", properties: { limit: { type: "integer" } } },
    },
    {
      name: "request_decision",
      displayName: "Request a decision from the founder (tap-to-decide)",
      description: "Surface a yes/no decision to the human founder as a native tap-to-decide on the current run's issue. For things that must cross a human (sends, money, contracts).",
      parametersSchema: { type: "object", properties: { issue_id: { type: "string", description: "Optional hint; live runs always anchor the card to their current issue." }, prompt: { type: "string" }, details: { type: "string" }, accept_label: { type: "string" }, reject_label: { type: "string" } }, required: ["prompt"] },
    },
    {
      name: "espo_pipeline",
      displayName: "Espo: pipeline scoreboard",
      description: "Read the CRM sales pipeline scoreboard: totals, counts by status, email coverage. The manager's weekly numbers. Read-only.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: "espo_rank_prospects",
      displayName: "Espo: rank next uncontacted prospects",
      description: "Scan the complete CRM Account universe and deterministically rank reachable open prospects after suppression. Read-only by default; create_task_pairs=true creates only internal REV-04 research + blocked REV-06 draft tasks and never sends.",
      parametersSchema: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          origin: { type: "string" },
          local_slots: { type: "integer" },
          exceptional_slots: { type: "integer" },
          create_task_pairs: { type: "boolean" },
          include_suppressed_examples: { type: "boolean" },
        },
      },
    },
    {
      name: "create_task",
      displayName: "Create & assign task",
      description: "Create a Paperclip issue assigned to another agent, linked under the current workflow issue by default. Assignee is woken automatically. When a task depends on research or another deliverable, pass that issue id in blockedByIssueIds instead of merely writing 'wait' in prose.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          assigneeAgentId: { type: "string" },
          goalId: { type: "string" },
          parentIssueId: { type: "string" },
          blockedByIssueIds: { type: "array", items: { type: "string" } },
          priority: { type: "string" },
          dedupeKey: { type: "string" },
        },
        required: ["title", "assigneeAgentId"],
      },
    },
    {
      name: "web_fetch",
      displayName: "Web fetch (stealth)",
      description: "Fetch a venue's website (homepage + Kontakt/Impressum) and return REAL emails found. Falls back to a stealth browser on a Swiss residential IP (renders JS, decodes Cloudflare). Never invents.",
      parametersSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    {
      name: "browser_act",
      displayName: "Browser (drive a real page — stealth)",
      description: "Do anything a person can do in a web browser (stealth Firefox, Swiss residential IP). One action/call; tabs persist by tabId. Actions: open, navigate, snapshot (see the page), click, type, press, scroll, evaluate (run JS), links, screenshot, allow_dialogs, close. Respects do-not-contact + human-approval like send_email.",
      parametersSchema: {
        type: "object",
        properties: {
          action: { type: "string" },
          tabId: { type: "string" },
          url: { type: "string" },
          ref: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
          pressEnter: { type: "boolean" },
          key: { type: "string" },
          direction: { type: "string" },
          expression: { type: "string" },
          screenshot: { type: "boolean" },
          offset: { type: "integer" },
          sessionKey: { type: "string" },
          waitMs: { type: "integer" },
        },
        required: ["action"],
      },
    },
    {
      name: "espo_list_emailless",
      displayName: "Espo: list emailless venues",
      description: "List EspoCRM venue accounts missing an email but having a website (the enrichment work-list).",
      parametersSchema: { type: "object", properties: { limit: { type: "integer" } } },
    },
    {
      name: "espo_list_incomplete_location",
      displayName: "Espo: list venues missing city/canton",
      description: "List EspoCRM venue accounts missing a city and/or canton (the address-enrichment work-list). Fill with espo_update_account {city, canton, evidence}.",
      parametersSchema: { type: "object", properties: { limit: { type: "integer" } } },
    },
    {
      name: "crm_backfill_city",
      displayName: "CRM: backfill empty City from Street (deterministic)",
      description: "DETERMINISTIC bulk fixer for EspoCRM Accounts whose City is empty because an import put the town in the Street field. Moves town Street→City across ALL accounts in one call — no LLM, no per-record guessing, never overwrites a non-empty City. Prefer THIS over hand-filling city rows one by one or delegating raw data-entry to a bulk agent. Pass dry_run:true to preview. Returns {emptyCity, filled, changes}.",
      parametersSchema: { type: "object", properties: { dry_run: { type: "boolean", description: "preview without writing" } } },
    },
    {
      name: "espo_set_email",
      displayName: "Espo: write venue email",
      description: "Write a found email to an EspoCRM account. Refuses any email NOT found on that account's own site this run.",
      parametersSchema: { type: "object", properties: { account_id: { type: "string" }, email: { type: "string" } }, required: ["account_id", "email"] },
    },
    {
      name: "recall",
      displayName: "Recall memory",
      description: "Recall durable facts the company/you have learned from past tasks (verified + unverified). Read-only. Use at task start so you don't re-derive known facts.",
      parametersSchema: { type: "object", properties: { query: { type: "string" }, scope: { type: "string" }, limit: { type: "integer" } } },
    },
    {
      name: "remember",
      displayName: "Remember a fact or checkpoint",
      description: "Save one durable fact or one reusable checkpoint. A fact must be independently verifiable and reusable beyond the current task; transient progress belongs in the task work product. A checkpoint is changing resumable state and must overwrite one stable key. Never create date/run/task-specific keys.",
      parametersSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Required stable id reused across runs; no dates, task ids, issue ids, or run ids." },
          value: { type: "string" },
          confidence: { type: "number", description: "0..1" },
          scope: { type: "string", enum: ["company", "self"] },
          mode: { type: "string", enum: ["fact", "checkpoint"], description: "fact corroborates/contests; checkpoint overwrites its stable key and is trusted as self-owned state" },
          ttl_days: { type: "integer" },
        },
        required: ["key", "value"],
      },
    },
    {
      name: "espo_get_account",
      displayName: "Espo: get venue account (full detail)",
      description: "Read the full EspoCRM record for one venue Account: contact person, category, channel, priority, source, industry, type, description, status. Look this up before drafting/researching a venue. Read-only.",
      parametersSchema: { type: "object", properties: { account_id: { type: "string" }, name: { type: "string" } } },
    },
    {
      name: "plan_visit_route",
      displayName: "Plan in-person visit route",
      description: "Plan an optimized in-person driving route to visit prospect venues from an origin town (default Oberbuchsiten). Geocodes CRM addresses (OpenStreetMap) + optimizes order (OSRM). Returns ordered stops, total km/hours, and a Google Maps navigation link. Filter with cantons ('SO,BE'), maxStops, radiusKm for a realistic day-trip.",
      parametersSchema: { type: "object", properties: { origin: { type: "string" }, cantons: { type: "string" }, maxStops: { type: "number" }, radiusKm: { type: "number" }, roundTrip: { type: "boolean" } } },
    },
    {
      name: "espo_add_note",
      displayName: "Espo: log a note on a venue",
      description: "Write a short activity note onto a venue Account's timeline in EspoCRM (research findings, draft summary). Visible natively in the CRM UI. Additive-only.",
      parametersSchema: { type: "object", properties: { account_id: { type: "string" }, note: { type: "string" } }, required: ["account_id", "note"] },
    },
    {
      name: "espo_list_opportunities",
      displayName: "Espo: list opportunities",
      description: "List EspoCRM Opportunity records (stage, amount, probability, closeDate, linked account). Read-only.",
      parametersSchema: { type: "object", properties: { limit: { type: "integer" } } },
    },
    {
      name: "espo_upsert_opportunity",
      displayName: "Espo: create/update an opportunity",
      description: "Create or update the real Opportunity for a venue deal (stage/amount/probability/closeDate) instead of only the Account status enum.",
      parametersSchema: { type: "object", properties: { opportunity_id: { type: "string" }, account_id: { type: "string" }, name: { type: "string" }, stage: { type: "string" }, amount_chf: { type: "number" }, close_date: { type: "string" }, commercial_evidence: { type: "string", description: "Required for amount or close date; cite the quote, order, or confirmed timetable." } } },
    },
    {
      name: "espo_forecast",
      displayName: "Espo: stage-weighted CHF forecast (deterministic)",
      description: "Compute the stage-weighted pipeline forecast in CHF from real Opportunity records — a pure formula, never LLM-estimated. Read-only.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: "espo_read_emails",
      displayName: "Espo: read emails",
      description: "Search/list emails synced into EspoCRM (sender/subject filter). Read the actual mail you must answer. Read-only.",
      parametersSchema: { type: "object", properties: { search: { type: "string" }, limit: { type: "integer" } } },
    },
    {
      name: "espo_create_meeting",
      displayName: "Espo: create meeting (Alan's calendar)",
      description: "Create a PLANNED meeting only after the venue confirms the exact date in a real linked CRM email. Requires an exact confirmation_quote naming that date; a request to propose dates is not confirmation. No invitation is sent.",
      parametersSchema: { type: "object", properties: { name: { type: "string" }, date_start: { type: "string" }, date_end: { type: "string" }, account_id: { type: "string" }, evidence_email_id: { type: "string" }, confirmation_quote: { type: "string" }, description: { type: "string" } }, required: ["name", "date_start", "account_id", "evidence_email_id", "confirmation_quote"] },
    },
  ],
  jobs: [
    {
      jobKey: JOB_DAILY_HUDDLE,
      displayName: "CK Daily Huddle",
      description: "Deterministic context-sync: compose the daily huddle digest from live workforce state and post it to the board.",
      schedule: "0 9 * * *",
    },
    {
      jobKey: JOB_STALL_WATCHDOG,
      displayName: "CK Stall Watchdog",
      description: "Every 15 min, find any task stuck in_progress with no output for >25 min. First stall → flag it + re-queue (status→todo). Repeat stall → mark blocked + escalate a heads-up task to GOV-25. Deterministic — catches a lost agent in minutes so none silently spins.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: JOB_CRM_ADDRESS_SELFHEAL,
      displayName: "CK CRM Address Self-Heal",
      description:
        "Daily deterministic CRM data-quality pass: fill any EspoCRM Account whose City is empty because a bulk venue import put the town in the Street field (moves town Street→City, cleans notes/canton suffixes; splits real 'Street 12, Town'). Never overwrites a non-empty City. Zero LLM, zero spend, idempotent — the durable cure for the recurring 'empty City column' that no agent-triggered routine could fix.",
      schedule: "30 7 * * *",
    },
    {
      jobKey: JOB_WEEKLY_TACTICAL,
      displayName: "CK Weekly Tactical (Level-10)",
      description:
        "Assemble the Weekly Tactical deterministic pre-read (segments 1–5: segue + the SPC noise-vs-signal filter over each unit + 'where stuck') and write the meeting_run + Issues List. IDS (the only LLM segment, with a mandated Red-Team and golden-case write-back) is deferred to the budgeted runner so spend stays under the per-meeting budget breaker. Deterministic, zero spend.",
      schedule: "0 10 * * 1",
    },
    {
      jobKey: JOB_FOUNDER_BRIEF,
      displayName: "CK Founder Brief",
      description:
        "The 'meeting with Alan': compose a decision-ready brief (wins, focus, runway, reds, decisions), post it as an issue assigned to the owner, surface tap-to-decide interactions, and write back the owner's resolved decisions on the next run.",
      schedule: "0 8 * * *",
    },
    {
      jobKey: JOB_GOV_REGRESSION,
      displayName: "CK Governance Regression",
      description:
        "Run the governance/eval kernel on schedule: grade every built, certified unit with a golden set (GOV-01, REV-09, REV-10) against ground truth, write graded eval_runs + a scorecard with verdict + cost-adjusted score, route the consequence (keep->none, tune->auto_tune, quarantine->quarantine; retire stays human-gated), and append an audit entry. Deterministic, zero spend.",
      schedule: "*/30 * * * *",
    },
    {
      jobKey: JOB_GOV_META_EVAL,
      displayName: "CK Governance Meta-Eval",
      description:
        "GOV-12 Meta-Evaluator: re-read the latest two scorecards per spec and flag drift (verdict changed or score moved >0.01) -> consequence_event (drift->auto_tune) + audit. Deterministic.",
      schedule: "0 */6 * * *",
    },
    {
      jobKey: JOB_LOOP_INGEST,
      displayName: "REV-L1 Inquiry-Ingestor (shadow)",
      description:
        "REV-LOOP-01 v0 (shadow): poll EspoCRM for genuine inbound mail and normalize each into an idempotent ck_eval.loop_inquiry row (sender, subject, B2B/B2C channel by recipient, language). Deterministic, READ-ONLY against the CRM — no Espo writes, no sends. The first runtime unit of the money loop.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: JOB_B2B_REPLY_ESCALATE,
      displayName: "REV-07 Reply-Escalator (B2B)",
      description:
        "Reads the 'b2b' slice of ck_eval.loop_inquiry (already populated by REV-L1 Ingestor above) that hasn't been routed yet, and creates a Paperclip issue assigned to REV-07 Reply-Classifier per venue reply — the loop's inbound-reply detection. Deterministic, no LLM, no Espo writes; only flips the inquiry's status so it isn't re-escalated. Offset 5 min after the ingest cycle so replies are already normalized when this runs.",
      schedule: "5,20,35,50 * * * *",
    },
    {
      jobKey: JOB_B2B_MAIL_SYNC,
      displayName: "B2B Mail Sync (Espo Sent folder → agent routing)",
      description:
        "Reads alan@treshermanos.ch mail already synced into EspoCRM by the InboundEmail fetcher (INBOX + Sent + Drafts). Detects outbound mail Alan sent outside the CK approval path (phone, Espo compose, mobile) and routes each once to GOV-25 or REV-07 with the mail content so agents can close tasks, update pipeline, or draft follow-ups. Espo CheckInboundEmails runs every 2 min; this job runs shortly after to process new Sent records.",
      schedule: "3,18,33,48 * * * *",
    },
    {
      jobKey: JOB_LOOP_QUALIFY,
      displayName: "REV-L2 Lead-Qualifier (shadow)",
      description:
        "REV-LOOP-01 v0 (shadow): the first JUDGMENT agent. Read each un-qualified ck_eval.loop_inquiry and assign intent + ICP-fit + believability. Uses DeepSeek when a key is configured, else a zero-spend deterministic stub. Budget-capped per run. Writes ONLY to its own internal rows — never touches the curated CRM, never sends. ADVISORY/manual until it earns a scorecard on the golden set (eval-first: no autonomy before grading); the heartbeat is intentionally OFF (rare cron = manual trigger only).",
      schedule: "0 0 29 2 *",
    },
    {
      jobKey: JOB_LOOP_QUALIFY_EVAL,
      displayName: "REV-L2 Lead-Qualifier — Eval (scorecard)",
      description:
        "The scorecard half of REV-L2: run the SAME classification over the FROZEN golden cases (Alan's ground truth in ck_eval.golden_case), score intent (exact) + ICP/believability (within 0.25), write graded eval_runs + a scorecard (verdict + cost-adjusted score), route the consequence, audit. Budget-capped; a missed real buyer forces quarantine. Separate from the deterministic gov-regression loop because it is judgment/paid. No-ops cleanly while no golden case is active (before the human freeze).",
      schedule: "0 11 * * 1",
    },
    {
      jobKey: JOB_LOOP_DRAFT,
      displayName: "REV-L3 Reply-Drafter (shadow, draft-only)",
      description:
        "REV-LOOP-01 v0 (shadow): draft a buyer reply for each qualified ck_eval.loop_inquiry from the divino-sales buyer-reply template + style contract, run it through the KS-DG Disclosure-Guard (one corrective pass if a hard rule trips), and STORE it in ck_eval.loop_draft for Alan to review. DRAFT-ONLY: no send path exists, money/outward comms stay human-gated. Budget-capped; DeepSeek when keyed else stub. Manual trigger (rare cron) until it earns a scorecard.",
      schedule: "0 0 29 2 *",
    },
    {
      jobKey: JOB_ESPO_SMOKE,
      displayName: "Espo Write Smoke Test (manual)",
      description:
        "One-shot proof that the deployed worker can ACT on EspoCRM through the connector: create a stream Note -> read it back -> edit it -> read again. The worker never deletes (no-delete rail); the operator removes the single test artifact. Rare cron (Feb 29) so it only ever runs on manual trigger. No outward send.",
      schedule: "0 0 29 2 *",
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: PAGE_EVAL,
        displayName: "CK Evaluation",
        exportName: PAGE_EVAL_EXPORT,
        routePath: PAGE_EVAL_ROUTE,
      },
      {
        type: "page",
        id: PAGE_MEETING,
        displayName: "CK Meeting Room",
        exportName: PAGE_MEETING_EXPORT,
        routePath: PAGE_MEETING_ROUTE,
      },
      // CK Org page RETIRED 2026-07-01 (Alan's call): Paperclip's native Org view already shows the
      // live agent tree from real data; the bespoke page read a disconnected ck_eval schema and
      // badged live units "unregistered". Constants/export kept to avoid churn; slot + launcher removed.
      {
        type: "page",
        id: PAGE_CRM,
        displayName: "CRM",
        exportName: PAGE_CRM_EXPORT,
        routePath: PAGE_CRM_ROUTE,
      },
      {
        type: "page",
        id: PAGE_DIVINO,
        displayName: "Divino",
        exportName: PAGE_DIVINO_EXPORT,
        routePath: PAGE_DIVINO_ROUTE,
      },
      {
        type: "page",
        id: PAGE_MEMORY,
        displayName: "CK Memory",
        exportName: PAGE_MEMORY_EXPORT,
        routePath: PAGE_MEMORY_ROUTE,
      },
      {
        type: "page",
        id: PAGE_APPROVALS,
        displayName: "Outreach outbox",
        exportName: PAGE_APPROVALS_EXPORT,
        routePath: PAGE_APPROVALS_ROUTE,
      },
    ],
    // Sidebar nav entries (page slots alone get a route but no nav link). These put "CK Meeting Room"
    // and "CK Evaluation" in the left sidebar's Work section, each navigating to its page route.
    launchers: [
      {
        id: "ck-meeting-room-launcher",
        displayName: "CK Meeting Room",
        placementZone: "sidebar",
        order: 1,
        action: { type: "navigate", target: PAGE_MEETING_ROUTE },
      },
      {
        id: "ck-evaluation-launcher",
        displayName: "CK Evaluation",
        placementZone: "sidebar",
        order: 2,
        action: { type: "navigate", target: PAGE_EVAL_ROUTE },
      },
      {
        id: "ck-memory-launcher",
        displayName: "CK Memory",
        placementZone: "sidebar",
        order: 3,
        action: { type: "navigate", target: PAGE_MEMORY_ROUTE },
      },
      {
        id: "ck-approvals-launcher",
        displayName: "Outreach outbox",
        placementZone: "sidebar",
        order: 0,
        badge: {
          dataKey: DATA_APPROVALS,
          valuePath: "count",
          label: "pending decisions",
          refreshIntervalMs: 3000,
        },
        action: { type: "navigate", target: PAGE_APPROVALS_ROUTE },
      },
      {
        id: "ck-crm-launcher",
        displayName: "CRM",
        placementZone: "sidebar",
        order: 3,
        action: { type: "navigate", target: PAGE_CRM_ROUTE },
      },
      {
        id: "ck-divino-launcher",
        displayName: "Divino",
        placementZone: "sidebar",
        order: 4,
        action: { type: "navigate", target: PAGE_DIVINO_ROUTE },
      },
    ],
  },
};

export default manifest;
