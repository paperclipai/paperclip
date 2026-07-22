import type { PluginContext } from "@paperclipai/plugin-sdk";
import type postgres from "postgres";
import { Espo } from "../espo.js";

type Sql = ReturnType<typeof postgres>;

// REV-L1 Inquiry-Ingestor (REV-LOOP-01, v0 shadow).
// DETERMINISTIC unit: poll EspoCRM for genuine inbound mail, normalize each into an idempotent
// `loop_inquiry` row in the ck_eval schema (the loop's working memory). No LLM, no Espo writes in v0
// — pure read + normalize. The schema check IS the proof (ADR-019: deterministic -> ~0 verifiers).
// Channel (B2B/B2C) is derived from the recipient identity, never crossed (see divino-mail-routing).
export const JOB_LOOP_INGEST = "ck.loop-ingest";

const B2B_ADDR = "alan@treshermanos.ch";
const B2C_ADDR = "info@divinocigars.ch";
const OURS = /treshermanos|divinocigars/i;

// Deterministic, dependency-free language guess from stopword hits. Good enough to route; the
// Qualifier (REV-L2) refines it. Returns de|fr|it|en|unknown.
function guessLanguage(text: string): string {
  const t = " " + text.toLowerCase().replace(/[^a-zàâäéèêëïîôöùûüç\s]/g, " ") + " ";
  const score = (words: string[]) => words.reduce((n, w) => n + (t.includes(" " + w + " ") ? 1 : 0), 0);
  const de = score(["und", "der", "die", "das", "ich", "wir", "mit", "für", "ist", "sehr", "gerne", "zigarren"]);
  const fr = score(["et", "le", "la", "les", "vous", "nous", "pour", "avec", "merci", "bonjour", "cigares"]);
  const it = score(["e", "il", "la", "che", "per", "con", "grazie", "buongiorno", "sigari", "sono"]);
  const en = score(["the", "and", "you", "for", "with", "thanks", "hello", "please", "cigars", "would"]);
  const best = Math.max(de, fr, it, en);
  if (best === 0) return "unknown";
  return de === best ? "de" : fr === best ? "fr" : it === best ? "it" : "en";
}

function deriveChannel(toField: string): string {
  const to = (toField || "").toLowerCase();
  if (to.includes(B2B_ADDR)) return "b2b";
  if (to.includes(B2C_ADDR)) return "b2c";
  return "unknown";
}

function firstAddress(s: string): { email: string; name: string } {
  const m = String(s || "").match(/([a-z0-9._%+\-]+)@([a-z0-9.\-]+)/i);
  return { email: m ? m[0].toLowerCase() : "", name: "" };
}

// The loop's working-memory table. Owned by the plugin (ck_eval schema), separate from Espo so v0
// never mutates the CRM the operator curated. Idempotent on the Espo email id.
async function ensureLoopTables(sql: Sql): Promise<void> {
  await sql`
    create table if not exists ck_eval.loop_inquiry (
      espo_email_id text primary key,
      account_id   text,
      lead_id      text,
      parent_type  text,
      from_address text,
      from_name    text,
      subject      text,
      body_snippet text,
      channel      text not null default 'unknown',
      language     text not null default 'unknown',
      received_at  timestamptz,
      intent       text,
      icp_fit      numeric,
      believability numeric,
      status       text not null default 'ingested',
      ingested_by  text not null default 'REV-L1',
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now()
    )`;
}

interface EspoEmail {
  id: string;
  name?: string;
  fromString?: string;
  fromName?: string;
  to?: string;
  dateSent?: string;
  bodyPlain?: string;
  parentType?: string;
  parentId?: string;
}

export interface IngestResult {
  scanned: number;
  inbound: number;
  inserted: number;
  refreshed: number;
}

// Core, exported for direct testing: read inbound Espo emails (paginated), upsert inquiry rows.
// `cap` bounds how far back we scan the mailbox so a poll stays cheap; Espo caps a page at 200.
export async function ingestInquiries(espo: Espo, sql: Sql, cap = 500): Promise<IngestResult> {
  await ensureLoopTables(sql);
  const PAGE = 200;
  const emails: EspoEmail[] = [];
  for (let offset = 0; offset < cap; offset += PAGE) {
    const res = await espo.list<EspoEmail>("Email", {
      select: ["id", "name", "fromString", "fromName", "to", "dateSent", "bodyPlain", "parentType", "parentId"],
      orderBy: "dateSent",
      order: "desc",
      maxSize: Math.min(PAGE, cap - offset),
      offset,
    });
    emails.push(...res.list);
    if (res.list.length < PAGE) break; // last page
  }
  const out: IngestResult = { scanned: emails.length, inbound: 0, inserted: 0, refreshed: 0 };

  for (const e of emails) {
    const from = e.fromString || "";
    if (!from || OURS.test(from)) continue; // outbound / our own — not an inquiry
    out.inbound += 1;
    const addr = firstAddress(from);
    const channel = deriveChannel(e.to || "");
    const body = (e.bodyPlain || "").replace(/\s+/g, " ").trim();
    const language = guessLanguage((e.name || "") + " " + body);
    const accountId = e.parentType === "Account" ? e.parentId ?? null : null;
    const leadId = e.parentType === "Lead" ? e.parentId ?? null : null;

    const rows = (await sql`
      insert into ck_eval.loop_inquiry
        (espo_email_id, account_id, lead_id, parent_type, from_address, from_name,
         subject, body_snippet, channel, language, received_at)
      values
        (${e.id}, ${accountId}, ${leadId}, ${e.parentType ?? null}, ${addr.email}, ${e.fromName ?? null},
         ${e.name ?? null}, ${body.slice(0, 500)}, ${channel}, ${language},
         ${e.dateSent ? new Date(e.dateSent) : null})
      on conflict (espo_email_id) do update set
        account_id = excluded.account_id,
        lead_id = excluded.lead_id,
        parent_type = excluded.parent_type,
        channel = excluded.channel,
        language = excluded.language,
        updated_at = now()
      returning (xmax = 0) as inserted
    `) as unknown as Array<{ inserted: boolean }>;
    if (rows[0]?.inserted) out.inserted += 1;
    else out.refreshed += 1;
  }
  return out;
}

export function registerInquiryIngestor(
  ctx: PluginContext,
  deps: { getSql: () => Promise<Sql>; getEspo: () => Promise<Espo | null> },
): void {
  ctx.jobs.register(JOB_LOOP_INGEST, async (job) => {
    const espo = await deps.getEspo();
    if (!espo) {
      ctx.logger.warn("REV-L1 Ingestor: no Espo config (set espoApiKey) — skipping.");
      return;
    }
    const sql = await deps.getSql();
    const r = await ingestInquiries(espo, sql);
    ctx.logger.info(
      `REV-L1 Ingestor: scanned=${r.scanned} inbound=${r.inbound} inserted=${r.inserted} refreshed=${r.refreshed} (trigger=${job.trigger})`,
    );
    try {
      const companies = await ctx.companies.list({ limit: 100 });
      const ck = companies.find((c) => c.name === "CK IT Solutions");
      if (ck) {
        await ctx.activity.log({
          companyId: ck.id,
          message: `REV-L1 Inquiry-Ingestor ran: ${r.inserted} new + ${r.refreshed} refreshed inquiries from ${r.inbound} inbound mails (shadow, read-only).`,
          entityType: "job",
          entityId: JOB_LOOP_INGEST,
          metadata: { ...r, phase: "v0-shadow" },
        });
      }
    } catch (err) {
      ctx.logger.warn(`REV-L1 Ingestor: activity log skipped (${String(err).slice(0, 80)})`);
    }
  });
}
