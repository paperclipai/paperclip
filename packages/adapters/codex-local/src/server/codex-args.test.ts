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
      model: "gpt-5.4-custom",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.4-custom",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it.each(["gpt-5.5", "gpt-5.4-mini"])("preserves fast mode for newly promoted known model %s", (model) => {
    const result = buildCodexExecArgs({
      model,
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toContain(model);
    expect(result.args).toContain('service_tier="fast"');
    expect(result.args).toContain("features.fast_mode=true");
  });

  it("passes modelReasoningEffort to codex -c flag", () => {
    const result = buildCodexExecArgs({ modelReasoningEffort: "high" });
    expect(result.args).toContain("-c");
    expect(result.args).toContain('model_reasoning_effort="high"');
  });

  it("falls back to reasoningEffort when modelReasoningEffort is absent", () => {
    const result = buildCodexExecArgs({ reasoningEffort: "medium" });
    expect(result.args).toContain("-c");
    expect(result.args).toContain('model_reasoning_effort="medium"');
  });

  it("falls back to effort alias when neither modelReasoningEffort nor reasoningEffort is set", () => {
    const result = buildCodexExecArgs({ effort: "high" });
    expect(result.args).toContain("-c");
    expect(result.args).toContain('model_reasoning_effort="high"');
  });

  it("prefers modelReasoningEffort over effort alias", () => {
    const result = buildCodexExecArgs({ modelReasoningEffort: "high", effort: "low" });
    expect(result.args).toContain('model_reasoning_effort="high"');
    expect(result.args).not.toContain('model_reasoning_effort="low"');
  });

  it("prefers reasoningEffort over effort alias", () => {
    const result = buildCodexExecArgs({ reasoningEffort: "medium", effort: "low" });
    expect(result.args).toContain('model_reasoning_effort="medium"');
    expect(result.args).not.toContain('model_reasoning_effort="low"');
  });

  it("ignores fast mode for unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.3-codex",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.5, gpt-5.4, gpt-5.4-mini or manually configured model IDs",
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
