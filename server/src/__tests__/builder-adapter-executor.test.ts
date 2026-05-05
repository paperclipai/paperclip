import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mockExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/registry.js", () => ({
  getServerAdapter: vi.fn(() => ({
    execute: mockExecute,
  })),
}));

describe("builder adapter executor", () => {
  it("falls back to model pricing when the adapter does not report costUsd", async () => {
    mockExecute.mockResolvedValueOnce({
      exitCode: 0,
      errorMessage: null,
      summary: '{"text":"done","toolCalls":[],"finishReason":"stop"}',
      resultJson: null,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: 0,
      },
      costUsd: null,
      timedOut: false,
    });

    const { executeBuilderTurn } = await import("../services/builder/adapter-executor.js");
    const result = await executeBuilderTurn({
      db: {} as Db,
      sessionId: "session-1",
      companyId: "company-1",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      adapterConfig: {
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-4o-mini" },
      },
    });

    expect(result.usage).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costCents: 75,
    });
  });
});
