import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import postgres from "postgres";
import {
  JOB_DAILY_HUDDLE,
  JOB_WEEKLY_TACTICAL,
  JOB_GOV_REGRESSION,
  JOB_GOV_META_EVAL,
  JOB_STALL_WATCHDOG,
  DATA_EVAL_OVERVIEW,
  DATA_MEETING_ROOM,
  DATA_ORG,
  DATA_MEMORY,
  ACTION_MEMORY_CURATE,
  DATA_DIVINO_STATUS,
  DATA_DIVINO_LISTINGS,
  DATA_DIVINO_JOBS,
  ACTION_DIVINO_RUN,
  ACTION_DIVINO_ASK,
  DATA_DIVINO_ACCESS,
  DATA_DIVINO_MONEY,
  DATA_DIVINO_MAIL,
  DATA_DIVINO_MAIL_MSG,
  DATA_DIVINO_MAIL_FOLDERS,
  ACTION_DIVINO_MAIL_SEND,
  JOB_LOOP_INGEST,
  JOB_CRM_ADDRESS_SELFHEAL,
  DATA_APPROVALS,
  ACTION_APPROVAL_SEND,
  ACTION_APPROVAL_CANCEL,
} from "./manifest.js";
import { registerFounderBrief } from "./founder-brief.js";
import { supersededRecurringIssues } from "./recurring-issue-lifecycle.js";
import { Espo } from "./espo.js";
import { selfHealCityFromStreet } from "./crm-selfheal.js";
import { sendVenueEmailM, ensurePendingSendTable, reviewOutreachMessage } from "./tools.js";
import { registerInquiryIngestor } from "./loop/ingestor.js";
import { registerB2bReplyEscalator } from "./loop/b2b-escalate.js";
import { registerB2bMailSync } from "./loop/mail-sync.js";
import { registerEspoSmoke } from "./loop/espo-smoke.js";
import { registerLeadQualifier, resolveCaller } from "./loop/qualifier.js";
import { registerLeadQualifierEval } from "./loop/qualifier-eval.js";
import { registerReplyDrafter } from "./loop/drafter.js";
import { registerCkTools } from "./tools.js";
import { setEspoSendLiveEnabled } from "./send-guard.js";
import { shouldLearnSentOutreachEdit } from "./outreach-learning.js";
import { runGovRegression, runGovMetaEval } from "./gov-kernel.js";
import { assembleLivePreRead } from "./meeting/live-preread.js";
import { ensureMeetingSpec, runLiveWeeklyTactical } from "./meeting/weekly-tactical.js";
import { normalizeMemoryPageParams } from "./memory-page.js";
import { issueAwaitsHumanApproval, outboxSendCompletionState } from "./approval-lifecycle.js";
import { listAllCompanyIssues } from "./issue-pagination.js";
import { defaultMeetingId } from "./meeting/meeting-selection.js";

const COMPANY_NAME = "CK IT Solutions";

// Lazy, single Postgres connection for reading the `ck_eval` schema. `ctx.db` is
// scoped to the plugin's own namespace + whitelisted core tables and cannot reach
// `ck_eval`, so the worker (trusted local Node) connects directly via the same
// `postgres` client the GOV kernel scripts use. The host sandboxes the worker and
// strips DATABASE_URL from its env, so the connection string is supplied via the
// plugin's instance config (`databaseUrl`), falling back to DATABASE_URL if present.
let sqlClient: ReturnType<typeof postgres> | null = null;
let sqlClientUrl: string | null = null;
let currentContext: PluginContext | null = null;

async function resolveDbUrl(ctx: PluginContext): Promise<string> {
  try {
    const cfg = await ctx.config.get();
    const fromConfig = cfg?.databaseUrl;
    if (typeof fromConfig === "string" && fromConfig.length > 0) return fromConfig;
  } catch {
    // fall through to env
  }
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  throw new Error(
    "No database URL: set the plugin's `databaseUrl` config or DATABASE_URL; cannot read ck_eval schema",
  );
}

function db(url: string): ReturnType<typeof postgres> {
  if (!sqlClient || sqlClientUrl !== url) {
    sqlClient = postgres(url, { onnotice: () => {} });
    sqlClientUrl = url;
  }
  return sqlClient;
}

async function reconcileSentOutreachLifecycle(
  ctx: PluginContext,
  sql: ReturnType<typeof postgres>,
  row: Record<string, unknown>,
): Promise<void> {
  const interactionId = String(row.interaction_id || "");
  const issueId = String(row.issue_id || "");
  const companyId = String(row.company_id || "");
  const emailId = String(row.email_id || "");
  const completion = outboxSendCompletionState();

  if (interactionId) {
    await sql`
      update issue_thread_interactions
      set status = ${completion.interactionStatus},
          result = (coalesce(result, '{}'::jsonb) - 'send_error')
                || jsonb_build_object(
                  'version', 1,
                  'outcome', ${completion.interactionOutcome}::text,
                  'completion_surface', ${completion.completionSurface}::text,
                  'send_used_at', coalesce(result->>'send_used_at', now()::text),
                  'send_email_id', ${emailId}::text
                ),
          resolved_at = coalesce(resolved_at, now()),
          updated_at = now()
      where id = ${interactionId}
        and status in ('pending', 'accepted', 'expired')
    `;
  }

  if (issueId && companyId) {
    const otherPending = (await sql`
      select count(*)::int as count
      from issue_thread_interactions
      where issue_id = ${issueId}
        and status = 'pending'
    `) as unknown as Array<{ count: number }>;
    if ((otherPending[0]?.count ?? 0) === 0) {
      const issue = await ctx.issues.get(issueId, companyId);
      if (issue && issue.status !== "done" && issue.status !== "cancelled") {
        await ctx.issues.update(issueId, { status: completion.issueStatus }, companyId);
      }
    }
  }
}

// Base URL of the host-side divino-ops bridge (marketplace machine state + tools). Loopback only;
// the worker runs on the host network so 127.0.0.1:8899 is reachable.
async function divinoOpsUrl(ctx: PluginContext): Promise<string> {
  try {
    const cfg = (await ctx.config.get()) as Record<string, unknown> | null;
    const u = cfg?.divinoOpsUrl;
    if (typeof u === "string" && u.trim()) return u.trim().replace(/\/+$/, "");
  } catch {
    // fall through to default
  }
  return "http://127.0.0.1:8899";
}

async function divinoOpsGet(ctx: PluginContext, path: string, timeoutMs = 10000): Promise<unknown> {
  const base = await divinoOpsUrl(ctx);
  const res = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`divino-ops ${path} → HTTP ${res.status}`);
  return res.json();
}

async function divinoOpsPost(ctx: PluginContext, path: string, body: unknown, timeoutMs = 15000): Promise<unknown> {
  const base = await divinoOpsUrl(ctx);
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `divino-ops ${path} → HTTP ${res.status}`);
  return data;
}

// The only actions the cockpit may trigger. post-next is outward (publishes) — the UI confirm-gates it.
const DIVINO_ACTION_KINDS = new Set(["health-check", "refresh", "post-next"]);

// Resolve an EspoCRM connector from instance config. Prefer the secret reference
// (espoApiKeyRef) resolved via ctx.secrets; fall back to a direct key (espoApiKey),
// mirroring how databaseUrl is supplied to this sandboxed worker. Returns null if no
// key is configured, so the loop jobs no-op cleanly instead of throwing.
async function resolveEspo(ctx: PluginContext): Promise<Espo | null> {
  let cfg: Record<string, unknown> | null = null;
  try {
    cfg = (await ctx.config.get()) as Record<string, unknown> | null;
  } catch {
    cfg = null;
  }
  const baseUrl =
    (typeof cfg?.espoBaseUrl === "string" && cfg.espoBaseUrl.trim()) || "http://127.0.0.1:8085/api/v1";
  const ref = typeof cfg?.espoApiKeyRef === "string" ? cfg.espoApiKeyRef.trim() : "";
  let apiKey = typeof cfg?.espoApiKey === "string" ? cfg.espoApiKey.trim() : "";
  if (ref) {
    try {
      apiKey = await ctx.secrets.resolve(ref);
    } catch (e) {
      ctx.logger.warn(`resolveEspo: secret ref '${ref}' failed (${String(e).slice(0, 80)})`);
    }
  }
  if (!apiKey) return null;
  return new Espo({ baseUrl, apiKey });
}

interface EvalAgentRow {
  agent_id: string;
  name: string;
  role: string | null;
  agent_status: string | null;
  spec_id: string | null;
  type: string | null;
  spec_status: string | null;
  verdict: string | null;
  cost_adjusted_score: string | number | null;
  period_end: Date | string | null;
  recent_runs: number | string | null;
}

function deriveDepartment(name: string, role: string | null): string {
  if (name.startsWith("GOV") || role === "governance") return "governance";
  if (name.startsWith("REV") || role === "revenue") return "revenue";
  return role ?? "unknown";
}

// Certification status is derived from the agent_spec lifecycle: only `active`
// specs are certified for production; draft/quarantined/retired and unregistered
// agents are surfaced as-is.
function deriveCertification(specStatus: string | null): string {
  if (!specStatus) return "unregistered";
  if (specStatus === "active") return "certified";
  return specStatus;
}

// ── ADR-019 org mesh: the canonical department spine + spec'd-unit counts ────────
// The org is a WIDE-FLAT verifier mesh (ADR-019), NOT a tall hierarchy: Alan at the apex, a thin
// coordination layer, a wide field of verifiers, then the line departments. Built units come from the
// live substrate; planned departments (spec'd in agent-catalog.md but not yet built) are shown with
// their spec'd-unit counts so the chart is honest about what EXISTS vs. what is only DESIGNED.
const DEPARTMENTS: Array<{ code: string; key: string; label: string; spec: number }> = [
  { code: "GOV", key: "governance", label: "Governance / Evaluation Office", spec: 25 },
  { code: "KS", key: "knowledge-safety", label: "Knowledge & Safety (Disclosure-Guard)", spec: 10 },
  { code: "REV", key: "revenue", label: "Revenue / Go-to-Market", spec: 13 },
  { code: "MKT", key: "marketing", label: "Marketing / Content", spec: 9 },
  { code: "CS", key: "customer-success", label: "Customer Success / Support", spec: 7 },
  { code: "FIN", key: "finance", label: "Finance / Accounting", spec: 10 },
  { code: "LEG", key: "legal", label: "Legal / Compliance / IP-admin", spec: 6 },
  { code: "SEC", key: "security", label: "Security / Reliability / IT", spec: 8 },
  { code: "ENG", key: "engineering", label: "Engineering / Internal Tooling", spec: 5 },
  { code: "FDR", key: "founder-ops", label: "Founder Ops / Executive Support", spec: 5 },
  { code: "PPL", key: "people", label: "People / Hiring (deferred)", spec: 1 },
];

// The thin coordination layer (the integrator seats that batch up to Alan) vs. the wide verifier mesh
// (the spine that grades every unit). Both sit under "governance" but play different mesh roles.
const COORDINATION_SEATS = ["Chief-of-Staff", "Integrator", "Cadence-Scheduler", "Issues-Manager", "Digest-Composer"];
const isCoordination = (name: string): boolean => COORDINATION_SEATS.some((s) => name.includes(s));

// The CK Evaluation Office worker.
//   - Job `ck.daily-huddle`: deterministic context-sync posted to the board (ADR-018).
//   - Data endpoint `ck-eval-overview`: joins CK agents with their latest ck_eval
//     scorecard verdict + cost-adjusted score for the CK Evaluation UI page.
const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    const instanceConfig = (await ctx.config.get().catch(() => ({}))) as Record<string, unknown>;
    setEspoSendLiveEnabled(instanceConfig.liveVenueSend === true);
    ctx.logger.info("CK Evaluation Office plugin: setup");

    // Founder Brief — the "meeting with Alan": composes a decision-ready brief,
    // posts it as an issue assigned to the owner, surfaces tap-to-decide
    // interactions, and writes back the owner's choices on its next run. Reuses
    // the same direct Postgres connection the eval-overview endpoint uses.
    registerFounderBrief(ctx, {
      companyName: COMPANY_NAME,
      getSql: async () => db(await resolveDbUrl(ctx)),
    });

    // REV-LOOP-01 v0 (shadow): the first runtime unit of the money loop. REV-L1
    // Inquiry-Ingestor polls EspoCRM for inbound mail and normalizes it into
    // ck_eval.loop_inquiry. Deterministic, read-only against the CRM.
    registerInquiryIngestor(ctx, {
      getSql: async () => db(await resolveDbUrl(ctx)),
      getEspo: async () => resolveEspo(ctx),
    });

    // REV-07 Reply-Escalator (B2B): the inbound-reply-detection gap fix. Reuses REV-L1's
    // ck_eval.loop_inquiry (above) — reads the un-routed 'b2b' rows and wakes REV-07 Reply-Classifier
    // via a real assigned Paperclip issue, instead of nothing watching for a venue's reply.
    registerB2bReplyEscalator(ctx, {
      getSql: async () => db(await resolveDbUrl(ctx)),
      companyName: COMPANY_NAME,
    });

    // B2B mail sync: Espo InboundEmail (INBOX+Sent+Drafts) → detect external Alan sends → route agents.
    registerB2bMailSync(ctx, {
      getSql: async () => db(await resolveDbUrl(ctx)),
      getEspo: async () => resolveEspo(ctx),
      companyName: COMPANY_NAME,
    });

    // One-shot Espo WRITE smoke test (manual trigger): proves the worker can act on the CRM through
    // the connector (create -> read -> update a stream Note). Worker never deletes; operator cleans up.
    registerEspoSmoke(ctx, { getEspo: async () => resolveEspo(ctx) });

    // REV-L2 Lead-Qualifier — the first JUDGMENT agent. Heartbeat: classify each un-qualified inquiry
    // (intent + ICP + believability). DeepSeek when keyed, else zero-spend stub. Internal writes only,
    // budget-capped, never sends. resolveCaller picks the provider from config at run time.
    registerLeadQualifier(ctx, {
      getSql: async () => db(await resolveDbUrl(ctx)),
      getCaller: async () => resolveCaller(ctx),
    });

    // REV-L2 GRADER — the scorecard half. Runs the same classify over the FROZEN golden cases (Alan's
    // ground truth), writes graded eval_runs + a scorecard, routes the consequence. Its own job (NOT the
    // free 30-min gov-regression loop) because it is judgment/paid; budget-capped; no-ops until a golden
    // set is active. "No hire without a scorecard" — this is what lets REV-L2 ever leave shadow.
    registerLeadQualifierEval(ctx, {
      getSql: async () => db(await resolveDbUrl(ctx)),
      getCaller: async () => resolveCaller(ctx),
    });

    // REV-L3 Reply-Drafter (REV-LOOP-01 v0 SHADOW) — the loop's drafting endpoint. Drafts a buyer reply
    // for each qualified inquiry, runs it through the KS-DG Disclosure-Guard (with one corrective pass),
    // and STORES it in ck_eval.loop_draft for Alan to review. No send path exists here; nothing goes out.
    registerReplyDrafter(ctx, {
      getSql: async () => db(await resolveDbUrl(ctx)),
      getCaller: async () => resolveCaller(ctx),
    });

    // Native agent tools (web_fetch stealth, espo_list_emailless, espo_set_email) — discoverable via
    // GET /api/plugins/tools, executable via POST /api/plugins/tools/execute. Replaces runner-hardcoded tools.
    registerCkTools(ctx, {
      getEspo: async () => resolveEspo(ctx),
      getSql: async () => db(await resolveDbUrl(ctx)),
    });

    // ── CK Memory — the curation surface over ck_eval.memory_record ──────────────
    // Data: bounded, filterable review page plus corpus-wide counts. Never send
    // the full memory corpus into the browser: it grows continuously and made
    // the curation surface both slow and impossible to scan.
    ctx.data.register(DATA_MEMORY, async (params) => {
      const { filter, query, pageSize, page, offset } =
        normalizeMemoryPageParams((params ?? {}) as Record<string, unknown>);
      const searchPattern = `%${query}%`;
      const sql = db(await resolveDbUrl(ctx));
      const rows = (await sql`
        select id, store, key, coalesce(value #>> '{}', value::text) as value,
               source, status, confidence, quarantine_reason, created_at, updated_at
        from ck_eval.memory_record
        where (
          ${filter} = 'all'
          or (${filter} = 'verified' and status = 'verified')
          or (${filter} = 'needs_review' and status in ('unverified', 'contested'))
        )
          and (
            ${query} = ''
            or key ilike ${searchPattern}
            or coalesce(value #>> '{}', value::text) ilike ${searchPattern}
            or source ilike ${searchPattern}
          )
        order by updated_at desc
        limit ${pageSize} offset ${offset}
      `) as unknown as Array<Record<string, unknown>>;
      const totalRows = (await sql`
        select count(*)::int as count
        from ck_eval.memory_record
        where (
          ${filter} = 'all'
          or (${filter} = 'verified' and status = 'verified')
          or (${filter} = 'needs_review' and status in ('unverified', 'contested'))
        )
          and (
            ${query} = ''
            or key ilike ${searchPattern}
            or coalesce(value #>> '{}', value::text) ilike ${searchPattern}
            or source ilike ${searchPattern}
          )
      `) as unknown as Array<{ count: number }>;
      const countRows = (await sql`
        select status, count(*)::int as count
        from ck_eval.memory_record
        group by status
      `) as unknown as Array<{ status: string; count: number }>;
      const memories = rows.map((r) => ({
        id: r.id,
        scope: String(r.store).startsWith("agent:") ? "self" : "company",
        store: r.store,
        key: r.key,
        value: r.value,
        source: r.source,
        status: r.status,
        confidence: r.confidence != null ? Number(r.confidence) : null,
        reason: r.quarantine_reason ?? null,
        updatedAt: r.updated_at,
      }));
      const counts: Record<string, number> = {};
      for (const row of countRows) counts[String(row.status)] = Number(row.count);
      return {
        memories,
        counts,
        total: Number(totalRows[0]?.count ?? 0),
        page,
        pageSize,
        generatedAt: new Date().toISOString(),
      };
    });

    // ── Divino Marketplace Cockpit — live reads from the divino-ops bridge ────────
    // Status: rollups (per-platform coverage, alerts, browser/persona health) for the cockpit.
    ctx.data.register(DATA_DIVINO_STATUS, async () => {
      return divinoOpsGet(ctx, "/status");
    });
    // Listings: the full table, with optional filters forwarded as query params.
    ctx.data.register(DATA_DIVINO_LISTINGS, async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const qs = new URLSearchParams();
      for (const k of ["channel", "status", "health", "category", "product", "stale"]) {
        const v = p[k];
        if (v != null && String(v) !== "") qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return divinoOpsGet(ctx, `/listings${suffix}`);
    });
    // Jobs: recent action runs (status + log tail) for the Control Room run-log panel.
    ctx.data.register(DATA_DIVINO_JOBS, async () => {
      return divinoOpsGet(ctx, "/jobs");
    });
    // Access: persona / stealth-browser / Swiss exit-node / blocked-platform health.
    ctx.data.register(DATA_DIVINO_ACCESS, async () => {
      return divinoOpsGet(ctx, "/access");
    });
    // Money: webshop revenue tied to the marketplace effort (honest 'not connected' until wired).
    ctx.data.register(DATA_DIVINO_MONEY, async () => {
      return divinoOpsGet(ctx, "/money");
    });
    // Mail: the info@divinocigars.ch mailbox (IMAP is slower → longer timeout).
    ctx.data.register(DATA_DIVINO_MAIL, async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const qs = new URLSearchParams();
      if (p.folder) qs.set("folder", String(p.folder));
      if (p.limit) qs.set("limit", String(p.limit));
      return divinoOpsGet(ctx, `/mail${qs.toString() ? `?${qs}` : ""}`, 30000);
    });
    ctx.data.register(DATA_DIVINO_MAIL_MSG, async (params) => {
      const p = (params ?? {}) as { uid?: string; folder?: string };
      const uid = String(p.uid || "");
      if (!uid) throw new Error("uid required");
      const qs = new URLSearchParams({ uid });
      if (p.folder) qs.set("folder", String(p.folder));
      return divinoOpsGet(ctx, `/mail/message?${qs}`, 30000);
    });
    // Mailbox folders (Inbox/Sent/Drafts/Trash/Junk) for the folder switcher.
    ctx.data.register(DATA_DIVINO_MAIL_FOLDERS, async () => {
      return divinoOpsGet(ctx, "/mail/folders", 30000);
    });
    // Action: send/reply as info@divinocigars.ch (outward mail — the UI confirms before sending).
    ctx.actions.register(ACTION_DIVINO_MAIL_SEND, async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!p.to || !String(p.to).trim()) throw new Error("recipient required");
      return divinoOpsPost(ctx, "/mail/send", {
        to: p.to, subject: p.subject, body: p.body, in_reply_to: p.in_reply_to,
      }, 30000);
    });
    // Action: trigger a machine tool. Health-check/Refresh are internal maintenance; post-next is
    // outward (the UI confirm-gates it). The bridge validates channel/limit and enforces rate limits.
    ctx.actions.register(ACTION_DIVINO_RUN, async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const kind = String(p.kind || "");
      if (!DIVINO_ACTION_KINDS.has(kind)) throw new Error(`unknown action '${kind}'`);
      const body: Record<string, unknown> = {};
      if (p.channel) body.channel = String(p.channel);
      if (p.limit != null && String(p.limit) !== "") body.limit = Number(p.limit);
      if (p.dry_run) body.dry_run = true;
      return divinoOpsPost(ctx, `/actions/${kind}`, body);
    });
    // Action: chat with the warm Divino agent (same session substrate as Telegram → fast). Can act.
    ctx.actions.register(ACTION_DIVINO_ASK, async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const message = String(p.message || "");
      if (!message.trim()) throw new Error("empty message");
      return divinoOpsPost(ctx, "/ask", { message, session_id: p.session_id }, 320000);
    });

    // Action: curate a memory — verify / quarantine / unverify / forget(expire). Human-driven, audited.
    ctx.actions.register(ACTION_MEMORY_CURATE, async (params) => {
      const id = String((params as { id?: string }).id || "");
      const op = String((params as { op?: string }).op || "");
      if (!id || !op) throw new Error("id and op are required");
      const map: Record<string, string> = { verify: "verified", quarantine: "quarantined", unverify: "unverified", forget: "expired" };
      const status = map[op];
      if (!status) throw new Error(`unknown op '${op}'`);
      const sql = db(await resolveDbUrl(ctx));
      const reason = op === "quarantine" ? "quarantined by curator" : null;
      await sql`update ck_eval.memory_record set status=${status}, quarantine_reason=${reason}, updated_at=now() where id=${id}`;
      await sql`insert into ck_eval.memory_audit (record_id, action, reason, actor, automatic, snapshot)
        values (${id}, ${"curate:" + op}, ${"curator action"}, ${"Alan (curator)"}, false, ${sql.json({ op, status })})`;
      return { ok: true, op, status };
    });

    // ── Approvals / Outbox — pending outreach emails Alan edits + sends from the panel ──────────
    // Data: the pending queue (newest first), each with its editable body + the original draft.
    ctx.data.register(DATA_APPROVALS, async () => {
      const sql = db(await resolveDbUrl(ctx));
      await ensurePendingSendTable(sql);
      // A Hold/reject on the native task card owns the same decision as the
      // outbox card. Reconcile before reading so the outbox cannot keep
      // offering a send that Alan already declined elsewhere.
      await sql`
        update ck_eval.pending_send p
        set status = 'cancelled', resolved_at = now(), updated_at = now()
        from issue_thread_interactions i
        where p.interaction_id = i.id
          and p.status = 'pending'
          and i.status in ('rejected', 'expired')
      `;
      // Recover a send that reached Espo but was interrupted before its
      // task-side state was updated. This path is idempotent and never sends.
      const unsyncedSent = (await sql`
        select p.*
        from ck_eval.pending_send p
        left join issue_thread_interactions i on i.id = p.interaction_id
        left join issues issue on issue.id = p.issue_id
        where p.status = 'sent'
          and (
            (p.interaction_id is not null and i.status is distinct from 'accepted')
            or issue.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
          )
        order by p.resolved_at desc nulls last
        limit 100
      `) as unknown as Array<Record<string, unknown>>;
      for (const sentRow of unsyncedSent) {
        await reconcileSentOutreachLifecycle(ctx, sql, sentRow).catch((error) => {
          ctx.logger.warn(
            `Unable to reconcile sent outreach ${String(sentRow.id || "")}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      const rows = (await sql`
        select id, issue_id, account_id, venue_name, to_email, subject, draft_body, body, edited, created_at
        from ck_eval.pending_send where status = 'pending' order by created_at desc limit 100
      `) as unknown as Array<Record<string, unknown>>;
      return {
        pending: rows.map((r) => ({
          id: r.id, issueId: r.issue_id, accountId: r.account_id, venue: r.venue_name,
          to: r.to_email, subject: r.subject, body: r.body, draftBody: r.draft_body,
          edited: r.edited, createdAt: r.created_at,
        })),
        count: rows.length, generatedAt: new Date().toISOString(),
      };
    });

    // Action: Approve & Send — sends the (possibly-edited) body directly, records any edit as a durable
    // learning signal, marks the item sent + resolves its card. `body` carries Alan's edited text.
    ctx.actions.register(ACTION_APPROVAL_SEND, async (params) => {
      const p = params as { id?: string; body?: string; subject?: string };
      const id = String(p.id || "");
      if (!id) throw new Error("id is required");
      const sql = db(await resolveDbUrl(ctx));
      await ensurePendingSendTable(sql);
      // claim it atomically (pending -> sending) so a double-tap or the card can't double-send
      const claimed = (await sql`update ck_eval.pending_send set status = 'sending', updated_at = now()
        where id = ${id} and status = 'pending' returning *`) as unknown as Array<Record<string, unknown>>;
      if (!claimed.length) throw new Error("not a pending item (already sent, cancelled, or in flight)");
      const row = claimed[0];
      const finalBody = typeof p.body === "string" && p.body.trim() ? p.body : String(row.body);
      const finalSubject = typeof p.subject === "string" && p.subject.trim() ? p.subject : String(row.subject);
      const gate = reviewOutreachMessage(finalSubject, finalBody, {
        venueName: String(row.venue_name || ""),
      });
      if (!gate.pass) {
        await sql`update ck_eval.pending_send set status = 'pending', updated_at = now() where id = ${id} and status = 'sending'`;
        throw new Error(`Draft no longer passes the outreach gate: ${gate.violations.join(" ")}`);
      }
      const espo = await resolveEspo(ctx);
      if (!espo) { await sql`update ck_eval.pending_send set status = 'pending' where id = ${id}`; throw new Error("no Espo config"); }
      const res = await sendVenueEmailM(espo, { to: String(row.to_email), subject: finalSubject, body: finalBody, account_id: String(row.account_id), in_reply_to: row.in_reply_to ? String(row.in_reply_to) : undefined });
      if (!res.ok) { await sql`update ck_eval.pending_send set status = 'pending' where id = ${id}`; throw new Error(res.error); }
      const editedFromDraft = finalBody.trim() !== String(row.draft_body).trim() || finalSubject.trim() !== String(row.subject).trim();
      await sql`update ck_eval.pending_send set status = 'sent', body = ${finalBody}, subject = ${finalSubject}, edited = ${editedFromDraft}, email_id = ${String((res as { email_id?: unknown }).email_id ?? "")}, resolved_at = now() where id = ${id}`;
      // LEARN-FROM-EDITS: if Alan changed the copy, store the correction as a durable memory the drafting
      // agent recalls next time — the corpus learns even though the model is frozen (ADR-020).
      if (
        row.agent_id
        && shouldLearnSentOutreachEdit({
          edited: editedFromDraft,
          testLock: Boolean((res as { test_lock?: boolean }).test_lock),
          subject: finalSubject,
          body: finalBody,
        })
      ) {
        try {
          const lesson = `Outreach edit by Alan (venue: ${row.venue_name}). He changed the draft before sending. `
            + `BEFORE:\n${String(row.draft_body).slice(0, 700)}\n\nSENT:\n${finalBody.slice(0, 700)}\n\n`
            + `Apply this style/wording preference to future drafts.`;
          await sql`insert into ck_eval.memory_record (store, key, value, source, evidence, status, confidence)
            values (${"agent:" + String(row.agent_id)}, ${"outreach-edit:" + String(row.venue_name || row.account_id).slice(0, 60)}, ${lesson}, ${"alan-edit"}, ${sql.json({ pending_id: id, issue_id: String(row.issue_id ?? "") })}, ${"verified"}, ${0.9})`;
        } catch { /* learning capture is best-effort */ }
      }
      // Resolve both controls as one decision. The send is already durable at
      // this point, so lifecycle repair is best-effort and retried by the data
      // handler without ever sending the message again.
      await reconcileSentOutreachLifecycle(ctx, sql, {
        ...row,
        email_id: String((res as { email_id?: unknown }).email_id ?? ""),
      }).catch((error) => {
        ctx.logger.warn(
          `Email sent but task lifecycle reconciliation failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return {
        ok: true, sent: true, edited: editedFromDraft,
        email_id: (res as { email_id?: unknown }).email_id,
        requested_to: (res as { requested_to?: string }).requested_to ?? String(row.to_email),
        delivered_to: (res as { delivered_to?: string }).delivered_to,
        test_lock: (res as { test_lock?: boolean }).test_lock,
        live_send: (res as { live_send?: boolean }).live_send ?? false,
        learned: editedFromDraft,
      };
    });

    // Action: Cancel — drop a pending outreach without sending; clears its card.
    ctx.actions.register(ACTION_APPROVAL_CANCEL, async (params) => {
      const id = String((params as { id?: string }).id || "");
      if (!id) throw new Error("id is required");
      const sql = db(await resolveDbUrl(ctx));
      await ensurePendingSendTable(sql);
      const rows = (await sql`update ck_eval.pending_send set status = 'cancelled', resolved_at = now()
        where id = ${id} and status = 'pending' returning interaction_id`) as unknown as Array<{ interaction_id?: string }>;
      if (rows.length && rows[0].interaction_id) {
        await sql`
          update issue_thread_interactions
          set status = 'rejected',
              result = jsonb_build_object(
                'version', 1,
                'outcome', 'rejected',
                'reason', 'Cancelled in Outreach outbox; no email was sent.'
              ),
              resolved_at = now(),
              updated_at = now()
          where id = ${rows[0].interaction_id}
            and status in ('pending', 'accepted')
        `.catch(() => undefined);
      }
      return { ok: true, cancelled: rows.length > 0 };
    });

    ctx.jobs.register(JOB_DAILY_HUDDLE, async (job) => {
      const companies = await ctx.companies.list({ limit: 100 });
      const ck = companies.find((c) => c.name === COMPANY_NAME);
      if (!ck) {
        ctx.logger.warn(`CK Daily Huddle: company '${COMPANY_NAME}' not found`);
        return;
      }
      const agents = await ctx.agents.list({ companyId: ck.id, limit: 200 });
      const issues = await listAllCompanyIssues(ctx.issues, ck.id);
      const gov = agents.filter((a) => a.name.startsWith("GOV"));
      const rev = agents.filter((a) => a.name.startsWith("REV"));
      const today = new Date().toISOString().slice(0, 10);
      const fmt = (a: { name: string }) => `    - ${a.name}`;

      // The huddle is the 90-second subset of the meeting pipeline: segment 1 (segue) + a metric
      // (the SPC filter over each unit's cost-adjusted score) + "where are you stuck" (open issues).
      // NO IDS. Shares assembleLivePreRead with the Weekly Tactical so the logic isn't duplicated.
      const sql = db(await resolveDbUrl(ctx));
      const live = await assembleLivePreRead(sql, ck.id);
      const openIssues = issues.filter((i) => i.status !== "done" && i.status !== "cancelled");
      const stuck = openIssues
        .filter((i) => !i.title.startsWith("Daily Huddle") && !i.title.startsWith("Founder Brief"))
        .slice(0, 6);
      const digest = [
        `CK IT Solutions — Daily Huddle — ${today}`,
        `(live context-sync, composed by the CK Evaluation Office plugin; trigger=${job.trigger})`,
        ``,
        `SEGUE / GOOD NEWS: ${live.wins.join(" · ")}`,
        ``,
        `SCORECARD (SPC filter over ${live.unitsConsidered} unit(s)): ${live.redCount} red, ` +
          `${live.issues.length} special-cause signal(s), ${live.dropped.length} dropped as noise.`,
        ...live.issues.map((c) => `    ! ${c.title}`),
        ...(live.dropped.length ? [`    (dropped noise: ${live.dropped.map((d) => d.unit).join(", ")})`] : []),
        ``,
        `WHERE ARE YOU STUCK (${stuck.length} open):`,
        ...(stuck.length ? stuck.map((i) => `    - ${i.title}`) : ["    - Board clear."]),
        ``,
        `Roster: ${gov.length} governance, ${rev.length} revenue.`,
        ...gov.map(fmt),
        ...rev.map(fmt),
        ``,
        `Blockers / escalations to Alan: none (no IDS in the huddle — promoted signals go to the Weekly Tactical).`,
      ].join("\n");

      const title = `Daily Huddle — ${today}`;
      const existing = issues.find((i) => i.title === title);
      if (existing) {
        await ctx.issues.update(existing.id, { description: digest, status: "done" }, ck.id);
        ctx.logger.info(`CK Daily Huddle refreshed and completed: '${title}' (${existing.id})`);
      } else {
        await ctx.issues.create({ companyId: ck.id, title, description: digest, status: "done" });
      }
      const superseded = supersededRecurringIssues(
        issues,
        title,
        "Daily Huddle — ",
      );
      for (const issue of superseded) {
        await ctx.issues.update(issue.id, { status: "done" }, ck.id);
      }
      ctx.logger.info(`CK Daily Huddle posted to the board: '${title}' (${gov.length} gov, ${rev.length} rev)`);
      if (superseded.length) {
        ctx.logger.info(`CK Daily Huddle: completed ${superseded.length} superseded huddle(s)`);
      }
    });

    // Weekly Tactical (Level-10) — scheduled end-to-end. Assembles segments 1–5
    // deterministically, runs IDS only for promoted special-cause issues under
    // the hard meeting budget, then grades and concludes the meeting.
    ctx.jobs.register(JOB_WEEKLY_TACTICAL, async (job) => {
      const companies = await ctx.companies.list({ limit: 100 });
      const ck = companies.find((c) => c.name === COMPANY_NAME);
      if (!ck) {
        ctx.logger.warn(`CK Weekly Tactical: company '${COMPANY_NAME}' not found`);
        return;
      }
      const agents = await ctx.agents.list({ companyId: ck.id, limit: 200 });
      const chair =
        agents.find((a) => a.name.includes("Issues-Manager")) ??
        agents.find((a) => a.name.startsWith("GOV"));
      if (!chair) {
        ctx.logger.warn("CK Weekly Tactical: no GOV chair agent to attribute the meeting to");
        return;
      }
      const sql = db(await resolveDbUrl(ctx));
      const meetingSpecId = await ensureMeetingSpec(sql, chair.id);
      const result = await runLiveWeeklyTactical(sql, {
        companyId: ck.id,
        agentId: chair.id,
        meetingSpecId,
        budgetCapCents: 5,
        caller: await resolveCaller(ctx),
      });

      // Post the meeting to the board so it's visible in the GUI (the full room view is the
      // CK Meeting Room page; this is the at-a-glance board card linking to it).
      const today = new Date().toISOString().slice(0, 10);
      const title = `Weekly Tactical — ${today}`;
      const lines = [
        `CK IT Solutions — Weekly Tactical (Level-10) — ${today}`,
        `(deterministic pre-read by the CK Evaluation Office plugin; trigger=${job.trigger})`,
        ``,
        `SEGUE / GOOD NEWS: ${result.wins.join(" · ") || "—"}`,
        ``,
        `SCORECARD (SPC filter over ${result.unitsConsidered} unit(s)): ${result.redCount} red → ` +
          `${result.promoted} special-cause signal(s) promoted, ${result.dropped} dropped as noise.`,
        ...(result.promotedTitles.length ? result.promotedTitles.map((t) => `    ! ${t}`) : ["    (no special-cause issues this week)"]),
        ...(result.droppedUnits.length ? [`    (dropped noise: ${result.droppedUnits.join(", ")})`] : []),
        ``,
        result.promoted === 0
          ? `IDS: not needed — no special-cause issue was promoted.`
          : `IDS: completed under the budget breaker — ${result.ids.solved.length} solved, ` +
            `${result.ids.deferred} deferred, spend ${result.ids.observedCents.toFixed(4)} cents` +
            `${result.ids.tripped ? " (budget tripped)" : ""}.`,
        ``,
        `→ Open the CK Meeting Room page to see the full room (agenda, scorecard, Issues List, decisions).`,
        `meeting_run=${result.meetingRunId}`,
      ].join("\n");
      const issues = await listAllCompanyIssues(ctx.issues, ck.id);
      const existing = issues.find((i) => i.title === title);
      if (existing) await ctx.issues.update(existing.id, { description: lines, status: "done" }, ck.id);
      else await ctx.issues.create({ companyId: ck.id, title, description: lines, status: "done" });
      const superseded = supersededRecurringIssues(
        issues,
        title,
        "Weekly Tactical — ",
      );
      for (const issue of superseded) {
        await ctx.issues.update(issue.id, { status: "done" }, ck.id);
      }

      ctx.logger.info(
        `CK Weekly Tactical pre-read: run=${result.meetingRunId} units=${result.unitsConsidered} ` +
          `reds=${result.redCount} promoted=${result.promoted} dropped_noise=${result.dropped} ` +
          `spec=${meetingSpecId} board='${title}' ids_solved=${result.ids.solved.length} ` +
          `ids_deferred=${result.ids.deferred} spend_cents=${result.ids.observedCents.toFixed(4)} ` +
          `(trigger=${job.trigger})`,
      );
      if (superseded.length) {
        ctx.logger.info(`CK Weekly Tactical: completed ${superseded.length} superseded meeting(s)`);
      }
    });

    // Governance regression — re-hosts the proven eval kernel as a scheduled job.
    // For each built, certified unit with a golden set (GOV-01, REV-09, REV-10):
    // grade vs ground truth -> write eval_runs -> scorecard (verdict + cost-adjusted
    // score) -> route consequence (retire stays human-gated) -> audit. Deterministic.
    ctx.jobs.register(JOB_GOV_REGRESSION, async (job) => {
      const sql = db(await resolveDbUrl(ctx));
      const report = await runGovRegression(sql);
      for (const r of report.ran) {
        ctx.logger.info(
          `CK Gov Regression [${r.unit}]: verdict=${r.verdict} scorecard=${r.scorecardId} ` +
            `consequence=${r.consequence ? `${r.consequence.trigger}->${r.consequence.action}` : "none"} (trigger=${job.trigger})`,
        );
      }
      if (report.skipped.length)
        ctx.logger.warn(`CK Gov Regression: skipped (no spec/agent) ${report.skipped.join(", ")}`);
    });

    // Governance meta-eval (GOV-12) — re-read recent scorecards and flag drift.
    ctx.jobs.register(JOB_GOV_META_EVAL, async (job) => {
      const sql = db(await resolveDbUrl(ctx));
      const report = await runGovMetaEval(sql);
      ctx.logger.info(
        `CK Gov Meta-Eval: checked ${report.checked.length} specs, ${report.driftEvents} drift event(s) ` +
          `(trigger=${job.trigger}); ${report.checked.map((c) => `${c.spec}:${c.drift ? `DRIFT(${c.reason})` : "ok"}`).join(", ")}`,
      );
    });

    // Stall watchdog — catches any task stuck in_progress with no output, so no agent silently spins.
    // First stall: flag + re-queue (status→todo). Repeat stall: mark blocked + escalate to GOV-25.
    ctx.jobs.register(JOB_STALL_WATCHDOG, async (job) => {
      const STALL_MIN = 25;
      const companies = await ctx.companies.list({ limit: 100 });
      const ck = companies.find((c) => c.name === COMPANY_NAME);
      if (!ck) return;
      const issues = (await ctx.issues.list({ companyId: ck.id, limit: 300 })) as unknown as Array<{ id: string; title?: string; status?: string; updatedAt?: string; createdAt?: string; assigneeAgentId?: string }>;
      const agents = await ctx.agents.list({ companyId: ck.id, limit: 300 });
      const gov25 = agents.find((a) => a.name.startsWith("GOV-25"));
      const now = Date.now();
      const inProg = (issues || []).filter((i) => i.status === "in_progress");
      const pendingApprovalIssueIds = new Set<string>();
      try {
        const sql = db(await resolveDbUrl(ctx));
        await ensurePendingSendTable(sql);
        const pending = await sql`
          select issue_id
          from ck_eval.pending_send
          where company_id = ${ck.id}
            and status in ('pending', 'sending')
            and issue_id is not null`;
        for (const row of pending as Array<{ issue_id?: unknown }>) {
          const issueId = String(row.issue_id || "");
          if (issueId) pendingApprovalIssueIds.add(issueId);
        }
      } catch {
        // Preserve watchdog coverage if the optional approval ledger is unavailable.
      }
      let requeued = 0;
      let escalated = 0;
      for (const i of inProg) {
        if (issueAwaitsHumanApproval(i.id, pendingApprovalIssueIds)) continue;
        let comments: Array<{ body?: string; content?: string; createdAt?: string }> = [];
        try { comments = (await ctx.issues.listComments(i.id, ck.id)) as unknown as typeof comments; } catch { /* skip on error */ }
        const lastComment = comments.length ? Math.max(...comments.map((c) => new Date(c.createdAt || 0).getTime() || 0)) : 0;
        const updated = new Date(i.updatedAt || i.createdAt || 0).getTime() || 0;
        const idleMin = (now - Math.max(lastComment, updated)) / 60000;
        if (idleMin < STALL_MIN) continue;
        const priorFlags = comments.filter((c) => String(c.body || c.content || "").includes("STALL-WATCHDOG")).length;
        if (priorFlags === 0) {
          await ctx.issues.createComment(i.id, `⏱ STALL-WATCHDOG: in_progress ~${Math.round(idleMin)} min with no output. Re-queuing (status→todo) — report your blocker/finding or complete; a run that posts nothing is a failure.`, ck.id).catch(() => {});
          await ctx.issues.update(i.id, { status: "todo" }, ck.id).catch(() => {});
          requeued++;
        } else {
          await ctx.issues.createComment(i.id, `⏱ STALL-WATCHDOG: STILL stalled after a re-queue (~${Math.round(idleMin)} min, ${priorFlags} prior flag(s)). Marking blocked + escalating to GOV-25 for Alan's attention.`, ck.id).catch(() => {});
          await ctx.issues.update(i.id, { status: "blocked" }, ck.id).catch(() => {});
          if (gov25) {
            await ctx.issues.create({ companyId: ck.id, title: `⚠️ Stuck agent — needs attention: ${String(i.title || i.id).slice(0, 55)}`, description: `Stall-watchdog escalation. Task "${i.title}" (${i.id}), assignee ${i.assigneeAgentId || "?"}, stalled TWICE (no output ~${Math.round(idleMin)} min). Triage: is the assignee mis-tooled, given an impossible/empty task, or looping? Reassign, clarify, or flag to Alan.`, status: "todo", assigneeAgentId: gov25.id, priority: "high" }).catch(() => {});
          }
          escalated++;
        }
      }
      ctx.logger.info(`stall-watchdog (trigger=${job.trigger}): ${inProg.length} in_progress, ${requeued} re-queued, ${escalated} escalated`);
    });

    // Deterministic CRM data-quality: fill empty Account.City from the Street field
    // (bulk imports that mis-mapped town->street). Zero LLM, idempotent — the durable
    // fix for the recurring "empty City column" that agent-triggered routines never cured.
    ctx.jobs.register(JOB_CRM_ADDRESS_SELFHEAL, async (job) => {
      const espo = await resolveEspo(ctx);
      if (!espo) { ctx.logger.warn("crm-address-selfheal: no Espo config — skipped"); return; }
      const r = await selfHealCityFromStreet(espo, true);
      ctx.logger.info(`crm-address-selfheal (trigger=${job.trigger}): scanned=${r.scanned} emptyCity=${r.emptyCity} filled=${r.filled} skipped=${r.skipped}`);
    });

    // Data endpoint backing the CK Evaluation UI page. Joins Paperclip agents for
    // "CK IT Solutions" with their ck_eval agent_spec (via paperclip_agent_id) and
    // their latest scorecard (by period_end desc), plus an eval-run count.
    ctx.data.register(DATA_EVAL_OVERVIEW, async () => {
      const companies = await ctx.companies.list({ limit: 200 });
      const ck = companies.find((c) => c.name === COMPANY_NAME);
      if (!ck) {
        return { company: COMPANY_NAME, found: false, generatedAt: new Date().toISOString(), agents: [] };
      }

      const sql = db(await resolveDbUrl(ctx));
      // One spec per agent (active first, then newest) via a lateral, so a stray duplicate agent_spec
      // row can't fan an agent into two table rows / inflate the counts.
      const rows = (await sql`
        select
          a.id            as agent_id,
          a.name          as name,
          a.role          as role,
          a.status        as agent_status,
          spec.spec_id    as spec_id,
          spec.type       as type,
          spec.status     as spec_status,
          sc.verdict      as verdict,
          sc.cost_adjusted_score as cost_adjusted_score,
          sc.period_end   as period_end,
          coalesce(runs.cnt, 0) as recent_runs
        from public.agents a
        left join lateral (
          select id as spec_id, type, status
          from ck_eval.agent_spec
          where paperclip_agent_id = a.id
          order by (status = 'active') desc, created_at desc
          limit 1
        ) spec on true
        left join lateral (
          select verdict, cost_adjusted_score, period_end
          from ck_eval.scorecard
          where spec_id = spec.spec_id
          order by period_end desc
          limit 1
        ) sc on true
        left join lateral (
          select count(*)::int as cnt
          from ck_eval.eval_run
          where spec_id = spec.spec_id
        ) runs on true
        where a.company_id = ${ck.id}
        order by a.name
      `) as unknown as EvalAgentRow[];

      const agents = rows.map((r) => ({
        id: r.agent_id,
        name: r.name,
        department: deriveDepartment(r.name, r.role),
        type: r.type ?? "n/a",
        certification: deriveCertification(r.spec_status),
        specStatus: r.spec_status ?? null,
        verdict: r.verdict ?? null,
        costAdjustedScore:
          r.cost_adjusted_score != null ? Number(r.cost_adjusted_score) : null,
        latestEvalAt: r.period_end ? new Date(r.period_end).toISOString() : null,
        recentRuns: Number(r.recent_runs ?? 0),
      }));

      return {
        company: COMPANY_NAME,
        companyId: ck.id,
        found: true,
        generatedAt: new Date().toISOString(),
        agents,
      };
    });

    // Data endpoint backing the CK Meeting Room UI page. Returns the recent meetings (for the picker)
    // plus the full detail of the selected (default latest) meeting: the assembled packet (segments
    // 1–5) and the Issues List with each IDS outcome (root, the Red-Team's objection, the decision,
    // the to-do, the golden case). Read-only.
    ctx.data.register(DATA_MEETING_ROOM, async (params) => {
      // A universal meeting viewer: show meetings across all companies (the live Weekly Tactical for
      // CK IT Solutions plus any IDS demo run), each labelled with its company.
      const sql = db(await resolveDbUrl(ctx));
      const meetings = (await sql`
        select mr.id, mr.kind, mr.started_at, mr.finished_at, mr.rating,
               coalesce(c.name, '(archived)') as company_name,
               (select count(*) from ck_eval.meeting_issue mi where mi.meeting_run_id = mr.id) as issue_count,
               (select count(*) from ck_eval.meeting_issue mi where mi.meeting_run_id = mr.id and mi.status = 'solved') as solved_count
        from ck_eval.meeting_run mr
        left join public.companies c on c.id = mr.company_id
        order by mr.started_at desc
        limit 50
      `) as unknown as Array<Record<string, unknown>>;

      // A power user expects "Meeting Room" to open on the newest run, even
      // when it was a clean meeting with zero promoted issues. Historical,
      // richer meetings remain selectable from the dropdown.
      const wanted = defaultMeetingId(meetings, params?.meetingId);
      let selected: Record<string, unknown> | null = null;
      if (wanted) {
        const [run] = (await sql`
          select mr.id, mr.kind, mr.started_at, mr.finished_at, mr.rating, mr.spend_cents, mr.budget_cap_cents,
                 mr.packet, mr.meta_eval_ref, coalesce(c.name, '(archived)') as company_name
          from ck_eval.meeting_run mr
          left join public.companies c on c.id = mr.company_id
          where mr.id = ${wanted as string}
        `) as unknown as Array<Record<string, unknown>>;
        if (run) {
          const issues = (await sql`
            select id, source_kind, source_ref, title, evidence, impact_score, believability,
                   identified_root, decision, owner_unit, due_at, status, golden_case_id, redteam
            from ck_eval.meeting_issue
            where meeting_run_id = ${wanted as string}
            order by (impact_score * believability) desc, impact_score desc
          `) as unknown as Array<Record<string, unknown>>;
          selected = {
            id: run.id,
            kind: run.kind,
            companyName: run.company_name,
            startedAt: run.started_at,
            finishedAt: run.finished_at,
            rating: run.rating,
            spendCents: run.spend_cents,
            budgetCapCents: run.budget_cap_cents,
            packet: run.packet ?? {},
            issues: issues.map((i) => ({
              id: i.id,
              sourceKind: i.source_kind,
              sourceRef: i.source_ref,
              title: i.title,
              evidence: i.evidence ?? {},
              impactScore: i.impact_score != null ? Number(i.impact_score) : 0,
              believability: i.believability != null ? Number(i.believability) : 1,
              identifiedRoot: i.identified_root,
              decision: i.decision,
              ownerUnit: i.owner_unit,
              dueAt: i.due_at,
              status: i.status,
              goldenCaseId: i.golden_case_id,
              redteam: i.redteam ?? null,
            })),
          };
        }
      }

      return {
        company: COMPANY_NAME,
        found: true,
        generatedAt: new Date().toISOString(),
        meetings: meetings.map((m) => ({
          id: m.id,
          kind: m.kind,
          companyName: m.company_name,
          startedAt: m.started_at,
          finishedAt: m.finished_at,
          rating: m.rating,
          issueCount: Number(m.issue_count ?? 0),
          solvedCount: Number(m.solved_count ?? 0),
        })),
        selected,
      };
    });

    // Data endpoint backing the CK Org UI page. Returns the ADR-019 mesh: Alan at the apex, the thin
    // coordination layer, the wide verifier mesh (the governance spine that grades every unit), and the
    // line departments — built units from the live substrate, planned departments shown with their
    // spec'd-unit counts (0-of-N). Each judgment unit carries a verifier badge (ADR-019 heuristic:
    // deterministic ~0, judgment 1, outward/irreversible 3). Read-only.
    ctx.data.register(DATA_ORG, async () => {
      const companies = await ctx.companies.list({ limit: 200 });
      const ck = companies.find((c) => c.name === COMPANY_NAME);
      const generatedAt = new Date().toISOString();
      if (!ck) {
        return {
          company: COMPANY_NAME, found: false, generatedAt,
          apex: null, coordination: [], verifierMesh: [], departments: [], stats: null,
        };
      }

      const sql = db(await resolveDbUrl(ctx));
      // Pick exactly ONE spec per agent (active first, then most-recently-created) via a lateral so a
      // stray duplicate agent_spec row can't fan the agent out into two mesh nodes.
      const rows = (await sql`
        select
          a.id as agent_id, a.name as name, a.role as role, a.status as agent_status,
          spec.spec_id as spec_id, spec.type as type, spec.status as spec_status,
          sc.verdict as verdict, sc.cost_adjusted_score as cost_adjusted_score, sc.period_end as period_end,
          coalesce(runs.cnt, 0) as recent_runs
        from public.agents a
        left join lateral (
          select id as spec_id, type, status from ck_eval.agent_spec
          where paperclip_agent_id = a.id
          order by (status = 'active') desc, created_at desc
          limit 1
        ) spec on true
        left join lateral (
          select verdict, cost_adjusted_score, period_end from ck_eval.scorecard
          where spec_id = spec.spec_id order by period_end desc limit 1
        ) sc on true
        left join lateral (
          select count(*)::int as cnt from ck_eval.eval_run where spec_id = spec.spec_id
        ) runs on true
        where a.company_id = ${ck.id}
        order by a.name
      `) as unknown as EvalAgentRow[];

      const units = rows.map((r) => ({
        id: r.agent_id,
        name: r.name,
        dept: deriveDepartment(r.name, r.role),
        type: r.type ?? "n/a",
        certification: deriveCertification(r.spec_status),
        verdict: r.verdict ?? null,
        costAdjustedScore: r.cost_adjusted_score != null ? Number(r.cost_adjusted_score) : null,
        // ADR-019 starting heuristic: a judgment unit gets 1 dedicated verifier (the Department-
        // Evaluator); a deterministic unit needs ~none (the kernel checks it against ground truth).
        verifiers: r.type === "judgment" ? 1 : 0,
      }));

      const governance = units.filter((u) => u.dept === "governance");
      const coordination = governance.filter((u) => isCoordination(u.name));
      const verifierMesh = governance.filter((u) => !isCoordination(u.name));

      const departments = DEPARTMENTS.filter((d) => d.code !== "GOV").map((d) => {
        const built = units.filter((u) => u.dept === d.key);
        return {
          code: d.code, key: d.key, label: d.label,
          specCount: d.spec, builtCount: built.length, units: built,
        };
      });

      const stats = {
        builtUnits: units.length,
        certified: units.filter((u) => u.certification === "certified").length,
        draft: units.filter((u) => u.certification === "draft").length,
        specdTotal: DEPARTMENTS.reduce((acc, d) => acc + d.spec, 0),
      };

      return {
        company: COMPANY_NAME, companyId: ck.id, found: true, generatedAt,
        principle:
          "ADR-019 — management is a wide-flat verifier mesh, not a tall hierarchy. Alan is the apex and the one constraint that never lifts; the layer's job is to absorb and protect his attention. Verifier depth is set per-output by stakes: deterministic units need ~none, judgment units get 1, anything outward/irreversible gets 3 diverse checks.",
        apex: {
          name: "Alan",
          title: "Founder · CEO · Board",
          note: "The one constraint that never lifts. Everything below subordinates to protecting his attention (ToC).",
        },
        coordination,
        verifierMesh,
        departments,
        stats,
      };
    });
  },

  async onHealth() {
    const ctx = currentContext;
    if (!ctx) return { status: "error" as const, message: "Plugin context is not initialized" };

    const details: Record<string, unknown> = {};
    const failures: string[] = [];

    try {
      const sql = db(await resolveDbUrl(ctx));
      await sql`select 1 as ok`;
      details.database = "connected";
    } catch (err) {
      details.database = "unavailable";
      failures.push(`database: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const espo = await resolveEspo(ctx);
      if (!espo) {
        details.espocrm = "not configured";
        failures.push("EspoCRM: no API credential configured");
      } else {
        await espo.list("Account", { maxSize: 1 });
        details.espocrm = "connected";
      }
    } catch (err) {
      details.espocrm = "unavailable";
      failures.push(`EspoCRM: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await divinoOpsGet(ctx, "/status", 2500);
      details.divinoOps = "connected";
    } catch {
      details.divinoOps = "unavailable";
      failures.push("Divino ops bridge is unavailable");
    }

    return failures.length === 0
      ? { status: "ok" as const, message: "CK Office dependencies are reachable", details }
      : {
          status: "degraded" as const,
          message: failures.join("; "),
          details,
        };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
