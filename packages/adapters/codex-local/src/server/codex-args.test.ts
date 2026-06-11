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

  it("falls back to gpt-5.3-codex-spark when detectUnsupportedModel rewrites the cheap profile model", () => {
    const result = buildCodexExecArgs(
      { model: "gpt-5.3-codex" },
      { detectUnsupportedModel: true },
    );

    expect(result.modelFallbackApplied).toBe(true);
    expect(result.originalModel).toBe("gpt-5.3-codex");
    expect(result.model).toBe("gpt-5.3-codex-spark");
    // The unsupported model must never reach the Codex CLI args.
    expect(result.args).not.toContain("gpt-5.3-codex");
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex-spark",
      "-",
    ]);
  });

  it("does not rewrite the model when detectUnsupportedModel is disabled", () => {
    const result = buildCodexExecArgs({ model: "gpt-5.3-codex" });

    expect(result.modelFallbackApplied).toBe(false);
    expect(result.model).toBe("gpt-5.3-codex");
    expect(result.args).toContain("gpt-5.3-codex");
  });

  it("leaves an already-supported spark model untouched under detection", () => {
    const result = buildCodexExecArgs(
      { model: "gpt-5.3-codex-spark" },
      { detectUnsupportedModel: true },
    );

    expect(result.modelFallbackApplied).toBe(false);
    expect(result.model).toBe("gpt-5.3-codex-spark");
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
      "-",
    ]);
  });
});
