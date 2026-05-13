import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issueRelations, issues, providerRateLimitBlocks } from "@paperclipai/db";
import { fetchAllQuotaWindows } from "./quota-windows.js";

const PROVIDER_RATE_LIMIT_RUN_ERROR_CODES = [
  "claude_hard_limit",
  "codex_hard_limit",
  "provider_rate_limit",
];

const PROVIDER_LIMIT_MATCHING_AGENT_STATUSES = ["active", "idle", "running", "error", "paused"];
const RECOVERY_OPEN_STATUSES = ["todo", "in_progress", "blocked"];

type ProviderRecoveryRow = {
  recoveryIssueId: string;
  sourceIssueId: string | null;
};

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

  async function listDueBlocks(now: Date) {
    return db
      .select()
      .from(providerRateLimitBlocks)
      .where(
        and(
          isNull(providerRateLimitBlocks.resolvedAt),
          lte(providerRateLimitBlocks.resetsAt, now),
        ),
      );
  }

  async function resolveExpiredBlocks(now: Date) {
    return releaseDueBlocks(now).then((result) => result.resolvedBlocks);
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

  async function getActiveBlock(blockId: string) {
    return db
      .select()
      .from(providerRateLimitBlocks)
      .where(and(eq(providerRateLimitBlocks.id, blockId), isNull(providerRateLimitBlocks.resolvedAt)))
      .then((rows) => rows[0] ?? null);
  }

  function agentScopeFilter(
    companyId: string,
    adapterType: string,
    modelFamily: string | null,
  ) {
    const baseFilter = and(
      eq(agents.companyId, companyId),
      eq(agents.adapterType, adapterType),
      inArray(agents.status, PROVIDER_LIMIT_MATCHING_AGENT_STATUSES),
      or(
        sql`${agents.status} <> 'paused'`,
        eq(agents.pauseReason, "provider_rate_limit"),
      ),
    );

    return modelFamily
      ? and(
          baseFilter,
          sql`lower(${agents.adapterConfig}->>'model') LIKE lower(${modelFamily + "%"})`,
        )
      : baseFilter;
  }

  async function listMatchingAgentsForBlock(
    companyId: string,
    adapterType: string,
    modelFamily: string | null,
  ) {
    return db
      .select()
      .from(agents)
      .where(agentScopeFilter(companyId, adapterType, modelFamily));
  }

  async function hasReleasedDueBlockForAgent(
    companyId: string,
    adapterType: string,
    model: string | null,
    now: Date,
  ) {
    const modelFilter = model
      ? or(
          isNull(providerRateLimitBlocks.modelFamily),
          sql`lower(${model}) LIKE lower(${providerRateLimitBlocks.modelFamily} || '%')`,
        )
      : isNull(providerRateLimitBlocks.modelFamily);

    const [block] = await db
      .select({ id: providerRateLimitBlocks.id })
      .from(providerRateLimitBlocks)
      .where(
        and(
          eq(providerRateLimitBlocks.companyId, companyId),
          eq(providerRateLimitBlocks.adapterType, adapterType),
          sql`${providerRateLimitBlocks.resolvedAt} is not null`,
          lte(providerRateLimitBlocks.resetsAt, now),
          modelFilter,
        ),
      )
      .limit(1);
    return Boolean(block);
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
    const matchingAgents = await listMatchingAgentsForBlock(
      block.companyId,
      block.adapterType,
      block.modelFamily,
    );
    const resumedAgents = await resumeAgentsForBlock(
      block.companyId,
      block.adapterType,
      block.modelFamily,
    );

    const matchingAgentIds = matchingAgents.map((a) => a.id);
    if (matchingAgentIds.length === 0) {
      return {
        matchingAgents: 0,
        resumedAgentIds: [] as string[],
        unblockedIssueIds: [] as string[],
        retiredRecoveryIssueIds: [] as string[],
      };
    }

    const now = new Date();
    // Unblock issues that were blocked after the rate limit started and belong to resumed agents.
    const unblockedIssues = await db
      .update(issues)
      .set({ status: "in_progress", updatedAt: now })
      .where(
        and(
          eq(issues.companyId, block.companyId),
          eq(issues.status, "blocked"),
          inArray(issues.assigneeAgentId, matchingAgentIds),
          // Only unblock issues that became blocked after the rate limit was created.
          or(
            isNull(issues.updatedAt),
            sql`${issues.updatedAt} >= ${block.createdAt.toISOString()}::timestamptz`,
          ),
        ),
      )
      .returning({ id: issues.id });

    const providerRecoveryRows = await db
      .select({
        recoveryIssueId: issues.id,
        sourceIssueId: issues.originId,
      })
      .from(issues)
      .innerJoin(heartbeatRuns, sql`${issues.originRunId} = ${heartbeatRuns.id}::text`)
      .where(
        and(
          eq(issues.companyId, block.companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          inArray(issues.status, RECOVERY_OPEN_STATUSES),
          inArray(issues.assigneeAgentId, matchingAgentIds),
          inArray(heartbeatRuns.errorCode, PROVIDER_RATE_LIMIT_RUN_ERROR_CODES),
        ),
      );

    const retiredRecovery = await retireProviderRecoveryRows(block.companyId, providerRecoveryRows, now);

    const unblockedIssueIds = [...new Set([
      ...unblockedIssues.map((issue) => issue.id),
      ...retiredRecovery.sourceIssueIds,
    ])];

    return {
      matchingAgents: matchingAgents.length,
      resumedAgentIds: resumedAgents.map((agent) => agent.id),
      unblockedIssueIds,
      retiredRecoveryIssueIds: retiredRecovery.recoveryIssueIds,
    };
  }

  async function retireProviderRecoveryRows(
    companyId: string,
    rows: ProviderRecoveryRow[],
    now: Date,
  ) {
    const recoveryIssueIds = rows.map((row) => row.recoveryIssueId);
    const sourceIssueIds = rows
      .map((row) => row.sourceIssueId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    if (recoveryIssueIds.length === 0) {
      return {
        recoveryIssueIds,
        sourceIssueIds,
      };
    }

    await db
      .update(issues)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(inArray(issues.id, recoveryIssueIds));

    await db
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.issueId, recoveryIssueIds),
          sourceIssueIds.length > 0
            ? inArray(issueRelations.relatedIssueId, sourceIssueIds)
            : sql`false`,
        ),
      );

    return {
      recoveryIssueIds,
      sourceIssueIds,
    };
  }

  async function cleanupReleasedProviderRecoveryBlockers(now = new Date()) {
    const sourceIssues = alias(issues, "source_issues");
    const runAgents = alias(agents, "run_agents");
    const rows = await db
      .select({
        companyId: issues.companyId,
        recoveryIssueId: issues.id,
        sourceIssueId: issues.originId,
        adapterType: runAgents.adapterType,
        model: sql<string | null>`${runAgents.adapterConfig}->>'model'`,
      })
      .from(issues)
      .innerJoin(heartbeatRuns, sql`${issues.originRunId} = ${heartbeatRuns.id}::text`)
      .innerJoin(runAgents, eq(heartbeatRuns.agentId, runAgents.id))
      .leftJoin(sourceIssues, sql`${issues.originId} = ${sourceIssues.id}::text`)
      .where(
        and(
          eq(issues.originKind, "stranded_issue_recovery"),
          inArray(issues.status, RECOVERY_OPEN_STATUSES),
          inArray(heartbeatRuns.errorCode, PROVIDER_RATE_LIMIT_RUN_ERROR_CODES),
        ),
      );

    const eligibleByCompany = new Map<string, ProviderRecoveryRow[]>();

    for (const row of rows) {
      const activeBlock = await getActiveBlockForAgent(row.companyId, row.adapterType, row.model);
      if (activeBlock) {
        const stillBlocked = await isWindowStillBlocked(activeBlock.adapterType, activeBlock.limitKind, {
          resetsAt: activeBlock.resetsAt,
          now,
        });
        if (stillBlocked) continue;
      } else if (!(await hasReleasedDueBlockForAgent(row.companyId, row.adapterType, row.model, now))) {
        continue;
      }

      const companyRows = eligibleByCompany.get(row.companyId) ?? [];
      companyRows.push({
        recoveryIssueId: row.recoveryIssueId,
        sourceIssueId: row.sourceIssueId,
      });
      eligibleByCompany.set(row.companyId, companyRows);
    }

    const result = {
      checked: rows.length,
      retiredRecoveryIssueIds: [] as string[],
      unblockedIssueIds: [] as string[],
    };

    for (const [companyId, companyRows] of eligibleByCompany) {
      const retired = await retireProviderRecoveryRows(companyId, companyRows, now);
      result.retiredRecoveryIssueIds.push(...retired.recoveryIssueIds);
      result.unblockedIssueIds.push(...retired.sourceIssueIds);
    }

    result.retiredRecoveryIssueIds = [...new Set(result.retiredRecoveryIssueIds)];
    result.unblockedIssueIds = [...new Set(result.unblockedIssueIds)];
    return result;
  }

  async function releaseDueBlocks(now: Date) {
    const dueBlocks = await listDueBlocks(now);
    const result = {
      checked: dueBlocks.length,
      released: 0,
      stillBlocked: 0,
      resolvedBlocks: [] as Array<typeof providerRateLimitBlocks.$inferSelect>,
      unblockedIssueIds: [] as string[],
      retiredRecoveryIssueIds: [] as string[],
    };

    for (const block of dueBlocks) {
      const stillBlocked = await isWindowStillBlocked(block.adapterType, block.limitKind, {
        resetsAt: block.resetsAt,
        now,
      });
      if (stillBlocked) {
        result.stillBlocked += 1;
        continue;
      }

      const resolved = await resolveBlock(block.id, "system");
      if (!resolved) continue;
      const releaseResult = await releaseAndResumeForBlock(resolved);
      result.released += 1;
      result.resolvedBlocks.push(resolved);
      result.unblockedIssueIds.push(...releaseResult.unblockedIssueIds);
      result.retiredRecoveryIssueIds.push(...releaseResult.retiredRecoveryIssueIds);
    }

    result.unblockedIssueIds = [...new Set(result.unblockedIssueIds)];
    result.retiredRecoveryIssueIds = [...new Set(result.retiredRecoveryIssueIds)];
    return result;
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
    getActiveBlock,
    listActiveBlocks,
    listDueBlocks,
    releaseDueBlocks,
    cleanupReleasedProviderRecoveryBlockers,
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
