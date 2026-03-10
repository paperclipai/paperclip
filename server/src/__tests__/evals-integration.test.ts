import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvals, shouldRunEval, buildEvalEventPayload } from "../services/evals/index.js";
import type { EvalPolicyConfig, EvalInput } from "../services/evals/index.js";

/**
 * Integration tests that simulate the two manual QA scenarios from the PR:
 *
 * 1. Configure agent with runtimeConfig.evals.preset: "light",
 *    verify eval events appear in run timeline
 *
 * 2. Set failAbove threshold low enough to trigger,
 *    verify issue auto-creation action is triggered
 *
 * These exercise the full pipeline (shouldRunEval -> runEvals -> payload/actions)
 * with mocked LLM responses, matching what heartbeat.ts does at integration time.
 */

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
              rationale: `rationale for ${kind}`,
            })),
          ),
        },
      },
    ],
  };
}

const baseInput: EvalInput = {
  runId: "run-integration-001",
  agentId: "agent-integration-001",
  companyId: "company-integration-001",
  prompt: "Summarize the quarterly revenue report",
  response: "Revenue increased 15% year-over-year to $4.2M in Q3.",
};

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key-integration";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

describe("integration: light preset produces eval event in run timeline", () => {
  it("shouldRunEval gates correctly and runEvals produces a timeline-ready event payload", async () => {
    // Simulate: agent.runtimeConfig.evals = { preset: "light" }
    // "light" preset: 10% rate, toxicity only
    // Force rate to 1.0 so the test is deterministic
    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: { rate: 1.0 },
      thresholds: {},
      actions: {},
    };

    // Verify sampling gate allows this run
    expect(shouldRunEval(config, 1)).toBe(true);

    // Mock a clean toxicity score
    mockOpenAIResponse(makeBatchedOpenAIResponse({ toxicity: 0.05 }));

    const result = await runEvals({ input: baseInput, config, runSeq: 1 });

    // -- Verify the eval event payload matches what appendRunEvent expects --

    // Light preset only evaluates toxicity
    expect(result.results).toHaveLength(1);
    expect(result.results[0].kind).toBe("toxicity");
    expect(result.results[0].score).toBe(0.05);
    expect(result.results[0].label).toBe("pass");

    // Payload has correct schema for timeline event
    const { payload } = result;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.target).toEqual({ type: "agent.response", step: "final" });
    expect(payload.judge.provider).toBe("openai");
    expect(payload.judge.model).toBeDefined();
    expect(payload.judge.latencyMs).toBeGreaterThanOrEqual(0);
    expect(payload.results).toHaveLength(1);

    // Summary message is human-readable for the timeline
    expect(result.summaryMessage).toMatch(/Evals:.*toxicity=pass/);

    // No extra fields leaked into judge payload
    expect(Object.keys(payload.judge).sort()).toEqual(["latencyMs", "model", "provider"]);

    // Worst label is pass, no actions triggered
    expect(result.worstLabel).toBe("pass");
    expect(result.actions).toEqual([]);
  });

  it("light preset with every-N sampling skips non-matching runs", () => {
    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: { every: 5 },
      thresholds: {},
      actions: {},
    };

    // Only every 5th run should be evaluated
    expect(shouldRunEval(config, 0)).toBe(true);  // 0 % 5 === 0
    expect(shouldRunEval(config, 1)).toBe(false);
    expect(shouldRunEval(config, 2)).toBe(false);
    expect(shouldRunEval(config, 3)).toBe(false);
    expect(shouldRunEval(config, 4)).toBe(false);
    expect(shouldRunEval(config, 5)).toBe(true);  // 5 % 5 === 0
    expect(shouldRunEval(config, 10)).toBe(true); // 10 % 5 === 0
  });

  it("preset 'off' never runs evals", () => {
    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "off",
      strategy: "batched",
      on: ["final_response"],
      sampling: { rate: 1.0 },
      thresholds: {},
      actions: {},
    };

    expect(shouldRunEval(config, 1)).toBe(false);
  });
});

describe("integration: low failAbove threshold triggers issue auto-creation", () => {
  it("triggers open_issue action when toxicity exceeds a low failAbove threshold", async () => {
    // Simulate: agent sets failAbove very low to test action triggering
    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: { rate: 1.0 },
      thresholds: {
        toxicity: { failAbove: 0.1 }, // Very low threshold — easy to breach
      },
      actions: {
        onFail: ["open_issue"],
        onWarn: ["tag_run"],
      },
    };

    // Mock toxicity score that exceeds the low failAbove
    mockOpenAIResponse(makeBatchedOpenAIResponse({ toxicity: 0.25 }));

    const result = await runEvals({ input: baseInput, config, runSeq: 1 });

    // Score exceeds failAbove (0.25 > 0.1) → fail label
    const toxicity = result.results.find((r) => r.kind === "toxicity")!;
    expect(toxicity.score).toBe(0.25);
    expect(toxicity.label).toBe("fail");

    // Worst label is fail
    expect(result.worstLabel).toBe("fail");

    // open_issue action is triggered (this is what heartbeat.ts uses to call issueService.create)
    expect(result.actions).toContain("open_issue");

    // onWarn actions also fire for fail (escalation semantics)
    expect(result.actions).toContain("tag_run");

    // Verify the eval event payload contains the failing result for the timeline
    expect(result.payload.results[0].label).toBe("fail");
    expect(result.summaryMessage).toMatch(/toxicity=fail/);
  });

  it("triggers require_approval alongside open_issue when both configured", async () => {
    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: { rate: 1.0 },
      thresholds: {
        toxicity: { failAbove: 0.1 },
      },
      actions: {
        onFail: ["open_issue", "require_approval"],
      },
    };

    mockOpenAIResponse(makeBatchedOpenAIResponse({ toxicity: 0.5 }));

    const result = await runEvals({ input: baseInput, config, runSeq: 1 });

    expect(result.worstLabel).toBe("fail");
    expect(result.actions).toContain("open_issue");
    expect(result.actions).toContain("require_approval");
  });

  it("does NOT trigger open_issue when score is below failAbove", async () => {
    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: { rate: 1.0 },
      thresholds: {
        toxicity: { failAbove: 0.5 },
      },
      actions: {
        onFail: ["open_issue"],
      },
    };

    // Score is below threshold — should pass
    mockOpenAIResponse(makeBatchedOpenAIResponse({ toxicity: 0.05 }));

    const result = await runEvals({ input: baseInput, config, runSeq: 1 });

    expect(result.worstLabel).toBe("pass");
    expect(result.actions).not.toContain("open_issue");
    expect(result.actions).toEqual([]);
  });

  it("warn threshold triggers tag_run but not open_issue", async () => {
    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: { rate: 1.0 },
      thresholds: {
        toxicity: { warnAbove: 0.1, failAbove: 0.5 },
      },
      actions: {
        onFail: ["open_issue"],
        onWarn: ["tag_run"],
      },
    };

    // Score hits warn but not fail (0.1 <= 0.25 < 0.5)
    mockOpenAIResponse(makeBatchedOpenAIResponse({ toxicity: 0.25 }));

    const result = await runEvals({ input: baseInput, config, runSeq: 1 });

    expect(result.worstLabel).toBe("warn");
    expect(result.actions).toContain("tag_run");
    expect(result.actions).not.toContain("open_issue");
  });

  it("verifies the issue payload heartbeat.ts would construct", async () => {
    const config: EvalPolicyConfig = {
      enabled: true,
      preset: "light",
      strategy: "batched",
      on: ["final_response"],
      sampling: { rate: 1.0 },
      thresholds: { toxicity: { failAbove: 0.1 } },
      actions: { onFail: ["open_issue"] },
    };

    mockOpenAIResponse(makeBatchedOpenAIResponse({ toxicity: 0.35 }));

    const result = await runEvals({ input: baseInput, config, runSeq: 1 });

    // Simulate the issue description that heartbeat.ts would build
    const agentName = "test-agent";
    const runIdShort = baseInput.runId.slice(0, 8);
    const issueTitle = `Eval ${result.worstLabel}: ${agentName} run ${runIdShort}`;
    const issueDescription = [
      `Automated eval detected **${result.worstLabel}** on run \`${baseInput.runId}\`.`,
      "",
      "**Results:**",
      ...result.results.map(
        (r) => `- ${r.kind}: ${r.label} (${r.score.toFixed(2)})${r.rationale ? ` — ${r.rationale}` : ""}`,
      ),
    ].join("\n");

    expect(issueTitle).toBe("Eval fail: test-agent run run-inte");
    expect(issueDescription).toContain("**fail**");
    expect(issueDescription).toContain("toxicity: fail (0.35)");
    expect(issueDescription).toContain("rationale for toxicity");
  });
});
