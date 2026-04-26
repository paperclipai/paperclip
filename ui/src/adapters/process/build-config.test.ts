import { describe, it, expect } from "vitest";
import { buildProcessConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

// Minimal CreateConfigValues shape needed for buildProcessConfig tests.
function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "process",
    cwd: "",
    promptTemplate: "",
    model: "",
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
    maxTurnsPerRun: 0,
    heartbeatEnabled: false,
    intervalSec: 60,
    ...overrides,
  };
}

describe("buildProcessConfig", () => {
  it("always includes timeoutSec 0 and graceSec 15", () => {
    const result = buildProcessConfig(makeValues());
    expect(result.timeoutSec).toBe(0);
    expect(result.graceSec).toBe(15);
  });

  it("includes cwd when non-empty", () => {
    const result = buildProcessConfig(makeValues({ cwd: "/home/user/project" }));
    expect(result.cwd).toBe("/home/user/project");
  });

  it("omits cwd when empty string", () => {
    const result = buildProcessConfig(makeValues({ cwd: "" }));
    expect(Object.prototype.hasOwnProperty.call(result, "cwd")).toBe(false);
  });

  it("includes command when non-empty", () => {
    const result = buildProcessConfig(makeValues({ command: "node server.js" }));
    expect(result.command).toBe("node server.js");
  });

  it("omits command when empty string", () => {
    const result = buildProcessConfig(makeValues({ command: "" }));
    expect(Object.prototype.hasOwnProperty.call(result, "command")).toBe(false);
  });

  it("splits args on commas and trims whitespace", () => {
    const result = buildProcessConfig(makeValues({ args: "--port, 3000,  --verbose" }));
    expect(result.args).toEqual(["--port", "3000", "--verbose"]);
  });

  it("filters empty segments from args after splitting", () => {
    const result = buildProcessConfig(makeValues({ args: "--flag,, ,--other" }));
    expect(result.args).toEqual(["--flag", "--other"]);
  });

  it("omits args when args is empty string (falsy check)", () => {
    const result = buildProcessConfig(makeValues({ args: "" }));
    expect(Object.prototype.hasOwnProperty.call(result, "args")).toBe(false);
  });

  it("handles single arg without comma", () => {
    const result = buildProcessConfig(makeValues({ args: "--debug" }));
    expect(result.args).toEqual(["--debug"]);
  });

  it("returns full config with all fields when all values are set", () => {
    const result = buildProcessConfig(
      makeValues({ cwd: "/app", command: "python", args: "app.py, --mode, prod" }),
    );
    expect(result.cwd).toBe("/app");
    expect(result.command).toBe("python");
    expect(result.args).toEqual(["app.py", "--mode", "prod"]);
    expect(result.timeoutSec).toBe(0);
    expect(result.graceSec).toBe(15);
  });
});
