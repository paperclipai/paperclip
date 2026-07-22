import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Espo } from "../espo.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = any;

// B2B mail sync — Espo-native (no parallel IMAP poller).
// Espo's InboundEmail account (alan@treshermanos.ch) already fetches INBOX via CheckInboundEmails
// every 2 min; we extended monitoredFolders to include Sent (+ Drafts). This job:
//   1) reads the freshly-synced Email records from Espo (the same store agents use),
//   2) detects outbound mail Alan sent outside the CK approval path (phone, Espo compose, …),
//   3) routes each once to GOV-25 or REV-07 with the mail content so agents can act.
export const JOB_B2B_MAIL_SYNC = "ck.b2b-mail-sync";

const B2B_FROM = /alan@treshermanos\.(ch|com)/i;
const GOV25_AGENT_NAME = "GOV-25 Chief-of-Staff";
// Only route mail newer than this window (avoids re-firing on years of Sent-folder backfill).
const ROUTE_WINDOW_DAYS = 14;

interface EspoEmailRow {
  id: string;
  createdAt?: string;
  name?: string;
  fromString?: string;
  from?: string;
  to?: string;
  dateSent?: string;
  bodyPlain?: string;
  status?: string;
  messageId?: string;
  parentType?: string;
  parentId?: string;
  parentName?: string;
}

export interface MailSyncResult {
  synced: boolean;
  scanned: number;
  sentFromAlan: number;
  externalCandidates: number;
  routed: number;
  skippedAlreadyRouted: number;
  skippedSystem: number;
  error?: string;
}

async function ensureMailSyncTable(sql: Sql): Promise<void> {
  await sql`
    create table if not exists ck_eval.mail_sync_event (
      espo_email_id text primary key,
      message_id    text,
      direction     text not null default 'outbound',
      source        text not null default 'external',
      account_id    text,
      to_address    text,
      subject       text,
      body_snippet  text,
      sent_at       timestamptz,
      issue_id      uuid,
      routed_agent  text,
      status        text not null default 'detected',
      created_at    timestamptz not null default now(),
      updated_at    timestamptz not null default now()
    )`;
  await sql`create index if not exists mail_sync_event_status_idx on ck_eval.mail_sync_event (status)`;
  await sql`
    create table if not exists ck_eval.mail_sync_state (
      key text primary key,
      last_seen_created_at timestamptz not null,
      updated_at timestamptz not null default now()
    )`;
  // Do not reinterpret an existing Sent folder as new work when this detector
  // is first enabled or its classification rules change.
  await sql`
    insert into ck_eval.mail_sync_state (key, last_seen_created_at)
    values ('external_sent_cursor', now())
    on conflict (key) do nothing
  `;
}

function firstAddress(s: string): string {
  const m = String(s || "").match(/([a-z0-9._%+\-]+)@[a-z0-9.\-]+/i);
  return m ? m[0].toLowerCase() : "";
}

function isFromAlan(row: EspoEmailRow): boolean {
  const from = `${row.fromString || ""} ${row.from || ""}`;
  return B2B_FROM.test(from);
}

// Espo creates this suffix for both Paperclip-triggered sends and messages Alan
// composes manually in Espo. It identifies Espo as the producer, not CK as the
// initiator, so it must never be used as the reconciliation boundary.
function isEspoGeneratedMessageId(messageId: string | undefined): boolean {
  return Boolean(messageId && /@espo>$/i.test(messageId));
}

// IMAP-imported Sent-folder mail often lands as Archived in Espo, not Sent.
function isOutboundAlan(row: EspoEmailRow): boolean {
  if (!isFromAlan(row)) return false;
  const st = String(row.status || "");
  if (st === "Sent" || st === "Archived") return true;
  // Real Message-Id from the mail server (not Espo's internal id) ⇒ synced from IMAP Sent.
  if (row.messageId && !isEspoGeneratedMessageId(row.messageId)) return true;
  return false;
}

function withinRouteWindow(dateSent: string | undefined): boolean {
  if (!dateSent) return false;
  const t = new Date(dateSent).getTime();
  if (Number.isNaN(t)) return false;
  return t >= Date.now() - ROUTE_WINDOW_DAYS * 86400000;
}

async function loadSystemEmailIds(sql: Sql): Promise<Set<string>> {
  const rows = (await sql`
    select email_id
    from ck_eval.pending_send
    where status = 'sent' and email_id is not null and email_id <> ''
    union
    select result->>'send_email_id' as email_id
    from issue_thread_interactions
    where result->>'send_used_at' is not null
      and result->>'send_email_id' is not null
      and result->>'send_email_id' <> ''
  `) as Array<{ email_id: string }>;
  return new Set(rows.map((r) => r.email_id));
}

export function isKnownSystemSend(emailId: string, systemEmailIds: ReadonlySet<string>): boolean {
  return systemEmailIds.has(emailId);
}

export function isAfterMailSyncCursor(createdAt: string | undefined, cursor: Date): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  return Number.isFinite(t) && t > cursor.getTime();
}

async function fetchRecentEmails(espo: Espo, cap = 300): Promise<EspoEmailRow[]> {
  const PAGE = 200;
  const out: EspoEmailRow[] = [];
  for (let offset = 0; offset < cap; offset += PAGE) {
    const res = await espo.list<EspoEmailRow>("Email", {
      select: [
        "id", "createdAt", "name", "fromString", "from", "to", "dateSent", "bodyPlain",
        "status", "messageId", "parentType", "parentId", "parentName",
      ],
      orderBy: "dateSent",
      order: "desc",
      maxSize: Math.min(PAGE, cap - offset),
      offset,
    });
    out.push(...res.list);
    if (res.list.length < PAGE) break;
  }
  return out;
}

export async function runB2bMailSync(
  ctx: PluginContext,
  sql: Sql,
  companyId: string,
  espo: Espo | null,
): Promise<MailSyncResult> {
  await ensureMailSyncTable(sql);
  const out: MailSyncResult = {
    synced: false,
    scanned: 0,
    sentFromAlan: 0,
    externalCandidates: 0,
    routed: 0,
    skippedAlreadyRouted: 0,
    skippedSystem: 0,
  };

  if (!espo) {
    out.error = "no Espo config";
    return out;
  }

  try {
    const emails = await fetchRecentEmails(espo);
    out.synced = true;
    out.scanned = emails.length;

    const systemIds = await loadSystemEmailIds(sql);
    const cursorRows = (await sql`
      select last_seen_created_at
      from ck_eval.mail_sync_state
      where key = 'external_sent_cursor'
    `) as Array<{ last_seen_created_at: Date }>;
    const cursor = new Date(cursorRows[0]?.last_seen_created_at ?? Date.now());
    const sentFromAlan = emails.filter((e) => isOutboundAlan(e));
    out.sentFromAlan = sentFromAlan.length;
    let newestCreatedAt = cursor;

    const agents = await ctx.agents.list({ companyId, limit: 200 });
    const gov25 = (agents as Array<{ id: string; name: string }>).find((a) => a.name === GOV25_AGENT_NAME);

    for (const row of sentFromAlan) {
      const eid = row.id;
      if (!eid) continue;
      if (row.createdAt) {
        const created = new Date(row.createdAt);
        if (!Number.isNaN(created.getTime()) && created > newestCreatedAt) newestCreatedAt = created;
      }
      if (!isAfterMailSyncCursor(row.createdAt, cursor)) continue;

      // The durable send ledger is authoritative. An @espo Message-Id is not:
      // Alan's manual Espo-compose messages receive the same suffix.
      if (isKnownSystemSend(eid, systemIds)) {
        out.skippedSystem += 1;
        continue;
      }

      if (!withinRouteWindow(row.dateSent)) continue;

      const existing = (await sql`
        select espo_email_id, status from ck_eval.mail_sync_event where espo_email_id = ${eid}
      `) as Array<{ espo_email_id: string; status: string }>;
      if (existing.length && existing[0].status !== "detected") {
        out.skippedAlreadyRouted += 1;
        continue;
      }

      out.externalCandidates += 1;
      const toAddr = firstAddress(row.to || "");
      const accountId = row.parentType === "Account" ? row.parentId ?? null : null;
      const body = (row.bodyPlain || "").replace(/\s+/g, " ").trim();

      await sql`
        insert into ck_eval.mail_sync_event
          (espo_email_id, message_id, direction, source, account_id, to_address, subject, body_snippet, sent_at, status)
        values
          (${eid}, ${row.messageId ?? null}, 'outbound', 'external',
           ${accountId}, ${toAddr || null}, ${row.name ?? null},
           ${body.slice(0, 1500)},
           ${row.dateSent ? new Date(row.dateSent) : null}, 'detected')
        on conflict (espo_email_id) do update set
          account_id = excluded.account_id,
          subject = excluded.subject,
          body_snippet = excluded.body_snippet,
          updated_at = now()
      `;

      const assignee = gov25;
      if (!assignee) {
        ctx.logger.warn(`B2B mail-sync: no assignee for external send ${eid}`);
        continue;
      }

      const title = `External send detected — ${row.parentName || toAddr || "unknown recipient"}`;
      const description = [
        "Alan sent this email outside the CK approval/system path (phone, Espo compose, mobile, etc.).",
        "The message is now in Espo (synced from the Sent folder). Act on the content:",
        "close redundant draft tasks, update CRM/pipeline, schedule follow-up, or delegate drafting.",
        "",
        `To: ${row.to || "unknown"}`,
        `Account: ${row.parentName || "(unlinked)"} ${accountId ? `(${accountId})` : ""}`,
        `Subject: ${row.name || "(no subject)"}`,
        `Espo email id: ${eid}`,
        `Message-Id: ${row.messageId || "(none)"}`,
        `Sent: ${row.dateSent || "unknown"}`,
        "",
        body.slice(0, 2000),
      ].join("\n");

      try {
        const issue = await ctx.issues.create({
          companyId,
          title,
          description,
          status: "todo",
          assigneeAgentId: assignee.id,
          priority: "high",
        });
        await sql`
          update ck_eval.mail_sync_event
          set status = 'routed', issue_id = ${issue.id}, routed_agent = ${assignee.name}, updated_at = now()
          where espo_email_id = ${eid}
        `;
        out.routed += 1;
      } catch (e) {
        ctx.logger.warn(`B2B mail-sync: failed to route ${eid} (${String(e).slice(0, 120)})`);
      }
    }
    await sql`
      update ck_eval.mail_sync_state
      set last_seen_created_at = ${newestCreatedAt}, updated_at = now()
      where key = 'external_sent_cursor'
    `;
  } catch (e) {
    out.error = String(e).slice(0, 240);
  }

  return out;
}

export function registerB2bMailSync(
  ctx: PluginContext,
  deps: { getSql: () => Promise<Sql>; getEspo: () => Promise<Espo | null>; companyName: string },
): void {
  ctx.jobs.register(JOB_B2B_MAIL_SYNC, async (job) => {
    const companies = await ctx.companies.list({ limit: 100 });
    const ck = companies.find((c) => c.name === deps.companyName);
    if (!ck) {
      ctx.logger.warn(`B2B mail-sync: company '${deps.companyName}' not found`);
      return;
    }
    const sql = await deps.getSql();
    const espo = await deps.getEspo();
    const r = await runB2bMailSync(ctx, sql, ck.id, espo);
    ctx.logger.info(
      `B2B mail-sync: synced=${r.synced} scanned=${r.scanned} sent_from_alan=${r.sentFromAlan} external=${r.externalCandidates} routed=${r.routed} skipped_system=${r.skippedSystem} (${job.trigger})`,
    );
    if (r.error) ctx.logger.warn(`B2B mail-sync error: ${r.error}`);
    if (r.synced && (r.externalCandidates > 0 || r.routed > 0)) {
      try {
        await ctx.activity.log({
          companyId: ck.id,
          message: `B2B mail-sync: ${r.externalCandidates} external send(s) from Espo Sent; ${r.routed} routed to agents.`,
          entityType: "job",
          entityId: JOB_B2B_MAIL_SYNC,
          metadata: r as unknown as Record<string, unknown>,
        });
      } catch (err) {
        ctx.logger.warn(`B2B mail-sync: activity log skipped (${String(err).slice(0, 80)})`);
      }
    }
  });
}
