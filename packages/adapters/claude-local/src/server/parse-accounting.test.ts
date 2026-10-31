import { describe, expect, it } from "vitest";
import { claudeModelReceipts, createClaudeStreamParser, parseClaudeStreamJson } from "./parse.js";

const model = "claude-haiku-4-5";
const ledger = (inputTokens: number, outputTokens: number, costUSD: number) => ({
  inputTokens, outputTokens, costUSD, cacheReadInputTokens: 200,
  cacheCreationInputTokens: 20, webSearchRequests: 0,
  contextWindow: 200_000, maxOutputTokens: 32_000,
});
const baseline = (modelUsage: Record<string, unknown>, cost = 0.00031, requestId = "paperclip-usage-baseline") => ({
  type: "control_response",
  response: { subtype: "success", request_id: requestId,
    response: { session: { total_cost_usd: cost, model_usage: modelUsage } } },
});
const result = (modelUsage: Record<string, unknown>, cost = 0.000635) => ({
  type: "result", subtype: "success", session_id: "session-1", result: "done",
  total_cost_usd: cost, modelUsage,
  usage: { input_tokens: 120, output_tokens: 32, cache_read_input_tokens: 200, cache_creation_input_tokens: 20 },
});
const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
const previous = { [model]: ledger(110, 31, 0.00031) };
const cumulative = { [model]: { ...ledger(230, 63, 0.000635), cacheReadInputTokens: 400, cacheCreationInputTokens: 40 } };

describe("Claude resumed-session accounting", () => {
  it("subtracts the process's starting ledger from its final result", () => {
    // Counters from Claude Code 2.1.286 against a synthetic loopback Messages API.
    const parsed = parseClaudeStreamJson(jsonl(baseline(previous), result(cumulative)));
    expect(parsed.usage).toEqual({ inputTokens: 140, outputTokens: 32, cachedInputTokens: 200 });
    expect(parsed.costUsd).toBeCloseTo(0.000325, 10);
    expect(parsed.usageBasis).toBe("per_run");
    expect(parsed.resultJson?.modelUsage).toEqual(cumulative);
    expect(claudeModelReceipts(parsed.modelUsage)).toEqual([
      { model, usage: { inputTokens: 140, outputTokens: 32, cachedInputTokens: 200 }, costUsd: expect.closeTo(0.000325, 10) },
    ]);
  });

  it("counts new models and subagents instead of using main-loop-only usage", () => {
    const parsed = parseClaudeStreamJson(jsonl(baseline(previous), result({
      ...cumulative, "claude-subagent": ledger(50, 80, 0.002),
    }, 0.002635)));
    expect(parsed.usage).toEqual({ inputTokens: 210, outputTokens: 112, cachedInputTokens: 400 });
    expect(parsed.costUsd).toBeCloseTo(0.002325, 10);
    expect(claudeModelReceipts(parsed.modelUsage)).toHaveLength(2);
  });

  it("uses a zero baseline when the resumed process did not restore earlier costs", () => {
    const parsed = parseClaudeStreamJson(jsonl(baseline({}, 0), result(previous, 0.00031)));
    expect(parsed.usage).toEqual({ inputTokens: 130, outputTokens: 31, cachedInputTokens: 200 });
    expect(parsed.costUsd).toBe(0.00031);
  });

  it("omits inactive restored models from this run's model receipts", () => {
    const parsed = parseClaudeStreamJson(jsonl(baseline(previous), result({
      ...previous, "new-model": ledger(50, 80, 0.002),
    }, 0.00231)));
    expect(parsed.usage).toEqual({ inputTokens: 70, outputTokens: 80, cachedInputTokens: 200 });
    expect(claudeModelReceipts(parsed.modelUsage)?.map(receipt => receipt.model)).toEqual(["new-model"]);
  });

  it("subtracts additive metadata while retaining model limits", () => {
    const parsed = parseClaudeStreamJson(jsonl(
      baseline({ [model]: { ...previous[model], thinkingTokens: 5, webSearchRequests: 1 } }),
      result({ [model]: { ...cumulative[model], thinkingTokens: 12, webSearchRequests: 3 } }),
    ));
    expect(parsed.modelUsage).toMatchObject({ [model]: {
      thinkingTokens: 7, webSearchRequests: 2, contextWindow: 200_000, maxOutputTokens: 32_000,
    } });
  });

  it("retains incremental accounting without subtracting the baseline from partial messages", () => {
    const consume = createClaudeStreamParser();
    expect(consume(jsonl(baseline(previous))).usage).toBeNull();
    const partial = consume(jsonl({ type: "assistant", message: {
      id: "m2", usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 20 },
    } }));
    expect(partial.usage).toEqual({ inputTokens: 140, outputTokens: 1, cachedInputTokens: 200 });
    expect(partial.costUsd).toBeNull();
    const final = consume(jsonl(result(cumulative)));
    expect(final.usage?.outputTokens).toBe(32);
    expect(final.costUsd).toBeCloseTo(0.000325, 10);
  });

  it.each([
    ["no response", []],
    ["older CLI without get_usage", [{ type: "control_response", response: { subtype: "error", request_id: "paperclip-usage-baseline", error: "Unknown request type: get_usage" } }]],
    ["unrelated request", [baseline(previous, 0.00031, "another-request")]],
    ["malformed cost", [baseline(previous, -1)]],
    ["malformed ledger", [baseline({ [model]: { ...previous[model], outputTokens: "31" } })]],
  ])("preserves legacy accounting for %s", (_name, events) => {
    const parsed = parseClaudeStreamJson(jsonl(...events, result(previous, 0.00031)));
    expect(parsed.usage?.outputTokens).toBe(31);
    expect(parsed.costUsd).toBe(0.00031);
  });

  it("does not subtract a baseline collected after work has started", () => {
    const parsed = parseClaudeStreamJson(jsonl(
      { type: "assistant", message: { id: "m1", content: [] } },
      baseline(previous), result(cumulative),
    ));
    expect(parsed.usage?.outputTokens).toBe(63);
    expect(parsed.costUsd).toBe(0.000635);
  });

  it("does not subtract an inconsistent baseline when counters decreased", () => {
    const parsed = parseClaudeStreamJson(jsonl(baseline(previous), result({
      [model]: { ...ledger(10, 40, 0.0004), cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    }, 0.0004)));
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 40, cachedInputTokens: 0 });
    expect(parsed.costUsd).toBe(0.0004);
  });

  it("keeps top-level per-invocation usage when modelUsage is absent", () => {
    const terminal = { ...result({}, 0.000635), modelUsage: undefined };
    const parsed = parseClaudeStreamJson(jsonl(baseline(previous), terminal));
    expect(parsed.usage).toEqual({ inputTokens: 140, outputTokens: 32, cachedInputTokens: 200 });
    expect(parsed.costUsd).toBeCloseTo(0.000325, 10);
  });
});
