import { describe, it, expect } from "vitest";
import { buildOpenClawGatewayConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "openclaw_gateway",
    cwd: "",
    instructionsFilePath: "",
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

describe("buildOpenClawGatewayConfig", () => {
  it("includes url when provided", () => {
    const config = buildOpenClawGatewayConfig(makeValues({ url: "ws://localhost:8080" }));
    expect(config.url).toBe("ws://localhost:8080");
  });

  it("omits url when empty", () => {
    const config = buildOpenClawGatewayConfig(makeValues({ url: "" }));
    expect(config).not.toHaveProperty("url");
  });

  it("sets required defaults: timeoutSec, waitTimeoutMs, sessionKeyStrategy, role, scopes", () => {
    const config = buildOpenClawGatewayConfig(makeValues());
    expect(config.timeoutSec).toBe(120);
    expect(config.waitTimeoutMs).toBe(120000);
    expect(config.sessionKeyStrategy).toBe("issue");
    expect(config.role).toBe("operator");
    expect(config.scopes).toEqual(["operator.admin"]);
  });

  it("parses payloadTemplateJson and includes it as payloadTemplate", () => {
    const template = { key: "value", nested: { a: 1 } };
    const config = buildOpenClawGatewayConfig(
      makeValues({ payloadTemplateJson: JSON.stringify(template) }),
    );
    expect(config.payloadTemplate).toEqual(template);
  });

  it("omits payloadTemplate when payloadTemplateJson is empty", () => {
    const config = buildOpenClawGatewayConfig(makeValues({ payloadTemplateJson: "" }));
    expect(config).not.toHaveProperty("payloadTemplate");
  });

  it("omits payloadTemplate when payloadTemplateJson is invalid JSON", () => {
    const config = buildOpenClawGatewayConfig(makeValues({ payloadTemplateJson: "not-json" }));
    expect(config).not.toHaveProperty("payloadTemplate");
  });

  it("omits payloadTemplate when payloadTemplateJson is a JSON array (not an object)", () => {
    const config = buildOpenClawGatewayConfig(makeValues({ payloadTemplateJson: "[1,2,3]" }));
    expect(config).not.toHaveProperty("payloadTemplate");
  });

  it("parses runtimeServicesJson with services array and sets workspaceRuntime", () => {
    const services = { services: [{ name: "db", port: 5432 }] };
    const config = buildOpenClawGatewayConfig(
      makeValues({ runtimeServicesJson: JSON.stringify(services) }),
    );
    expect(config.workspaceRuntime).toEqual(services);
  });

  it("omits workspaceRuntime when runtimeServicesJson is empty", () => {
    const config = buildOpenClawGatewayConfig(makeValues({ runtimeServicesJson: "" }));
    expect(config).not.toHaveProperty("workspaceRuntime");
  });

  it("omits workspaceRuntime when runtimeServicesJson has no services array", () => {
    const config = buildOpenClawGatewayConfig(
      makeValues({ runtimeServicesJson: JSON.stringify({ other: "field" }) }),
    );
    expect(config).not.toHaveProperty("workspaceRuntime");
  });

  it("returns a plain object with all expected keys for a full config", () => {
    const template = { auth: "token" };
    const services = { services: [{ name: "redis" }] };
    const config = buildOpenClawGatewayConfig(
      makeValues({
        url: "ws://example.com",
        payloadTemplateJson: JSON.stringify(template),
        runtimeServicesJson: JSON.stringify(services),
      }),
    );
    expect(config).toMatchObject({
      url: "ws://example.com",
      timeoutSec: 120,
      waitTimeoutMs: 120000,
      sessionKeyStrategy: "issue",
      role: "operator",
      scopes: ["operator.admin"],
      payloadTemplate: template,
      workspaceRuntime: services,
    });
  });
});
