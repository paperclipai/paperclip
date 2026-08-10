import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "./codex-args.js";

describe("buildCodexExecArgs", () => {
  it("rewrites the legacy bare gpt-5.6 alias to gpt-5.6-sol and applies fast mode", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.6",
      fastMode: true,
    });

    expect(result.model).toBe("gpt-5.6-sol");
    expect(result.args).toContain("gpt-5.6-sol");
    expect(result.args).not.toContain("gpt-5.6");
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
  });

  it.each(["max", "ultra"])("passes %s reasoning effort to Codex", (effort) => {
    const result = buildCodexExecArgs({
      model: "gpt-5.6-sol",
      modelReasoningEffort: effort,
    });

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.6-sol",
      "-c",
      `model_reasoning_effort=${JSON.stringify(effort)}`,
      "-",
    ]);
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"])(
    "enables Codex fast mode overrides for %s",
    (model) => {
      const result = buildCodexExecArgs({
        model,
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
        model,
        "-c",
        'service_tier="fast"',
        "-c",
        "features.fast_mode=true",
        "-",
      ]);
    },
  );

  it.each(["my-custom-tune", "future-codex-model"])(
    "enables Codex fast mode overrides for manually configured model %s",
    (model) => {
      const result = buildCodexExecArgs({ model, fastMode: true });

      expect(result.fastModeRequested).toBe(true);
      expect(result.fastModeApplied).toBe(true);
      expect(result.fastModeIgnoredReason).toBeNull();
      expect(result.args).toEqual([
        "exec",
        "--json",
        "--model",
        model,
        "-c",
        'service_tier="fast"',
        "-c",
        "features.fast_mode=true",
        "-",
      ]);
    },
  );

  it("enables Codex fast mode overrides when model is omitted (CLI default)", () => {
    const result = buildCodexExecArgs({ fastMode: true });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("ignores fast mode for known unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4 or manually configured model IDs",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5",
      "-",
    ]);
  });

  it("ignores fast mode for gpt-5.4-mini", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4-mini",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.4-mini",
      "-",
    ]);
  });

  it("adds --skip-git-repo-check when requested", () => {
    const result = buildCodexExecArgs(
      { model: "gpt-5.5" },
      { skipGitRepoCheck: true },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-",
    ]);
  });

  it("does not add a second --skip-git-repo-check when extraArgs already carry it", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.5",
        extraArgs: ["--skip-git-repo-check"],
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1);
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "--skip-git-repo-check",
      "-",
    ]);
  });

  it("does not add a second --skip-git-repo-check when the legacy args field carries it", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.5",
        args: ["--skip-git-repo-check"],
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1);
  });

  it("keeps the operator's --skip-git-repo-check when the sandbox injection is not requested", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      extraArgs: ["--skip-git-repo-check"],
    });

    expect(result.args.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1);
  });
});
