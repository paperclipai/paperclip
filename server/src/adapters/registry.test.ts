import { afterEach, describe, expect, it, vi } from "vitest";
import { assertValidAdapterLoginCapability } from "@paperclipai/adapter-utils";
import { listServerAdapters, requireServerAdapter } from "./registry.js";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";

// The registry registers a login capability for the two built-in interactive
// adapters. The test checks the scalar values and the presence of the required
// callbacks. It also runs the shared validator, so the built-in capabilities
// obey the same fail-closed contract as an external adapter.

describe("built-in adapter login capabilities", () => {
  it("registers the Codex device-login capability", () => {
    const capability = requireServerAdapter("codex_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("displayed_code");
    expect(capability.timeoutPolicy).toBe("caller_bounded");
    expect(capability.completionClaim).toBeUndefined();
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "codex_local")).not.toThrow();
  });

  it("registers the Grok device-login capability", () => {
    const capability = requireServerAdapter("grok_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("displayed_code");
    expect(capability.timeoutPolicy).toBe("caller_bounded");
    expect(capability.completionClaim).toBeUndefined();
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "grok_local")).not.toThrow();
  });

  it("registers the Claude setup-token capability", () => {
    const capability = requireServerAdapter("claude_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("submitted_browser_code");
    expect(capability.timeoutPolicy).toBe("fixed");
    expect(capability.completionClaim).toBe("storedSessionId");
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(typeof capability.captureCredential).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "claude_local")).not.toThrow();
  });
});

describe("built-in runtime connection tool delivery", () => {
  const expectedStrategies = new Map([
    ["acpx_local", "environment"],
    ["claude_local", "native_mcp"],
    ["codex_local", "native_mcp"],
    ["cursor_cloud", "invocation_context"],
    ["cursor", "environment"],
    ["gemini_local", "environment"],
    ["grok_local", "environment"],
    ["hermes_gateway", "invocation_context"],
    ["hermes_local", "environment"],
    ["kimi_local", "environment"],
    ["openclaw_gateway", "invocation_context"],
    ["opencode_local", "environment"],
    ["paperclip_runner", "environment"],
    ["pi_local", "environment"],
    ["process", "environment"],
    ["http", "invocation_context"],
  ] as const);

  it("requires every built-in adapter to declare its expected delivery strategy", () => {
    const builtIns = listServerAdapters().filter((adapter) => BUILTIN_ADAPTER_TYPES.has(adapter.type));
    expect(new Set(builtIns.map((adapter) => adapter.type))).toEqual(BUILTIN_ADAPTER_TYPES);
    expect(new Map(builtIns.map((adapter) => [adapter.type, adapter.runtimeToolDelivery]))).toEqual(
      expectedStrategies,
    );
  });

  it.each([...expectedStrategies])("delivers %s runtime tools through %s", (type, strategy) => {
    expect(requireServerAdapter(type).runtimeToolDelivery).toBe(strategy);
  });
});


describe("native ACPX environment checks", () => {
  afterEach(() => vi.restoreAllMocks());

  const context = {
    companyId: "company-test",
    adapterType: "paperclip_runner",
    config: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" },
  };

  it("reports unsupported local platforms before a successful CLI login can mask them", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!(context);
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([expect.objectContaining({
      code: "acpx_runtime_platform_unsupported",
      level: "error",
    })]);
  });

  it("keeps the qualified Linux x64 profile available", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!(context);
    expect(result.status).toBe("pass");
  });

  it("does not use the host platform to reject a remote environment", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({
      ...context,
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" },
    });
    expect(result.status).toBe("pass");
  });
});
