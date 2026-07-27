import { describe, expect, it } from "vitest";
import {
  diffSessionUsage,
  indicatesSessionUsageUnsupported,
  parseSessionUsageTotals,
} from "./execute.js";

const KEY = "agent:kael:heartbeat";

/** Shaped like a live sessions.list row (see session-utils-row.ts): no cache buckets. */
function row(over: Record<string, unknown> = {}) {
  return {
    inputTokens: 1000,
    outputTokens: 200,
    estimatedCostUsd: 0.25,
    ...over,
  };
}

describe("parseSessionUsageTotals", () => {
  it("reads the row matching the session key", () => {
    const parsed = parseSessionUsageTotals(
      {
        sessions: [
          row({ key: "other", inputTokens: 99 }),
          row({ key: KEY, model: "claude-opus-5", modelProvider: "clawrouter" }),
        ],
      },
      KEY,
    );

    expect(parsed).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 0,
      costUsd: 0.25,
      model: "claude-opus-5",
      provider: "clawrouter",
    });
  });

  // Verbatim from the live gateway: gpt-5.6-sol on clawrouter, and no estimatedCostUsd,
  // which is why Paperclip prices the tokens itself rather than trusting the gateway.
  it("reads a live-shaped row that carries no cost estimate", () => {
    const parsed = parseSessionUsageTotals(
      {
        sessions: [
          {
            key: "agent:smilerite:paperclip:run:4984a4ae-3858-4379-9bbc-b21d13d6fd53",
            inputTokens: 202026,
            outputTokens: 1610,
            estimatedCostUsd: null,
            model: "gpt-5.6-sol",
            modelProvider: "clawrouter",
            status: "done",
          },
        ],
      },
      "agent:smilerite:paperclip:run:4984a4ae-3858-4379-9bbc-b21d13d6fd53",
    );

    expect(parsed).toMatchObject({
      inputTokens: 202026,
      outputTokens: 1610,
      costUsd: 0,
      model: "gpt-5.6-sol",
      provider: "clawrouter",
    });
  });

  it("matches on sessionId when the row key differs", () => {
    const parsed = parseSessionUsageTotals(
      { sessions: [row({ key: "family-row", sessionId: KEY })] },
      KEY,
    );
    expect(parsed?.inputTokens).toBe(1000);
  });

  it("returns null when the key is absent among several rows", () => {
    const parsed = parseSessionUsageTotals(
      { sessions: [row({ key: "a" }), row({ key: "b" })] },
      KEY,
    );
    expect(parsed).toBeNull();
  });

  // A missing row means the session is not in the store yet, not that it burned nothing.
  // Reporting zero would bill the run at nothing while looking like a success.
  it("returns null rather than zero when no row matches", () => {
    expect(parseSessionUsageTotals({ sessions: [] }, KEY)).toBeNull();
  });

  it("returns null for junk payloads", () => {
    expect(parseSessionUsageTotals(null, KEY)).toBeNull();
    expect(parseSessionUsageTotals({}, KEY)).toBeNull();
  });
});

describe("diffSessionUsage", () => {
  const before = {
    inputTokens: 1000,
    outputTokens: 200,
    cachedInputTokens: 5000,
    costUsd: 0.25,
    model: "m",
    provider: "p",
  };

  it("differences cumulative session totals down to one run", () => {
    const delta = diffSessionUsage(before, {
      ...before,
      inputTokens: 1600,
      outputTokens: 320,
      cachedInputTokens: 9000,
      costUsd: 0.4,
    });

    expect(delta).toMatchObject({
      inputTokens: 600,
      outputTokens: 120,
      cachedInputTokens: 4000,
    });
    expect(delta?.costUsd).toBeCloseTo(0.15, 10);
  });

  it("treats a rewound session as a fresh total rather than clamping to zero", () => {
    const after = { ...before, inputTokens: 10, outputTokens: 2, costUsd: 0.01 };
    expect(diffSessionUsage(before, after)).toEqual(after);
  });

  it("uses the post-run reading when no baseline was captured", () => {
    expect(diffSessionUsage(null, before)).toEqual(before);
  });

  it("returns null when the post-run reading is unavailable", () => {
    expect(diffSessionUsage(before, null)).toBeNull();
  });
});

describe("indicatesSessionUsageUnsupported", () => {
  // Production regression: every run mints a fresh session key, so the gateway answered the
  // baseline lookup with this error. Treating it as "method unsupported" struck the gateway
  // off process-wide and silently dropped billing for 24 consecutive runs.
  it("does not strike off a gateway for a session it has never seen", () => {
    expect(
      indicatesSessionUsageUnsupported(
        "Invalid session reference: agent:main:paperclip:run:472b1f88-0b4a-48ce-90c4-aa646b031c15",
      ),
    ).toBe(false);
  });

  it("does not strike off a gateway for any other session-scoped error", () => {
    expect(indicatesSessionUsageUnsupported("Invalid session key: agent:main:paperclip")).toBe(
      false,
    );
    expect(indicatesSessionUsageUnsupported("session not found")).toBe(false);
  });

  it("strikes off a gateway that cannot answer the method at all", () => {
    expect(indicatesSessionUsageUnsupported("gateway request timeout (sessions.usage)")).toBe(true);
    expect(indicatesSessionUsageUnsupported("gateway not connected")).toBe(true);
    expect(indicatesSessionUsageUnsupported("Method not found")).toBe(true);
    expect(indicatesSessionUsageUnsupported("JSON-RPC error -32601")).toBe(true);
  });
});
