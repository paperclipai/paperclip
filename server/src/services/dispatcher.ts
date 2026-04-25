import { eq, and, isNull, sql, desc, asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { subscriptionQuotas, agentRoleCandidates, type AgentRoleCandidate } from "@paperclipai/db";
import { fetchAllQuotaWindows } from "./quota-windows.js";
import { logger } from "../middleware/logger.js";

export interface DispatchTask {
  issueId: string;
  role: string;
  taskComplexity: "S" | "M" | "L" | "XL";
}

export const TASK_COMPLEXITY_FACTORS: Record<DispatchTask["taskComplexity"], number> = {
  S: 1.5,
  M: 1.2,
  L: 1.0,
  XL: 0.8,
};

export interface RankedCandidate {
  id: string;
  role: string;
  model: string;
  harness: string;
  subscription: string;
  provider: string;
  qualityRank: number;
  isSaturated: boolean;
  lastUsedAt: Date | null;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
  score: number;
  taskComplexityFactor: number;
}

export const SUBSCRIPTION_PROVIDER_MAP: Record<string, string> = {
  "Anthropic Max": "anthropic",
  "ChatGPT Pro 20x": "openai",
  "Gemini AI Ultra": "google",
  "BytePlus Coding Plan": "byteplus",
  "MiniMax Coding Plan": "minimax",
  "Z.AI Coding Plan": "zai",
};

export const KNOWN_SUBSCRIPTIONS = Object.keys(SUBSCRIPTION_PROVIDER_MAP);

export interface QuotaReservation {
  subscription: string;
  allowed: boolean;
  reason?: string;
}

export interface DispatchResult {
  candidate: RankedCandidate | null;
  dispatchAllowed: boolean;
  reason: string;
  allExhausted: boolean;
  reviewerFamily?: string;
}

export interface PRContext {
  repositoryFullName: string;
  prNumber: number;
  headSha: string;
}

export interface ReviewDispatchTask extends DispatchTask {
  prContext: PRContext;
  reviewerFamily: string;
}

abstract class QuotaTracker {
  abstract readonly subscription: string;
  abstract readonly provider: string;

  constructor(protected db: Db) {}

  abstract checkQuotaAvailable(): Promise<number>;

  abstract reserveQuota(messages?: number, tokens?: number): Promise<boolean>;

  abstract markSaturated(): Promise<void>;

  abstract resetSaturation(): Promise<void>;

  protected utilizationCap = 0.7;

  async getQuotaAvailable(): Promise<number> {
    return this.checkQuotaAvailable();
  }
}

class AnthropicQuotaTracker extends QuotaTracker {
  readonly subscription = "Anthropic Max";
  readonly provider = "anthropic";

  async checkQuotaAvailable(): Promise<number> {
    const windows = await fetchAllQuotaWindows();
    const anthropicWindow = windows.find((w) => w.provider === "anthropic" && w.ok);
    if (!anthropicWindow || anthropicWindow.windows.length === 0) {
      return 0.5;
    }
    const primaryWindow = anthropicWindow.windows[0];
    if (!primaryWindow) return 0.5;
    const usedPercent = primaryWindow.usedPercent ?? 0;
    return Math.max(0, (100 - usedPercent) / 100);
  }

  async reserveQuota(messages = 1, tokens = 0): Promise<boolean> {
    try {
      const result = await this.db.execute(sql`
        SELECT try_reserve_quota(${this.subscription}, ${messages}, ${tokens}) as allowed
      `);
      const row = (result as unknown as { rows: { allowed: boolean }[] }).rows[0];
      return row?.allowed ?? false;
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "reserveQuota failed");
      return false;
    }
  }

  async markSaturated(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT mark_subscription_saturated(${this.subscription})`);
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "markSaturated failed");
    }
  }

  async resetSaturation(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT reset_saturated_subscriptions()`);
    } catch (err) {
      logger.error({ err }, "resetSaturatedSubscriptions failed");
    }
  }
}

class ChatGPTProQuotaTracker extends QuotaTracker {
  readonly subscription = "ChatGPT Pro 20x";
  readonly provider = "openai";

  async checkQuotaAvailable(): Promise<number> {
    const windows = await fetchAllQuotaWindows();
    const openaiWindow = windows.find((w) => w.provider === "openai" && w.ok);
    if (!openaiWindow || openaiWindow.windows.length === 0) {
      return 0.5;
    }
    const primaryWindow = openaiWindow.windows[0];
    if (!primaryWindow) return 0.5;
    const usedPercent = primaryWindow.usedPercent ?? 0;
    return Math.max(0, (100 - usedPercent) / 100);
  }

  async reserveQuota(messages = 1, tokens = 0): Promise<boolean> {
    try {
      const result = await this.db.execute(sql`
        SELECT try_reserve_quota(${this.subscription}, ${messages}, ${tokens}) as allowed
      `);
      const row = (result as unknown as { rows: { allowed: boolean }[] }).rows[0];
      return row?.allowed ?? false;
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "reserveQuota failed");
      return false;
    }
  }

  async markSaturated(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT mark_subscription_saturated(${this.subscription})`);
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "markSaturated failed");
    }
  }

  async resetSaturation(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT reset_saturated_subscriptions()`);
    } catch (err) {
      logger.error({ err }, "resetSaturatedSubscriptions failed");
    }
  }
}

class GeminiQuotaTracker extends QuotaTracker {
  readonly subscription = "Gemini AI Ultra";
  readonly provider = "google";

  async checkQuotaAvailable(): Promise<number> {
    const windows = await fetchAllQuotaWindows();
    const geminiWindow = windows.find((w) => w.provider === "google" && w.ok);
    if (!geminiWindow || geminiWindow.windows.length === 0) {
      return 0.5;
    }
    const primaryWindow = geminiWindow.windows[0];
    if (!primaryWindow) return 0.5;
    const usedPercent = primaryWindow.usedPercent ?? 0;
    return Math.max(0, (100 - usedPercent) / 100);
  }

  async reserveQuota(messages = 1, tokens = 0): Promise<boolean> {
    try {
      const result = await this.db.execute(sql`
        SELECT try_reserve_quota(${this.subscription}, ${messages}, ${tokens}) as allowed
      `);
      const row = (result as unknown as { rows: { allowed: boolean }[] }).rows[0];
      return row?.allowed ?? false;
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "reserveQuota failed");
      return false;
    }
  }

  async markSaturated(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT mark_subscription_saturated(${this.subscription})`);
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "markSaturated failed");
    }
  }

  async resetSaturation(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT reset_saturated_subscriptions()`);
    } catch (err) {
      logger.error({ err }, "resetSaturatedSubscriptions failed");
    }
  }
}

class BytePlusQuotaTracker extends QuotaTracker {
  readonly subscription = "BytePlus Coding Plan";
  readonly provider = "byteplus";

  async checkQuotaAvailable(): Promise<number> {
    return 0.7;
  }

  async reserveQuota(messages = 1, tokens = 0): Promise<boolean> {
    try {
      const result = await this.db.execute(sql`
        SELECT try_reserve_quota(${this.subscription}, ${messages}, ${tokens}) as allowed
      `);
      const row = (result as unknown as { rows: { allowed: boolean }[] }).rows[0];
      return row?.allowed ?? false;
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "reserveQuota failed");
      return false;
    }
  }

  async markSaturated(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT mark_subscription_saturated(${this.subscription})`);
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "markSaturated failed");
    }
  }

  async resetSaturation(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT reset_saturated_subscriptions()`);
    } catch (err) {
      logger.error({ err }, "resetSaturatedSubscriptions failed");
    }
  }
}

class MiniMaxQuotaTracker extends QuotaTracker {
  readonly subscription = "MiniMax Coding Plan";
  readonly provider = "minimax";

  async checkQuotaAvailable(): Promise<number> {
    return 0.7;
  }

  async reserveQuota(messages = 1, tokens = 0): Promise<boolean> {
    try {
      const result = await this.db.execute(sql`
        SELECT try_reserve_quota(${this.subscription}, ${messages}, ${tokens}) as allowed
      `);
      const row = (result as unknown as { rows: { allowed: boolean }[] }).rows[0];
      return row?.allowed ?? false;
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "reserveQuota failed");
      return false;
    }
  }

  async markSaturated(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT mark_subscription_saturated(${this.subscription})`);
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "markSaturated failed");
    }
  }

  async resetSaturation(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT reset_saturated_subscriptions()`);
    } catch (err) {
      logger.error({ err }, "resetSaturatedSubscriptions failed");
    }
  }
}

class ZAIQuotaTracker extends QuotaTracker {
  readonly subscription = "Z.AI Coding Plan";
  readonly provider = "zai";

  async checkQuotaAvailable(): Promise<number> {
    return 0.7;
  }

  async reserveQuota(messages = 1, tokens = 0): Promise<boolean> {
    try {
      const result = await this.db.execute(sql`
        SELECT try_reserve_quota(${this.subscription}, ${messages}, ${tokens}) as allowed
      `);
      const row = (result as unknown as { rows: { allowed: boolean }[] }).rows[0];
      return row?.allowed ?? false;
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "reserveQuota failed");
      return false;
    }
  }

  async markSaturated(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT mark_subscription_saturated(${this.subscription})`);
    } catch (err) {
      logger.error({ err, subscription: this.subscription }, "markSaturated failed");
    }
  }

  async resetSaturation(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT reset_saturated_subscriptions()`);
    } catch (err) {
      logger.error({ err }, "resetSaturatedSubscriptions failed");
    }
  }
}

function createTracker(db: Db, subscription: string): QuotaTracker {
  switch (subscription) {
    case "Anthropic Max":
      return new AnthropicQuotaTracker(db);
    case "ChatGPT Pro 20x":
      return new ChatGPTProQuotaTracker(db);
    case "Gemini AI Ultra":
      return new GeminiQuotaTracker(db);
    case "BytePlus Coding Plan":
      return new BytePlusQuotaTracker(db);
    case "MiniMax Coding Plan":
      return new MiniMaxQuotaTracker(db);
    case "Z.AI Coding Plan":
      return new ZAIQuotaTracker(db);
    default:
      throw new Error(`Unknown subscription: ${subscription}`);
  }
}

export function createDispatcherService(db: Db) {
  async function getCandidatesForRole(
    role: string,
  ): Promise<AgentRoleCandidate[]> {
    const rows = await db
      .select()
      .from(agentRoleCandidates)
      .where(and(
        eq(agentRoleCandidates.role, role),
        eq(agentRoleCandidates.isSaturated, false),
      ))
      .orderBy(desc(agentRoleCandidates.qualityRank));
    return rows;
  }

  async function recordFailure(
    role: string,
    model: string,
    harness: string,
  ): Promise<void> {
    try {
      await db.execute(sql`
        SELECT record_candidate_failure(${role}, ${model}, ${harness})
      `);
    } catch (err) {
      logger.error({ err, role, model, harness }, "recordCandidateFailure failed");
    }
  }

  async function recordSuccess(
    role: string,
    model: string,
    harness: string,
  ): Promise<void> {
    try {
      await db.execute(sql`
        SELECT record_candidate_success(${role}, ${model}, ${harness})
      `);
    } catch (err) {
      logger.error({ err, role, model, harness }, "recordCandidateSuccess failed");
    }
  }

  async function dispatch(task: DispatchTask): Promise<DispatchResult> {
    const { issueId, role, taskComplexity } = task;
    const complexityFactor = TASK_COMPLEXITY_FACTORS[taskComplexity] ?? 1.0;

    const candidates = await getCandidatesForRole(role);

    if (candidates.length === 0) {
      return {
        candidate: null,
        dispatchAllowed: false,
        reason: `No candidates found for role: ${role}`,
        allExhausted: true,
      };
    }

    for (const rawCandidate of candidates) {
      const candidate = rawCandidate as unknown as RankedCandidate;
      const tracker = createTracker(db, candidate.subscription);

      const quotaAvailable = await tracker.getQuotaAvailable();

      candidate.taskComplexityFactor = complexityFactor;
      candidate.score =
        Number(candidate.qualityRank) * quotaAvailable * complexityFactor;

      if (candidate.score < 0.2) {
        await recordFailure(role, candidate.model, candidate.harness);
        continue;
      }

      const reserved = await tracker.reserveQuota();
      if (reserved) {
        await recordSuccess(role, candidate.model, candidate.harness);
        return {
          candidate,
          dispatchAllowed: true,
          reason: `Dispatched to ${candidate.model} on ${candidate.subscription} (score: ${candidate.score.toFixed(2)})`,
          allExhausted: false,
        };
      }

      await tracker.markSaturated();
      await recordFailure(role, candidate.model, candidate.harness);
      logger.info(
        { subscription: candidate.subscription, role, model: candidate.model },
        "Candidate saturated, trying next",
      );
    }

    return {
      candidate: null,
      dispatchAllowed: false,
      reason: `All candidates for role ${role} exhausted`,
      allExhausted: true,
    };
  }

  async function dispatchForReview(task: ReviewDispatchTask): Promise<DispatchResult> {
    const { issueId, role, taskComplexity, prContext, reviewerFamily } = task;
    const complexityFactor = TASK_COMPLEXITY_FACTORS[taskComplexity] ?? 1.0;

    if (role === "breaker") {
      const breakerResult = await db.execute(sql`
        SELECT get_next_breaker_candidate(${prContext.repositoryFullName}, ${prContext.prNumber}, ${prContext.headSha}, 'breaker') as agent_id
      `);
      const breakerRow = (breakerResult as unknown as { rows: { agent_id: string | null }[] }).rows[0];
      if (!breakerRow?.agent_id) {
        return {
          candidate: null,
          dispatchAllowed: false,
          reason: `No eligible breaker candidate for ${prContext.repositoryFullName}#${prContext.prNumber} (family diversity exhausted)`,
          allExhausted: true,
        };
      }
      const breakerAgentRows = await db
        .select()
        .from(agentRoleCandidates)
        .where(eq(agentRoleCandidates.id, breakerRow.agent_id))
        .limit(1);
      const breakerCandidate = breakerAgentRows[0];
      if (!breakerCandidate) {
        return {
          candidate: null,
          dispatchAllowed: false,
          reason: "Breaker candidate DB row not found",
          allExhausted: true,
        };
      }
      return {
        candidate: breakerCandidate as unknown as RankedCandidate,
        dispatchAllowed: true,
        reason: `Breaker selected via get_next_breaker_candidate for ${prContext.repositoryFullName}#${prContext.prNumber}`,
        allExhausted: false,
        reviewerFamily: "breaker",
      };
    }

    const candidates = await getCandidatesForRole(role);
    if (candidates.length === 0) {
      return {
        candidate: null,
        dispatchAllowed: false,
        reason: `No candidates found for role: ${role}`,
        allExhausted: true,
      };
    }

    for (const rawCandidate of candidates) {
      const candidate = rawCandidate as unknown as RankedCandidate;
      const familyExhaustedResult = await db.execute(sql`
        SELECT is_family_exhausted_for_pr(
          ${prContext.repositoryFullName},
          ${prContext.prNumber},
          ${prContext.headSha},
          ${candidate.provider}
        ) as exhausted
      `);
      const familyExhaustedRow = (familyExhaustedResult as unknown as { rows: { exhausted: boolean }[] }).rows[0];
      if (familyExhaustedRow?.exhausted) {
        logger.info(
          { role, provider: candidate.provider, repository: prContext.repositoryFullName, pr: prContext.prNumber },
          "Candidate skipped: family exhausted for PR",
        );
        continue;
      }
      if (candidate.provider === reviewerFamily) {
        logger.info(
          { role, provider: candidate.provider, reviewerFamily, repository: prContext.repositoryFullName, pr: prContext.prNumber },
          "Candidate skipped: same family as PR author",
        );
        continue;
      }

      const tracker = createTracker(db, candidate.subscription);
      const quotaAvailable = await tracker.getQuotaAvailable();
      candidate.taskComplexityFactor = complexityFactor;
      candidate.score = Number(candidate.qualityRank) * quotaAvailable * complexityFactor;

      if (candidate.score < 0.2) {
        await recordFailure(role, candidate.model, candidate.harness);
        continue;
      }

      const reserved = await tracker.reserveQuota();
      if (reserved) {
        await recordSuccess(role, candidate.model, candidate.harness);
        return {
          candidate,
          dispatchAllowed: true,
          reason: `Dispatched to ${candidate.model} on ${candidate.subscription} (score: ${candidate.score.toFixed(2)})`,
          allExhausted: false,
          reviewerFamily: candidate.provider,
        };
      }

      await tracker.markSaturated();
      await recordFailure(role, candidate.model, candidate.harness);
      logger.info(
        { subscription: candidate.subscription, role, model: candidate.model },
        "Candidate saturated in review dispatch, trying next",
      );
    }

    return {
      candidate: null,
      dispatchAllowed: false,
      reason: `All candidates for role ${role} exhausted or same-family for ${prContext.repositoryFullName}#${prContext.prNumber}`,
      allExhausted: true,
    };
  }

  async function syncQuotaFromProvider(subscription: string): Promise<void> {
    const tracker = createTracker(db, subscription);
    await tracker.resetSaturation();
  }

  async function getQuotaStatus(subscription: string): Promise<{
    subscription: string;
    available: number;
    saturated: boolean;
  } | null> {
    try {
      const rows = await db
        .select()
        .from(subscriptionQuotas)
        .where(and(
          eq(subscriptionQuotas.subscription, subscription),
          sql`${subscriptionQuotas.windowStart} <= NOW()`,
          sql`${subscriptionQuotas.windowEnd} > NOW()`,
        ))
        .limit(1);

      if (rows.length === 0) {
        return {
          subscription,
          available: 0.7,
          saturated: false,
        };
      }

      const row = rows[0]!;
      return {
        subscription,
        available: Math.max(0, 1 - (row.usedMessages / row.capacityMessages)),
        saturated: row.isSaturated,
      };
    } catch (err) {
      logger.error({ err, subscription }, "getQuotaStatus failed");
      return null;
    }
  }

  async function upsertCandidate(input: {
    role: string;
    model: string;
    harness: string;
    subscription: string;
    provider: string;
    qualityRank?: number;
  }): Promise<void> {
    const { role, model, harness, subscription, provider, qualityRank = 1.0 } = input;

    await db
      .insert(agentRoleCandidates)
      .values({
        role,
        model,
        harness,
        subscription,
        provider,
        qualityRank,
      })
      .onConflictDoUpdate({
        target: [agentRoleCandidates.role, agentRoleCandidates.model, agentRoleCandidates.harness],
        set: {
          subscription,
          provider,
          qualityRank,
          updatedAt: new Date(),
        },
      });
  }

  async function initializeDefaultCandidates(): Promise<void> {
    const defaults: Array<{
      role: string;
      model: string;
      harness: string;
      subscription: string;
      provider: string;
      qualityRank: number;
    }> = [
      { role: "engineer", model: "claude-sonnet-4-6", harness: "claude_code_local", subscription: "Anthropic Max", provider: "anthropic", qualityRank: 1.0 },
      { role: "engineer", model: "gpt-5.1-codex", harness: "codex_local", subscription: "ChatGPT Pro 20x", provider: "openai", qualityRank: 0.95 },
      { role: "engineer", model: "gemini-2.5-pro", harness: "gemini_local", subscription: "Gemini AI Ultra", provider: "google", qualityRank: 0.9 },
      { role: "reviewer", model: "kimi-k2.5", harness: "opencode_local", subscription: "BytePlus Coding Plan", provider: "byteplus", qualityRank: 0.85 },
      { role: "reviewer", model: "gpt-5.1", harness: "codex_local", subscription: "ChatGPT Pro 20x", provider: "openai", qualityRank: 0.9 },
      { role: "reviewer", model: "gemini-2.5-pro", harness: "gemini_local", subscription: "Gemini AI Ultra", provider: "google", qualityRank: 0.85 },
      { role: "designer", model: "claude-opus-4-7", harness: "claude_code_local", subscription: "Anthropic Max", provider: "anthropic", qualityRank: 1.0 },
      { role: "designer", model: "gemini-2.5-pro", harness: "gemini_local", subscription: "Gemini AI Ultra", provider: "google", qualityRank: 0.85 },
      { role: "architect", model: "claude-opus-4-7", harness: "claude_code_local", subscription: "Anthropic Max", provider: "anthropic", qualityRank: 1.0 },
      { role: "ceo", model: "claude-opus-4-7", harness: "claude_code_local", subscription: "Anthropic Max", provider: "anthropic", qualityRank: 1.0 },
    ];

    for (const candidate of defaults) {
      await upsertCandidate(candidate);
    }
  }

  return {
    dispatch,
    dispatchForReview,
    getCandidatesForRole,
    recordFailure,
    recordSuccess,
    syncQuotaFromProvider,
    getQuotaStatus,
    upsertCandidate,
    initializeDefaultCandidates,
  };
}

export type DispatcherService = ReturnType<typeof createDispatcherService>;