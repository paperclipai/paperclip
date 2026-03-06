import { describe, expect, it } from "vitest";
import {
  applyLabel,
  determineActions,
  shouldRunEval,
  resolveKindsForRun,
  buildEvalEventPayload,
  buildEvalSummaryMessage,
} from "../services/evals/index.js";
import type { EvalResult, EvalPolicyConfig } from "../services/evals/index.js";

describe("applyLabel", () => {
  it("returns pass when score is within safe range", () => {
    expect(applyLabel("toxicity", 0.05)).toBe("pass");
    expect(applyLabel("relevance", 0.8)).toBe("pass");
  });

  it("returns warn for toxicity above warnAbove threshold", () => {
    expect(applyLabel("toxicity", 0.2)).toBe("warn");
  });

  it("returns fail for toxicity above failAbove threshold", () => {
    expect(applyLabel("toxicity", 0.5)).toBe("fail");
  });

  it("returns warn for relevance below warnBelow threshold", () => {
    expect(applyLabel("relevance", 0.45)).toBe("warn");
  });

  it("returns fail for relevance below failBelow threshold", () => {
    expect(applyLabel("relevance", 0.2)).toBe("fail");
  });

  it("returns fail for hallucination above failAbove", () => {
    expect(applyLabel("hallucination", 0.7)).toBe("fail");
  });

  it("returns warn for hallucination in warn range", () => {
    expect(applyLabel("hallucination", 0.35)).toBe("warn");
  });

  it("respects custom thresholds", () => {
    expect(applyLabel("toxicity", 0.96, { failAbove: 0.95 })).toBe("fail");
    // Below custom failAbove but above default warnAbove (0.15) → warn via merge
    expect(applyLabel("toxicity", 0.9, { failAbove: 0.95 })).toBe("warn");
  });

  it("merges custom thresholds with defaults instead of replacing", () => {
    // Only override failAbove — default warnAbove (0.15) should still apply
    expect(applyLabel("toxicity", 0.2, { failAbove: 0.95 })).toBe("warn");
    // Below default warnAbove → pass
    expect(applyLabel("toxicity", 0.1, { failAbove: 0.95 })).toBe("pass");
  });
});

function makeConfig(overrides: Partial<EvalPolicyConfig> = {}): EvalPolicyConfig {
  return {
    enabled: true,
    preset: "full",
    strategy: "batched",
    on: ["final_response"],
    sampling: {},
    thresholds: {},
    actions: {},
    ...overrides,
  };
}

describe("shouldRunEval", () => {
  it("returns false when disabled", () => {
    expect(shouldRunEval(makeConfig({ enabled: false }))).toBe(false);
  });

  it("returns false for 'off' preset", () => {
    expect(shouldRunEval(makeConfig({ preset: "off" }))).toBe(false);
  });

  it("returns true for 'full' preset (rate=1.0)", () => {
    expect(shouldRunEval(makeConfig({ preset: "full" }))).toBe(true);
  });

  it("respects explicit rate=0", () => {
    expect(shouldRunEval(makeConfig({ sampling: { rate: 0 } }))).toBe(false);
  });

  it("respects explicit rate=1", () => {
    expect(shouldRunEval(makeConfig({ sampling: { rate: 1 } }))).toBe(true);
  });

  it("gates on every-N using runSeq", () => {
    const config = makeConfig({ preset: "custom", sampling: { every: 5 } });
    expect(shouldRunEval(config, 0)).toBe(true);
    expect(shouldRunEval(config, 1)).toBe(false);
    expect(shouldRunEval(config, 4)).toBe(false);
    expect(shouldRunEval(config, 5)).toBe(true);
    expect(shouldRunEval(config, 10)).toBe(true);
  });

  it("rate takes priority over every", () => {
    const config = makeConfig({ sampling: { rate: 1, every: 100 } });
    // rate=1 always fires regardless of every
    expect(shouldRunEval(config, 1)).toBe(true);
    expect(shouldRunEval(config, 99)).toBe(true);
  });
});

describe("resolveKindsForRun", () => {
  it("returns only toxicity for 'light' preset", () => {
    const kinds = resolveKindsForRun(makeConfig({ preset: "light" }));
    expect(kinds).toEqual(["toxicity"]);
  });

  it("returns 3 kinds for 'moderate' preset", () => {
    const kinds = resolveKindsForRun(makeConfig({ preset: "moderate" }));
    expect(kinds).toEqual(["toxicity", "hallucination", "relevance"]);
  });

  it("returns all 5 for 'full' preset", () => {
    const kinds = resolveKindsForRun(makeConfig({ preset: "full" }));
    expect(kinds).toHaveLength(5);
  });

  it("uses threshold keys for 'custom' preset", () => {
    const kinds = resolveKindsForRun(
      makeConfig({
        preset: "custom",
        thresholds: { toxicity: { failAbove: 0.5 }, quality: { failBelow: 0.3 } },
      }),
    );
    expect(kinds).toEqual(["toxicity", "quality"]);
  });

  it("filters per-kind with rate=0", () => {
    const kinds = resolveKindsForRun(
      makeConfig({
        preset: "full",
        sampling: { perKind: { factuality: { rate: 0 } } },
      }),
    );
    expect(kinds).not.toContain("factuality");
    expect(kinds).toContain("toxicity");
  });

  it("filters per-kind with every-N", () => {
    const config = makeConfig({
      preset: "strict",
      sampling: { perKind: { quality: { every: 3 } } },
    });
    // seq=0 → quality included (0 % 3 === 0)
    expect(resolveKindsForRun(config, 0)).toContain("quality");
    // seq=1 → quality excluded
    expect(resolveKindsForRun(config, 1)).not.toContain("quality");
    // seq=3 → quality included
    expect(resolveKindsForRun(config, 3)).toContain("quality");
  });
});

describe("determineActions", () => {
  const baseConfig = makeConfig({
    actions: {
      onFail: ["require_approval", "open_issue"],
      onWarn: ["tag_run"],
    },
  });

  it("returns no actions when all pass", () => {
    const results: EvalResult[] = [
      { kind: "toxicity", score: 0.01, label: "pass" },
      { kind: "relevance", score: 0.9, label: "pass" },
    ];
    const { triggered, worstLabel } = determineActions(results, baseConfig);
    expect(worstLabel).toBe("pass");
    expect(triggered).toEqual([]);
  });

  it("returns onWarn actions when worst is warn", () => {
    const results: EvalResult[] = [
      { kind: "toxicity", score: 0.01, label: "pass" },
      { kind: "hallucination", score: 0.35, label: "warn" },
    ];
    const { triggered, worstLabel } = determineActions(results, baseConfig);
    expect(worstLabel).toBe("warn");
    expect(triggered).toEqual(["tag_run"]);
  });

  it("returns onFail actions when any result is fail", () => {
    const results: EvalResult[] = [
      { kind: "toxicity", score: 0.5, label: "fail" },
      { kind: "relevance", score: 0.9, label: "pass" },
    ];
    const { triggered, worstLabel } = determineActions(results, baseConfig);
    expect(worstLabel).toBe("fail");
    expect(triggered).toContain("require_approval");
    expect(triggered).toContain("open_issue");
  });

  it("fail escalates: onWarn actions also fire when worstLabel is fail", () => {
    const results: EvalResult[] = [
      { kind: "toxicity", score: 0.5, label: "fail" },
      { kind: "relevance", score: 0.9, label: "pass" },
    ];
    const { triggered, worstLabel } = determineActions(results, baseConfig);
    expect(worstLabel).toBe("fail");
    // onWarn actions (tag_run) should fire in addition to onFail actions
    expect(triggered).toContain("tag_run");
    expect(triggered).toContain("require_approval");
    expect(triggered).toContain("open_issue");
  });

  it("fail takes precedence over warn for worstLabel", () => {
    const results: EvalResult[] = [
      { kind: "toxicity", score: 0.5, label: "fail" },
      { kind: "hallucination", score: 0.35, label: "warn" },
    ];
    const { worstLabel } = determineActions(results, baseConfig);
    expect(worstLabel).toBe("fail");
  });
});

describe("resolveKindsForRun — empty result", () => {
  it("returns empty array when all per-kind rates are 0", () => {
    const kinds = resolveKindsForRun(
      makeConfig({
        preset: "light",
        sampling: { perKind: { toxicity: { rate: 0 } } },
      }),
    );
    expect(kinds).toEqual([]);
  });
});

describe("buildEvalEventPayload", () => {
  it("produces valid schema version 1 payload", () => {
    const results: EvalResult[] = [
      { kind: "toxicity", score: 0.02, label: "pass" },
      { kind: "relevance", score: 0.86, label: "pass" },
    ];
    const payload = buildEvalEventPayload(
      results,
      { provider: "openai", model: "gpt-4.1-mini" },
      842,
    );

    expect(payload.schemaVersion).toBe(1);
    expect(payload.target).toEqual({ type: "agent.response", step: "final" });
    expect(payload.results).toHaveLength(2);
    expect(payload.judge.provider).toBe("openai");
    expect(payload.judge.model).toBe("gpt-4.1-mini");
    expect(payload.judge.latencyMs).toBe(842);
  });
});

describe("buildEvalSummaryMessage", () => {
  it("formats a compact summary string", () => {
    const results: EvalResult[] = [
      { kind: "toxicity", score: 0.02, label: "pass" },
      { kind: "hallucination", score: 0.33, label: "warn" },
    ];
    const msg = buildEvalSummaryMessage(results);
    expect(msg).toBe("Evals: toxicity=pass(0.02), hallucination=warn(0.33)");
  });
});
