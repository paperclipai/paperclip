import { describe, it, expect } from "vitest";
import { buildHttpConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

// Minimal CreateConfigValues shape needed for buildHttpConfig tests.
function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "http",
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

describe("buildHttpConfig", () => {
  it("always includes method POST and timeoutMs 15000", () => {
    const result = buildHttpConfig(makeValues());
    expect(result.method).toBe("POST");
    expect(result.timeoutMs).toBe(15000);
  });

  it("includes url when non-empty", () => {
    const result = buildHttpConfig(makeValues({ url: "https://api.example.com/run" }));
    expect(result.url).toBe("https://api.example.com/run");
  });

  it("omits url when empty string", () => {
    const result = buildHttpConfig(makeValues({ url: "" }));
    expect(Object.prototype.hasOwnProperty.call(result, "url")).toBe(false);
  });

  it("returns only method and timeoutMs when url is not set", () => {
    const result = buildHttpConfig(makeValues());
    expect(Object.keys(result).sort()).toEqual(["method", "timeoutMs"]);
  });

  it("returns url, method, and timeoutMs when url is set", () => {
    const result = buildHttpConfig(makeValues({ url: "http://localhost:3000" }));
    expect(Object.keys(result).sort()).toEqual(["method", "timeoutMs", "url"]);
  });
});
