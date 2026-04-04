import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "./cli-args.js";

describe("buildCodexExecArgs", () => {
  it("adds --skip-git-repo-check for non-repo fallback workspaces", () => {
    expect(
      buildCodexExecArgs({
        search: false,
        bypass: false,
        skipGitRepoCheck: true,
        extraArgs: [],
        model: "",
        modelReasoningEffort: "",
        resumeSessionId: null,
      }),
    ).toEqual(["exec", "--json", "--skip-git-repo-check", "-"]);
  });

  it("does not duplicate --skip-git-repo-check when already provided in extra args", () => {
    expect(
      buildCodexExecArgs({
        search: false,
        bypass: false,
        skipGitRepoCheck: true,
        extraArgs: ["--skip-git-repo-check", "--color", "never"],
        model: "",
        modelReasoningEffort: "",
        resumeSessionId: null,
      }),
    ).toEqual(["exec", "--json", "--skip-git-repo-check", "--color", "never", "-"]);
  });

  it("keeps normal repo-backed runs unchanged", () => {
    expect(
      buildCodexExecArgs({
        search: true,
        bypass: false,
        skipGitRepoCheck: false,
        extraArgs: [],
        model: "gpt-5.4",
        modelReasoningEffort: "medium",
        resumeSessionId: null,
      }),
    ).toEqual([
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'model_reasoning_effort="medium"',
      "-",
    ]);
  });
});
