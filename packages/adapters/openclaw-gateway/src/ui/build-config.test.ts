import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildOpenClawGatewayConfig } from "./build-config.js";

function baseValues(): CreateConfigValues {
  return {
    adapterType: "openclaw_gateway",
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
    url: "wss://gateway.example/ws",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: false,
    intervalSec: 0,
  };
}

describe("buildOpenClawGatewayConfig", () => {
  it("applies the documented timeout defaults when unset (timeoutSec=120, waitTimeoutMs=120000)", () => {
    const config = buildOpenClawGatewayConfig(baseValues());
    expect(config.timeoutSec).toBe(120);
    expect(config.waitTimeoutMs).toBe(120000);
  });

  it("preserves explicit timeout values when provided", () => {
    const config = buildOpenClawGatewayConfig({
      ...baseValues(),
      timeoutSec: 45,
      waitTimeoutMs: 9000,
    });
    expect(config.timeoutSec).toBe(45);
    expect(config.waitTimeoutMs).toBe(9000);
  });

  it("applies the documented identity defaults when unset", () => {
    const config = buildOpenClawGatewayConfig(baseValues());
    expect(config.sessionKeyStrategy).toBe("issue");
    expect(config.role).toBe("operator");
    expect(config.scopes).toEqual(["operator.admin"]);
  });
});
