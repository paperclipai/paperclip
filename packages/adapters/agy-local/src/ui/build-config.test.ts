import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildAgyConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "agy_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "gemini-3.7-flash-high",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildAgyConfig", () => {
  it("builds config from form values", () => {
    const config = buildAgyConfig(
      makeValues({
        cwd: "/home/user/project",
        instructionsFilePath: "/home/user/project/AGENTS.md",
        model: "gemini-3.7-flash-high",
        thinkingEffort: "high",
        dangerouslySkipPermissions: true,
        command: "agy",
        extraArgs: "--log-file, /tmp/agy.log",
        envVars: "FOO=bar",
      }),
    );

    expect(config).toEqual({
      cwd: "/home/user/project",
      instructionsFilePath: "/home/user/project/AGENTS.md",
      model: "gemini-3.7-flash-high",
      effort: "high",
      dangerouslySkipPermissions: true,
      timeoutSec: 0,
      graceSec: 15,
      command: "agy",
      extraArgs: ["--log-file", "/tmp/agy.log"],
      env: {
        FOO: { type: "plain", value: "bar" },
      },
    });
  });

  it("applies defaults when values are missing", () => {
    const config = buildAgyConfig(makeValues({ model: "" }));
    expect(config).toEqual({
      model: "gemini-3.8-flash-high",
      dangerouslySkipPermissions: false,
      timeoutSec: 0,
      graceSec: 15,
    });
  });

  it("preserves configured mode", () => {
    const config = buildAgyConfig({
      ...makeValues(),
      mode: "plan",
    } as any);
    expect(config.mode).toBe("plan");
  });

  it("preserves agent persona, jsonSchema, sandbox, and addDirs", () => {
    const config = buildAgyConfig({
      ...makeValues(),
      agent: "flutter_a11y_agent",
      jsonSchema: '{"type":"object"}',
      sandbox: true,
      addDirs: "/tmp/ws1, /tmp/ws2",
    } as any);
    expect(config.agent).toBe("flutter_a11y_agent");
    expect(config.jsonSchema).toBe('{"type":"object"}');
    expect(config.sandbox).toBe(true);
    expect(config.addDirs).toEqual(["/tmp/ws1", "/tmp/ws2"]);
  });

  it("preserves dangerouslySkipPermissions: true", () => {
    const config = buildAgyConfig(makeValues({ dangerouslySkipPermissions: true }));
    expect(config.dangerouslySkipPermissions).toBe(true);
  });

  it("preserves dangerouslySkipPermissions: false", () => {
    const config = buildAgyConfig(makeValues({ dangerouslySkipPermissions: false }));
    expect(config.dangerouslySkipPermissions).toBe(false);
  });

  it("builds git_worktree workspaceStrategy when configured", () => {
    const config = buildAgyConfig(
      makeValues({
        workspaceStrategyType: "git_worktree",
        workspaceBaseRef: "main",
        workspaceBranchTemplate: "task/{{issue.key}}",
        worktreeParentDir: "/tmp/worktrees",
      }),
    );
    expect(config.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "main",
      branchTemplate: "task/{{issue.key}}",
      worktreeParentDir: "/tmp/worktrees",
    });
  });

  it("preserves project, printTimeout, and disableSlashCommands", () => {
    const config = buildAgyConfig({
      ...makeValues(),
      project: "my-custom-project",
      printTimeout: "30m",
      disableSlashCommands: true,
    } as any);
    expect(config.project).toBe("my-custom-project");
    expect(config.printTimeout).toBe("30m");
    expect(config.disableSlashCommands).toBe(true);
  });
});
