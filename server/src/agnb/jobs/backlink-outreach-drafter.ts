import { sql } from "drizzle-orm";
import { generateJson } from "../lib/gemini.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

const MAX_PER_RUN = 5;

/**
 * backlink-outreach-drafter — producer→consumer loop on the backlink side. The
 * Backlink Scout agent fills agnb.backlink_prospects; this drafts a ready-to-send
 * outreach email (subject + body via Gemini) for each top new prospect that has
 * none, so a human / the Outbound SDR only reviews and sends. Idempotent: only
 * touches prospects with status='new' and no outreach_subject yet.
 *
 * Cadence: daily. requiresEnv: GEMINI_API_KEY. Brand from AGNB_BRAND_NAME.
 */
export async function backlinkOutreachDrafter(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const brand = process.env.AGNB_BRAND_NAME || "Finn";

  const prospects = rows<{ id: string; source_domain: string; competitor_name: string | null }>(
    await db.execute(sql`
      SELECT id, source_domain, competitor_name
      FROM agnb.backlink_prospects
      WHERE status = 'new' AND (outreach_subject IS NULL OR outreach_subject = '')
      ORDER BY domain_rank DESC NULLS LAST
      LIMIT ${MAX_PER_RUN}
    `),
  );

  let drafted = 0;
  for (const p of prospects) {
    if (ctx.signal.aborted) break;
    const prompt =
      `You are an outreach specialist for ${brand}, an AI voice-agent platform. ` +
      `Write a short, warm backlink-outreach email to the editor of ${p.source_domain}` +
      `${p.competitor_name ? ` (they currently link to our competitor ${p.competitor_name})` : ""}. ` +
      `Goal: get ${brand} added or mentioned. Under 120 words, specific, no fluff, no placeholders. ` +
      `Return JSON: { "subject": string, "body": string }.`;
    let out: { subject?: string; body?: string };
    try {
      ({ data: out } = await generateJson<{ subject?: string; body?: string }>(prompt, { temperature: 0.5 }));
    } catch (e) {
      ctx.log(`outreach draft ${p.source_domain} error: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`);
      continue;
    }
    const subject = (out?.subject ?? "").trim();
    const body = (out?.body ?? "").trim();
    if (!subject || !body) continue;
    await db.execute(sql`
      UPDATE agnb.backlink_prospects
      SET outreach_subject = ${subject.slice(0, 200)}, notes = ${body}
      WHERE id = ${p.id}
    `);
    drafted++;
  }

  ctx.log(`backlink-outreach-drafter drafted ${drafted} outreach emails`);
  return { ok: true, drafted, summary: `drafted outreach for ${drafted} prospects` };
}
