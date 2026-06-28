import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  xMentionAuthorAllowlist,
  xMentionBudgetLedger,
  xMentionSources,
  xMentions,
} from "@paperclipai/db";

const execFileAsync = promisify(nodeExecFile);

export type XMentionOperation = "poll" | "hydrate_thread" | "hydrate_replies" | "hydrate_media";
export type XMentionGateStatus = "stored" | "queued" | "approved";
export type XMentionHydrationStatus = "none" | "queued" | "hydrated";

export interface XMentionSource {
  id: string;
  companyId: string;
  sourceKey: string;
  accountUserId: string;
  accountHandle: string | null;
  sinceId: string | null;
  monthlyBudgetCents: number;
  perRunBudgetCents: number;
  budgetPausedAt: Date | null;
  budgetPauseReason: string | null;
  rateLimitResetAt: Date | null;
}

export interface XMentionInput {
  tweetId: string;
  authorUserId: string;
  authorHandle?: string | null;
  text?: string | null;
  mentionedAt?: Date | string | null;
  raw?: Record<string, unknown>;
}

export interface StoredXMention {
  id: string;
  companyId: string;
  sourceId: string;
  tweetId: string;
  authorUserId: string;
  authorHandle: string | null;
  gateStatus: XMentionGateStatus;
  hydrationStatus: XMentionHydrationStatus;
  manualApprovedAt: Date | null;
}

export interface XMentionFetchResult {
  mentions: XMentionInput[];
  nextSinceId?: string | null;
  rateLimitResetAt?: Date | null;
}

export interface XHydrationResult {
  thread?: Record<string, unknown> | null;
  replies?: Record<string, unknown> | null;
  media?: Record<string, unknown> | null;
}

export interface XMentionAdapter {
  estimateOperation(input: {
    operation: XMentionOperation;
    source: XMentionSource;
    mention?: StoredXMention | null;
  }): Promise<number | null> | number | null;
  fetchMentions(input: {
    accountUserId: string;
    sinceId: string | null;
    limit: number;
  }): Promise<XMentionFetchResult>;
  hydrateMention?(input: {
    tweetId: string;
    operations: Exclude<XMentionOperation, "poll">[];
  }): Promise<XHydrationResult>;
}

export interface XMentionStore {
  getOrCreateSource(input: {
    companyId: string;
    sourceKey: string;
    accountUserId: string;
    accountHandle?: string | null;
    monthlyBudgetCents?: number;
    perRunBudgetCents?: number;
  }): Promise<XMentionSource>;
  updateSourceCursor(input: { sourceId: string; sinceId: string | null; now: Date }): Promise<void>;
  pauseSourceForBudget(input: { sourceId: string; reason: string; now: Date }): Promise<void>;
  markSourceRateLimited(input: { sourceId: string; resetAt: Date; now: Date }): Promise<void>;
  isAuthorAllowlisted(input: { companyId: string; xUserId: string }): Promise<boolean>;
  upsertMention(input: {
    companyId: string;
    sourceId: string;
    mention: XMentionInput;
    gateStatus: XMentionGateStatus;
    hydrationStatus: XMentionHydrationStatus;
    now: Date;
  }): Promise<{ mention: StoredXMention; inserted: boolean }>;
  listQueuedHydration(input: { companyId: string; sourceId: string; limit: number }): Promise<StoredXMention[]>;
  markHydrated(input: { mentionId: string; now: Date; data?: Record<string, unknown> }): Promise<void>;
  sumBudgetSince(input: { sourceId: string; since: Date }): Promise<number>;
  recordBudget(input: {
    companyId: string;
    sourceId: string;
    mentionId?: string | null;
    operation: XMentionOperation;
    estimatedCostCents: number;
    actualCostCents?: number | null;
    status?: "recorded" | "rejected";
    failureReason?: string | null;
    now: Date;
  }): Promise<void>;
}

export class XRateLimitError extends Error {
  readonly resetAt: Date;

  constructor(resetAt: Date, message = "X API rate limit exceeded") {
    super(message);
    this.name = "XRateLimitError";
    this.resetAt = resetAt;
  }
}

export class XBudgetPausedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "XBudgetPausedError";
    this.reason = reason;
  }
}

function toDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function monthStartUtc(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function maxTweetId(current: string | null, mentions: XMentionInput[]) {
  let max = current;
  for (const mention of mentions) {
    if (!max || compareTweetIds(mention.tweetId, max) > 0) {
      max = mention.tweetId;
    }
  }
  return max;
}

function compareTweetIds(a: string, b: string) {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left > right ? 1 : -1;
  } catch {
    return a.localeCompare(b);
  }
}

function assertSafeEstimate(value: number | null, operation: XMentionOperation) {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return `missing_cost_estimate:${operation}`;
  }
  return null;
}

export function createXMentionPoller(options: {
  store: XMentionStore;
  adapter: XMentionAdapter;
  now?: () => Date;
}) {
  const { store, adapter } = options;
  const now = options.now ?? (() => new Date());

  async function checkBudget(input: {
    source: XMentionSource;
    operation: XMentionOperation;
    mention?: StoredXMention | null;
    runSpendCents: number;
    unrecordedSpendCents?: number;
  }) {
    const at = now();
    const estimate = await adapter.estimateOperation({
      operation: input.operation,
      source: input.source,
      mention: input.mention ?? null,
    });
    const unsafeReason = assertSafeEstimate(estimate, input.operation);
    if (unsafeReason) {
      await store.recordBudget({
        companyId: input.source.companyId,
        sourceId: input.source.id,
        mentionId: input.mention?.id ?? null,
        operation: input.operation,
        estimatedCostCents: 0,
        status: "rejected",
        failureReason: unsafeReason,
        now: at,
      });
      await store.pauseSourceForBudget({ sourceId: input.source.id, reason: unsafeReason, now: at });
      throw new XBudgetPausedError(unsafeReason);
    }

    const estimatedCostCents = Math.ceil(estimate as number);
    if (input.runSpendCents + estimatedCostCents > input.source.perRunBudgetCents) {
      const reason = `per_run_budget_exceeded:${input.operation}`;
      await store.recordBudget({
        companyId: input.source.companyId,
        sourceId: input.source.id,
        mentionId: input.mention?.id ?? null,
        operation: input.operation,
        estimatedCostCents,
        status: "rejected",
        failureReason: reason,
        now: at,
      });
      await store.pauseSourceForBudget({ sourceId: input.source.id, reason, now: at });
      throw new XBudgetPausedError(reason);
    }

    const monthSpend = await store.sumBudgetSince({
      sourceId: input.source.id,
      since: monthStartUtc(at),
    });
    if (monthSpend + (input.unrecordedSpendCents ?? 0) + estimatedCostCents > input.source.monthlyBudgetCents) {
      const reason = `monthly_budget_exceeded:${input.operation}`;
      await store.recordBudget({
        companyId: input.source.companyId,
        sourceId: input.source.id,
        mentionId: input.mention?.id ?? null,
        operation: input.operation,
        estimatedCostCents,
        status: "rejected",
        failureReason: reason,
        now: at,
      });
      await store.pauseSourceForBudget({ sourceId: input.source.id, reason, now: at });
      throw new XBudgetPausedError(reason);
    }

    return estimatedCostCents;
  }

  async function recordSuccessfulBudget(input: {
    source: XMentionSource;
    operation: XMentionOperation;
    estimatedCostCents: number;
    mention?: StoredXMention | null;
  }) {
    await store.recordBudget({
      companyId: input.source.companyId,
      sourceId: input.source.id,
      mentionId: input.mention?.id ?? null,
      operation: input.operation,
      estimatedCostCents: input.estimatedCostCents,
      actualCostCents: input.estimatedCostCents,
      now: now(),
    });
  }

  async function reserveBudget(input: {
    source: XMentionSource;
    operation: XMentionOperation;
    mention?: StoredXMention | null;
    runSpendCents: number;
  }) {
    const estimatedCostCents = await checkBudget(input);
    await recordSuccessfulBudget({ ...input, estimatedCostCents });
    return estimatedCostCents;
  }

  async function pollMentions(input: {
    companyId: string;
    sourceKey: string;
    accountUserId: string;
    accountHandle?: string | null;
    limit?: number;
    monthlyBudgetCents?: number;
    perRunBudgetCents?: number;
  }) {
    const source = await store.getOrCreateSource(input);
    if (source.budgetPausedAt) {
      return {
        status: "budget_paused" as const,
        reason: source.budgetPauseReason ?? "budget_paused",
        stored: 0,
        queued: 0,
        duplicates: 0,
        cursor: source.sinceId,
      };
    }
    if (source.rateLimitResetAt && source.rateLimitResetAt > now()) {
      return {
        status: "rate_limited" as const,
        rateLimitResetAt: source.rateLimitResetAt,
        stored: 0,
        queued: 0,
        duplicates: 0,
        cursor: source.sinceId,
      };
    }

    let runSpendCents = 0;
    try {
      runSpendCents += await reserveBudget({ source, operation: "poll", runSpendCents });
      const result = await adapter.fetchMentions({
        accountUserId: source.accountUserId,
        sinceId: source.sinceId,
        limit: input.limit ?? 100,
      });
      let stored = 0;
      let queued = 0;
      let duplicates = 0;
      for (const mention of result.mentions) {
        const approved = await store.isAuthorAllowlisted({
          companyId: source.companyId,
          xUserId: mention.authorUserId,
        });
        const upserted = await store.upsertMention({
          companyId: source.companyId,
          sourceId: source.id,
          mention,
          gateStatus: approved ? "queued" : "stored",
          hydrationStatus: approved ? "queued" : "none",
          now: now(),
        });
        if (upserted.inserted) {
          stored += 1;
        } else {
          duplicates += 1;
        }
        if (upserted.mention.hydrationStatus === "queued") {
          queued += 1;
        }
      }
      const nextSinceId = result.nextSinceId ?? maxTweetId(source.sinceId, result.mentions);
      await store.updateSourceCursor({ sourceId: source.id, sinceId: nextSinceId, now: now() });
      if (result.rateLimitResetAt) {
        await store.markSourceRateLimited({ sourceId: source.id, resetAt: result.rateLimitResetAt, now: now() });
      }
      return {
        status: "ok" as const,
        stored,
        queued,
        duplicates,
        cursor: nextSinceId,
      };
    } catch (err) {
      if (err instanceof XBudgetPausedError) {
        return {
          status: "budget_paused" as const,
          reason: err.reason,
          stored: 0,
          queued: 0,
          duplicates: 0,
          cursor: source.sinceId,
        };
      }
      if (err instanceof XRateLimitError) {
        await store.markSourceRateLimited({ sourceId: source.id, resetAt: err.resetAt, now: now() });
        return {
          status: "rate_limited" as const,
          rateLimitResetAt: err.resetAt,
          stored: 0,
          queued: 0,
          duplicates: 0,
          cursor: source.sinceId,
        };
      }
      throw err;
    }
  }

  async function hydrateQueuedMentions(input: {
    companyId: string;
    sourceKey: string;
    accountUserId: string;
    accountHandle?: string | null;
    limit?: number;
    operations?: Exclude<XMentionOperation, "poll">[];
  }) {
    const source = await store.getOrCreateSource(input);
    if (source.budgetPausedAt) {
      return { status: "budget_paused" as const, reason: source.budgetPauseReason ?? "budget_paused", hydrated: 0 };
    }
    if (source.rateLimitResetAt && source.rateLimitResetAt > now()) {
      return { status: "rate_limited" as const, rateLimitResetAt: source.rateLimitResetAt, hydrated: 0 };
    }
    if (!adapter.hydrateMention) {
      return { status: "ok" as const, hydrated: 0 };
    }
    const operations = input.operations ?? ["hydrate_thread", "hydrate_replies", "hydrate_media"];
    const queued = await store.listQueuedHydration({
      companyId: input.companyId,
      sourceId: source.id,
      limit: input.limit ?? 25,
    });
    let runSpendCents = 0;
    let hydrated = 0;
    try {
      for (const mention of queued) {
        const budgets: Array<{ operation: Exclude<XMentionOperation, "poll">; estimatedCostCents: number }> = [];
        let pendingSpendCents = 0;
        for (const operation of operations) {
          const estimatedCostCents = await checkBudget({
            source,
            operation,
            mention,
            runSpendCents: runSpendCents + pendingSpendCents,
            unrecordedSpendCents: pendingSpendCents,
          });
          budgets.push({ operation, estimatedCostCents });
          pendingSpendCents += estimatedCostCents;
        }
        const data = await adapter.hydrateMention({ tweetId: mention.tweetId, operations });
        for (const budget of budgets) {
          await recordSuccessfulBudget({ source, mention, ...budget });
        }
        runSpendCents += pendingSpendCents;
        await store.markHydrated({ mentionId: mention.id, now: now(), data: data as Record<string, unknown> });
        hydrated += 1;
      }
      return { status: "ok" as const, hydrated };
    } catch (err) {
      if (err instanceof XBudgetPausedError) {
        return { status: "budget_paused" as const, reason: err.reason, hydrated };
      }
      if (err instanceof XRateLimitError) {
        await store.markSourceRateLimited({ sourceId: source.id, resetAt: err.resetAt, now: now() });
        return { status: "rate_limited" as const, rateLimitResetAt: err.resetAt, hydrated };
      }
      throw err;
    }
  }

  return { pollMentions, hydrateQueuedMentions };
}

export function createDbXMentionStore(db: Db): XMentionStore {
  return {
    async getOrCreateSource(input) {
      const now = new Date();
      const rows = await db
        .insert(xMentionSources)
        .values({
          companyId: input.companyId,
          sourceKey: input.sourceKey,
          accountUserId: input.accountUserId,
          accountHandle: input.accountHandle ?? null,
          monthlyBudgetCents: input.monthlyBudgetCents ?? 5000,
          perRunBudgetCents: input.perRunBudgetCents ?? 500,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [xMentionSources.companyId, xMentionSources.sourceKey],
          set: {
            accountUserId: input.accountUserId,
            accountHandle: input.accountHandle ?? null,
            monthlyBudgetCents: input.monthlyBudgetCents ?? sql`${xMentionSources.monthlyBudgetCents}`,
            perRunBudgetCents: input.perRunBudgetCents ?? sql`${xMentionSources.perRunBudgetCents}`,
            updatedAt: now,
          },
        })
        .returning();
      return rows[0] as XMentionSource;
    },
    async updateSourceCursor(input) {
      await db
        .update(xMentionSources)
        .set({ sinceId: input.sinceId, updatedAt: input.now })
        .where(eq(xMentionSources.id, input.sourceId));
    },
    async pauseSourceForBudget(input) {
      await db
        .update(xMentionSources)
        .set({ budgetPausedAt: input.now, budgetPauseReason: input.reason, updatedAt: input.now })
        .where(eq(xMentionSources.id, input.sourceId));
    },
    async markSourceRateLimited(input) {
      await db
        .update(xMentionSources)
        .set({ rateLimitResetAt: input.resetAt, updatedAt: input.now })
        .where(eq(xMentionSources.id, input.sourceId));
    },
    async isAuthorAllowlisted(input) {
      const rows = await db
        .select({ id: xMentionAuthorAllowlist.id })
        .from(xMentionAuthorAllowlist)
        .where(and(
          eq(xMentionAuthorAllowlist.companyId, input.companyId),
          eq(xMentionAuthorAllowlist.xUserId, input.xUserId),
          eq(xMentionAuthorAllowlist.isActive, true),
        ));
      return rows.length > 0;
    },
    async upsertMention(input) {
      const mentionedAt = toDate(input.mention.mentionedAt);
      const rows = await db
        .insert(xMentions)
        .values({
          companyId: input.companyId,
          sourceId: input.sourceId,
          tweetId: input.mention.tweetId,
          authorUserId: input.mention.authorUserId,
          authorHandle: input.mention.authorHandle ?? null,
          text: input.mention.text ?? "",
          mentionedAt,
          raw: input.mention.raw ?? {},
          gateStatus: input.gateStatus,
          hydrationStatus: input.hydrationStatus,
          queuedAt: input.hydrationStatus === "queued" ? input.now : null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [xMentions.companyId, xMentions.tweetId],
          set: {
            sourceId: input.sourceId,
            authorUserId: input.mention.authorUserId,
            authorHandle: input.mention.authorHandle ?? null,
            text: input.mention.text ?? "",
            mentionedAt,
            raw: input.mention.raw ?? {},
            gateStatus: sql`case when ${xMentions.manualApprovedAt} is not null then 'approved' else ${input.gateStatus} end`,
            hydrationStatus: sql`case when ${xMentions.manualApprovedAt} is not null then 'queued' else ${input.hydrationStatus} end`,
            queuedAt: sql`case when ${xMentions.manualApprovedAt} is not null or ${input.hydrationStatus} = 'queued' then coalesce(${xMentions.queuedAt}, ${input.now}) else ${xMentions.queuedAt} end`,
            updatedAt: input.now,
          },
        })
        .returning();
      const mention = rows[0] as StoredXMention & { createdAt?: Date };
      return {
        mention,
        inserted: mention.createdAt?.getTime() === input.now.getTime(),
      };
    },
    async listQueuedHydration(input) {
      const rows = await db
        .select()
        .from(xMentions)
        .where(and(
          eq(xMentions.companyId, input.companyId),
          eq(xMentions.sourceId, input.sourceId),
          eq(xMentions.hydrationStatus, "queued"),
        ))
        .limit(input.limit);
      return rows as StoredXMention[];
    },
    async markHydrated(input) {
      await db
        .update(xMentions)
        .set({
          hydrationStatus: "hydrated",
          hydratedAt: input.now,
          raw: input.data ?? sql`${xMentions.raw}`,
          updatedAt: input.now,
        })
        .where(eq(xMentions.id, input.mentionId));
    },
    async sumBudgetSince(input) {
      const rows = await db
        .select({ total: sql<number>`coalesce(sum(${xMentionBudgetLedger.actualCostCents}), 0)` })
        .from(xMentionBudgetLedger)
        .where(and(
          eq(xMentionBudgetLedger.sourceId, input.sourceId),
          eq(xMentionBudgetLedger.status, "recorded"),
          gte(xMentionBudgetLedger.occurredAt, input.since),
        ));
      return Number(rows[0]?.total ?? 0);
    },
    async recordBudget(input) {
      await db.insert(xMentionBudgetLedger).values({
        companyId: input.companyId,
        sourceId: input.sourceId,
        mentionId: input.mentionId ?? null,
        operation: input.operation,
        estimatedCostCents: input.estimatedCostCents,
        actualCostCents: input.actualCostCents ?? null,
        status: input.status ?? "recorded",
        failureReason: input.failureReason ?? null,
        occurredAt: input.now,
      });
    },
  };
}

interface XApiMentionAdapterOptions {
  bearerToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  estimates?: Partial<Record<XMentionOperation, number | null>>;
}

export function createXApiV2MentionAdapter(options: XApiMentionAdapterOptions): XMentionAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.x.com/2";
  const estimates = options.estimates ?? { poll: 1, hydrate_thread: 1, hydrate_replies: 1, hydrate_media: 1 };

  return {
    estimateOperation({ operation }) {
      return estimates[operation] ?? null;
    },
    async fetchMentions({ accountUserId, sinceId, limit }) {
      const url = new URL(`${baseUrl}/users/${encodeURIComponent(accountUserId)}/mentions`);
      url.searchParams.set("max_results", String(Math.max(5, Math.min(limit, 100))));
      url.searchParams.set("tweet.fields", "author_id,created_at,conversation_id,referenced_tweets");
      url.searchParams.set("expansions", "author_id");
      url.searchParams.set("user.fields", "username");
      if (sinceId) url.searchParams.set("since_id", sinceId);
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${options.bearerToken}` },
      });
      if (response.status === 429) {
        const resetAt = Number(response.headers.get("x-rate-limit-reset"));
        throw new XRateLimitError(Number.isFinite(resetAt) ? new Date(resetAt * 1000) : new Date(Date.now() + 15 * 60_000));
      }
      if (!response.ok) {
        throw new Error(`X mention fetch failed with HTTP ${response.status}`);
      }
      const body = await response.json() as {
        data?: Array<Record<string, unknown>>;
        includes?: { users?: Array<{ id?: string; username?: string }> };
        meta?: { newest_id?: string };
      };
      const users = new Map((body.includes?.users ?? []).map((user) => [String(user.id), user.username ?? null]));
      return {
        mentions: (body.data ?? []).map((tweet) => {
          const authorUserId = String(tweet.author_id ?? "");
          return {
            tweetId: String(tweet.id),
            authorUserId,
            authorHandle: users.get(authorUserId) ?? null,
            text: typeof tweet.text === "string" ? tweet.text : "",
            mentionedAt: typeof tweet.created_at === "string" ? tweet.created_at : null,
            raw: tweet,
          };
        }).filter((mention) => mention.tweetId && mention.authorUserId),
        nextSinceId: body.meta?.newest_id ?? null,
      };
    },
  };
}

interface XcMentionAdapterOptions {
  command?: string;
  execFile?: typeof nodeExecFile;
  estimates?: Partial<Record<XMentionOperation, number | null>>;
  timeoutMs?: number;
}

export function createXcMentionAdapter(options: XcMentionAdapterOptions = {}): XMentionAdapter {
  const command = options.command ?? "xc";
  const estimates = options.estimates ?? { poll: 1, hydrate_thread: 1, hydrate_replies: 1, hydrate_media: 1 };
  const run = options.execFile
    ? promisify(options.execFile)
    : execFileAsync;

  async function execJson(args: string[]) {
    const { stdout } = await run(command, args, { timeout: options.timeoutMs ?? 30_000 });
    return JSON.parse(stdout.toString()) as Record<string, unknown>;
  }

  return {
    estimateOperation({ operation }) {
      return estimates[operation] ?? null;
    },
    async fetchMentions({ accountUserId, sinceId, limit }) {
      const args = ["mentions", "list", "--user-id", accountUserId, "--limit", String(limit), "--json"];
      if (sinceId) args.push("--since-id", sinceId);
      const body = await execJson(args) as {
        mentions?: XMentionInput[];
        nextSinceId?: string | null;
        rateLimitResetAt?: string | null;
      };
      return {
        mentions: body.mentions ?? [],
        nextSinceId: body.nextSinceId ?? null,
        rateLimitResetAt: toDate(body.rateLimitResetAt ?? null),
      };
    },
    async hydrateMention({ tweetId, operations }) {
      const args = ["mentions", "hydrate", "--tweet-id", tweetId, "--operations", operations.join(","), "--json"];
      return await execJson(args) as XHydrationResult;
    },
  };
}
