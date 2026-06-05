import { describe, expect, it } from "vitest";
import { buildOpenCodeLocalConfig } from "./build-config.js";
import { DEFAULT_OPENCODE_LOCAL_TIMEOUT_SEC } from "../index.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function baseValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "opencode_local",
    cwd: "/tmp/agent",
    instructionsFilePath: undefined,
    promptTemplate: "",
    model: "openai/gpt-5.2-codex",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "opencode",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: true,
    intervalSec: 1800,
    ...overrides,
  };
}

describe("buildOpenCodeLocalConfig", () => {
  it("defaults timeoutSec to the 900s platform cap (HNT-2743)", () => {
    // HNT-2743 changes the opencode_local adapter's default
    // adapterConfig.timeoutSec from 0 (unbounded) to 900s, so a freshly
    // created agent inherits the same stall guardrail the HNT-2664
    // per-agent rollout applied. Without this default, any new agent
    // would silently lose the 900s wall-clock cap.
    const config = buildOpenCodeLocalConfig(baseValues());

    expect(config.timeoutSec).toBe(DEFAULT_OPENCODE_LOCAL_TIMEOUT_SEC);
    expect(config.timeoutSec).toBe(900);
    expect(config.graceSec).toBe(20);
  });
});
