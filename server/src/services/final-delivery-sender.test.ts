import { describe, expect, it, vi } from "vitest";
import type { IssueFinalDeliveryPayload, IssueFinalDeliveryResult } from "@paperclipai/shared";
import {
  createIssueFinalDeliverySender,
  formatIssueFinalDeliveryMessage,
  shouldAttemptFinalDelivery,
  type FinalDeliveryPendingInteraction,
} from "./final-delivery-sender.js";

const payload: IssueFinalDeliveryPayload = {
  version: 1,
  destination: {
    platform: "telegram",
    chatId: "-1003913210493",
    threadId: "103",
  },
  issue: {
    id: "11111111-1111-4111-8111-111111111111",
    identifier: "LET-50",
    title: "Ship final delivery loop",
  },
  message: {
    format: "markdown",
    body: "Done. Evidence attached.",
  },
  artifacts: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      type: "pull_request",
      title: "PR #16",
      url: "https://github.com/lmanualm/paperclip/pull/16",
      summary: "Final delivery intent",
      isPrimary: true,
    },
  ],
  queuedAt: "2026-05-12T16:00:00.000Z",
};

function pendingInteraction(result: IssueFinalDeliveryResult | null = null): FinalDeliveryPendingInteraction {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    companyId: "44444444-4444-4444-8444-444444444444",
    issueId: payload.issue.id,
    status: "pending",
    payload,
    result,
  };
}

function sendingInteraction(result: IssueFinalDeliveryResult): FinalDeliveryPendingInteraction {
  return {
    ...pendingInteraction(result),
    status: "sending",
  };
}

describe("final delivery sender", () => {
  it("formats final delivery messages with evidence artifacts", () => {
    expect(formatIssueFinalDeliveryMessage(payload)).toContain("Done. Evidence attached.");
    expect(formatIssueFinalDeliveryMessage(payload)).toContain("Evidence");
    expect(formatIssueFinalDeliveryMessage(payload)).toContain("PR #16");
    expect(formatIssueFinalDeliveryMessage(payload)).toContain("https://github.com/lmanualm/paperclip/pull/16");
  });

  it("respects pending retry backoff metadata", () => {
    const interaction = pendingInteraction({
      version: 1,
      outcome: "failed",
      error: "429 Too Many Requests",
      attemptCount: 1,
      lastAttemptAt: "2026-05-12T16:00:00.000Z",
      nextAttemptAt: "2026-05-12T16:05:00.000Z",
    });

    expect(shouldAttemptFinalDelivery(interaction, new Date("2026-05-12T16:04:59.000Z"))).toBe(false);
    expect(shouldAttemptFinalDelivery(interaction, new Date("2026-05-12T16:05:00.000Z"))).toBe(true);
  });

  it("reclaims expired sending claims but leaves active claims alone", () => {
    const active = sendingInteraction({
      version: 1,
      outcome: "sending",
      attemptCount: 1,
      lastAttemptAt: "2026-05-12T16:10:00.000Z",
      nextAttemptAt: null,
      claimToken: "active-claim",
      claimedAt: "2026-05-12T16:10:00.000Z",
      claimExpiresAt: "2026-05-12T16:15:00.000Z",
    });
    const expired = sendingInteraction({
      version: 1,
      outcome: "sending",
      attemptCount: 1,
      lastAttemptAt: "2026-05-12T16:10:00.000Z",
      nextAttemptAt: null,
      claimToken: "expired-claim",
      claimedAt: "2026-05-12T16:10:00.000Z",
      claimExpiresAt: "2026-05-12T16:14:59.000Z",
    });
    const malformed = sendingInteraction({
      version: 1,
      outcome: "sending",
      attemptCount: 1,
      lastAttemptAt: "2026-05-12T16:10:00.000Z",
      nextAttemptAt: null,
      claimToken: "malformed-claim",
      claimedAt: "2026-05-12T16:10:00.000Z",
      claimExpiresAt: "not-a-date",
    });
    const missingLease = sendingInteraction({
      version: 1,
      outcome: "sending",
      attemptCount: 1,
      lastAttemptAt: "2026-05-12T16:10:00.000Z",
      nextAttemptAt: null,
      claimToken: "missing-lease-claim",
      claimedAt: "2026-05-12T16:10:00.000Z",
    });

    expect(shouldAttemptFinalDelivery(active, new Date("2026-05-12T16:14:59.000Z"))).toBe(false);
    expect(shouldAttemptFinalDelivery(expired, new Date("2026-05-12T16:15:00.000Z"))).toBe(true);
    expect(shouldAttemptFinalDelivery(malformed, new Date("2026-05-12T16:15:00.000Z"))).toBe(false);
    expect(shouldAttemptFinalDelivery(missingLease, new Date("2026-05-12T16:15:00.000Z"))).toBe(false);
  });

  it("skips unsupported transport platforms without claiming rows", async () => {
    const interaction: FinalDeliveryPendingInteraction = {
      ...pendingInteraction(),
      payload: {
        ...payload,
        destination: {
          platform: "slack",
          channelId: "C123",
        },
      },
    };
    const store = {
      listPendingFinalDeliveries: vi.fn(async () => [interaction]),
      claimForDelivery: vi.fn(async () => interaction),
      markDelivered: vi.fn(async () => undefined),
      markRetry: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const transport = {
      supports: vi.fn(() => false),
      send: vi.fn(async () => ({ externalMessageId: "slack:123" })),
    };
    const sender = createIssueFinalDeliverySender({ store, transport });

    const result = await sender.processPendingFinalDeliveries({ limit: 10 });

    expect(result).toEqual({ scanned: 1, attempted: 0, delivered: 0, retrying: 0, failed: 0, skipped: 1 });
    expect(store.claimForDelivery).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("marks successful deliveries as delivered exactly once", async () => {
    const interaction = pendingInteraction();
    const store = {
      listPendingFinalDeliveries: vi.fn(async () => [interaction]),
      claimForDelivery: vi.fn(async (candidate, claim) => ({
        ...candidate,
        status: "sending" as const,
        result: {
          version: 1,
          outcome: "sending" as const,
          attemptCount: 1,
          lastAttemptAt: "2026-05-12T16:10:00.000Z",
          nextAttemptAt: null,
          claimToken: claim.claimToken,
          claimedAt: "2026-05-12T16:10:00.000Z",
          claimExpiresAt: "2026-05-12T16:15:00.000Z",
        },
      })),
      markDelivered: vi.fn(async () => undefined),
      markRetry: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const transport = {
      send: vi.fn(async () => ({ externalMessageId: "telegram:123" })),
    };
    const sender = createIssueFinalDeliverySender({
      store,
      transport,
      now: () => new Date("2026-05-12T16:10:00.000Z"),
      maxAttempts: 3,
      retryBaseMs: 60_000,
    });

    const result = await sender.processPendingFinalDeliveries({ limit: 10 });

    expect(result).toEqual({ scanned: 1, attempted: 1, delivered: 1, retrying: 0, failed: 0, skipped: 0 });
    expect(store.claimForDelivery).toHaveBeenCalledWith(interaction, expect.objectContaining({
      attemptCount: 1,
      claimToken: expect.any(String),
      claimedAt: new Date("2026-05-12T16:10:00.000Z"),
      claimExpiresAt: new Date("2026-05-12T16:15:00.000Z"),
    }));
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledWith(payload, expect.objectContaining({
      text: expect.stringContaining("Done. Evidence attached."),
      attemptCount: 1,
    }));
    expect(store.markDelivered).toHaveBeenCalledWith(expect.objectContaining({
      id: interaction.id,
      status: "sending",
    }), expect.objectContaining({
      outcome: "delivered",
      deliveredAt: "2026-05-12T16:10:00.000Z",
      externalMessageId: "telegram:123",
      attemptCount: 1,
    }));
    expect(store.markRetry).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it("does not send when another worker already claimed the delivery", async () => {
    const interaction = pendingInteraction();
    const store = {
      listPendingFinalDeliveries: vi.fn(async () => [interaction]),
      claimForDelivery: vi.fn(async () => null),
      markDelivered: vi.fn(async () => undefined),
      markRetry: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const transport = {
      send: vi.fn(async () => ({ externalMessageId: "telegram:duplicate" })),
    };
    const sender = createIssueFinalDeliverySender({
      store,
      transport,
      now: () => new Date("2026-05-12T16:10:00.000Z"),
    });

    const result = await sender.processPendingFinalDeliveries({ limit: 10 });

    expect(result).toEqual({ scanned: 1, attempted: 1, delivered: 0, retrying: 0, failed: 0, skipped: 1 });
    expect(store.claimForDelivery).toHaveBeenCalledTimes(1);
    expect(transport.send).not.toHaveBeenCalled();
    expect(store.markDelivered).not.toHaveBeenCalled();
    expect(store.markRetry).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it("persists retry metadata for retryable failures and terminal failure after max attempts", async () => {
    const first = pendingInteraction();
    const terminal = pendingInteraction({
      version: 1,
      outcome: "failed",
      error: "still failing",
      attemptCount: 2,
      lastAttemptAt: "2026-05-12T16:09:00.000Z",
      nextAttemptAt: "2026-05-12T16:10:00.000Z",
    });
    const store = {
      listPendingFinalDeliveries: vi.fn(async () => [first, terminal]),
      claimForDelivery: vi.fn(async (candidate, claim) => ({
        ...candidate,
        status: "sending" as const,
        result: {
          version: 1,
          outcome: "sending" as const,
          attemptCount: claim.attemptCount,
          lastAttemptAt: "2026-05-12T16:10:00.000Z",
          nextAttemptAt: null,
          claimToken: claim.claimToken,
          claimedAt: "2026-05-12T16:10:00.000Z",
          claimExpiresAt: "2026-05-12T16:15:00.000Z",
        },
      })),
      markDelivered: vi.fn(async () => undefined),
      markRetry: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const transport = {
      send: vi.fn(async () => {
        throw new Error("429 Too Many Requests");
      }),
    };
    const sender = createIssueFinalDeliverySender({
      store,
      transport,
      now: () => new Date("2026-05-12T16:10:00.000Z"),
      maxAttempts: 3,
      retryBaseMs: 60_000,
    });

    const result = await sender.processPendingFinalDeliveries({ limit: 10 });

    expect(result).toEqual({ scanned: 2, attempted: 2, delivered: 0, retrying: 1, failed: 1, skipped: 0 });
    expect(store.markRetry).toHaveBeenCalledWith(expect.objectContaining({
      id: first.id,
      status: "sending",
      result: expect.objectContaining({
        outcome: "sending",
        attemptCount: 1,
        claimToken: expect.any(String),
      }),
    }), expect.objectContaining({
      outcome: "failed",
      attemptCount: 1,
      lastAttemptAt: "2026-05-12T16:10:00.000Z",
      nextAttemptAt: "2026-05-12T16:11:00.000Z",
      error: "429 Too Many Requests",
    }));
    expect(store.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      id: terminal.id,
      status: "sending",
      result: expect.objectContaining({
        outcome: "sending",
        attemptCount: 3,
        claimToken: expect.any(String),
      }),
    }), expect.objectContaining({
      outcome: "failed",
      attemptCount: 3,
      lastAttemptAt: "2026-05-12T16:10:00.000Z",
      nextAttemptAt: null,
      error: "429 Too Many Requests",
    }));
  });

  it("marks non-retryable delivery failures terminal immediately", async () => {
    const interaction = pendingInteraction();
    const store = {
      listPendingFinalDeliveries: vi.fn(async () => [interaction]),
      claimForDelivery: vi.fn(async (candidate, claim) => ({
        ...candidate,
        status: "sending" as const,
        result: {
          version: 1,
          outcome: "sending" as const,
          attemptCount: claim.attemptCount,
          lastAttemptAt: "2026-05-12T16:10:00.000Z",
          nextAttemptAt: null,
          claimToken: claim.claimToken,
          claimedAt: "2026-05-12T16:10:00.000Z",
          claimExpiresAt: "2026-05-12T16:15:00.000Z",
        },
      })),
      markDelivered: vi.fn(async () => undefined),
      markRetry: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const transport = {
      send: vi.fn(async () => {
        throw new Error("invalid_auth");
      }),
    };
    const sender = createIssueFinalDeliverySender({
      store,
      transport,
      now: () => new Date("2026-05-12T16:10:00.000Z"),
      maxAttempts: 3,
      retryBaseMs: 60_000,
    });

    const result = await sender.processPendingFinalDeliveries({ limit: 10 });

    expect(result).toEqual({ scanned: 1, attempted: 1, delivered: 0, retrying: 0, failed: 1, skipped: 0 });
    expect(store.markRetry).not.toHaveBeenCalled();
    expect(store.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      id: interaction.id,
      status: "sending",
    }), expect.objectContaining({
      outcome: "failed",
      attemptCount: 1,
      nextAttemptAt: null,
      error: "invalid_auth",
      retryable: false,
      terminal: true,
    }));
  });
});
