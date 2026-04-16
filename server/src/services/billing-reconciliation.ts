/**
 * Layer 3 — Anthropic Admin API reconciliation (daily cron).
 *
 * Compares Paperclip-recorded cost_events vs Anthropic's org-level usage
 * report. Writes one row per company per day to billing_reconciliation and
 * alerts on drift > 10%.
 *
 * Requires ANTHROPIC_ADMIN_API_KEY env var. Without it, this service logs a
 * warning and becomes a no-op.
 *
 * ## Metadata tagging constraint
 *
 * The Paperclip CLI owns all Anthropic API calls, which means attaching
 * metadata.user_id = "paperclip:agent:<id>:run:<id>" to each request is not
 * feasible in the current architecture. The Anthropic usage report therefore
 * cannot be broken down per agent on our side. Reconciliation is consequently
 * performed at company (org) level only — one row per day with agentId = null.
 *
 * Per-agent reconciliation is deferred until metadata tagging can be wired
 * into the adapter layer.
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { billingReconciliation, costEvents } from "@paperclipai/db";
import { computeEquivalentCostCents, calculateDriftPct } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const ANTHROPIC_USAGE_API = "https://api.anthropic.com/v1/organizations/usage_report/messages";
const DRIFT_ALERT_THRESHOLD_PCT = 10;

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type AnthropicUsageRow = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  model: string;
};

async function fetchAnthropicOrgUsageForDay(
  adminApiKey: string,
  dateStr: string,
): Promise<AnthropicUsageRow[]> {
  const nextDay = new Date(dateStr);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const endStr = utcDateString(nextDay);

  const results: AnthropicUsageRow[] = [];
  let nextPage: string | null = null;

  do {
    const params = new URLSearchParams({ starting_at: dateStr, ending_at: endStr });
    if (nextPage) params.set("page", nextPage);

    const resp = await fetch(`${ANTHROPIC_USAGE_API}?${params.toString()}`, {
      headers: {
        "x-api-key": adminApiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, date: dateStr }, "Anthropic Admin API usage request failed");
      break;
    }

    const body = await resp.json() as Record<string, unknown>;
    const data = Array.isArray(body.data) ? body.data : [];
    nextPage = typeof body.next_page === "string" ? body.next_page : null;

    for (const row of data) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      results.push({
        model: typeof r.model === "string" ? r.model : "unknown",
        inputTokens: typeof r.input_tokens === "number" ? r.input_tokens : 0,
        cachedInputTokens: typeof r.cache_read_input_tokens === "number" ? r.cache_read_input_tokens : 0,
        cacheCreationInputTokens: typeof r.cache_creation_input_tokens === "number" ? r.cache_creation_input_tokens : 0,
        outputTokens: typeof r.output_tokens === "number" ? r.output_tokens : 0,
      });
    }
  } while (nextPage);

  return results;
}

export function billingReconciliationService(db: Db) {
  return {
    runDailyReconciliation: async (companyId: string): Promise<void> => {
      const adminApiKey = process.env.ANTHROPIC_ADMIN_API_KEY;
      if (!adminApiKey) {
        logger.warn(
          "ANTHROPIC_ADMIN_API_KEY not set — skipping Anthropic console reconciliation (Layer 3). " +
          "Provide the key to enable org-level drift detection.",
        );
        return;
      }

      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const dateStr = utcDateString(yesterday);
      const dayStart = new Date(`${dateStr}T00:00:00Z`);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);

      logger.info({ date: dateStr, companyId }, "Starting Anthropic billing reconciliation (org level)");

      let anthropicRows: AnthropicUsageRow[];
      try {
        anthropicRows = await fetchAnthropicOrgUsageForDay(adminApiKey, dateStr);
      } catch (err) {
        logger.error({ err, date: dateStr }, "Failed to fetch Anthropic usage report");
        return;
      }

      // Sum all Anthropic rows for the org into a single cost figure
      let anthropicCents = 0;
      for (const row of anthropicRows) {
        anthropicCents += computeEquivalentCostCents(
          {
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            cacheCreationInputTokens: row.cacheCreationInputTokens,
            outputTokens: row.outputTokens,
          },
          row.model,
        );
      }

      // Sum Paperclip cost_events for the entire company for the same day
      const [paperclipRow] = await db
        .select({
          cents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, dayStart),
            lt(costEvents.occurredAt, dayEnd),
          ),
        );

      const paperclipCents = Number(paperclipRow?.cents ?? 0);
      const driftPct = calculateDriftPct(paperclipCents, anthropicCents);

      await db
        .insert(billingReconciliation)
        .values({
          date: dateStr,
          agentId: null,
          companyId,
          paperclipCents,
          anthropicCents,
          driftPct: driftPct.toFixed(2),
          rawAnthropicRow: { rowCount: anthropicRows.length },
        })
        .onConflictDoUpdate({
          target: [billingReconciliation.date, billingReconciliation.companyId],
          set: {
            paperclipCents,
            anthropicCents,
            driftPct: driftPct.toFixed(2),
            rawAnthropicRow: { rowCount: anthropicRows.length },
          },
        });

      if (driftPct > DRIFT_ALERT_THRESHOLD_PCT) {
        logger.warn(
          { date: dateStr, companyId, paperclipCents, anthropicCents, driftPct: driftPct.toFixed(1) },
          `Billing reconciliation: org-level drift ${driftPct.toFixed(1)}% exceeds ${DRIFT_ALERT_THRESHOLD_PCT}% threshold. ` +
          "Check billing_reconciliation table.",
        );
      } else {
        logger.info(
          { date: dateStr, companyId, paperclipCents, anthropicCents, driftPct: driftPct.toFixed(1) },
          "Billing reconciliation complete — within drift threshold",
        );
      }
    },
  };
}
