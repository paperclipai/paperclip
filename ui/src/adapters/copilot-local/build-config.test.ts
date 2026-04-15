import { describe, expect, it } from "vitest";
import { buildCopilotLocalConfig } from "./build-config";

describe("buildCopilotLocalConfig", () => {
  it("builds the adapter config with defaults", () => {
    const config = buildCopilotLocalConfig({
      cwd: "/tmp/repo",
      instructionsFilePath: "/tmp/repo/AGENTS.md",
      promptTemplate: "Continue working",
      bootstrapPrompt: "",
      model: "",
      thinkingEffort: "high",
      autopilot: true,
      experimental: true,
      enableReasoningSummaries: true,
      maxAutopilotContinues: 4,
      envVars: "GH_TOKEN=abc123",
      envBindings: null,
      command: "copilot",
      extraArgs: "--experimental, --enable-reasoning-summaries",
      workspaceStrategyType: "git_worktree",
      workspaceBaseRef: "origin/main",
      workspaceBranchTemplate: "{{issue.identifier}}-{{slug}}",
      worktreeParentDir: ".paperclip/worktrees",
      runtimeServicesJson: JSON.stringify({ services: [{ name: "preview" }] }),
    } as never);

    expect(config.cwd).toBe("/tmp/repo");
    expect(config.instructionsFilePath).toBe("/tmp/repo/AGENTS.md");
    expect(config.autopilot).toBe(true);
    expect(config.experimental).toBe(true);
    expect(config.enableReasoningSummaries).toBe(true);
    expect(config.effort).toBe("high");
    expect(config.maxAutopilotContinues).toBe(4);
    expect(config.command).toBe("copilot");
    expect(config.extraArgs).toEqual(["--experimental", "--enable-reasoning-summaries"]);
    expect(config.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "origin/main",
      branchTemplate: "{{issue.identifier}}-{{slug}}",
      worktreeParentDir: ".paperclip/worktrees",
    });
    expect(config.workspaceRuntime).toEqual({ services: [{ name: "preview" }] });
    expect(config.env).toEqual({
      GH_TOKEN: { type: "plain", value: "abc123" },
    });
  });
});
