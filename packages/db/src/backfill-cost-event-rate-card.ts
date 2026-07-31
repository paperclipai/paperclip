/**
 * Backfill: populate `cost_events.rate_card_cents` and correct
 * `cost_events.cost_status` for rows written before the rate card existed.
 *
 * Historical rows carry correct token counts but were written with
 * `cost_status='reported'` and `cost_cents=0`, because the Claude Code CLI
 * reports a well-formed `total_cost_usd: 0` under OAuth/subscription auth. That
 * made subscription burn indistinguishable from genuinely free work.
 *
 * This deliberately does NOT touch `cost_cents`. That column means "cash
 * actually billed", it feeds `agents.spentMonthlyCents` and the budget guard,
 * and `0` is the correct value for a subscription run. Only the notional
 * rate-card figure and the honesty of the status label are restored here.
 *
 * Implemented as a script rather than a SQL migration (the usual convention in
 * this folder) so that pricing comes from the single source of truth in
 * `@paperclipai/shared`'s rate card — model-id normalisation and Sonnet 5's
 * dated price tiers would otherwise have to be reimplemented in SQL and would
 * inevitably drift from the TypeScript version.
 *
 * Usage:
 *   tsx src/backfill-cost-event-rate-card.ts            # dry run, prints a plan
 *   tsx src/backfill-cost-event-rate-card.ts --apply    # writes
 *
 * Idempotent: re-running recomputes the same values from the same tokens.
 *
 * KNOWN UNDERSTATEMENT on pre-migration rows. Before this change, cache-creation
 * tokens were summed into `input_tokens` and never stored separately, and the
 * migration defaults `cache_write_tokens` to 0. Those tokens are therefore
 * priced here at the ordinary input rate rather than the 1.25x cache-write
 * premium, so historical `rate_card_cents` is slightly low.
 *
 * This is not recoverable: the split was never recorded, and any correction
 * would be a guessed ratio dressed up as data. A rate card that is slightly low
 * and honest about it beats one that is invented. Rows written after this change
 * carry a real `cache_write_tokens` and are priced exactly. The affected span is
 * bounded and shrinking, and the figure is notional in the first place — it
 * never reaches `cost_cents`, so nothing downstream of cash is affected.
 */
import { deriveRateCardCents } from "@paperclipai/shared";
import postgres from "postgres";

interface CostEventRow {
  id: string;
  model: string;
  occurred_at: Date;
  cost_cents: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cost_status: string;
  rate_card_cents: number;
}

type Resolution = { rateCardCents: number; costStatus: string };

/**
 * Mirrors `resolveLedgerCostStatus` in the heartbeat service, reading the
 * persisted `cost_cents` as the stand-in for a provider-reported cost (the raw
 * `costUsd` is not retained on the row).
 */
export function resolveBackfill(row: {
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  model: string;
  occurredAt: Date;
}): Resolution {
  const hasTokenUsage =
    row.inputTokens > 0 || row.cachedInputTokens > 0 || row.outputTokens > 0 || row.cacheWriteTokens > 0;

  const derivedCents = deriveRateCardCents(
    row.model,
    {
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      outputTokens: row.outputTokens,
      cacheWriteTokens: row.cacheWriteTokens,
    },
    row.occurredAt,
  );

  // No tokens means there is nothing to price and nothing to misrepresent.
  if (!hasTokenUsage) return { rateCardCents: 0, costStatus: "reported" };

  // A provider that billed real money reported a credible cost; keep the label
  // and populate the rate card alongside it as a cross-check.
  if (row.costCents > 0) return { rateCardCents: derivedCents ?? 0, costStatus: "reported" };

  // Tokens but no cash and no rate for the model: an honest gap, not a zero.
  if (derivedCents === null) return { rateCardCents: 0, costStatus: "unpriced" };

  return { rateCardCents: derivedCents, costStatus: "derived" };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const sql = postgres(connectionString, { max: 1 });
  try {
    const rows = (await sql`
      select id, model, occurred_at, cost_cents, input_tokens, cached_input_tokens,
             output_tokens, cache_write_tokens, cost_status, rate_card_cents
      from cost_events
    `) as unknown as CostEventRow[];

    const updates: Array<{ id: string; resolution: Resolution }> = [];
    const byStatus = new Map<string, { rows: number; cents: number }>();

    for (const row of rows) {
      const resolution = resolveBackfill({
        costCents: Number(row.cost_cents),
        inputTokens: Number(row.input_tokens),
        cachedInputTokens: Number(row.cached_input_tokens),
        outputTokens: Number(row.output_tokens),
        cacheWriteTokens: Number(row.cache_write_tokens),
        model: row.model,
        occurredAt: new Date(row.occurred_at),
      });

      const tally = byStatus.get(resolution.costStatus) ?? { rows: 0, cents: 0 };
      tally.rows += 1;
      tally.cents += resolution.rateCardCents;
      byStatus.set(resolution.costStatus, tally);

      const unchanged =
        resolution.costStatus === row.cost_status && resolution.rateCardCents === Number(row.rate_card_cents);
      if (!unchanged) updates.push({ id: row.id, resolution });
    }

    const foldedCacheWriteRows = rows.filter(
      (row) => Number(row.cache_write_tokens) === 0 && Number(row.input_tokens) > 0,
    ).length;

    console.log(`Scanned ${rows.length} cost_events row(s).`);
    for (const [status, tally] of [...byStatus.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
      console.log(`  ${status.padEnd(9)} ${String(tally.rows).padStart(6)} rows  rate card $${(tally.cents / 100).toFixed(2)}`);
    }
    console.log(`${updates.length} row(s) need updating.`);
    if (foldedCacheWriteRows > 0) {
      console.log(
        `Note: ${foldedCacheWriteRows} row(s) have cache_write_tokens=0 with non-zero input_tokens. ` +
          "Rows written before cache writes were recorded separately fold those tokens into " +
          "input_tokens, so they are priced at the input rate rather than the 1.25x cache-write " +
          "premium. Their rate card is therefore a slight underestimate. This is not recoverable " +
          "from stored data. cost_cents is unaffected.",
      );
    }

    if (!apply) {
      console.log("Dry run. Re-run with --apply to write.");
      return;
    }

    // Chunked so a large history does not build one enormous statement.
    const CHUNK = 500;
    let written = 0;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      await sql.begin(async (tx) => {
        for (const update of chunk) {
          await tx`
            update cost_events
            set rate_card_cents = ${update.resolution.rateCardCents},
                cost_status = ${update.resolution.costStatus}
            where id = ${update.id}
          `;
        }
      });
      written += chunk.length;
      console.log(`  updated ${written}/${updates.length}`);
    }
    console.log("Backfill complete.");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
