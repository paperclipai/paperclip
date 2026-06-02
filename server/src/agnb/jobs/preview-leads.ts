import { sql } from "drizzle-orm";
import { previewLeads, hasRocketKey } from "../lib/rocketsdr-client.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * preview-leads — port of agnb api/internal/preview-leads.
 *
 * The original was an on-demand POST: the bucket-builder UI passed a targeting
 * filter dict and got back an estimated lead count. There is no recurring
 * input for a cron and no table to persist previews into, so this job is
 * MANUAL-TRIGGER ONLY (enabledByDefault: false in the registry).
 *
 * When triggered it previews lead counts for each persona currently in
 * agnb.rocket_personas, parsing the estimated total out of Rocket's markdown
 * response (same heuristic as the original route). Rocket caps preview_leads
 * at 20/day; the shared client pre-flights that cap via quota_log, so this
 * job stops cleanly once the budget is spent.
 *
 * Env: ROCKETSDR_API_KEY (or ROCKET_MCP_TOKEN). No-ops if unset.
 */
function parseTotal(text: string): number | null {
  const m =
    text.match(/total[:\s]+(\d[\d,]*)/i) ??
    text.match(/(\d[\d,]*)\s+leads?\b/i) ??
    text.match(/estimated[:\s]+(\d[\d,]*)/i);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

function pluckText(res: unknown): string {
  if (typeof res === "object" && res && "content" in res) {
    return ((res as { content: Array<{ text?: string }> }).content ?? [])
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return "";
}

export async function previewLeadsJob(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  if (!hasRocketKey()) return { ok: true, processed: 0, summary: "skipped: no key" };
  const { db } = ctx;

  const personas = rows<{ id: string; name: string | null }>(
    await db.execute(sql`SELECT id, name FROM agnb.rocket_personas ORDER BY synced_at DESC LIMIT 20`),
  );
  if (personas.length === 0) {
    return { ok: true, processed: 0, summary: "no personas to preview" };
  }

  const results: Array<{ persona_id: string; name: string | null; total: number | null; error?: string }> = [];
  for (const p of personas) {
    if (ctx.signal.aborted) break;
    try {
      const res = await previewLeads({ persona_id: p.id }, { db });
      const total = parseTotal(pluckText(res));
      results.push({ persona_id: p.id, name: p.name, total });
      ctx.log("previewed leads", { persona_id: p.id, total });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ persona_id: p.id, name: p.name, total: null, error: msg });
      ctx.log("preview-leads error", { persona_id: p.id, error: msg });
      // Quota-exhausted errors are terminal for this run — stop early.
      if (/quota/i.test(msg)) break;
    }
  }

  return { ok: true, processed: results.length, results, summary: `${results.length} personas previewed` };
}
