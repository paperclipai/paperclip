import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Sql } from "postgres";
import type { ModelCaller } from "../meeting/llm.js";
import { extractJson } from "./qualifier.js";
import { guard, type GuardContext } from "../safety/disclosure-guard.js";

// REV-L3 Reply-Drafter (REV-LOOP-01 v0 SHADOW) — the loop's first DRAFTING agent. For each qualified
// inquiry it writes a buyer reply from the divino-sales buyer-reply template + style contract, runs it
// through the KS-DG Disclosure-Guard, and STORES it for Alan to review. It NEVER sends — there is no
// send path in this module, the Espo connector refuses sends, and money/outward comms are human-gated
// (non-negotiable #6 + the divino-sales autonomy boundary: buyer replies stay draft-only → Alan sends).
//
// The Guard is IN the generation loop, not just a grader: if the first draft trips a block-rule, the
// drafter gets one corrective pass with the violations fed back, then stores the result (pass or, if
// still blocked, flagged 'blocked' so the human sees the unit needs tuning). Budget-capped per run.
export const JOB_LOOP_DRAFT = "ck.loop-draft";

// Intents worth a buyer reply (a real inbound buyer signal). Noise/other is skipped.
const DRAFTABLE = new Set(["price", "availability", "order", "reorder", "partnership"]);

export const DRAFTER_SYSTEM = `You are REV-L3, the Reply-Drafter for Divino Cigars (a Swiss seller of Tres Hermanos cigars).
You draft a SINGLE short reply to one inbound buyer inquiry. You are draft-only: a human (Alan) reads
and sends every reply. You never send, never promise delivery dates, never invent facts.

STYLE (non-negotiable, this is how a real Swiss person texts a buyer):
- Plain conversational prose. Short sentences.
- NO dashes or hyphens used as punctuation, NO bullet points, NO markdown, NO emojis.
- Reply in the buyer's language: de -> German (Swiss «ss», never «ß»), fr -> French, it -> Italian, en -> English.
- Warm, quick, helpful. Sign off as "Divino Cigars".

CONTENT:
- Acknowledge their interest in the product they named.
- Confirm availability and price ONLY if you were given them; otherwise say you will confirm shortly. Never invent a price or a product fact.
- Invite them to order: ask for their delivery address so you can arrange the rest.
- Do NOT send payment or bank details yet. Those go out only after they confirm an order.

HARD RULES (a disclosure guard will reject your draft if you break these):
- The cigars are openly Tres Hermanos. That brand name is fine to use.
- NEVER reveal that orders are relayed, forwarded, ordered, or invoiced through Tres Hermanos.
- NEVER name "CK IT Solutions GmbH". The seller is "Divino Cigars".

OUTPUT: strict JSON only, no prose around it: { "reply": "<the message text>", "language": "<de|fr|it|en>" }`;

interface QualifiedRow {
  espo_email_id: string;
  from_name: string | null;
  subject: string | null;
  body_snippet: string | null;
  channel: string;
  language: string;
  intent: string | null;
  icp_fit: string | number | null;
}

function buildUser(r: QualifiedRow): string {
  return [
    `language: ${r.language}`,
    `intent (already classified): ${r.intent ?? "unknown"}`,
    `from: ${r.from_name ?? "there"}`,
    `subject: ${r.subject ?? ""}`,
    `their message: ${r.body_snippet ?? ""}`,
    ``,
    `Draft the reply now as JSON.`,
  ].join("\n");
}

async function ensureTable(sql: Sql): Promise<void> {
  await sql`
    create table if not exists ck_eval.loop_draft (
      espo_email_id   text primary key references ck_eval.loop_inquiry(espo_email_id) on delete cascade,
      language        text not null default 'unknown',
      channel         text not null default 'buyer',
      draft_text      text not null,
      guard_pass      boolean not null,
      guard_violations jsonb not null default '[]'::jsonb,
      attempts        int not null default 1,
      model           text,
      cost_cents      numeric not null default 0,
      status          text not null default 'drafted',
      drafted_by      text not null default 'REV-L3',
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now()
    )`;
}

export interface DraftResult { considered: number; drafted: number; blocked: number; failed: number; spentCents: number; provider: string; capped: boolean; }

async function generate(caller: ModelCaller, system: string, user: string): Promise<{ reply: string; language: string; costCents: number }> {
  const res = await caller.chat({ system, user, json: true, maxTokens: 700, temperature: 0.3 });
  const parsed = extractJson(res.text);
  const reply = typeof parsed?.reply === "string" ? parsed.reply.trim() : "";
  if (!reply) throw new Error("empty reply");
  return { reply, language: typeof parsed?.language === "string" ? parsed.language : "", costCents: res.costCents };
}

export async function draftReplies(
  caller: ModelCaller,
  sql: Sql,
  opts: { limit?: number; budgetCapCents?: number } = {},
): Promise<DraftResult> {
  const limit = opts.limit ?? 25;
  const cap = opts.budgetCapCents ?? 30;
  await ensureTable(sql);

  const rows = (await sql`
    select i.espo_email_id, i.from_name, i.subject, i.body_snippet, i.channel, i.language, i.intent, i.icp_fit
    from ck_eval.loop_inquiry i
    left join ck_eval.loop_draft d on d.espo_email_id = i.espo_email_id
    where i.status = 'qualified' and i.intent is not null and d.espo_email_id is null
    order by i.received_at desc nulls last
    limit ${limit}`) as unknown as QualifiedRow[];

  const out: DraftResult = { considered: 0, drafted: 0, blocked: 0, failed: 0, spentCents: 0, provider: caller.provider, capped: false };
  for (const r of rows) {
    if (!DRAFTABLE.has(String(r.intent))) continue; // skip 'other'/'support' for the buyer-reply drafter
    out.considered += 1;
    if (out.spentCents >= cap) { out.capped = true; break; }

    const gctx: GuardContext = { channel: "buyer", targetLanguage: r.language, hasOrdered: false };
    try {
      // Pass 1.
      let gen = await generate(caller, DRAFTER_SYSTEM, buildUser(r));
      out.spentCents += gen.costCents;
      let verdict = guard(gen.reply, gctx);
      let attempts = 1;

      // Pass 2 (corrective) only if a hard rule tripped and budget allows — feed the violations back.
      if (!verdict.pass && out.spentCents < cap) {
        const blocks = verdict.violations.filter((v) => v.severity === "block").map((v) => `${v.rule}: ${v.message} (you wrote: "${v.evidence}")`);
        const corrective = `${buildUser(r)}\n\nYour previous draft BROKE these hard rules and was rejected:\n${blocks.join("\n")}\nRewrite the reply so it breaks none of them. Same language, same plain style. JSON only.`;
        gen = await generate(caller, DRAFTER_SYSTEM, corrective);
        out.spentCents += gen.costCents;
        verdict = guard(gen.reply, gctx);
        attempts = 2;
      }

      const status = verdict.pass ? "drafted" : "blocked";
      await sql`
        insert into ck_eval.loop_draft (espo_email_id, language, channel, draft_text, guard_pass, guard_violations, attempts, model, cost_cents, status)
        values (${r.espo_email_id}, ${gen.language || r.language}, 'buyer', ${gen.reply}, ${verdict.pass},
                ${sql.json(verdict.violations as never)}, ${attempts}, ${caller.provider}, ${out.spentCents}, ${status})
        on conflict (espo_email_id) do update set
          draft_text = excluded.draft_text, guard_pass = excluded.guard_pass, guard_violations = excluded.guard_violations,
          attempts = excluded.attempts, status = excluded.status, updated_at = now()`;
      if (verdict.pass) out.drafted += 1; else out.blocked += 1;
    } catch {
      out.failed += 1;
      continue;
    }
  }
  return out;
}

export function registerReplyDrafter(
  ctx: PluginContext,
  deps: { getSql: () => Promise<Sql>; getCaller: () => Promise<ModelCaller> },
): void {
  ctx.jobs.register(JOB_LOOP_DRAFT, async (job) => {
    const caller = await deps.getCaller();
    const sql = await deps.getSql();
    const r = await draftReplies(caller, sql, { limit: 25, budgetCapCents: 30 });
    ctx.logger.info(
      `REV-L3 Drafter (SHADOW): provider=${r.provider} considered=${r.considered} drafted=${r.drafted} ` +
        `blocked=${r.blocked} failed=${r.failed} spent=${r.spentCents.toFixed(4)}c capped=${r.capped} (trigger=${job.trigger}) — DRAFTS ONLY, NOTHING SENT`,
    );
    try {
      const companies = await ctx.companies.list({ limit: 100 });
      const ck = companies.find((c) => c.name === "CK IT Solutions");
      if (ck)
        await ctx.activity.log({
          companyId: ck.id,
          message: `REV-L3 Reply-Drafter (${r.provider}): ${r.drafted} draft(s) ready for Alan, ${r.blocked} blocked by Disclosure-Guard, ${r.failed} failed. Drafts only — Alan reads and sends; nothing was sent.`,
          entityType: "job", entityId: JOB_LOOP_DRAFT, metadata: { ...r },
        });
    } catch (err) {
      ctx.logger.warn(`REV-L3 Drafter: activity log skipped (${String(err).slice(0, 80)})`);
    }
  });
}
