import { describe, expect, it } from "vitest";

import {
  OpenCodeProxyUsageLedger,
  openCodeProxyUsageMeasurement,
} from "./opencode-proxy-usage.js";

describe("OpenCode proxy usage accounting", () => {
  it("folds reasoning into output without changing the budget token total", () => {
    expect(
      openCodeProxyUsageMeasurement({
        input: 11,
        output: 5,
        reasoning: 7,
        cache: { read: 3, write: 2 },
        cost: 0.012,
      }),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 12,
      cachedInputTokens: 3,
      cacheWriteTokens: 2,
      activeSeconds: 0,
      requests: 1,
      providerCostUsd: 0.012,
    });
  });

  it("replaces repeated message snapshots and aggregates tool-loop messages across turns", () => {
    const ledger = new OpenCodeProxyUsageLedger();

    expect(
      ledger.update({
        turnId: "turn-1",
        messageId: "message-1",
        usage: { input: 10, output: 2, reasoning: 3, cost: 0.01 },
      }),
    ).toMatchObject({
      total: {
        inputTokens: 10,
        outputTokens: 5,
        requests: 1,
        providerCostUsd: 0.01,
      },
      last: {
        inputTokens: 10,
        outputTokens: 5,
        requests: 1,
        providerCostUsd: 0.01,
      },
    });

    const firstTurn = ledger.update({
      turnId: "turn-1",
      messageId: "message-1",
      usage: { input: 12, output: 3, reasoning: 4, cost: 0.012 },
    });
    expect(firstTurn.last).toMatchObject({
      inputTokens: 12,
      outputTokens: 7,
      requests: 1,
      providerCostUsd: 0.012,
    });

    expect(
      ledger.update({
        turnId: "turn-1",
        messageId: "message-2",
        usage: { input: 5, output: 1, reasoning: 2, costUsd: 0.005 },
      }),
    ).toMatchObject({
      total: {
        inputTokens: 17,
        outputTokens: 10,
        requests: 2,
        providerCostUsd: 0.017,
      },
      last: {
        inputTokens: 17,
        outputTokens: 10,
        requests: 2,
        providerCostUsd: 0.017,
      },
    });

    ledger.completeTurn("turn-1");
    expect(
      ledger.update({
        turnId: "turn-2",
        messageId: "message-3",
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          reasoningTokens: 1,
          cost: 0.004,
        },
      }),
    ).toMatchObject({
      total: {
        inputTokens: 24,
        outputTokens: 14,
        requests: 3,
        providerCostUsd: 0.021,
      },
      last: {
        inputTokens: 7,
        outputTokens: 4,
        requests: 1,
        providerCostUsd: 0.004,
      },
    });

    ledger.reset();
    expect(
      ledger.update({
        turnId: "turn-attached-run",
        messageId: "message-attached-run",
        usage: { input: 2, output: 1, reasoning: 1, cost: 0.001 },
      }),
    ).toMatchObject({
      total: {
        inputTokens: 2,
        outputTokens: 2,
        requests: 1,
        providerCostUsd: 0.001,
      },
      last: {
        inputTokens: 2,
        outputTokens: 2,
        requests: 1,
        providerCostUsd: 0.001,
      },
    });
  });
});
