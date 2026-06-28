import { describe, expect, it, vi } from "vitest";
import {
  createXMentionPoller,
  XRateLimitError,
  type StoredXMention,
  type XMentionAdapter,
  type XMentionInput,
  type XMentionSource,
  type XMentionStore,
} from "../services/x-mention-poller.js";

function createMemoryStore(options: {
  allowlistedUserIds?: string[];
  monthlyBudgetCents?: number;
  perRunBudgetCents?: number;
} = {}) {
  const source: XMentionSource = {
    id: "source-1",
    companyId: "company-1",
    sourceKey: "paperclip",
    accountUserId: "999",
    accountHandle: "paperclip",
    sinceId: null,
    monthlyBudgetCents: options.monthlyBudgetCents ?? 5000,
    perRunBudgetCents: options.perRunBudgetCents ?? 500,
    budgetPausedAt: null,
    budgetPauseReason: null,
    rateLimitResetAt: null,
  };
  const allowlist = new Set(options.allowlistedUserIds ?? []);
  const mentions = new Map<string, StoredXMention & { raw?: Record<string, unknown> }>();
  const ledger: Array<{
    operation: string;
    estimatedCostCents: number;
    actualCostCents: number | null;
    status: string;
    failureReason: string | null;
  }> = [];

  const store: XMentionStore = {
    async getOrCreateSource(input) {
      source.companyId = input.companyId;
      source.sourceKey = input.sourceKey;
      source.accountUserId = input.accountUserId;
      source.accountHandle = input.accountHandle ?? null;
      if (input.monthlyBudgetCents !== undefined) source.monthlyBudgetCents = input.monthlyBudgetCents;
      if (input.perRunBudgetCents !== undefined) source.perRunBudgetCents = input.perRunBudgetCents;
      return source;
    },
    async updateSourceCursor(input) {
      source.sinceId = input.sinceId;
    },
    async pauseSourceForBudget(input) {
      source.budgetPausedAt = input.now;
      source.budgetPauseReason = input.reason;
    },
    async markSourceRateLimited(input) {
      source.rateLimitResetAt = input.resetAt;
    },
    async isAuthorAllowlisted(input) {
      return allowlist.has(input.xUserId);
    },
    async upsertMention(input) {
      const existing = mentions.get(input.mention.tweetId);
      if (existing) {
        const approvedByExistingManualApproval = existing.manualApprovedAt !== null;
        existing.authorUserId = input.mention.authorUserId;
        existing.authorHandle = input.mention.authorHandle ?? null;
        existing.gateStatus = approvedByExistingManualApproval ? "approved" : input.gateStatus;
        existing.hydrationStatus = approvedByExistingManualApproval ? "queued" : input.hydrationStatus;
        return { mention: existing, inserted: false };
      }
      const mention: StoredXMention = {
        id: `mention-${mentions.size + 1}`,
        companyId: input.companyId,
        sourceId: input.sourceId,
        tweetId: input.mention.tweetId,
        authorUserId: input.mention.authorUserId,
        authorHandle: input.mention.authorHandle ?? null,
        gateStatus: input.gateStatus,
        hydrationStatus: input.hydrationStatus,
        manualApprovedAt: null,
      };
      mentions.set(input.mention.tweetId, mention);
      return { mention, inserted: true };
    },
    async listQueuedHydration(input) {
      return [...mentions.values()]
        .filter((mention) => mention.companyId === input.companyId && mention.sourceId === input.sourceId && mention.hydrationStatus === "queued")
        .slice(0, input.limit);
    },
    async markHydrated(input) {
      const mention = [...mentions.values()].find((candidate) => candidate.id === input.mentionId);
      if (mention) {
        mention.hydrationStatus = "hydrated";
        mention.raw = input.data;
      }
    },
    async sumBudgetSince() {
      return ledger
        .filter((row) => row.status === "recorded")
        .reduce((sum, row) => sum + (row.actualCostCents ?? 0), 0);
    },
    async recordBudget(input) {
      ledger.push({
        operation: input.operation,
        estimatedCostCents: input.estimatedCostCents,
        actualCostCents: input.actualCostCents ?? null,
        status: input.status ?? "recorded",
        failureReason: input.failureReason ?? null,
      });
    },
  };

  return { store, source, mentions, ledger, allowlist };
}

function createAdapter(input: {
  mentions?: XMentionInput[];
  estimate?: number | null | Partial<Record<string, number | null>>;
  fetchError?: Error;
} = {}) {
  const estimate = input.estimate ?? 1;
  const adapter: XMentionAdapter = {
    estimateOperation: vi.fn(({ operation }) => {
      if (typeof estimate === "object") return estimate[operation] ?? null;
      return estimate;
    }),
    fetchMentions: vi.fn(async () => {
      if (input.fetchError) throw input.fetchError;
      return { mentions: input.mentions ?? [], nextSinceId: input.mentions?.at(-1)?.tweetId ?? null };
    }),
    hydrateMention: vi.fn(async ({ tweetId }) => ({
      thread: { tweetId },
      replies: { count: 1 },
      media: { count: 0 },
    })),
  };
  return adapter;
}

const pollInput = {
  companyId: "company-1",
  sourceKey: "paperclip",
  accountUserId: "999",
  accountHandle: "paperclip",
};

describe("x mention poller", () => {
  it("stores every mention but only queues allowlisted authors by stable X user id", async () => {
    const memory = createMemoryStore({ allowlistedUserIds: ["42"] });
    const adapter = createAdapter({
      mentions: [
        { tweetId: "100", authorUserId: "42", authorHandle: "allowed", text: "@paperclip hi" },
        { tweetId: "101", authorUserId: "77", authorHandle: "blocked", text: "@paperclip nope" },
      ],
    });
    const poller = createXMentionPoller({ store: memory.store, adapter, now: () => new Date("2026-06-01T00:00:00Z") });

    const result = await poller.pollMentions(pollInput);

    expect(result).toMatchObject({ status: "ok", stored: 2, queued: 1, duplicates: 0, cursor: "101" });
    expect(memory.mentions.get("100")).toMatchObject({ gateStatus: "queued", hydrationStatus: "queued" });
    expect(memory.mentions.get("101")).toMatchObject({ gateStatus: "stored", hydrationStatus: "none" });
  });

  it("uses idempotent upsert and cursoring to prevent duplicate intake rows across retries", async () => {
    const memory = createMemoryStore({ allowlistedUserIds: ["42"] });
    const adapter = createAdapter({
      mentions: [{ tweetId: "100", authorUserId: "42", text: "@paperclip first" }],
    });
    const poller = createXMentionPoller({ store: memory.store, adapter });

    await expect(poller.pollMentions(pollInput)).resolves.toMatchObject({ stored: 1, duplicates: 0, cursor: "100" });
    await expect(poller.pollMentions(pollInput)).resolves.toMatchObject({ stored: 0, duplicates: 1, cursor: "100" });

    expect(memory.mentions).toHaveLength(1);
    expect(adapter.fetchMentions).toHaveBeenLastCalledWith(expect.objectContaining({ sinceId: "100" }));
  });

  it("does not advance since_id when a fetch fails so the next run retries the same cursor", async () => {
    const memory = createMemoryStore();
    memory.source.sinceId = "99";
    const adapter = createAdapter({ fetchError: new Error("network down") });
    const poller = createXMentionPoller({ store: memory.store, adapter });

    await expect(poller.pollMentions(pollInput)).rejects.toThrow("network down");

    expect(memory.source.sinceId).toBe("99");
  });

  it("records rate-limit backoff without advancing the cursor", async () => {
    const memory = createMemoryStore();
    memory.source.sinceId = "99";
    const resetAt = new Date("2026-06-01T00:15:00Z");
    const adapter = createAdapter({ fetchError: new XRateLimitError(resetAt) });
    const poller = createXMentionPoller({ store: memory.store, adapter });

    const result = await poller.pollMentions(pollInput);

    expect(result).toMatchObject({ status: "rate_limited", cursor: "99", rateLimitResetAt: resetAt });
    expect(memory.source.rateLimitResetAt).toEqual(resetAt);
  });

  it("fails closed and pauses the source when poll cost cannot be estimated", async () => {
    const memory = createMemoryStore();
    const adapter = createAdapter({ estimate: { poll: null } });
    const poller = createXMentionPoller({ store: memory.store, adapter });

    const result = await poller.pollMentions(pollInput);

    expect(result).toMatchObject({ status: "budget_paused", reason: "missing_cost_estimate:poll" });
    expect(adapter.fetchMentions).not.toHaveBeenCalled();
    expect(memory.source.budgetPauseReason).toBe("missing_cost_estimate:poll");
    expect(memory.ledger).toContainEqual(expect.objectContaining({
      operation: "poll",
      status: "rejected",
      failureReason: "missing_cost_estimate:poll",
    }));
  });

  it("applies per-run caps across hydration thread, replies, and media operations", async () => {
    const memory = createMemoryStore({ allowlistedUserIds: ["42"], perRunBudgetCents: 3 });
    const adapter = createAdapter({
      estimate: {
        poll: 1,
        hydrate_thread: 1,
        hydrate_replies: 1,
        hydrate_media: 2,
      },
      mentions: [{ tweetId: "100", authorUserId: "42", text: "@paperclip hydrate" }],
    });
    const poller = createXMentionPoller({ store: memory.store, adapter });

    await poller.pollMentions(pollInput);
    const result = await poller.hydrateQueuedMentions(pollInput);

    expect(result).toMatchObject({ status: "budget_paused", reason: "per_run_budget_exceeded:hydrate_media", hydrated: 0 });
    expect(adapter.hydrateMention).not.toHaveBeenCalled();
    expect(memory.ledger.map((row) => row.operation)).toEqual(["poll", "hydrate_thread", "hydrate_replies", "hydrate_media"]);
    expect(memory.ledger.at(-1)).toMatchObject({ status: "rejected", failureReason: "per_run_budget_exceeded:hydrate_media" });
  });
});
