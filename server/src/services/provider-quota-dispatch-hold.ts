import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  providerQuotaDispatchHolds,
} from "@paperclipai/db";

type Agent = typeof agents.$inferSelect;
type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

export const PROVIDER_QUOTA_HOLD_RETRY_REASON = "provider_quota_hold";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const ADAPTER_PROVIDERS: Record<string, string> = {
  claude_local: "anthropic",
  codex_local: "openai",
  gemini_local: "google",
  grok_local: "xai",
  opencode_local: "openrouter",
};

/**
 * A quota hold follows the provider account boundary available before process
 * startup. Local adapters use their host login, while multiplexed adapters
 * include the configured provider/ACP agent so unrelated providers continue.
 */
export function providerQuotaScopeForAgent(agent: Pick<Agent, "adapterType" | "adapterConfig">) {
  const config = objectValue(agent.adapterConfig);
  const provider =
    nonEmptyString(config.provider) ?? ADAPTER_PROVIDERS[agent.adapterType] ?? null;
  const acpxAgent = nonEmptyString(config.acpxAgent);
  const scopeKey = JSON.stringify({
    adapterType: agent.adapterType,
    ...(provider ? { provider } : {}),
    ...(acpxAgent ? { acpxAgent } : {}),
  });
  return { scopeKey, provider };
}

export function providerQuotaResetAtFromRun(
  run: Pick<HeartbeatRun, "errorCode" | "resultJson">,
  now = new Date(),
): Date | null {
  const result = objectValue(run.resultJson);
  const family = nonEmptyString(result.errorFamily);
  if (run.errorCode !== "provider_quota" && family !== "provider_quota") return null;
  const raw =
    result.providerQuotaRetryNotBefore ??
    result.retryNotBefore ??
    result.transientRetryNotBefore;
  if (!(typeof raw === "string" || typeof raw === "number" || raw instanceof Date))
    return null;
  const parsed = new Date(raw);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()
    ? parsed
    : null;
}

export async function recordProviderQuotaDispatchHold(
  db: Db,
  input: { run: HeartbeatRun; agent: Agent; now?: Date },
) {
  const now = input.now ?? new Date();
  const holdUntil = providerQuotaResetAtFromRun(input.run, now);
  if (!holdUntil) return null;
  const scope = providerQuotaScopeForAgent(input.agent);
  const evidence = {
    sourceRunId: input.run.id,
    errorCode: input.run.errorCode,
    holdUntil: holdUntil.toISOString(),
  };
  const [hold] = await db
    .insert(providerQuotaDispatchHolds)
    .values({
      companyId: input.run.companyId,
      scopeKey: scope.scopeKey,
      adapterType: input.agent.adapterType,
      provider: scope.provider,
      sourceRunId: input.run.id,
      holdUntil,
      evidence,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        providerQuotaDispatchHolds.companyId,
        providerQuotaDispatchHolds.scopeKey,
      ],
      set: {
        adapterType: input.agent.adapterType,
        provider: scope.provider,
        sourceRunId: sql`case
          when excluded.hold_until >= ${providerQuotaDispatchHolds.holdUntil}
            then excluded.source_run_id
          else ${providerQuotaDispatchHolds.sourceRunId}
        end`,
        holdUntil: sql`greatest(${providerQuotaDispatchHolds.holdUntil}, excluded.hold_until)`,
        evidence: sql`case
          when excluded.hold_until >= ${providerQuotaDispatchHolds.holdUntil}
            then excluded.evidence
          else ${providerQuotaDispatchHolds.evidence}
        end`,
        releasedAt: null,
        releaseReason: null,
        updatedAt: now,
      },
    })
    .returning();
  return hold ?? null;
}

/**
 * Atomically checks the provider hold and parks a queued run at its reset
 * instant. Expiry is also committed here, so an elapsed hold cannot become a
 * permanent provider outage.
 */
export async function deferQueuedRunForProviderQuotaHold(
  db: Db,
  input: { run: HeartbeatRun; agent: Agent; now?: Date },
) {
  const now = input.now ?? new Date();
  const scope = providerQuotaScopeForAgent(input.agent);
  return db.transaction(async (tx) => {
    const hold = await tx
      .select()
      .from(providerQuotaDispatchHolds)
      .where(
        and(
          eq(providerQuotaDispatchHolds.companyId, input.run.companyId),
          eq(providerQuotaDispatchHolds.scopeKey, scope.scopeKey),
          isNull(providerQuotaDispatchHolds.releasedAt),
        ),
      )
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!hold) return null;

    if (hold.holdUntil.getTime() <= now.getTime()) {
      await tx
        .update(providerQuotaDispatchHolds)
        .set({
          releasedAt: now,
          releaseReason: "reset_elapsed",
          updatedAt: now,
        })
        .where(eq(providerQuotaDispatchHolds.id, hold.id));
      return null;
    }

    const [deferred] = await tx
      .update(heartbeatRuns)
      .set({
        status: "scheduled_retry",
        scheduledRetryAt: hold.holdUntil,
        scheduledRetryReason: PROVIDER_QUOTA_HOLD_RETRY_REASON,
        contextSnapshot: {
          ...objectValue(input.run.contextSnapshot),
          providerQuotaHoldUntil: hold.holdUntil.toISOString(),
        },
        resultJson: {
          ...objectValue(input.run.resultJson),
          providerQuotaDispatchHold: {
            holdId: hold.id,
            sourceRunId: hold.sourceRunId,
            holdUntil: hold.holdUntil.toISOString(),
          },
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(heartbeatRuns.id, input.run.id),
          eq(heartbeatRuns.companyId, input.run.companyId),
          eq(heartbeatRuns.agentId, input.run.agentId),
          eq(heartbeatRuns.status, "queued"),
        ),
      )
      .returning();
    return deferred ? { run: deferred, hold } : null;
  });
}
