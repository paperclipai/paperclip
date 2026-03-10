import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvals } from "../services/evals/index.js";
import type { EvalPolicyConfig, EvalInput } from "../services/evals/index.js";

// Mock fetch at the network boundary so the full pipeline executes:
// prompt construction → HTTP call → response parsing → label application → action triggering
const originalFetch = globalThis.fetch;

function mockOpenAIResponse(responseBody: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => responseBody,
  } as Response);
}

function makeBatchedOpenAIResponse(scores: Record<string, number>) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify(
            Object.entries(scores).map(([kind, score]) => ({
              kind,
              score,
              rationale: `mock rationale for ${kind}`,
            })),
          ),
        },
      },
    ],
  };
}

function makeIsolatedOpenAIResponse(score: number, kind: string) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            score,
            rationale: `isolated rationale for ${kind}`,
          }),
        },
      },
    ],
  };
}

function makeSpecializedClaimResponse(score: number, kind: string) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            score,
            rationale: `specialized rationale for ${kind}`,
            claims: [
              { text: "test claim", verdict: "grounded", evidence: "found in context" },
            ],
          }),
        },
      },
    ],
  };
}

const baseInput: EvalInput = {
  runId: "run-001",
  agentId: "agent-001",
  companyId: "company-001",
  prompt: "What is the capital of France?",
  response: "The capital of France is Paris. It has been the capital since the 10th century.",
  context: {
    messages: [{ role: "system", content: "You are a geography expert." }],
  },
};

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key-smoke";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

describe("smoke: batched strategy end-to-end", () => {
  it("runs full pipeline with moderate preset and returns correct structure", async () => {
    mockOpenAIResponse(
      makeBatchedOpenAIResponse({
        toxicity: 0.02,
        hallucination: 0.15,
        relevance: 0.92,
      }),
    );

    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "moderate",
      strategy: "batched",
      on: ["final_response"],
      sampling: {},
      thresholds: {
        toxicity: { failAbove: 0.4 },
        hallucination: { warnAbove: 0.3, failAbove: 0.6 },
        relevance: { failBelow: 0.3 },
      },
      actions: { onFail: ["open_issue"], onWarn: ["tag_run"] },
    };

    const result = await runEvals({ input: baseInput, config, runSeq: 0 });

    // Structure checks
    expect(result.payload.schemaVersion).toBe(1);
    expect(result.payload.target).toEqual({ type: "agent.response", step: "final" });
    expect(result.payload.judge.provider).toBe("openai");
    expect(result.payload.judge.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.results).toHaveLength(3);
    expect(result.summaryMessage).toContain("Evals:");

    // Score & label checks
    const toxicity = result.results.find((r) => r.kind === "toxicity")!;
    expect(toxicity.score).toBe(0.02);
    expect(toxicity.label).toBe("pass");

    const hallucination = result.results.find((r) => r.kind === "hallucination")!;
    expect(hallucination.score).toBe(0.15);
    expect(hallucination.label).toBe("pass");

    const relevance = result.results.find((r) => r.kind === "relevance")!;
    expect(relevance.score).toBe(0.92);
    expect(relevance.label).toBe("pass");

    // No actions triggered (all pass)
    expect(result.worstLabel).toBe("pass");
    expect(result.actions).toEqual([]);

    // Verify fetch was called exactly once (batched)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("triggers actions when thresholds are breached", async () => {
    mockOpenAIResponse(
      makeBatchedOpenAIResponse({
        toxicity: 0.55, // above failAbove 0.4
        hallucination: 0.35, // above warnAbove 0.3
        relevance: 0.85,
      }),
    );

    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "moderate",
      strategy: "batched",
      on: ["final_response"],
      sampling: {},
      thresholds: {
        toxicity: { failAbove: 0.4 },
        hallucination: { warnAbove: 0.3, failAbove: 0.6 },
        relevance: { failBelow: 0.3 },
      },
      actions: { onFail: ["open_issue", "require_approval"], onWarn: ["tag_run"] },
    };

    const result = await runEvals({ input: baseInput, config, runSeq: 0 });

    expect(result.worstLabel).toBe("fail");
    // Escalation: onWarn fires too since fail implies warn
    expect(result.actions).toContain("tag_run");
    expect(result.actions).toContain("open_issue");
    expect(result.actions).toContain("require_approval");

    const toxicity = result.results.find((r) => r.kind === "toxicity")!;
    expect(toxicity.label).toBe("fail");

    const hallucination = result.results.find((r) => r.kind === "hallucination")!;
    expect(hallucination.label).toBe("warn");
  });
});

describe("smoke: isolated strategy end-to-end", () => {
  it("makes one LLM call per dimension in parallel", async () => {
    // Mock fetch to return different scores per call
    let callCount = 0;
    const kinds = ["toxicity", "hallucination", "relevance"];
    const scores = [0.03, 0.2, 0.88];

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const idx = callCount++;
      return {
        ok: true,
        json: async () => makeIsolatedOpenAIResponse(scores[idx], kinds[idx]),
      } as Response;
    });

    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "moderate",
      strategy: "isolated",
      on: ["final_response"],
      sampling: {},
      thresholds: {},
      actions: {},
    };

    const result = await runEvals({ input: baseInput, config, runSeq: 0 });

    // Should make 3 separate calls (one per kind for moderate preset)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(result.results).toHaveLength(3);

    // Verify each call got a per-kind rubric (not the batched system prompt)
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      const body = JSON.parse(call[1].body);
      // Isolated mode uses per-kind rubrics, not the batched "Score each dimension" prompt
      expect(body.messages[0].content).not.toContain("Score each dimension");
    }
  });
});

describe("smoke: specialized strategy end-to-end", () => {
  it("uses claim extraction prompts for hallucination/factuality", async () => {
    let callCount = 0;
    const scores = [0.01, 0.1, 0.9, 0.12, 0.85];

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const idx = callCount++;
      return {
        ok: true,
        json: async () => makeSpecializedClaimResponse(scores[idx], "dim"),
      } as Response;
    });

    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "full",
      strategy: "specialized",
      on: ["final_response"],
      sampling: {},
      thresholds: {},
      actions: {},
    };

    const result = await runEvals({ input: baseInput, config, runSeq: 0 });

    // Full preset = 5 dimensions = 5 calls
    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
    expect(result.results).toHaveLength(5);

    // Verify claim data shows up in meta for hallucination/factuality results
    const hallucinationResult = result.results.find((r) => r.kind === "hallucination");
    expect(hallucinationResult).toBeDefined();
    expect(hallucinationResult!.meta?.claims).toBeDefined();
  });
});

describe("smoke: sampling integration", () => {
  it("runs correctly regardless of runSeq when called directly", async () => {
    mockOpenAIResponse(
      makeBatchedOpenAIResponse({ toxicity: 0.01 }),
    );

    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: { every: 10 },
      thresholds: {},
      actions: {},
    };

    // runSeq=5 should not be sampled (5 % 10 !== 0)
    // But the caller (heartbeat.ts) checks shouldRunEval before calling runEvals.
    // runEvals itself always runs if called. The sampling gate is in shouldRunEval.
    // So here we just verify that runEvals works correctly when called.
    const result = await runEvals({ input: baseInput, config, runSeq: 5 });
    expect(result.results).toHaveLength(1); // light = toxicity only
    expect(result.results[0].kind).toBe("toxicity");
  });

  it("returns empty results when all per-kind rates are zeroed out", async () => {
    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: { perKind: { toxicity: { rate: 0 } } },
      thresholds: {},
      actions: {},
    };

    const result = await runEvals({ input: baseInput, config, runSeq: 0 });

    // Should not call fetch at all
    expect(result.results).toEqual([]);
    expect(result.worstLabel).toBe("pass");
    expect(result.summaryMessage).toBe("Evals: (no dimensions selected)");
  });
});

describe("smoke: threshold merge behavior", () => {
  it("partial custom threshold preserves default warn tier", async () => {
    mockOpenAIResponse(
      makeBatchedOpenAIResponse({ toxicity: 0.25 }), // above default warnAbove (0.15)
    );

    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: {},
      // Only override failAbove — default warnAbove (0.15) should still apply
      thresholds: { toxicity: { failAbove: 0.9 } },
      actions: { onWarn: ["tag_run"] },
    };

    const result = await runEvals({ input: baseInput, config, runSeq: 0 });

    const toxicity = result.results.find((r) => r.kind === "toxicity")!;
    expect(toxicity.score).toBe(0.25);
    // Should be "warn" because default warnAbove (0.15) is preserved via merge
    expect(toxicity.label).toBe("warn");
    expect(result.worstLabel).toBe("warn");
    expect(result.actions).toContain("tag_run");
  });
});

describe("smoke: error resilience", () => {
  it("propagates judge errors (caller is responsible for try/catch)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error": "invalid api key"}',
    } as unknown as Response);

    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: {},
      thresholds: {},
      actions: {},
    };

    await expect(runEvals({ input: baseInput, config, runSeq: 0 })).rejects.toThrow(
      /eval judge request failed.*401/,
    );
  });

  it("handles malformed judge JSON gracefully", async () => {
    mockOpenAIResponse({
      choices: [{ message: { content: "this is not json at all" } }],
    });

    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: {},
      thresholds: {},
      actions: {},
    };

    const result = await runEvals({ input: baseInput, config, runSeq: 0 });

    // Should not throw — returns fallback scores with "warn" label
    expect(result.results).toHaveLength(1);
    expect(result.results[0].score).toBe(0.5);
    expect(result.results[0].rationale).toContain("could not be parsed");
  });
});
