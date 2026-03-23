import { describe, expect, it } from "vitest";
import { buildCopilotCliConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function baseValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "copilot_cli",
    cwd: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 100,
    heartbeatEnabled: false,
    intervalSec: 0,
    ...overrides,
  };
}

describe("buildCopilotCliConfig", () => {
  it("returns default timeoutSec and graceSec for empty values", () => {
    const ac = buildCopilotCliConfig(baseValues());
    expect(ac.timeoutSec).toBe(0);
    expect(ac.graceSec).toBe(15);
  });

  it("includes cwd when set", () => {
    const ac = buildCopilotCliConfig(baseValues({ cwd: "/home/user/project" }));
    expect(ac.cwd).toBe("/home/user/project");
  });

  it("omits cwd when empty", () => {
    const ac = buildCopilotCliConfig(baseValues({ cwd: "" }));
    expect(ac.cwd).toBeUndefined();
  });

  it("includes model when set", () => {
    const ac = buildCopilotCliConfig(baseValues({ model: "gpt-5.4" }));
    expect(ac.model).toBe("gpt-5.4");
  });

  it("maps thinkingEffort to reasoningEffort", () => {
    const ac = buildCopilotCliConfig(baseValues({ thinkingEffort: "high" }));
    expect(ac.reasoningEffort).toBe("high");
  });

  it("maps promptTemplate", () => {
    const ac = buildCopilotCliConfig(baseValues({ promptTemplate: "Do the work." }));
    expect(ac.promptTemplate).toBe("Do the work.");
  });

  it("maps bootstrapPrompt to bootstrapPromptTemplate", () => {
    const ac = buildCopilotCliConfig(baseValues({ bootstrapPrompt: "Initialize." }));
    expect(ac.bootstrapPromptTemplate).toBe("Initialize.");
  });

  it("maps dangerouslySkipPermissions to allowAll", () => {
    const ac = buildCopilotCliConfig(baseValues({ dangerouslySkipPermissions: true }));
    expect(ac.allowAll).toBe(true);
  });

  it("maps maxTurnsPerRun to maxAutopilotContinues", () => {
    const ac = buildCopilotCliConfig(baseValues({ maxTurnsPerRun: 50 }));
    expect(ac.maxAutopilotContinues).toBe(50);
  });

  it("includes command when set", () => {
    const ac = buildCopilotCliConfig(baseValues({ command: "/usr/local/bin/copilot" }));
    expect(ac.command).toBe("/usr/local/bin/copilot");
  });

  it("parses comma-separated extraArgs", () => {
    const ac = buildCopilotCliConfig(baseValues({ extraArgs: "--verbose, --no-banner" }));
    expect(ac.extraArgs).toEqual(["--verbose", "--no-banner"]);
  });

  it("omits extraArgs when empty", () => {
    const ac = buildCopilotCliConfig(baseValues({ extraArgs: "" }));
    expect(ac.extraArgs).toBeUndefined();
  });

  it("parses legacy envVars text", () => {
    const ac = buildCopilotCliConfig(baseValues({ envVars: "FOO=bar\nBAZ=qux" }));
    expect(ac.env).toEqual({
      FOO: { type: "plain", value: "bar" },
      BAZ: { type: "plain", value: "qux" },
    });
  });

  it("parses envBindings with plain values", () => {
    const ac = buildCopilotCliConfig(
      baseValues({
        envBindings: { MY_KEY: { type: "plain", value: "my-value" } },
      }),
    );
    expect(ac.env).toEqual({
      MY_KEY: { type: "plain", value: "my-value" },
    });
  });

  it("parses envBindings with secret_ref values", () => {
    const ac = buildCopilotCliConfig(
      baseValues({
        envBindings: { SECRET: { type: "secret_ref", secretId: "sec-1" } },
      }),
    );
    expect(ac.env).toEqual({
      SECRET: { type: "secret_ref", secretId: "sec-1" },
    });
  });

  it("envBindings take precedence over legacy envVars", () => {
    const ac = buildCopilotCliConfig(
      baseValues({
        envVars: "MY_KEY=legacy",
        envBindings: { MY_KEY: { type: "plain", value: "binding" } },
      }),
    );
    expect(ac.env).toEqual({
      MY_KEY: { type: "plain", value: "binding" },
    });
  });

  it("omits env when no env vars configured", () => {
    const ac = buildCopilotCliConfig(baseValues());
    expect(ac.env).toBeUndefined();
  });

  it("builds git_worktree workspace strategy", () => {
    const ac = buildCopilotCliConfig(
      baseValues({
        workspaceStrategyType: "git_worktree",
        workspaceBaseRef: "main",
        workspaceBranchTemplate: "agent/{{agent.id}}/{{issue.key}}",
        worktreeParentDir: "/tmp/worktrees",
      }),
    );
    expect(ac.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "main",
      branchTemplate: "agent/{{agent.id}}/{{issue.key}}",
      worktreeParentDir: "/tmp/worktrees",
    });
  });

  it("omits workspace strategy when type is not git_worktree", () => {
    const ac = buildCopilotCliConfig(baseValues());
    expect(ac.workspaceStrategy).toBeUndefined();
  });

  it("includes workspace runtime when valid JSON with services array", () => {
    const json = JSON.stringify({ services: [{ type: "postgres" }] });
    const ac = buildCopilotCliConfig(baseValues({ runtimeServicesJson: json }));
    expect(ac.workspaceRuntime).toEqual({ services: [{ type: "postgres" }] });
  });

  it("omits workspace runtime for invalid JSON", () => {
    const ac = buildCopilotCliConfig(baseValues({ runtimeServicesJson: "not json" }));
    expect(ac.workspaceRuntime).toBeUndefined();
  });

  it("parses comma-separated allowTool", () => {
    const ac = buildCopilotCliConfig(baseValues({ allowTool: "bash, gh, write_file" }));
    expect(ac.allowTool).toEqual(["bash", "gh", "write_file"]);
  });

  it("omits allowTool when empty", () => {
    const ac = buildCopilotCliConfig(baseValues({ allowTool: "" }));
    expect(ac.allowTool).toBeUndefined();
  });

  it("omits allowTool when undefined", () => {
    const ac = buildCopilotCliConfig(baseValues());
    expect(ac.allowTool).toBeUndefined();
  });

  it("parses comma-separated denyTool", () => {
    const ac = buildCopilotCliConfig(baseValues({ denyTool: "rm, curl" }));
    expect(ac.denyTool).toEqual(["rm", "curl"]);
  });

  it("omits denyTool when empty", () => {
    const ac = buildCopilotCliConfig(baseValues({ denyTool: "" }));
    expect(ac.denyTool).toBeUndefined();
  });

  it("omits denyTool when undefined", () => {
    const ac = buildCopilotCliConfig(baseValues());
    expect(ac.denyTool).toBeUndefined();
  });
});
