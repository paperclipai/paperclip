import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, providerRateLimitBlocks } from "@paperclipai/db";
import { fetchAllQuotaWindows } from "./quota-windows.js";

function hasPositiveMoneyValue(label: string | null | undefined): boolean {
  if (!label) return false;
  const match = label.match(/(?:\$|€|£)?\s*(\d+(?:\.\d+)?)/);
  if (!match) return false;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0;
}

function windowShowsUsablePaidOverflow(window: {
  windowId?: string | null;
  label: string;
  valueLabel?: string | null;
  detail?: string | null;
  usedPercent?: number | null;
}): boolean {
  const windowId = window.windowId?.toLowerCase() ?? "";
  const label = window.label.toLowerCase();
  const valueLabel = window.valueLabel?.toLowerCase() ?? "";
  const detail = window.detail?.toLowerCase() ?? "";

  if (windowId === "extra_usage" || label.includes("extra usage")) {
    if (valueLabel.includes("not enabled") || detail.includes("not enabled")) return false;
    if (window.usedPercent == null) return hasPositiveMoneyValue(window.valueLabel);
    return window.usedPercent < 100;
  }

  if (windowId === "credits" || label.includes("credits")) {
    if (valueLabel.includes("n/a") || valueLabel.includes("not enabled")) return false;
    return hasPositiveMoneyValue(window.valueLabel);
  }

  return false;
}

export function providerRateLimitService(db: Db) {
  async function upsertBlock(input: {
    companyId: string;
    adapterType: string;
    limitKind: string;
    modelFamily: string | null;
    message: string | null;
    resetsAt: Date | null;
  }) {
    const now = new Date();
    const scopeFilter = and(
      eq(providerRateLimitBlocks.companyId, input.companyId),
      eq(providerRateLimitBlocks.adapterType, input.adapterType),
      eq(providerRateLimitBlocks.limitKind, input.limitKind),
      input.modelFamily
        ? eq(providerRateLimitBlocks.modelFamily, input.modelFamily)
        : isNull(providerRateLimitBlocks.modelFamily),
      isNull(providerRateLimitBlocks.resolvedAt),
    );

    const existing = await db
      .select()
      .from(providerRateLimitBlocks)
      .where(scopeFilter)
      .then((rows) => rows[0] ?? null);
    if (existing) {
      const [updated] = await db
        .update(providerRateLimitBlocks)
        .set({
          message: input.message ?? existing.message,
          resetsAt: input.resetsAt ?? existing.resetsAt,
          updatedAt: now,
        })
        .where(eq(providerRateLimitBlocks.id, existing.id))
        .returning();
      return updated ?? existing;
    }

    const [block] = await db
      .insert(providerRateLimitBlocks)
      .values({
        companyId: input.companyId,
        adapterType: input.adapterType,
        limitKind: input.limitKind,
        modelFamily: input.modelFamily,
        message: input.message,
        resetsAt: input.resetsAt,
        updatedAt: now,
      })
      .returning();
    return block!;
  }

  async function getActiveBlockForAgent(
    companyId: string,
    adapterType: string,
    model: string | null,
  ) {
    const blocks = await db
      .select()
      .from(providerRateLimitBlocks)
      .where(
        and(
          eq(providerRateLimitBlocks.companyId, companyId),
          eq(providerRateLimitBlocks.adapterType, adapterType),
          isNull(providerRateLimitBlocks.resolvedAt),
        ),
      );

    // A block matches if modelFamily is null (global) or if the agent's model starts with modelFamily.
    for (const block of blocks) {
      if (!block.modelFamily) return block;
      if (model && model.toLowerCase().startsWith(block.modelFamily.toLowerCase())) return block;
    }
    return null;
  }

  async function listActiveBlocks(companyId: string) {
    return db
      .select()
      .from(providerRateLimitBlocks)
      .where(
        and(
          eq(providerRateLimitBlocks.companyId, companyId),
          isNull(providerRateLimitBlocks.resolvedAt),
        ),
      );
  }

  async function resolveExpiredBlocks(now: Date) {
    return db
      .update(providerRateLimitBlocks)
      .set({ resolvedAt: now, resolvedBy: "system", updatedAt: now })
      .where(
        and(
          isNull(providerRateLimitBlocks.resolvedAt),
          lt(providerRateLimitBlocks.resetsAt, now),
        ),
      )
      .returning();
  }

  async function resolveBlock(blockId: string, resolvedBy: string) {
    const now = new Date();
    const [block] = await db
      .update(providerRateLimitBlocks)
      .set({ resolvedAt: now, resolvedBy, updatedAt: now })
      .where(
        and(
          eq(providerRateLimitBlocks.id, blockId),
          isNull(providerRateLimitBlocks.resolvedAt),
        ),
      )
      .returning();
    return block ?? null;
  }

  async function pauseAgentsForBlock(
    companyId: string,
    adapterType: string,
    modelFamily: string | null,
  ) {
    const now = new Date();
    const baseFilter = and(
      eq(agents.companyId, companyId),
      eq(agents.adapterType, adapterType),
      inArray(agents.status, ["active", "idle", "running", "error"]),
    );

    const filter = modelFamily
      ? and(
          baseFilter,
          sql`lower(${agents.adapterConfig}->>'model') LIKE lower(${modelFamily + "%"})`,
        )
      : baseFilter;

    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "provider_rate_limit", pausedAt: now, updatedAt: now })
      .where(filter);
  }

  async function resumeAgentsForBlock(
    companyId: string,
    adapterType: string,
    modelFamily: string | null,
  ) {
    const now = new Date();
    const baseFilter = and(
      eq(agents.companyId, companyId),
      eq(agents.adapterType, adapterType),
      eq(agents.status, "paused"),
      eq(agents.pauseReason, "provider_rate_limit"),
    );

    const filter = modelFamily
      ? and(
          baseFilter,
          sql`lower(${agents.adapterConfig}->>'model') LIKE lower(${modelFamily + "%"})`,
        )
      : baseFilter;

    return db
      .update(agents)
      .set({ status: "idle", pauseReason: null, pausedAt: null, updatedAt: now })
      .where(filter)
      .returning();
  }

  async function isWindowStillBlocked(
    adapterType: string,
    limitKind: string,
    opts?: { resetsAt?: Date | null; now?: Date },
  ): Promise<boolean> {
    const now = opts?.now ?? new Date();
    const resetIsFuture = opts?.resetsAt ? opts.resetsAt.getTime() > now.getTime() : false;
    try {
      const results = await fetchAllQuotaWindows();
      const providerSlug = adapterType === "claude_local" ? "anthropic" : adapterType === "codex_local" ? "openai" : adapterType;
      const providerResult = results.find((r) => r.provider === providerSlug);
      if (!providerResult?.ok) return true; // Cannot verify → assume still blocked
      if (providerResult.windows.some(windowShowsUsablePaidOverflow)) return false;
      const window = providerResult.windows.find((w) => w.windowId === limitKind);
      if (!window) return resetIsFuture; // Future provider reset remains authoritative when the quota API omits the window.
      return (window.usedPercent ?? 0) >= 100;
    } catch {
      return true; // Quota probe failed → assume still blocked
    }
  }

  async function releaseAndResumeForBlock(
    block: typeof providerRateLimitBlocks.$inferSelect,
  ) {
    const resumedAgents = await resumeAgentsForBlock(
      block.companyId,
      block.adapterType,
      block.modelFamily,
    );
    if (resumedAgents.length === 0) return;

    const resumedAgentIds = resumedAgents.map((a) => a.id);
    const now = new Date();
    // Unblock issues that were blocked after the rate limit started and belong to resumed agents.
    await db
      .update(issues)
      .set({ status: "in_progress", updatedAt: now })
      .where(
        and(
          eq(issues.companyId, block.companyId),
          eq(issues.status, "blocked"),
          inArray(issues.assigneeAgentId, resumedAgentIds),
          // Only unblock issues that became blocked after the rate limit was created.
          or(
            isNull(issues.updatedAt),
            sql`${issues.updatedAt} >= ${block.createdAt.toISOString()}::timestamptz`,
          ),
        ),
      );
  }

  async function deriveBlockScope(
    adapterType: string,
    rateLimitBlock: { limitKind: string; modelFamily: string | null; resetsAt: string | null },
  ): Promise<{ limitKind: string; modelFamily: string | null; resetsAt: Date | null }> {
    let { limitKind, modelFamily } = rateLimitBlock;
    const resetsAt = rateLimitBlock.resetsAt ? new Date(rateLimitBlock.resetsAt) : null;

    // For generic limits, probe quota windows to find the exhausted one.
    if (limitKind === "generic") {
      try {
        const results = await fetchAllQuotaWindows();
        const providerSlug = adapterType === "claude_local" ? "anthropic" : adapterType === "codex_local" ? "openai" : adapterType;
        const providerResult = results.find((r) => r.provider === providerSlug && r.ok);
        if (providerResult) {
          const exhausted = providerResult.windows.find(
            (w) => w.windowId && (w.usedPercent ?? 0) >= 100,
          );
          if (exhausted?.windowId) {
            limitKind = exhausted.windowId;
            // Derive modelFamily from windowId
            if (limitKind === "seven_day_opus") modelFamily = "claude-opus";
            else if (limitKind === "seven_day_sonnet") modelFamily = "claude-sonnet";
            else modelFamily = null;
          }
        }
      } catch {
        // Fall through with generic
      }
    }

    return { limitKind, modelFamily, resetsAt };
  }

  return {
    upsertBlock,
    getActiveBlockForAgent,
    listActiveBlocks,
    resolveExpiredBlocks,
    resolveBlock,
    pauseAgentsForBlock,
    resumeAgentsForBlock,
    isWindowStillBlocked,
    releaseAndResumeForBlock,
    deriveBlockScope,
  };
}

export type ProviderRateLimitService = ReturnType<typeof providerRateLimitService>;
