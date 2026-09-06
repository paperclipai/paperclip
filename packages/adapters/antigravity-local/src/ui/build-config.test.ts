// Unit tests for Antigravity local UI build-config

import { describe, expect, it } from "vitest";
import { buildAntigravityLocalConfig } from "./build-config.js";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL } from "../index.js";

describe("buildAntigravityLocalConfig", () => {
  it("builds config with defaults", () => {
    const config = buildAntigravityLocalConfig({
      adapterType: "antigravity_local",
    } as any);

    expect(config.model).toBe(DEFAULT_ANTIGRAVITY_LOCAL_MODEL);
    expect(config.sandbox).toBe(false);
    expect(config.dangerouslySkipPermissions).toBe(true);
    expect(config.timeoutSec).toBe(0);
    expect(config.graceSec).toBe(15);
  });

  it("populates Antigravity-specific options when provided", () => {
    const config = buildAntigravityLocalConfig({
      adapterType: "antigravity_local",
      command: "custom-agy",
      model: "claude-sonnet-4-6",
      antigravityAgent: "researcher",
      antigravityEffort: "high",
      antigravitySandbox: true,
      antigravityDangerouslySkipPermissions: false,
      antigravityPrintTimeout: "10m0s",
      extraArgs: "--log-file,custom.log",
      cwd: "/my/project",
      instructionsFilePath: "/my/AGENTS.md",
    } as any);

    expect(config.command).toBe("custom-agy");
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.agent).toBe("researcher");
    expect(config.effort).toBe("high");
    expect(config.sandbox).toBe(true);
    expect(config.dangerouslySkipPermissions).toBe(false);
    expect(config.printTimeout).toBe("10m0s");
    expect(config.extraArgs).toEqual(["--log-file", "custom.log"]);
    expect(config.cwd).toBe("/my/project");
    expect(config.instructionsFilePath).toBe("/my/AGENTS.md");
  });
});
