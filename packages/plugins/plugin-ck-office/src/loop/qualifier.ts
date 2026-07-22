import type { PluginContext } from "@paperclipai/plugin-sdk";
import type postgres from "postgres";
import { StubCaller, DeepseekCaller, type ModelCaller } from "../meeting/llm.js";

type Sql = ReturnType<typeof postgres>;

// REV-L2 Lead-Qualifier (REV-LOOP-01) — the first JUDGMENT agent in the money loop.
// Reads each un-qualified ck_eval.loop_inquiry row and assigns: intent (what the sender wants),
// icp_fit (how well they match the ideal B2B hospitality buyer), believability (how real/serious
// the inquiry looks). DETERMINISM-FIRST: a free heuristic stub proves the machine end-to-end at zero
// spend; a DeepSeek caller does the real judgment once a key is configured (one mode switch).
//
// SAFETY: this agent NEVER sends and NEVER touches the curated CRM. It reads inquiries and writes
// ONLY back to its own ck_eval.loop_inquiry rows (reversible, internal). Outward action stays gated
// behind a human, enforced structurally — the Espo connector refuses sends and this agent never calls it.
export const JOB_LOOP_QUALIFY = "ck.loop-qualify";

// The operating persona / instructions (REV-06 Reply-Classifier charter, expanded). This IS the
// agent's "AGENTS.md" — also emitted to disk so the persona is inspectable, not buried in code.
export const QUALIFIER_SYSTEM = `You are REV-L2, the Lead-Qualifier for Divino Cigars / Tres Hermanos.
Your one job: read a single inbound sales inquiry and classify it. You produce judgement only — you
NEVER write to a customer, never send mail, never promise anything. A human handles every outward reply.

The real revenue is B2B hospitality: hotels, lounges, bars and restaurants placing/【re】ordering
hand-made cigars and accessories for their venues. B2C web orders exist but are secondary.

Return STRICT JSON, no prose, with exactly these fields:
{
  "intent": one of ["price","availability","order","reorder","partnership","support","other"],
  "icp_fit": number 0..1   // 1 = clearly a B2B hospitality buyer (hotel/lounge/bar/restaurant/retailer); 0 = clearly not
  "believability": number 0..1 // 1 = concrete, serious, specific; 0 = vague/spam/bot
  "reason": short string (<=120 chars), the single strongest cue you used
}
Be conservative: if unsure, lower believability rather than inventing intent.`;

export interface QualifyResult {
  considered: number;
  qualified: number;
  failed: number;
  spentCents: number;
  provider: string;
  capped: boolean;
}

interface InquiryRow {
  espo_email_id: string;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  body_snippet: string | null;
  channel: string;
  language: string;
}

// Tolerant JSON extraction: deepseek-v4-flash is a reasoning model — it may wrap the object in
// ```json fences``` or prefix it with chain-of-thought. Pull the first balanced {...} object out.
export function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  return JSON.parse(slice);
}

const INTENTS = new Set(["price", "availability", "order", "reorder", "partnership", "support", "other"]);
const clamp01 = (n: unknown): number => {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
};

// Deterministic, zero-spend classifier — proves the pipeline and serves as a believable fallback.
// Keyword cues across de/fr/it/en. The LLM replaces this for the real judgment; this never sends.
export class ClassifierStub implements ModelCaller {
  readonly provider = "stub";
  async chat(req: { system: string; user: string }) {
    const t = req.user.toLowerCase();
    const has = (...ws: string[]) => ws.some((w) => t.includes(w));
    let intent = "other";
    if (has("nachbestell", "réassort", "wieder bestellen", "reorder", "erneut", "di nuovo")) intent = "reorder";
    else if (has("bestell", "order", "ordin", "commande", "kaufen", "acheter", "comprare")) intent = "order";
    else if (has("preis", "price", "prix", "prezzo", "kosten", "offerte", "quote", "angebot")) intent = "price";
    else if (has("verfügbar", "available", "disponib", "stock", "lager", "lieferzeit")) intent = "availability";
    else if (has("hotel", "lounge", "bar ", "restaurant", "partner", "zusammenarbeit", "wholesale", "wiederverkäuf", "b2b")) intent = "partnership";
    else if (has("problem", "reklamation", "complaint", "support", "defekt", "beschwerde")) intent = "support";
    const icp = has("hotel", "lounge", "bar", "restaurant", "gmbh", "ag ", "sàrl", "shop", "store", "wholesale", "wiederverkäuf") ? 0.8 : 0.4;
    const believ = (req.user.length > 240 ? 0.7 : 0.4) + (has("@") ? 0.1 : 0) - (has("unsubscribe", "viagra", "crypto", "loan") ? 0.5 : 0);
    const obj = { intent, icp_fit: icp, believability: Math.max(0, Math.min(1, believ)), reason: `stub:${intent}` };
    const text = JSON.stringify(obj);
    return { text, inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4), costCents: 0, model: "stub" };
  }
}

// The fields an inquiry classification consumes — shared by the live loop (InquiryRow) and the
// graded golden cases (golden_case.input has exactly these keys), so the eval scores the SAME
// computation the production unit runs.
export interface InquiryInput {
  from_address?: string | null;
  from_name?: string | null;
  subject?: string | null;
  body_snippet?: string | null;
  channel?: string | null;
  language?: string | null;
}

function buildUser(r: InquiryInput): string {
  return [
    `channel: ${r.channel ?? "unknown"}`,
    `language: ${r.language ?? "unknown"}`,
    `from: ${r.from_name ?? ""} <${r.from_address ?? ""}>`,
    `subject: ${r.subject ?? ""}`,
    `body: ${r.body_snippet ?? ""}`,
  ].join("\n");
}

export interface Classification {
  intent: string;
  icp_fit: number;
  believability: number;
  reason: string;
  costCents: number;
}

// Classify ONE inquiry. The single source of truth for REV-L2's judgment, used by both the live
// qualifier and the grader. Throws if the model output cannot be parsed (caller decides how to count
// that — the live loop treats it as a failed row; the grader treats it as a 0-score case).
export async function classifyOne(caller: ModelCaller, input: InquiryInput): Promise<Classification> {
  const res = await caller.chat({ system: QUALIFIER_SYSTEM, user: buildUser(input), json: true, maxTokens: 600, temperature: 0 });
  const parsed = extractJson(res.text); // throws on unparseable output
  const intent = parsed && INTENTS.has(String(parsed.intent)) ? String(parsed.intent) : "other";
  return {
    intent,
    icp_fit: clamp01(parsed?.icp_fit),
    believability: clamp01(parsed?.believability),
    reason: typeof parsed?.reason === "string" ? parsed.reason : "",
    costCents: res.costCents,
  };
}

// Core, exported for direct testing. Pulls un-qualified inquiries, classifies each under a per-run
// budget cap (cents), writes the verdict back. Stops cleanly when the budget would be exceeded.
export async function qualifyInquiries(
  caller: ModelCaller,
  sql: Sql,
  opts: { limit?: number; budgetCapCents?: number } = {},
): Promise<QualifyResult> {
  const limit = opts.limit ?? 100;
  const cap = opts.budgetCapCents ?? 25; // pennies; the stub is free, DeepSeek is ~0.01c/inquiry
  const rows = (await sql`
    select espo_email_id, from_address, from_name, subject, body_snippet, channel, language
    from ck_eval.loop_inquiry
    where intent is null
    order by received_at desc nulls last
    limit ${limit}
  `) as unknown as InquiryRow[];

  const out: QualifyResult = { considered: rows.length, qualified: 0, failed: 0, spentCents: 0, provider: caller.provider, capped: false };
  for (const r of rows) {
    if (out.spentCents >= cap) { out.capped = true; break; } // budget breaker: cannot run away
    let cls: Classification;
    try {
      cls = await classifyOne(caller, r);
      out.spentCents += cls.costCents;
    } catch {
      out.failed += 1;
      continue;
    }
    const intent = cls.intent;
    const icp = cls.icp_fit;
    const believ = cls.believability;
    await sql`
      update ck_eval.loop_inquiry
      set intent = ${intent}, icp_fit = ${icp}, believability = ${believ},
          status = 'qualified', updated_at = now()
      where espo_email_id = ${r.espo_email_id}
    `;
    out.qualified += 1;
  }
  return out;
}

export function registerLeadQualifier(
  ctx: PluginContext,
  deps: { getSql: () => Promise<Sql>; getCaller: () => Promise<ModelCaller> },
): void {
  ctx.jobs.register(JOB_LOOP_QUALIFY, async (job) => {
    const caller = await deps.getCaller();
    const sql = await deps.getSql();
    const r = await qualifyInquiries(caller, sql, { limit: 100, budgetCapCents: 25 });
    ctx.logger.info(
      `REV-L2 Qualifier: provider=${r.provider} considered=${r.considered} qualified=${r.qualified} ` +
        `failed=${r.failed} spent=${r.spentCents.toFixed(4)}c capped=${r.capped} (trigger=${job.trigger})`,
    );
    try {
      const companies = await ctx.companies.list({ limit: 100 });
      const ck = companies.find((c) => c.name === "CK IT Solutions");
      if (ck) {
        await ctx.activity.log({
          companyId: ck.id,
          message: `REV-L2 Lead-Qualifier (${r.provider}): qualified ${r.qualified}/${r.considered} inquiries (intent+ICP+believability), spend ${r.spentCents.toFixed(2)}c. Drafts/labels only — no sends.`,
          entityType: "job",
          entityId: JOB_LOOP_QUALIFY,
          metadata: { ...r },
        });
      }
    } catch (err) {
      ctx.logger.warn(`REV-L2 Qualifier: activity log skipped (${String(err).slice(0, 80)})`);
    }
  });
}

// Build the model caller from config: real DeepSeek when a key is present, else the zero-spend stub.
export async function resolveCaller(ctx: PluginContext): Promise<ModelCaller> {
  let cfg: Record<string, unknown> | null = null;
  try { cfg = (await ctx.config.get()) as Record<string, unknown> | null; } catch { cfg = null; }
  const ref = typeof cfg?.deepseekApiKeyRef === "string" ? cfg.deepseekApiKeyRef.trim() : "";
  let key = typeof cfg?.deepseekApiKey === "string" ? cfg.deepseekApiKey.trim() : "";
  const model = typeof cfg?.deepseekModel === "string" && cfg.deepseekModel.trim().length > 0
    ? cfg.deepseekModel.trim()
    : "deepseek-v4-flash";
  if (ref) {
    try { key = await ctx.secrets.resolve(ref); } catch (e) { ctx.logger.warn(`resolveCaller: secret ref failed (${String(e).slice(0, 60)})`); }
  }
  // Default to the cheaper/faster lane, but allow the operator to switch to v4-pro in config.
  if (key) return new DeepseekCaller(key, model);
  ctx.logger.info("REV-L2 Qualifier: no DeepSeek key configured — using zero-spend stub (proves the pipeline).");
  return new ClassifierStub();
}
