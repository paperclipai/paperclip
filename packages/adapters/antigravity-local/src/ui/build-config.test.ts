// Unit tests for Antigravity local UI build-config

import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL } from "../index.js";
import { buildAntigravityLocalConfig } from "./build-config.js";

describe("buildAntigravityLocalConfig", () => {
  it("builds config with defaults (dangerouslySkipPermissions is false)", () => {
    const config = buildAntigravityLocalConfig({
      adapterType: "antigravity_local",
    } as unknown as CreateConfigValues);

    expect(config.model).toBe(DEFAULT_ANTIGRAVITY_LOCAL_MODEL);
    expect(config.sandbox).toBe(false);
    expect(config.dangerouslySkipPermissions).toBe(false);
    expect(config.timeoutSec).toBe(0);
    expect(config.graceSec).toBe(15);
  });

  it("enables dangerouslySkipPermissions only when explicitly true", () => {
    const enabledConfig = buildAntigravityLocalConfig({
      adapterType: "antigravity_local",
      dangerouslySkipPermissions: true,
    } as unknown as CreateConfigValues);
    expect(enabledConfig.dangerouslySkipPermissions).toBe(true);

    const disabledConfig = buildAntigravityLocalConfig({
      adapterType: "antigravity_local",
      dangerouslySkipPermissions: false,
    } as unknown as CreateConfigValues);
    expect(disabledConfig.dangerouslySkipPermissions).toBe(false);
  });

  it("populates Antigravity-specific options when provided", () => {
    const config = buildAntigravityLocalConfig({
      adapterType: "antigravity_local",
      command: "custom-agy",
      model: "claude-sonnet-4-6",
      antigravityAgent: "researcher",
      antigravityEffort: "high",
      antigravitySandbox: true,
      antigravityDangerouslySkipPermissions: true,
      antigravityPrintTimeout: "10m0s",
      extraArgs: "--log-file,custom.log",
      cwd: "/my/project",
      instructionsFilePath: "/my/AGENTS.md",
    } as unknown as CreateConfigValues);

    expect(config.command).toBe("custom-agy");
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.agent).toBe("researcher");
    expect(config.effort).toBe("high");
    expect(config.sandbox).toBe(true);
    expect(config.dangerouslySkipPermissions).toBe(true);
    expect(config.printTimeout).toBe("10m0s");
    expect(config.extraArgs).toEqual(["--log-file", "custom.log"]);
    expect(config.cwd).toBe("/my/project");
    expect(config.instructionsFilePath).toBe("/my/AGENTS.md");
  });

  it("parses extraArgs from array or whitespace-separated string", () => {
    const fromArray = buildAntigravityLocalConfig({
      adapterType: "antigravity_local",
      extraArgs: ["--flag1", "--flag2"],
    } as unknown as CreateConfigValues);
    expect(fromArray.extraArgs).toEqual(["--flag1", "--flag2"]);

    const fromSpaceString = buildAntigravityLocalConfig({
      adapterType: "antigravity_local",
      extraArgs: "--verbose --debug",
    } as unknown as CreateConfigValues);
    expect(fromSpaceString.extraArgs).toEqual(["--verbose", "--debug"]);
  });
});
