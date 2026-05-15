import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issues,
  issueRelations,
  providerRateLimitBlockMembers,
  providerRateLimitBlocks,
} from "@paperclipai/db";
import { fetchAllQuotaWindows } from "./quota-windows.js";
import { MODEL_PROFILE_KEYS, type ModelProfileKey, type ProviderQuotaResult, type QuotaWindow } from "@paperclipai/shared";
import { listAdapterModelProfiles } from "../adapters/index.js";

type BlockRow = typeof providerRateLimitBlocks.$inferSelect;

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readModelProfileKey(value: unknown): ModelProfileKey | null {
  return MODEL_PROFILE_KEYS.includes(value as ModelProfileKey)
    ? value as ModelProfileKey
    : null;
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function jitteredWakeTime(blockId: string, agentId: string, now: Date, issueId?: string | null): Date {
  const seed = `${blockId}:${issueId ?? "agent"}:${agentId}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return new Date(now.getTime() + (hash % 30_000));
}

function providerSlugForAdapterType(adapterType: string): string {
  if (adapterType === "claude_local") return "anthropic";
  if (adapterType === "codex_local") return "openai";
  return adapterType;
}

function hasPositiveMoneyValue(label: string | null | undefined): boolean {
  if (!label) return false;
  const match = label.match(/(?:\$|€|£)?\s*(\d+(?:\.\d+)?)/);
  if (!match) return false;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0;
}

function windowShowsUsablePaidOverflow(window: QuotaWindow): boolean {
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

function providerHasUsablePaidOverflow(providerResult: ProviderQuotaResult): boolean {
  return providerResult.windows.some(windowShowsUsablePaidOverflow);
}

export function providerRateLimitService(db: Db) {
  async function writeActivity(input: {
    companyId: string;
    action: string;
    entityId: string;
    agentId?: string | null;
    runId?: string | null;
    details?: Record<string, unknown>;
  }) {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "provider_rate_limit_service",
      action: input.action,
      entityType: "provider_rate_limit_block",
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      details: input.details ?? {},
    });
  }

  async function upsertBlock(input: {
    companyId: string;
    adapterType: string;
    limitKind: string;
    modelFamily: string | null;
    message: string | null;
    resetsAt: Date | null;
    agentId?: string | null;
    issueId?: string | null;
    runId?: string | null;
  }) {
    const now = new Date();
    const blockScopeKey = [
      "provider-rate-limit-block",
      input.companyId,
      input.adapterType,
      input.limitKind,
      input.modelFamily ?? "",
    ].join(":");

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${blockScopeKey}, 0))`);

      const scopeFilter = and(
        eq(providerRateLimitBlocks.companyId, input.companyId),
        eq(providerRateLimitBlocks.adapterType, input.adapterType),
        eq(providerRateLimitBlocks.limitKind, input.limitKind),
        input.modelFamily
          ? eq(providerRateLimitBlocks.modelFamily, input.modelFamily)
          : isNull(providerRateLimitBlocks.modelFamily),
        isNull(providerRateLimitBlocks.resolvedAt),
      );

      const existing = await tx
        .select()
        .from(providerRateLimitBlocks)
        .where(scopeFilter)
        .then((rows) => rows[0] ?? null);

      if (existing) {
        const [updated] = await tx
          .update(providerRateLimitBlocks)
          .set({
            hitCount: sql`${providerRateLimitBlocks.hitCount} + 1`,
            lastSeenAt: now,
            message: input.message ?? existing.message,
            resetsAt: input.resetsAt ?? existing.resetsAt,
            updatedAt: now,
          })
          .where(eq(providerRateLimitBlocks.id, existing.id))
          .returning();
        return { action: "coalesced" as const, block: updated ?? existing, existing };
      }

      const [block] = await tx
        .insert(providerRateLimitBlocks)
        .values({
          companyId: input.companyId,
          adapterType: input.adapterType,
          limitKind: input.limitKind,
          modelFamily: input.modelFamily,
          message: input.message,
          resetsAt: input.resetsAt,
          hitCount: 1,
          lastSeenAt: now,
          updatedAt: now,
        })
        .returning();
      return { action: "created" as const, block: block!, existing: null };
    });

    if (result.action === "coalesced") {
      await writeActivity({
        companyId: input.companyId,
        action: "provider_rate_limit.hit_coalesced",
        entityId: result.block.id,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        details: {
          adapterType: input.adapterType,
          limitKind: input.limitKind,
          modelFamily: input.modelFamily,
          hitCount: result.block.hitCount,
          resetsAt: isoOrNull(result.block.resetsAt),
          lastSeenAt: now.toISOString(),
        },
      });
      return result.block;
    }

    await writeActivity({
      companyId: input.companyId,
      action: "provider_rate_limit.block_created",
      entityId: result.block.id,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      details: {
        adapterType: input.adapterType,
        limitKind: input.limitKind,
        modelFamily: input.modelFamily,
        resetsAt: isoOrNull(input.resetsAt),
        lastSeenAt: now.toISOString(),
      },
    });
    return result.block;
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

  async function resolveEffectiveRunModel(input: {
    companyId: string;
    agent: {
      adapterType: string;
      adapterConfig: unknown;
      runtimeConfig?: unknown;
    };
    issueId?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
  }) {
    let issueOverrides: Record<string, unknown> = {};
    if (input.issueId) {
      const issue = await db
        .select({
          assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
        })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      issueOverrides = parseObject(issue?.assigneeAdapterOverrides);
    }

    const issueModelProfile = readModelProfileKey(issueOverrides.modelProfile);
    const contextModelProfile = readModelProfileKey(input.contextSnapshot?.modelProfile);
    const modelProfile = issueModelProfile ?? contextModelProfile;

    let adapterProfileConfig: Record<string, unknown> = {};
    if (modelProfile) {
      try {
        const profiles = await listAdapterModelProfiles(input.agent.adapterType);
        const profile = profiles.find((candidate) => candidate.key === modelProfile);
        adapterProfileConfig = parseObject(profile?.adapterConfig);
      } catch {
        adapterProfileConfig = {};
      }
    }

    let runtimeProfileConfig: Record<string, unknown> = {};
    if (modelProfile) {
      const runtimeProfiles = parseObject(parseObject(input.agent.runtimeConfig).modelProfiles);
      const runtimeProfile = parseObject(runtimeProfiles[modelProfile]);
      runtimeProfileConfig = runtimeProfile.enabled === false
        ? {}
        : parseObject(runtimeProfile.adapterConfig);
    }

    const effectiveConfig = {
      ...parseObject(input.agent.adapterConfig),
      ...adapterProfileConfig,
      ...runtimeProfileConfig,
      ...parseObject(issueOverrides.adapterConfig),
    };
    return readNonEmptyString(effectiveConfig.model);
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

  async function getBlock(blockId: string) {
    return db
      .select()
      .from(providerRateLimitBlocks)
      .where(eq(providerRateLimitBlocks.id, blockId))
      .then((rows) => rows[0] ?? null);
  }

  async function listResetDueActiveBlocks(now: Date) {
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

  async function releaseDueBlocks(now: Date, resolvedBy = "system") {
    const resetDueBlocks = await listResetDueActiveBlocks(now);
    let released = 0;
    let stillBlocked = 0;
    let wakeupsQueued = 0;
    let wakeupsSkipped = 0;
    for (const block of resetDueBlocks) {
      const windowStillBlocked = await isWindowStillBlocked(block.adapterType, block.limitKind, {
        resetsAt: block.resetsAt,
        now,
      });
      if (windowStillBlocked) {
        stillBlocked += 1;
        continue;
      }

      const resolvedBlock = await resolveBlock(block.id, resolvedBy);
      if (!resolvedBlock) continue;
      const result = await releaseAndResumeForBlock(resolvedBlock);
      released += 1;
      wakeupsQueued += result.wakeupsQueued;
      wakeupsSkipped += result.wakeupsSkipped;
    }
    return { checked: resetDueBlocks.length, released, stillBlocked, wakeupsQueued, wakeupsSkipped };
  }

  async function recoverLegacyResolvedBlocks(now = new Date()) {
    const candidates = await db
      .select({
        issueId: issues.id,
        companyId: issues.companyId,
        agentId: issues.assigneeAgentId,
        adapterType: agents.adapterType,
        runId: issues.executionRunId,
        issueUpdatedAt: issues.updatedAt,
      })
      .from(issues)
      .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
      .leftJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
      .where(
        and(
          eq(issues.status, "blocked"),
          sql`(
            ${heartbeatRuns.errorCode} = 'provider_rate_limit'
            or ${heartbeatRuns.resultJson} ->> 'errorFamily' = 'provider_rate_limit'
            or ${heartbeatRuns.resultJson} ->> 'stopReason' = 'provider_rate_limit'
          )`,
          sql`not exists (
            select 1
            from ${issueRelations}
            join ${issues} as blocker_issues
              on blocker_issues.id = ${issueRelations.issueId}
            where ${issueRelations.companyId} = ${issues.companyId}
              and ${issueRelations.type} = 'blocks'
              and ${issueRelations.relatedIssueId} = ${issues.id}
              and blocker_issues.status <> 'done'
          )`,
          sql`not exists (
            select 1
            from ${providerRateLimitBlocks}
            where ${providerRateLimitBlocks.companyId} = ${issues.companyId}
              and ${providerRateLimitBlocks.adapterType} = ${agents.adapterType}
              and ${providerRateLimitBlocks.resolvedAt} is null
          )`,
        ),
      );

    let recoveredIssues = 0;
    let wakeupsQueued = 0;
    let wakeupsSkipped = 0;
    for (const candidate of candidates) {
      if (!candidate.agentId) continue;
      const [block] = await db
        .insert(providerRateLimitBlocks)
        .values({
          companyId: candidate.companyId,
          adapterType: candidate.adapterType,
          limitKind: "legacy_recovery",
          modelFamily: null,
          message: "Recovered legacy provider rate-limit block from run metadata",
          resetsAt: now,
          resolvedAt: now,
          resolvedBy: "legacy_recovery",
          hitCount: 1,
          lastSeenAt: candidate.issueUpdatedAt ?? now,
          createdAt: candidate.issueUpdatedAt ?? now,
          updatedAt: now,
        })
        .returning();
      if (!block) continue;

      await db
        .insert(providerRateLimitBlockMembers)
        .values({
          blockId: block.id,
          companyId: candidate.companyId,
          agentId: candidate.agentId,
          issueId: candidate.issueId,
          runId: candidate.runId,
          originalAgentStatus: null,
          releaseStatus: "pending",
          updatedAt: now,
        })
        .onConflictDoNothing();

      const release = await releaseAndResumeForBlock(block);
      recoveredIssues += 1;
      wakeupsQueued += release.wakeupsQueued;
      wakeupsSkipped += release.wakeupsSkipped;
      await writeActivity({
        companyId: candidate.companyId,
        action: "provider_rate_limit.legacy_recovery",
        entityId: block.id,
        agentId: candidate.agentId,
        runId: candidate.runId,
        details: {
          issueId: candidate.issueId,
          adapterType: candidate.adapterType,
        },
      });
    }

    return { checked: candidates.length, recoveredIssues, wakeupsQueued, wakeupsSkipped };
  }

  async function pauseAgentsForBlock(
    companyId: string,
    adapterType: string,
    modelFamily: string | null,
    opts?: {
      blockId?: string | null;
      issueId?: string | null;
      runId?: string | null;
    },
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

    const candidates = await db
      .select({
        id: agents.id,
        status: agents.status,
        companyId: agents.companyId,
      })
      .from(agents)
      .where(filter);

    const paused = await db
      .update(agents)
      .set({ status: "paused", pauseReason: "provider_rate_limit", pausedAt: now, updatedAt: now })
      .where(filter)
      .returning();

    if (opts?.blockId) {
      const originalStatusByAgentId = new Map(candidates.map((candidate) => [candidate.id, candidate.status]));
      for (const pausedAgent of paused) {
        const originalAgentStatus = originalStatusByAgentId.get(pausedAgent.id) ?? null;
        await db
          .insert(providerRateLimitBlockMembers)
          .values({
            blockId: opts.blockId,
            companyId,
            agentId: pausedAgent.id,
            issueId: opts.issueId ?? null,
            runId: opts.runId ?? null,
            originalAgentStatus,
            releaseStatus: "pending",
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [providerRateLimitBlockMembers.blockId, providerRateLimitBlockMembers.agentId],
            set: {
              issueId: opts.issueId ?? null,
              runId: opts.runId ?? null,
              updatedAt: now,
            },
          });
        await writeActivity({
          companyId,
          action: "provider_rate_limit.agent_paused",
          entityId: opts.blockId,
          agentId: pausedAgent.id,
          runId: opts.runId ?? null,
          details: {
            adapterType,
            modelFamily,
            originalAgentStatus,
            issueId: opts.issueId ?? null,
          },
        });
      }
    }

    return paused;
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

  async function listAgentIdsForBlockScope(
    companyId: string,
    adapterType: string,
    modelFamily: string | null,
  ) {
    const baseFilter = and(
      eq(agents.companyId, companyId),
      eq(agents.adapterType, adapterType),
    );

    const filter = modelFamily
      ? and(
          baseFilter,
          sql`lower(${agents.adapterConfig}->>'model') LIKE lower(${modelFamily + "%"})`,
        )
      : baseFilter;

    return db
      .select({ id: agents.id })
      .from(agents)
      .where(filter)
      .then((rows) => rows.map((row) => row.id));
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
      const providerSlug = providerSlugForAdapterType(adapterType);
      const providerResult = results.find((r) => r.provider === providerSlug);
      if (!providerResult?.ok) return true; // Cannot verify → assume still blocked
      const window = providerResult.windows.find((w) => w.windowId === limitKind);
      if (!window) return resetIsFuture; // Future provider reset remains authoritative when the quota API omits the window.
      if ((window.usedPercent ?? 0) < 100) return false;
      return !providerHasUsablePaidOverflow(providerResult);
    } catch {
      return true; // Quota probe failed → assume still blocked
    }
  }

  async function queueProviderResetWakeup(input: {
    block: BlockRow;
    agent: typeof agents.$inferSelect;
    issueId: string | null;
    now: Date;
  }) {
    const idempotencyKey = input.issueId
      ? `provider_rate_limit_reset:${input.block.id}:${input.issueId}:${input.agent.id}`
      : `provider_rate_limit_reset:${input.block.id}:${input.agent.id}`;
    const existing = await db
      .select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.block.companyId),
          eq(agentWakeupRequests.agentId, input.agent.id),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return { queued: false, wakeupRequestId: existing.id, reason: "duplicate" };

    const scheduledAt = jitteredWakeTime(input.block.id, input.agent.id, input.now, input.issueId);
    const wakeupRequest = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: input.block.companyId,
        agentId: input.agent.id,
        source: "automation",
        triggerDetail: "system",
        reason: "provider_rate_limit_reset",
        payload: {
          blockId: input.block.id,
          adapterType: input.block.adapterType,
          limitKind: input.block.limitKind,
          modelFamily: input.block.modelFamily,
          ...(input.issueId ? { issueId: input.issueId } : {}),
          scheduledRetryAt: scheduledAt.toISOString(),
        },
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: "provider_rate_limit_service",
        idempotencyKey,
        requestedAt: input.now,
        updatedAt: input.now,
      })
      .returning()
      .then((rows) => rows[0]);

    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: input.block.companyId,
        agentId: input.agent.id,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: {
          source: "provider_rate_limit_reset",
          reason: "provider_rate_limit_reset",
          wakeReason: "provider_rate_limit_reset",
          blockId: input.block.id,
          adapterType: input.block.adapterType,
          limitKind: input.block.limitKind,
          modelFamily: input.block.modelFamily,
          ...(input.issueId ? { issueId: input.issueId } : {}),
        },
        scheduledRetryAt: scheduledAt,
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "provider_rate_limit_reset",
        updatedAt: input.now,
      })
      .returning()
      .then((rows) => rows[0]);

    await db
      .update(agentWakeupRequests)
      .set({ runId: run.id, updatedAt: input.now })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    await writeActivity({
      companyId: input.block.companyId,
      action: "provider_rate_limit.wakeup_queued",
      entityId: input.block.id,
      agentId: input.agent.id,
      runId: run.id,
      details: {
        wakeupRequestId: wakeupRequest.id,
        idempotencyKey,
        scheduledAt: scheduledAt.toISOString(),
        issueId: input.issueId,
      },
    });

    return { queued: true, wakeupRequestId: wakeupRequest.id, reason: "queued" };
  }

  async function recordSkippedProviderResetWakeup(input: {
    block: BlockRow;
    agent: typeof agents.$inferSelect;
    issueId: string;
    reason: string;
    unresolvedBlockerIssueIds?: string[];
    now: Date;
  }) {
    const idempotencyKey = `provider_rate_limit_reset_skipped:${input.block.id}:${input.issueId}:${input.agent.id}:${input.reason}`;
    const existing = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.block.companyId),
          eq(agentWakeupRequests.agentId, input.agent.id),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return existing.id;

    const [wakeup] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: input.block.companyId,
        agentId: input.agent.id,
        source: "automation",
        triggerDetail: "system",
        reason: input.reason,
        payload: {
          blockId: input.block.id,
          adapterType: input.block.adapterType,
          limitKind: input.block.limitKind,
          modelFamily: input.block.modelFamily,
          issueId: input.issueId,
          unresolvedBlockerIssueIds: input.unresolvedBlockerIssueIds ?? [],
        },
        status: "skipped",
        requestedByActorType: "system",
        requestedByActorId: "provider_rate_limit_service",
        idempotencyKey,
        requestedAt: input.now,
        finishedAt: input.now,
        error: input.reason,
        updatedAt: input.now,
      })
      .returning();
    return wakeup!.id;
  }

  async function queueProviderScopeChangedWakeup(input: {
    block: BlockRow;
    agent: typeof agents.$inferSelect;
    issueId: string;
    now: Date;
  }) {
    const idempotencyKey = `provider_rate_limit_scope_changed:${input.block.id}:${input.issueId}:${input.agent.id}`;
    const existing = await db
      .select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.block.companyId),
          eq(agentWakeupRequests.agentId, input.agent.id),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return { queued: false, wakeupRequestId: existing.id, runId: existing.runId, reason: "duplicate" };

    const wakeupRequest = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: input.block.companyId,
        agentId: input.agent.id,
        source: "automation",
        triggerDetail: "system",
        reason: "provider_rate_limit_scope_changed",
        payload: {
          blockId: input.block.id,
          adapterType: input.block.adapterType,
          limitKind: input.block.limitKind,
          modelFamily: input.block.modelFamily,
          issueId: input.issueId,
        },
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: "provider_rate_limit_service",
        idempotencyKey,
        requestedAt: input.now,
        updatedAt: input.now,
      })
      .returning()
      .then((rows) => rows[0]);

    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: input.block.companyId,
        agentId: input.agent.id,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: {
          source: "provider_rate_limit_scope_changed",
          reason: "provider_rate_limit_scope_changed",
          wakeReason: "provider_rate_limit_scope_changed",
          blockId: input.block.id,
          adapterType: input.block.adapterType,
          limitKind: input.block.limitKind,
          modelFamily: input.block.modelFamily,
          issueId: input.issueId,
        },
        updatedAt: input.now,
      })
      .returning()
      .then((rows) => rows[0]);

    await db
      .update(agentWakeupRequests)
      .set({ runId: run.id, updatedAt: input.now })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    await writeActivity({
      companyId: input.block.companyId,
      action: "provider_rate_limit.scope_changed_wakeup_queued",
      entityId: input.block.id,
      agentId: input.agent.id,
      runId: run.id,
      details: {
        issueId: input.issueId,
        wakeupRequestId: wakeupRequest.id,
        idempotencyKey,
      },
    });

    return { queued: true, wakeupRequestId: wakeupRequest.id, runId: run.id, reason: "queued" };
  }

  async function memberRowsForRelease(block: BlockRow) {
    const members = await db
      .select()
      .from(providerRateLimitBlockMembers)
      .where(eq(providerRateLimitBlockMembers.blockId, block.id));
    if (members.length > 0) return members;

    const scopedAgentIds = await listAgentIdsForBlockScope(
      block.companyId,
      block.adapterType,
      block.modelFamily,
    );
    return scopedAgentIds.map((agentId) => ({
      id: agentId,
      blockId: block.id,
      companyId: block.companyId,
      agentId,
      issueId: null,
      runId: null,
      originalAgentStatus: null,
      releaseStatus: "pending",
      releaseReason: null,
      wakeupRequestId: null,
      createdAt: block.createdAt,
      updatedAt: block.updatedAt,
    }));
  }

  async function releaseAndResumeForBlock(block: BlockRow) {
    const now = new Date();
    const members = await memberRowsForRelease(block);
    const agentIds = [...new Set(members.map((member) => member.agentId))];
    const agentRows = agentIds.length > 0
      ? await db.select().from(agents).where(inArray(agents.id, agentIds))
      : [];
    const agentById = new Map(agentRows.map((agent) => [agent.id, agent]));
    const memberIssueIds = [...new Set(members.map((member) => member.issueId).filter(Boolean) as string[])];
    const issueRows = memberIssueIds.length > 0
      ? await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, block.companyId), inArray(issues.id, memberIssueIds)))
      : [];
    const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
    const unresolvedBlockerRows = memberIssueIds.length > 0
      ? await db
        .select({
          issueId: issueRelations.relatedIssueId,
          blockerIssueId: issueRelations.issueId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, block.companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, memberIssueIds),
            sql`${issues.status} <> 'done'`,
          ),
        )
      : [];
    const unresolvedBlockersByIssueId = new Map<string, string[]>();
    for (const row of unresolvedBlockerRows) {
      const current = unresolvedBlockersByIssueId.get(row.issueId) ?? [];
      current.push(row.blockerIssueId);
      unresolvedBlockersByIssueId.set(row.issueId, current);
    }
    const queuedIssueIds = new Set<string>();
    const promotableIssueIds = new Set<string>();

    let resumed = 0;
    let wakeupsQueued = 0;
    let wakeupsSkipped = 0;
    for (const member of members) {
      const agent = agentById.get(member.agentId);
      if (!agent) {
        wakeupsSkipped += 1;
        await db
          .update(providerRateLimitBlockMembers)
          .set({ releaseStatus: "skipped", releaseReason: "agent_missing", updatedAt: now })
          .where(eq(providerRateLimitBlockMembers.id, member.id));
        continue;
      }

      let releaseStatus = "skipped";
      let releaseReason = "agent_not_invokable";
      let currentAgent = agent;
      if (agent.status === "paused" && agent.pauseReason === "provider_rate_limit") {
        const [updatedAgent] = await db
          .update(agents)
          .set({ status: "idle", pauseReason: null, pausedAt: null, updatedAt: now })
          .where(
            and(
              eq(agents.id, agent.id),
              eq(agents.companyId, block.companyId),
              eq(agents.status, "paused"),
              eq(agents.pauseReason, "provider_rate_limit"),
            ),
          )
          .returning();
        if (updatedAgent) {
          currentAgent = updatedAgent;
          resumed += 1;
          releaseStatus = "resumed";
          releaseReason = "provider_pause_released";
        }
      } else if (agent.status === "paused") {
        releaseStatus = "skipped";
        releaseReason = agent.pauseReason ? `paused:${agent.pauseReason}` : "paused";
      } else if (agent.status === "terminated" || agent.status === "pending_approval") {
        releaseStatus = "skipped";
        releaseReason = `agent_${agent.status}`;
      } else if (agent.status === "running") {
        releaseStatus = "skipped";
        releaseReason = "agent_running";
      } else {
        releaseStatus = "ready";
        releaseReason = "agent_already_invokable";
      }

      if (releaseStatus === "resumed" || releaseStatus === "ready") {
        const memberIssueId = member.issueId;
        if (memberIssueId) {
          const issue = issueById.get(memberIssueId);
          if (!issue) {
            wakeupsSkipped += 1;
            await db
              .update(providerRateLimitBlockMembers)
              .set({
                releaseStatus: "skipped",
                releaseReason: "issue_missing",
                updatedAt: now,
              })
              .where(eq(providerRateLimitBlockMembers.id, member.id));
            await writeActivity({
              companyId: block.companyId,
              action: "provider_rate_limit.wakeup_skipped",
              entityId: block.id,
              agentId: agent.id,
              details: {
                reason: "issue_missing",
                issueId: memberIssueId,
              },
            });
            continue;
          }

          if (issue.assigneeAgentId !== agent.id) {
            wakeupsSkipped += 1;
            await db
              .update(providerRateLimitBlockMembers)
              .set({
                releaseStatus,
                releaseReason: "issue_assignee_mismatch",
                updatedAt: now,
              })
              .where(eq(providerRateLimitBlockMembers.id, member.id));
            await writeActivity({
              companyId: block.companyId,
              action: "provider_rate_limit.wakeup_skipped",
              entityId: block.id,
              agentId: agent.id,
              details: {
                reason: "issue_assignee_mismatch",
                issueId: memberIssueId,
                currentAssigneeAgentId: issue.assigneeAgentId,
              },
            });
            continue;
          }

          const unresolvedBlockerIssueIds = unresolvedBlockersByIssueId.get(memberIssueId) ?? [];
          if (unresolvedBlockerIssueIds.length > 0) {
            wakeupsSkipped += 1;
            const wakeupRequestId = await recordSkippedProviderResetWakeup({
              block,
              agent,
              issueId: memberIssueId,
              reason: "issue_dependencies_blocked",
              unresolvedBlockerIssueIds,
              now,
            });
            await db
              .update(providerRateLimitBlockMembers)
              .set({
                releaseStatus,
                releaseReason: "issue_dependencies_blocked",
                wakeupRequestId,
                updatedAt: now,
              })
              .where(eq(providerRateLimitBlockMembers.id, member.id));
            await writeActivity({
              companyId: block.companyId,
              action: "provider_rate_limit.wakeup_skipped",
              entityId: block.id,
              agentId: agent.id,
              details: {
                reason: "issue_dependencies_blocked",
                issueId: memberIssueId,
                unresolvedBlockerIssueIds,
                wakeupRequestId,
              },
            });
            continue;
          }

          if (queuedIssueIds.has(memberIssueId)) {
            wakeupsSkipped += 1;
            await db
              .update(providerRateLimitBlockMembers)
              .set({
                releaseStatus,
                releaseReason: "issue_reset_already_queued",
                updatedAt: now,
              })
              .where(eq(providerRateLimitBlockMembers.id, member.id));
            await writeActivity({
              companyId: block.companyId,
              action: "provider_rate_limit.wakeup_skipped",
              entityId: block.id,
              agentId: agent.id,
              details: {
                reason: "issue_reset_already_queued",
                issueId: memberIssueId,
              },
            });
            continue;
          }
          queuedIssueIds.add(memberIssueId);
        }

        const wakeup = await queueProviderResetWakeup({
          block,
          agent: currentAgent,
          issueId: member.issueId ?? null,
          now,
        });
        if (wakeup.queued) {
          wakeupsQueued += 1;
        } else {
          wakeupsSkipped += 1;
          await writeActivity({
            companyId: block.companyId,
            action: "provider_rate_limit.wakeup_skipped",
            entityId: block.id,
            agentId: agent.id,
            details: {
              reason: wakeup.reason,
              wakeupRequestId: wakeup.wakeupRequestId,
            },
          });
        }
        if (member.issueId && (wakeup.queued || wakeup.reason === "duplicate")) {
          promotableIssueIds.add(member.issueId);
        }
        await db
          .update(providerRateLimitBlockMembers)
          .set({
            releaseStatus,
            releaseReason,
            wakeupRequestId: wakeup.wakeupRequestId,
            updatedAt: now,
          })
          .where(eq(providerRateLimitBlockMembers.id, member.id));
      } else {
        wakeupsSkipped += 1;
        await db
          .update(providerRateLimitBlockMembers)
          .set({ releaseStatus, releaseReason, updatedAt: now })
          .where(eq(providerRateLimitBlockMembers.id, member.id));
        await writeActivity({
          companyId: block.companyId,
          action: "provider_rate_limit.wakeup_skipped",
          entityId: block.id,
          agentId: agent.id,
          details: { reason: releaseReason },
        });
      }
    }

    const issueIdsToPromote = [...promotableIssueIds];
    if (issueIdsToPromote.length > 0) {
      await db
        .update(issues)
        .set({ status: "in_progress", updatedAt: now })
        .where(
          and(
            eq(issues.companyId, block.companyId),
            eq(issues.status, "blocked"),
            inArray(issues.id, issueIdsToPromote),
            sql`not exists (
              select 1
              from ${issueRelations}
              join ${issues} as blocker_issues
                on blocker_issues.id = ${issueRelations.issueId}
              where ${issueRelations.companyId} = ${block.companyId}
                and ${issueRelations.type} = 'blocks'
                and ${issueRelations.relatedIssueId} = ${issues.id}
                and blocker_issues.status <> 'done'
            )`,
          ),
        );
    }

    await writeActivity({
      companyId: block.companyId,
      action: "provider_rate_limit.block_released",
      entityId: block.id,
      details: {
        resolvedAt: isoOrNull(block.resolvedAt),
        resetsAt: isoOrNull(block.resetsAt),
        releaseLagMs: block.resetsAt ? Math.max(0, now.getTime() - block.resetsAt.getTime()) : null,
        affectedAgents: agentIds.length,
        resumed,
        wakeupsQueued,
        wakeupsSkipped,
      },
    });

    return { affectedAgents: agentIds.length, resumed, wakeupsQueued, wakeupsSkipped };
  }

  async function reconcileAgentProviderLimitPause(agentId: string) {
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.status !== "paused" || agent.pauseReason !== "provider_rate_limit") {
      return { released: false, issueIds: [] as string[], wakeupsQueued: 0, wakeupsSkipped: 0 };
    }

    const activeMembers = await db
      .select({
        member: providerRateLimitBlockMembers,
        block: providerRateLimitBlocks,
      })
      .from(providerRateLimitBlockMembers)
      .innerJoin(providerRateLimitBlocks, eq(providerRateLimitBlockMembers.blockId, providerRateLimitBlocks.id))
      .where(
        and(
          eq(providerRateLimitBlockMembers.companyId, agent.companyId),
          eq(providerRateLimitBlockMembers.agentId, agent.id),
          isNull(providerRateLimitBlocks.resolvedAt),
        ),
      );

    const scopesToCheck = activeMembers.length > 0
      ? activeMembers.map((row) => row.member.issueId ?? null)
      : [null];
    for (const issueId of scopesToCheck) {
      const model = await resolveEffectiveRunModel({
        companyId: agent.companyId,
        agent,
        issueId,
      });
      const matchingBlock = await getActiveBlockForAgent(agent.companyId, agent.adapterType, model);
      if (matchingBlock) {
        return { released: false, issueIds: [] as string[], wakeupsQueued: 0, wakeupsSkipped: 0 };
      }
    }

    const now = new Date();
    const [releasedAgent] = await db
      .update(agents)
      .set({ status: "idle", pauseReason: null, pausedAt: null, updatedAt: now })
      .where(
        and(
          eq(agents.id, agent.id),
          eq(agents.companyId, agent.companyId),
          eq(agents.status, "paused"),
          eq(agents.pauseReason, "provider_rate_limit"),
        ),
      )
      .returning();
    if (!releasedAgent) {
      return { released: false, issueIds: [] as string[], wakeupsQueued: 0, wakeupsSkipped: 0 };
    }

    const memberIssueIds = [...new Set(activeMembers.map((row) => row.member.issueId).filter(Boolean) as string[])];
    const wakeableIssues = memberIssueIds.length > 0
      ? await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, agent.companyId),
            eq(issues.assigneeAgentId, agent.id),
            eq(issues.status, "blocked"),
            inArray(issues.id, memberIssueIds),
            sql`not exists (
              select 1
              from ${issueRelations}
              join ${issues} as blocker_issues
                on blocker_issues.id = ${issueRelations.issueId}
              where ${issueRelations.companyId} = ${agent.companyId}
                and ${issueRelations.type} = 'blocks'
                and ${issueRelations.relatedIssueId} = ${issues.id}
                and blocker_issues.status <> 'done'
            )`,
          ),
        )
      : [];
    const issueIds = wakeableIssues.map((issue) => issue.id);

    if (issueIds.length > 0) {
      await db
        .update(issues)
        .set({ status: "in_progress", updatedAt: now })
        .where(
          and(
            eq(issues.companyId, agent.companyId),
            eq(issues.assigneeAgentId, agent.id),
            eq(issues.status, "blocked"),
            inArray(issues.id, issueIds),
          ),
        );
    }

    let wakeupsQueued = 0;
    let wakeupsSkipped = 0;
    const firstMemberByIssueId = new Map<string, { member: typeof providerRateLimitBlockMembers.$inferSelect; block: BlockRow }>();
    for (const row of activeMembers) {
      if (row.member.issueId && !firstMemberByIssueId.has(row.member.issueId)) {
        firstMemberByIssueId.set(row.member.issueId, row);
      }
    }
    for (const issueId of issueIds) {
      const row = firstMemberByIssueId.get(issueId);
      if (!row) continue;
      const wakeup = await queueProviderScopeChangedWakeup({
        block: row.block,
        agent: releasedAgent,
        issueId,
        now,
      });
      if (wakeup.queued) wakeupsQueued += 1;
      else wakeupsSkipped += 1;
      await db
        .update(providerRateLimitBlockMembers)
        .set({
          releaseStatus: "scope_changed",
          releaseReason: "agent_scope_no_longer_matches_active_block",
          wakeupRequestId: wakeup.wakeupRequestId,
          updatedAt: now,
        })
        .where(eq(providerRateLimitBlockMembers.id, row.member.id));
    }

    const memberIds = activeMembers.map((row) => row.member.id);
    if (memberIds.length > 0) {
      await db
        .update(providerRateLimitBlockMembers)
        .set({
          releaseStatus: "scope_changed",
          releaseReason: "agent_scope_no_longer_matches_active_block",
          updatedAt: now,
        })
        .where(inArray(providerRateLimitBlockMembers.id, memberIds));
    }

    for (const block of new Map(activeMembers.map((row) => [row.block.id, row.block])).values()) {
      await writeActivity({
        companyId: block.companyId,
        action: "provider_rate_limit.agent_scope_reconciled",
        entityId: block.id,
        agentId: agent.id,
        details: {
          adapterType: agent.adapterType,
          issueIds,
          wakeupsQueued,
          wakeupsSkipped,
        },
      });
    }

    return { released: true, issueIds, wakeupsQueued, wakeupsSkipped };
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
        const providerSlug = providerSlugForAdapterType(adapterType);
        const providerResult = results.find((r) => r.provider === providerSlug && r.ok);
        if (providerResult) {
          const exhausted = providerResult.windows.find(
            (w) => w.windowId && (w.usedPercent ?? 0) >= 100 && !windowShowsUsablePaidOverflow(w),
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
    getBlock,
    getActiveBlockForAgent,
    resolveEffectiveRunModel,
    listActiveBlocks,
    listResetDueActiveBlocks,
    resolveBlock,
    releaseDueBlocks,
    recoverLegacyResolvedBlocks,
    pauseAgentsForBlock,
    resumeAgentsForBlock,
    isWindowStillBlocked,
    releaseAndResumeForBlock,
    reconcileAgentProviderLimitPause,
    deriveBlockScope,
  };
}

export type ProviderRateLimitService = ReturnType<typeof providerRateLimitService>;
