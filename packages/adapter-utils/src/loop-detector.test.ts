import { describe, it, expect, vi } from "vitest";
import { LoopDetector, observeToolCallsFromChunk, imputeSubscriptionCostUsd } from "./loop-detector.js";

describe("LoopDetector", () => {
  it("trips on >= 5 same-tool same-args in 5s", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector({}, onTrip);
    for (let i = 0; i < 5; i++) {
      detector.observe("Bash", "abc12345");
    }
    expect(onTrip).toHaveBeenCalledOnce();
    expect(onTrip.mock.calls[0][0]).toMatch(/5s/);
  });

  it("trips on >= 10 same-tool same-args in 30s", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector({}, onTrip);
    // Inject events spread within 30s but not within 5s by using fake timestamps
    // We do this by calling observe in fast succession (all within 5s window)
    // but only 4 in 5s and 10 in 30s — use maxSameToolSameArgs5s override to raise the 5s threshold
    const detector2 = new LoopDetector({ maxSameToolSameArgs5s: 999 }, onTrip);
    for (let i = 0; i < 10; i++) {
      detector2.observe("Bash", "abc12345");
    }
    expect(onTrip).toHaveBeenCalledOnce();
    expect(onTrip.mock.calls[0][0]).toMatch(/30s/);
  });

  it("trips on >= 30 same-tool in 60s", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector(
      { maxSameToolSameArgs5s: 999, maxSameToolSameArgs30s: 999 },
      onTrip,
    );
    for (let i = 0; i < 30; i++) {
      // Different args each time to avoid 30s same-args trip
      detector.observe("Bash", `arg${i}`);
    }
    expect(onTrip).toHaveBeenCalledOnce();
    expect(onTrip.mock.calls[0][0]).toMatch(/60s/);
  });

  it("does not trip below thresholds", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector({}, onTrip);
    for (let i = 0; i < 4; i++) {
      detector.observe("Bash", "abc12345");
    }
    expect(onTrip).not.toHaveBeenCalled();
  });

  it("does not fire after already tripped", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector({}, onTrip);
    for (let i = 0; i < 10; i++) {
      detector.observe("Bash", "abc12345");
    }
    expect(onTrip).toHaveBeenCalledOnce();
  });

  it("respects enabled: false", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector({ enabled: false }, onTrip);
    for (let i = 0; i < 100; i++) {
      detector.observe("Bash", "abc12345");
    }
    expect(onTrip).not.toHaveBeenCalled();
  });

  it("respects custom thresholds", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector({ maxSameToolSameArgs5s: 3 }, onTrip);
    detector.observe("Bash", "abc12345");
    detector.observe("Bash", "abc12345");
    expect(onTrip).not.toHaveBeenCalled();
    detector.observe("Bash", "abc12345");
    expect(onTrip).toHaveBeenCalledOnce();
  });
});

describe("observeToolCallsFromChunk", () => {
  it("parses opencode_local tool_use events", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector({ maxSameToolSameArgs5s: 2 }, onTrip);
    const line = JSON.stringify({ type: "tool_use", part: { name: "list_files", input: { path: "/" } } });
    observeToolCallsFromChunk(`${line}\n${line}\n`, detector);
    expect(onTrip).toHaveBeenCalledOnce();
  });

  it("parses claude_local assistant content block tool_use events", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector({ maxSameToolSameArgs5s: 2 }, onTrip);
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/foo" } }],
      },
    });
    observeToolCallsFromChunk(`${line}\n${line}\n`, detector);
    expect(onTrip).toHaveBeenCalledOnce();
  });

  it("ignores non-JSON lines", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector({}, onTrip);
    observeToolCallsFromChunk("plain text\n[2024-01-01] something\n", detector);
    expect(onTrip).not.toHaveBeenCalled();
  });

  it("treats same tool with different args as distinct", () => {
    const onTrip = vi.fn();
    const detector = new LoopDetector({ maxSameToolSameArgs5s: 2 }, onTrip);
    const line1 = JSON.stringify({ type: "tool_use", part: { name: "Bash", input: { command: "ls" } } });
    const line2 = JSON.stringify({ type: "tool_use", part: { name: "Bash", input: { command: "pwd" } } });
    observeToolCallsFromChunk(`${line1}\n${line2}\n`, detector);
    expect(onTrip).not.toHaveBeenCalled();
  });
});

describe("imputeSubscriptionCostUsd", () => {
  it("imputes sonnet cost correctly", () => {
    const cost = imputeSubscriptionCostUsd("claude-sonnet-4-5", {
      inputTokens: 100_000,
      outputTokens: 10_000,
      cachedInputTokens: 0,
    });
    // 100k * $3/M input + 10k * $15/M output = $0.30 + $0.15 = $0.45
    expect(cost).toBeCloseTo(0.45, 4);
  });

  it("imputes opus cost at higher rate", () => {
    const cost = imputeSubscriptionCostUsd("claude-opus-4-5", {
      inputTokens: 10_000,
      outputTokens: 1_000,
      cachedInputTokens: 0,
    });
    // 10k * $15/M + 1k * $75/M = $0.15 + $0.075 = $0.225
    expect(cost).toBeCloseTo(0.225, 4);
  });

  it("defaults to sonnet rate for unknown models", () => {
    const sonnetCost = imputeSubscriptionCostUsd("claude-sonnet-4-5", {
      inputTokens: 50_000,
      outputTokens: 5_000,
      cachedInputTokens: 0,
    });
    const unknownCost = imputeSubscriptionCostUsd("unknown-model-xyz", {
      inputTokens: 50_000,
      outputTokens: 5_000,
      cachedInputTokens: 0,
    });
    expect(unknownCost).toBeCloseTo(sonnetCost, 6);
  });

  it("includes cached input tokens in cost", () => {
    const cost = imputeSubscriptionCostUsd("claude-sonnet-4-5", {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    // 1M cached * $3/M = $3.00
    expect(cost).toBeCloseTo(3.0, 4);
  });
});
