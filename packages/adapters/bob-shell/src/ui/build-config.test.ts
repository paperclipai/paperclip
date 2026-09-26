/**
 * Tests for buildBobShellConfig (UI config builder).
 */

import { describe, it, expect } from "vitest";
import { buildBobShellConfig } from "./build-config.js";

// Minimal CreateConfigValues — only the fields buildBobShellConfig reads are required.
// Cast to the full type to satisfy TypeScript without specifying every optional field.
const base = {
  model: "",
  cwd: "",
  command: "",
  maxTurnsPerRun: 0,
  promptTemplate: "",
  extraArgs: "",
  thinkingEffort: "",
  adapterType: "bob_shell",
  chrome: false,
  dangerouslySkipPermissions: false,
  search: false,
  fastMode: false,
  dangerouslyBypassSandbox: false,
  args: "",
  envVars: "",
  envBindings: {},
  url: "",
  bootstrapPrompt: "",
  heartbeatEnabled: false,
  intervalSec: 0,
} as import("@paperclipai/adapter-utils").CreateConfigValues;

describe("buildBobShellConfig", () => {
  it("produces minimal config for default values", () => {
    const config = buildBobShellConfig(base);
    expect(config.timeoutSec).toBeDefined();
    expect(config.maxTurns).toBe(0);
    expect(config.cwd).toBeUndefined();
    expect(config.bobCommand).toBeUndefined();
  });

  it("sets cwd when provided", () => {
    const config = buildBobShellConfig({ ...base, cwd: "/my/project" });
    expect(config.cwd).toBe("/my/project");
  });

  it("sets bobCommand when command provided", () => {
    const config = buildBobShellConfig({
      ...base,
      command: "/usr/local/bin/bob",
    });
    expect(config.bobCommand).toBe("/usr/local/bin/bob");
  });

  it("scales timeout with maxTurnsPerRun", () => {
    const config = buildBobShellConfig({ ...base, maxTurnsPerRun: 100 });
    expect(config.maxTurns).toBe(100);
    expect(config.timeoutSec).toBeGreaterThanOrEqual(100 * 20);
  });

  it("parses extraArgs as array", () => {
    const config = buildBobShellConfig({
      ...base,
      extraArgs: "--disable-mcp --log-level debug",
    });
    expect(config.extraArgs).toEqual(["--disable-mcp", "--log-level", "debug"]);
  });

  it("sets promptTemplate when provided", () => {
    const config = buildBobShellConfig({
      ...base,
      promptTemplate: "Do the task: {{taskBody}}",
    });
    expect(config.promptTemplate).toBe("Do the task: {{taskBody}}");
  });
});
