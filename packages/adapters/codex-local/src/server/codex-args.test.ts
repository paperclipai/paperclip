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

  it("adds a supported sandbox mode before model and extra args", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      sandboxMode: "danger-full-access",
      extraArgs: ["--skip-git-repo-check"],
    });

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.5",
      "--skip-git-repo-check",
      "-",
    ]);
  });

  it("does not emit sandbox mode when bypassing approvals and sandbox", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      sandboxMode: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
    });

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.5",
      "-",
    ]);
  });

  it("ignores unknown sandbox modes", () => {
    const result = buildCodexExecArgs({
      sandboxMode: "network-all",
    });

    expect(result.args).toEqual(["exec", "--json", "-"]);
  });
});
