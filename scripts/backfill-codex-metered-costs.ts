import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  agentRuntimeState,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import type { BillingType } from "@paperclipai/shared";
import { resolveBilledCost, type CostUsageTotals } from "../server/src/services/cost-estimation.js";

function parseArgs(argv: string[]) {
  const companyId = argv.find((arg) => arg.startsWith("--company-id="))?.slice("--company-id=".length) ?? null;
  const apply = argv.includes("--apply");
  if (!companyId) {
    throw new Error("Missing required --company-id=<uuid>");
  }
  return { companyId, apply };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readRawUsageTotals(usageJson: unknown): CostUsageTotals | null {
  const parsed = asRecord(usageJson);
  if (!parsed) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

async function main() {
  const { companyId, apply } = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const db = createDb(databaseUrl);

  const runs = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
      startedAt: heartbeatRuns.startedAt,
      usageJson: heartbeatRuns.usageJson,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, companyId))
    .orderBy(asc(heartbeatRuns.agentId), asc(heartbeatRuns.startedAt));

  const previousRawUsageByRunId = new Map<string, CostUsageTotals | null>();
  const latestRawUsageBySessionKey = new Map<string, CostUsageTotals>();

  for (const run of runs) {
    const sessionId = typeof run.sessionIdAfter === "string" && run.sessionIdAfter.trim().length > 0
      ? run.sessionIdAfter.trim()
      : null;
    const sessionKey = sessionId ? `${run.agentId}:${sessionId}` : null;
    previousRawUsageByRunId.set(run.id, sessionKey ? latestRawUsageBySessionKey.get(sessionKey) ?? null : null);

    const rawUsage = readRawUsageTotals(run.usageJson);
    if (sessionKey && rawUsage) {
      latestRawUsageBySessionKey.set(sessionKey, rawUsage);
    }
  }

  const runsById = new Map(runs.map((run) => [run.id, run]));

  const events = await db
    .select({
      id: costEvents.id,
      agentId: costEvents.agentId,
      heartbeatRunId: costEvents.heartbeatRunId,
      provider: costEvents.provider,
      biller: costEvents.biller,
      model: costEvents.model,
      billingType: costEvents.billingType,
      inputTokens: costEvents.inputTokens,
      cachedInputTokens: costEvents.cachedInputTokens,
      outputTokens: costEvents.outputTokens,
      costCents: costEvents.costCents,
    })
    .from(costEvents)
    .where(and(
      eq(costEvents.companyId, companyId),
      eq(costEvents.billingType, "metered_api"),
      eq(costEvents.costCents, 0),
    ))
    .orderBy(desc(costEvents.occurredAt));

  let estimatedEvents = 0;
  let estimatedCents = 0;
  const updates: Array<{ id: string; costCents: number }> = [];
  const affectedAgentIds = new Set<string>();

  for (const event of events) {
    const usage: CostUsageTotals = {
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
    };
    const run = event.heartbeatRunId ? runsById.get(event.heartbeatRunId) ?? null : null;
    const rawUsage = run ? readRawUsageTotals(run.usageJson) : null;
    const previousRawUsage = run ? previousRawUsageByRunId.get(run.id) ?? null : null;
    const resolved = resolveBilledCost({
      providerCostUsd: null,
      provider: event.provider,
      biller: event.biller,
      model: event.model,
      billingType: event.billingType as BillingType,
      usage,
      rawUsage,
      previousRawUsage,
    });

    if (resolved.costCents <= 0) continue;
    updates.push({ id: event.id, costCents: resolved.costCents });
    affectedAgentIds.add(event.agentId);
    estimatedEvents += 1;
    estimatedCents += resolved.costCents;
  }

  console.log(JSON.stringify({
    companyId,
    apply,
    scannedEvents: events.length,
    estimatedEvents,
    estimatedCents,
  }, null, 2));

  if (!apply || updates.length === 0) return;

  for (const update of updates) {
    await db
      .update(costEvents)
      .set({ costCents: update.costCents })
      .where(eq(costEvents.id, update.id));
  }

  for (const agentId of affectedAgentIds) {
    const sumRow = await db
      .select({
        totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), eq(costEvents.agentId, agentId)))
      .then((rows) => rows[0] ?? { totalCostCents: 0 });

    await db
      .update(agentRuntimeState)
      .set({
        totalCostCents: sumRow.totalCostCents,
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentRuntimeState.companyId, companyId),
        eq(agentRuntimeState.agentId, agentId),
      ));
  }

  console.log(JSON.stringify({
    companyId,
    updatedEvents: updates.length,
    affectedAgents: affectedAgentIds.size,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
