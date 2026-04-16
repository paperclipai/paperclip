/**
 * Layer 3 — Anthropic Admin API reconciliation (daily cron).
 *
 * Compares Paperclip-recorded cost_events vs Anthropic's org-level usage report
 * (grouped by metadata.user_id = "paperclip:agent:<agentId>:run:<runId>").
 * Writes results to billing_reconciliation and alerts on drift > 10%.
 *
 * Requires ANTHROPIC_ADMIN_API_KEY env var scoped to the usage_report endpoint.
 * Without it this service logs a warning and becomes a no-op.
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, billingReconciliation, costEvents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const ANTHROPIC_USAGE_API = "https://api.anthropic.com/v1/organizations/usage_report/messages";
const DRIFT_ALERT_THRESHOLD_PCT = 10;

// Pricing table mirrored from heartbeat.ts — kept in sync manually.
const MODEL_PRICING: Record<string, { inputPerMtok: number; outputPerMtok: number }> = {
  "claude-opus-4": { inputPerMtok: 15, outputPerMtok: 75 },
  "claude-opus-4-5": { inputPerMtok: 15, outputPerMtok: 75 },
  "claude-sonnet-4-5": { inputPerMtok: 3, outputPerMtok: 15 },
  "claude-sonnet-4-6": { inputPerMtok: 3, outputPerMtok: 15 },
  "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5 },
  "claude-haiku-4-5-20251001": { inputPerMtok: 1, outputPerMtok: 5 },
};

function resolvePricing(model: string): { inputPerMtok: number; outputPerMtok: number } {
  const norm = model.toLowerCase().trim();
  if (MODEL_PRICING[norm]) return MODEL_PRICING[norm]!;
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (norm.startsWith(key)) return pricing;
  }
  return { inputPerMtok: 15, outputPerMtok: 75 };
}

function tokensToCents(
  inputTokens: number,
  cachedInputTokens: number,
  cacheCreationInputTokens: number,
  outputTokens: number,
  model: string,
): number {
  const p = resolvePricing(model);
  return Math.round(
    (inputTokens / 1_000_000) * p.inputPerMtok * 100 +
    (cachedInputTokens / 1_000_000) * p.inputPerMtok * 0.1 * 100 +
    (cacheCreationInputTokens / 1_000_000) * p.inputPerMtok * 1.25 * 100 +
    (outputTokens / 1_000_000) * p.outputPerMtok * 100,
  );
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchAnthropicUsageForDay(
  adminApiKey: string,
  dateStr: string,
): Promise<Array<{ agentId: string; inputTokens: number; cachedInputTokens: number; cacheCreationInputTokens: number; outputTokens: number; model: string; raw: Record<string, unknown> }>> {
  const nextDay = new Date(dateStr);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const endStr = utcDateString(nextDay);

  const results: Array<{ agentId: string; inputTokens: number; cachedInputTokens: number; cacheCreationInputTokens: number; outputTokens: number; model: string; raw: Record<string, unknown> }> = [];
  let nextPage: string | null = null;

  do {
    const params = new URLSearchParams({
      starting_at: dateStr,
      ending_at: endStr,
    });
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

      const metadataUserId = typeof r.metadata === "object" && r.metadata !== null
        ? (r.metadata as Record<string, unknown>).user_id
        : null;

      if (typeof metadataUserId !== "string") continue;

      // Expected format: "paperclip:agent:<agentId>:run:<runId>"
      const match = /^paperclip:agent:([^:]+):run:/.exec(metadataUserId);
      if (!match) continue;
      const agentId = match[1]!;

      const model = typeof r.model === "string" ? r.model : "unknown";
      const inputTokens = typeof r.input_tokens === "number" ? r.input_tokens : 0;
      const cachedInputTokens = typeof r.cache_read_input_tokens === "number" ? r.cache_read_input_tokens : 0;
      const cacheCreationInputTokens = typeof r.cache_creation_input_tokens === "number" ? r.cache_creation_input_tokens : 0;
      const outputTokens = typeof r.output_tokens === "number" ? r.output_tokens : 0;

      results.push({ agentId, inputTokens, cachedInputTokens, cacheCreationInputTokens, outputTokens, model, raw: r });
    }
  } while (nextPage);

  return results;
}

export function billingReconciliationService(db: Db) {
  return {
    /**
     * Run the daily reconciliation for yesterday UTC.
     * Called from the server startup scheduler.
     */
    runDailyReconciliation: async (companyId: string): Promise<void> => {
      const adminApiKey = process.env.ANTHROPIC_ADMIN_API_KEY;
      if (!adminApiKey) {
        logger.warn(
          "ANTHROPIC_ADMIN_API_KEY not set — skipping Anthropic console reconciliation (Layer 3). " +
          "Provide the key to enable drift detection between Paperclip cost_events and Anthropic usage reports.",
        );
        return;
      }

      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const dateStr = utcDateString(yesterday);
      const dayStart = new Date(`${dateStr}T00:00:00Z`);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);

      logger.info({ date: dateStr, companyId }, "Starting Anthropic billing reconciliation");

      // Fetch Anthropic side
      let anthropicRows: Awaited<ReturnType<typeof fetchAnthropicUsageForDay>>;
      try {
        anthropicRows = await fetchAnthropicUsageForDay(adminApiKey, dateStr);
      } catch (err) {
        logger.error({ err, date: dateStr }, "Failed to fetch Anthropic usage report");
        return;
      }

      // Aggregate Anthropic data by agent
      const anthropicByAgent = new Map<string, { cents: number; raw: Record<string, unknown> }>();
      for (const row of anthropicRows) {
        const prev = anthropicByAgent.get(row.agentId) ?? { cents: 0, raw: row.raw };
        const rowCents = tokensToCents(row.inputTokens, row.cachedInputTokens, row.cacheCreationInputTokens, row.outputTokens, row.model);
        anthropicByAgent.set(row.agentId, { cents: prev.cents + rowCents, raw: row.raw });
      }

      // Fetch Paperclip side — sum cost_events for the same day
      const paperclipRows = await db
        .select({
          agentId: costEvents.agentId,
          cents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, dayStart),
            lt(costEvents.occurredAt, dayEnd),
          ),
        )
        .groupBy(costEvents.agentId);

      const paperclipByAgent = new Map<string, number>(
        paperclipRows.map((r) => [r.agentId, Number(r.cents)]),
      );

      // Get all known agent IDs in this company
      const companyAgents = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      const allAgentIds = new Set([
        ...companyAgents.map((a) => a.id),
        ...anthropicByAgent.keys(),
      ]);

      const alerts: string[] = [];

      for (const agentId of allAgentIds) {
        const paperclipCents = paperclipByAgent.get(agentId) ?? 0;
        const anthropicEntry = anthropicByAgent.get(agentId);
        const anthropicCents = anthropicEntry?.cents ?? 0;
        const rawAnthropicRow = anthropicEntry?.raw ?? {};

        const driftPct =
          anthropicCents > 0
            ? ((Math.abs(paperclipCents - anthropicCents) / anthropicCents) * 100)
            : paperclipCents > 0
              ? 100
              : 0;

        await db
          .insert(billingReconciliation)
          .values({
            date: dateStr,
            agentId,
            companyId,
            paperclipCents,
            anthropicCents,
            driftPct: driftPct.toFixed(2),
            rawAnthropicRow,
          })
          .onConflictDoUpdate({
            target: [billingReconciliation.date, billingReconciliation.agentId],
            set: {
              paperclipCents,
              anthropicCents,
              driftPct: driftPct.toFixed(2),
              rawAnthropicRow,
            },
          });

        if (driftPct > DRIFT_ALERT_THRESHOLD_PCT) {
          alerts.push(
            `Agent ${agentId}: Paperclip=${paperclipCents}¢ Anthropic=${anthropicCents}¢ drift=${driftPct.toFixed(1)}%`,
          );
        }
      }

      if (alerts.length > 0) {
        logger.warn(
          { date: dateStr, companyId, alerts },
          `Billing reconciliation: drift > ${DRIFT_ALERT_THRESHOLD_PCT}% detected for ${alerts.length} agent(s). ` +
          "Check billing_reconciliation table for details.",
        );
      } else {
        logger.info({ date: dateStr, companyId, agentCount: allAgentIds.size }, "Billing reconciliation complete — all agents within drift threshold");
      }
    },
  };
}
