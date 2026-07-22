import type { PluginContext } from "@paperclipai/plugin-sdk";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = any;

// REV-07 Reply-Escalator (B2B). DETERMINISTIC unit: reuses REV-L1's existing ck_eval.loop_inquiry
// table (already populated by the B2C inquiry-ingestor, which polls ALL inbound EspoCRM Email —
// both channels, see loop/ingestor.ts). This job just reads the 'b2b' slice that hasn't been handed
// to a human-facing agent yet, and turns each into a Paperclip issue assigned to REV-07
// Reply-Classifier — closing the "nothing watches for a venue reply" gap without a second mail poller.
// No LLM, no Espo writes — pure read + issue-create + status flip. The schema/idempotency (status
// column) IS the proof (ADR-019: deterministic -> ~0 verifiers).
export const JOB_B2B_REPLY_ESCALATE = "ck.b2b-reply-escalate";
const REV07_AGENT_NAME = "REV-07 Reply-Classifier";

interface Inquiry {
  espo_email_id: string;
  account_id: string | null;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  body_snippet: string | null;
  received_at: string | Date | null;
}

export interface EscalateResult {
  candidates: number;
  escalated: number;
  skipped_auto_reply: number;
  skipped_no_account: number;
  skipped_no_assignee: number;
}

export function isAutomaticReply(subject: string | null, body: string | null): boolean {
  const s = String(subject || "").toLowerCase();
  const b = String(body || "").toLowerCase();
  return (
    /(?:^|\b)(réponse automatique|reponse automatique|automatic reply|auto[- ]?reply|automatische antwort|abwesenheitsnotiz|fuori sede)(?:\b|:)/i.test(s)
    || /\b(i am|i'?m|je suis|ich bin)\s+(?:currently\s+)?(?:out of (?:the )?office|absent|abwesend)\b/i.test(b)
    || /\b(absent du|hors du bureau|nicht im büro|nicht im buero)\b/i.test(b)
  );
}

// Core, exported for direct testing. `sql` must already have ck_eval.loop_inquiry (ensured by the
// ingestor's ensureLoopTables, which always runs first in the same 15-min cycle family).
export async function escalateB2bReplies(
  ctx: PluginContext,
  sql: Sql,
  companyId: string,
  cap = 50,
): Promise<EscalateResult> {
  const rows = (await sql`
    select espo_email_id, account_id, from_address, from_name, subject, body_snippet, received_at
    from ck_eval.loop_inquiry
    where channel = 'b2b' and status = 'ingested'
    order by received_at asc nulls last
    limit ${cap}
  `) as Inquiry[];

  const out: EscalateResult = {
    candidates: rows.length,
    escalated: 0,
    skipped_auto_reply: 0,
    skipped_no_account: 0,
    skipped_no_assignee: 0,
  };
  if (!rows.length) return out;

  const agents = await ctx.agents.list({ companyId, limit: 200 });
  const rev07 = (agents as Array<{ id: string; name: string }>).find((a) => a.name === REV07_AGENT_NAME);
  if (!rev07) {
    ctx.logger.warn(`REV-07 Reply-Escalator: agent '${REV07_AGENT_NAME}' not found — cannot assign, skipping this cycle.`);
    out.skipped_no_assignee = rows.length;
    return out;
  }

  for (const r of rows) {
    if (isAutomaticReply(r.subject, r.body_snippet)) {
      await sql`
        update ck_eval.loop_inquiry
        set status = 'auto_reply', intent = 'automatic_reply', updated_at = now()
        where espo_email_id = ${r.espo_email_id}
      `;
      out.skipped_auto_reply += 1;
      continue;
    }
    // A reply we can't tie to a known venue Account isn't classifiable yet — leave it 'ingested' so a
    // later cycle (once REV-05/REV-09 have linked the account) can pick it up; never guess the account.
    if (!r.account_id) { out.skipped_no_account += 1; continue; }
    const title = `Reply from ${r.from_name || r.from_address || "unknown"} (venue reply)`;
    const description = [
      `Inbound reply on the B2B outreach thread — classify intent (interested / not-now / no / unclear / objection).`,
      `From: ${r.from_address || "unknown"}`,
      `Account ID: ${r.account_id}`,
      `Subject: ${r.subject || "(no subject)"}`,
      "",
      (r.body_snippet || "").slice(0, 1500),
    ].join("\n");
    try {
      await ctx.issues.create({
        companyId,
        title,
        description,
        status: "todo",
        assigneeAgentId: rev07.id,
        priority: "high",
      });
      await sql`update ck_eval.loop_inquiry set status = 'escalated', updated_at = now() where espo_email_id = ${r.espo_email_id}`;
      out.escalated += 1;
    } catch (e) {
      ctx.logger.warn(`REV-07 Reply-Escalator: failed to create issue for ${r.espo_email_id} (${String(e).slice(0, 120)})`);
    }
  }
  return out;
}

export function registerB2bReplyEscalator(
  ctx: PluginContext,
  deps: { getSql: () => Promise<Sql>; companyName: string },
): void {
  ctx.jobs.register(JOB_B2B_REPLY_ESCALATE, async (job) => {
    const companies = await ctx.companies.list({ limit: 100 });
    const ck = companies.find((c) => c.name === deps.companyName);
    if (!ck) {
      ctx.logger.warn(`REV-07 Reply-Escalator: company '${deps.companyName}' not found`);
      return;
    }
    const sql = await deps.getSql();
    const r = await escalateB2bReplies(ctx, sql, ck.id);
    ctx.logger.info(
      `REV-07 Reply-Escalator: candidates=${r.candidates} escalated=${r.escalated} skipped_auto_reply=${r.skipped_auto_reply} skipped_no_account=${r.skipped_no_account} skipped_no_assignee=${r.skipped_no_assignee} (trigger=${job.trigger})`,
    );
    if (r.escalated > 0) {
      try {
        await ctx.activity.log({
          companyId: ck.id,
          message: `REV-07 Reply-Escalator: ${r.escalated} venue reply/replies routed to REV-07 Reply-Classifier for classification.`,
          entityType: "job",
          entityId: JOB_B2B_REPLY_ESCALATE,
          metadata: r as unknown as Record<string, unknown>,
        });
      } catch (err) {
        ctx.logger.warn(`REV-07 Reply-Escalator: activity log skipped (${String(err).slice(0, 80)})`);
      }
    }
  });
}
