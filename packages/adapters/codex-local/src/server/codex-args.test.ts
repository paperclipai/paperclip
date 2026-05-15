import { describe, expect, it } from "vitest";
import { isCodexLocalKnownModel, models, modelProfiles } from "../index.js";
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
      'model_reasoning_effort="medium"',
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for manual models", () => {
    const result = buildCodexExecArgs({
      model: "my-org/custom-codex-v1",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "my-org/custom-codex-v1",
      "-c",
      'model_reasoning_effort="medium"',
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
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
      "-c",
      'model_reasoning_effort="medium"',
      "-",
    ]);
  });

  it("adds --skip-git-repo-check when requested", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.3-codex",
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.3-codex",
      "-c",
      'model_reasoning_effort="medium"',
      "-",
    ]);
  });

  it("defaults reasoning effort to medium when not configured", () => {
    const result = buildCodexExecArgs({ model: "gpt-5.5" });
    expect(result.args).toContain("-c");
    const idx = result.args.indexOf("-c");
    expect(result.args[idx + 1]).toBe('model_reasoning_effort="medium"');
  });

  it("skips reasoning effort flag when auto is set", () => {
    const result = buildCodexExecArgs({ model: "gpt-5.5", modelReasoningEffort: "auto" });
    expect(result.args).not.toContain('model_reasoning_effort="medium"');
    expect(result.args.join(" ")).not.toContain("model_reasoning_effort");
  });

  it("passes explicit reasoning effort values through exactly", () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh"] as const) {
      const result = buildCodexExecArgs({ model: "gpt-5.5", modelReasoningEffort: effort });
      const idx = result.args.indexOf("-c");
      expect(result.args[idx + 1]).toBe(`model_reasoning_effort="${effort}"`);
    }
  });
});

describe("resume commands", () => {
  it("does not inject reasoning args on resume — default effort", () => {
    const result = buildCodexExecArgs({ model: "gpt-5.5" }, { resumeSessionId: "session-123" });
    expect(result.args).toEqual(["exec", "--json", "--model", "gpt-5.5", "resume", "session-123", "-"]);
    expect(result.args.join(" ")).not.toContain("model_reasoning_effort");
  });

  it("does not inject reasoning args on resume — explicit effort", () => {
    const result = buildCodexExecArgs({ model: "gpt-5.5", modelReasoningEffort: "high" }, { resumeSessionId: "session-123" });
    expect(result.args.join(" ")).not.toContain("model_reasoning_effort");
    expect(result.args).toContain("resume");
  });

  it("does not inject reasoning args on resume — no model", () => {
    const result = buildCodexExecArgs({}, { resumeSessionId: "session-xyz" });
    expect(result.args.join(" ")).not.toContain("model_reasoning_effort");
    expect(result.args.slice(-3)).toEqual(["resume", "session-xyz", "-"]);
  });
});

describe("model catalog", () => {
  it("includes gpt-5.5 as a known model", () => {
    expect(models.some((m) => m.id === "gpt-5.5")).toBe(true);
    expect(isCodexLocalKnownModel("gpt-5.5")).toBe(true);
  });

  it("lists gpt-5.5 before gpt-5.4 (newest first)", () => {
    const idx55 = models.findIndex((m) => m.id === "gpt-5.5");
    const idx54 = models.findIndex((m) => m.id === "gpt-5.4");
    expect(idx55).toBeLessThan(idx54);
  });
});

describe("model profiles", () => {
  it("cheap profile uses gpt-5.3-codex-spark with xhigh reasoning", () => {
    const cheap = modelProfiles.find((p) => p.key === "cheap");
    expect(cheap).toBeDefined();
    expect(cheap!.adapterConfig.model).toBe("gpt-5.3-codex-spark");
    expect(cheap!.adapterConfig.modelReasoningEffort).toBe("xhigh");
  });
});
