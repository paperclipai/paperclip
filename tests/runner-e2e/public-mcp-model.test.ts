import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantUsage, recordAssistantUsage, runAssistant } from "./public-mcp-model.js";
import { aggregateCampaignBilling, summarizeExecutionBilling } from "./billing.js";
import type { RunnerE2EResult } from "./types.js";

afterEach(() => vi.unstubAllGlobals());
describe("external assistant evidence and billing", () => {
  it("rejects missing usage instead of silently treating paid work as free", () => {
    const usage = assistantUsage("openai", "gpt-5.4-mini");
    expect(() => recordAssistantUsage(usage, "gpt-5.4-mini", NaN, 20, 0)).toThrow("cost is unknown");
    expect(() => recordAssistantUsage(usage, "undefined", 200, 20, 0)).toThrow("cost is unknown");
  });
  it("prices uncached, cached and output tokens separately without calling estimates reported costs", () => {
    const usage = assistantUsage("openai", "gpt-5.4-nano");
    recordAssistantUsage(usage, "gpt-5.4-nano", 1000, 100, 2000);
    expect(usage.estimatedCostUsd).toBeCloseTo(0.000365);
    const result: RunnerE2EResult = {
      schema: "paperclip.runner-e2e.result/v2", executionId: "public-mcp.assistant-codex-mini.local.delegate-retrieve",
      attempt: 1, status: "passed", profileId: "assistant-codex-mini", caseId: "delegate-retrieve", provider: "codex", model: "gpt-5.4-mini", runtimeMode: "legacy",
      startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T00:00:01Z", cleanup: "passed",
      runIds: ["worker-run"], usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 }, environmentId: "local", durationMs: 1000, publicMcp: usage,
    };
    const billing = summarizeExecutionBilling(result);
    expect(billing.reportedCostUsd).toBe(0.01);
    expect(billing.assistant?.requests).toBe(1);
    expect(billing.observedAndEstimatedCostUsd).toBeCloseTo(0.010365);
    const aggregate = aggregateCampaignBilling([result, result]);
    expect(aggregate.assistant?.requests).toBe(2);
    expect(aggregate.assistant?.estimatedCostUsd).toBeCloseTo(0.00073);
    expect(aggregate.reportedLlmCostUsd).toBe(0.02);
  });

  it("retains tool evidence and final text while omitting provider reasoning", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ model: "gpt-5.4-nano", usage: { input_tokens: 200, output_tokens: 20 }, output: [
        { type: "reasoning", summary: [{ text: "private fixture reasoning" }] },
        { type: "function_call", name: "paperclip_connection", call_id: "one", arguments: "{}" },
      ] }))
      .mockResolvedValueOnce(Response.json({ model: "gpt-5.4-nano", usage: { input_tokens: 250, output_tokens: 10 }, output: [{ type: "message", content: [{ type: "output_text", text: "Connected to Team." }] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const observe = vi.fn();
    const call = vi.fn().mockResolvedValue({ companyId: "team" });
    const usage = assistantUsage("openai", "gpt-5.4-nano");
    const result = await runAssistant({ usage, credential: "unit-test-key", prompt: "Which team?", tools: [], call, deadlineAt: Date.now() + 10_000, observe });
    expect(result.final).toBe("Connected to Team.");
    expect(call).toHaveBeenCalledExactlyOnceWith("paperclip_connection", {});
    expect(JSON.stringify(observe.mock.calls)).not.toContain("private fixture reasoning");
    expect(JSON.stringify(observe.mock.calls)).not.toContain("unit-test-key");
    expect(usage.requests).toBe(2);
  });

  it("retains a failed partial turn and does not call a missing final answer a pass", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ model: "gpt-5.4-nano", usage: { input_tokens: 200, output_tokens: 20 }, output: [] })));
    const observe = vi.fn();
    await expect(runAssistant({ usage: assistantUsage("openai", "gpt-5.4-nano"), credential: "unit-test-key", prompt: "Do work", tools: [], call: vi.fn(), deadlineAt: Date.now() + 10_000, observe })).rejects.toThrow("no visible final answer");
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("persists paid usage and completed tools before the next provider request", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ model: "gpt-5.4-mini", usage: { input_tokens: 200, output_tokens: 20 }, output: [{ type: "function_call", name: "paperclip_connection", call_id: "one", arguments: "{}" }] }))
      .mockRejectedValueOnce(new Error("fixture connection interrupted")));
    const snapshots: Array<{ calls: number; requests: number }> = [];
    const usage = assistantUsage("openai", "gpt-5.4-mini");
    await expect(runAssistant({ usage, credential: "unit-test-key", prompt: "Which team?", tools: [],
      call: async () => ({ companyId: "company" }), deadlineAt: Date.now() + 10_000,
      observe: async turn => { snapshots.push({ calls: turn.calls.length, requests: usage.requests }); },
    })).rejects.toThrow("fixture connection interrupted");
    expect(snapshots).toEqual([{ calls: 0, requests: 1 }, { calls: 1, requests: 1 }, { calls: 1, requests: 1 }]);
    expect(usage.estimatedCostUsd).toBeGreaterThan(0);
  });
  it("shares the 16-request ceiling across fresh conversations in one cell", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ model: "gpt-5.4-mini", usage: { input_tokens: 10, output_tokens: 10 }, output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const usage = assistantUsage("openai", "gpt-5.4-mini");
    const input = { usage, credential: "unit-test-key", prompt: "Fresh conversation", tools: [], call: vi.fn(), deadlineAt: Date.now() + 10_000, observe: vi.fn() };
    for (let i = 0; i < 16; i++) await runAssistant(input);
    await expect(runAssistant(input)).rejects.toThrow("shared 16-request per-cell budget");
    expect(fetchMock).toHaveBeenCalledTimes(16);
    expect(usage.requests).toBe(16);
  });

});
