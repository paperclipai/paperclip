import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "./codex-args.js";

describe("buildCodexExecArgs", () => {
  it("enables Codex fast mode overrides for GPT-5.4", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for manual models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("normalizes xhigh modelReasoningEffort to high (Codex CLI alias)", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      modelReasoningEffort: "xhigh",
    });
    expect(result.args).toContain("model_reasoning_effort=\"high\"");
    expect(result.reasoningEffortNormalizedReason).toContain(
      'Normalized modelReasoningEffort "xhigh" to "high"',
    );
    expect(result.reasoningEffortIgnoredReason).toBeNull();
  });

  it("drops unsupported modelReasoningEffort values instead of forwarding", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      modelReasoningEffort: "banana",
    });
    expect(result.args.some((a) => a.startsWith("model_reasoning_effort"))).toBe(false);
    expect(result.reasoningEffortIgnoredReason).toContain(
      'Ignored unsupported modelReasoningEffort "banana"',
    );
    expect(result.reasoningEffortNormalizedReason).toBeNull();
  });

  it("passes supported modelReasoningEffort through unchanged", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      modelReasoningEffort: "high",
    });
    expect(result.args).toContain("model_reasoning_effort=\"high\"");
    expect(result.reasoningEffortNormalizedReason).toBeNull();
    expect(result.reasoningEffortIgnoredReason).toBeNull();
  });

  it("ignores fast mode for unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.3-codex",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.4 or manually configured model IDs",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex",
      "-",
    ]);
  });
});
