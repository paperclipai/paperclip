import { describe, expect, it, vi } from "vitest";
import {
  buildMuseAcpConfig,
  nodeVersionMeetsMuseAcpMinimum,
  resolveMuseExecutionEngine,
  resolveMuseExecutionEngineForRun,
} from "./acp.js";
import { testEnvironment } from "./test.js";
import { DEFAULT_MUSE_LOCAL_MODEL } from "../index.js";
import { uuidv7, parseArgs, MuseAcpBridge } from "../cli/muse-acp.js";

describe("resolveMuseExecutionEngine", () => {
  it("defaults to ACP (non-explicit) when engine is unset", () => {
    expect(resolveMuseExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
  });

  it("honors an explicit engine=acp", () => {
    expect(resolveMuseExecutionEngine({ engine: "acp" })).toEqual({ engine: "acp", explicit: true });
  });

  it("honors an explicit engine=cli", () => {
    expect(resolveMuseExecutionEngine({ engine: "CLI" })).toEqual({ engine: "cli", explicit: true });
  });

  it("treats unknown values as the non-explicit ACP default", () => {
    expect(resolveMuseExecutionEngine({ engine: "nonsense" })).toEqual({ engine: "acp", explicit: false });
  });
});

describe("resolveMuseExecutionEngineForRun", () => {
  it("rejects non-sandbox remote targets for ACP", async () => {
    const res = await resolveMuseExecutionEngineForRun({
      config: {},
      executionTransport: {
        remoteExecution: {
          transport: "ssh",
          host: "example.com",
          username: "test",
          port: 22,
          remoteCwd: "/work",
        },
      } as any,
    });
    expect(res.unavailableReason).toMatch(/Muse ACP supports sandbox remote targets only/);
  });

  it("rejects sandboxes without a bidirectional process runner for ACP", async () => {
    const res = await resolveMuseExecutionEngineForRun({
      config: {},
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "daytona",
        remoteCwd: "/work",
        runner: null,
      } as any,
    });
    expect(res.unavailableReason).toMatch(/Muse ACP requires a bidirectional remote process target/);
  });
});

describe("testEnvironment with engine resolution", () => {
  it("returns fail status when engineSelection has unavailableReason", async () => {
    const res = await testEnvironment({
      companyId: "company-123",
      adapterType: "muse_local",
      config: {},
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "daytona",
        remoteCwd: "/work",
        runner: null,
      } as any,
    });
    expect(res.status).toBe("fail");
    expect(res.checks.some((c) => c.code === "adapter_engine_unavailable")).toBe(true);
  });
});

describe("buildMuseAcpConfig", () => {
  it("targets the muse agent with persistent mode and default keepalive", () => {
    const out = buildMuseAcpConfig({ cwd: "/work" });
    expect(out.agent).toBe("muse");
    expect(out.mode).toBe("persistent");
    expect(out.cwd).toBe("/work");
    expect(out.warmHandleIdleMs).toBe(0);
  });

  it("preserves configured warmHandleIdleMs", () => {
    const out = buildMuseAcpConfig({ cwd: "/work", warmHandleIdleMs: 900_000 });
    expect(out.warmHandleIdleMs).toBe(900_000);
  });

  it("prefers an explicit agentCommand override", () => {
    const out = buildMuseAcpConfig({ agentCommand: "/custom/muse-acp --foo" });
    expect(out.agentCommand).toBe("/custom/muse-acp --foo");
  });

  it("defaults to DEFAULT_MUSE_LOCAL_MODEL when model is unset or matches default", () => {
    const out = buildMuseAcpConfig({ model: DEFAULT_MUSE_LOCAL_MODEL });
    expect(out.model).toBe(DEFAULT_MUSE_LOCAL_MODEL);
    const outUnset = buildMuseAcpConfig({});
    expect(outUnset.model).toBe(DEFAULT_MUSE_LOCAL_MODEL);
  });

  it("keeps a non-default model and forwards configured effort", () => {
    const out = buildMuseAcpConfig({ model: "muse-wonder-full-1.0", reasoningEffort: "xhigh" });
    expect(out.model).toBe("muse-wonder-full-1.0");
    expect(out.effort).toBe("xhigh");
    expect(out.reasoningEffort).toBe("xhigh");
  });

  it("opts into the shared engine summary and coalescing handling", () => {
    const out = buildMuseAcpConfig({});
    expect(out.summaryStrategy).toBe("lastOutputSegment");
    expect(out.coalescePlaceholderToolUpdates).toBe(true);
  });
});

describe("nodeVersionMeetsMuseAcpMinimum", () => {
  it("accepts Node >= 20", () => {
    expect(nodeVersionMeetsMuseAcpMinimum("v24.11.0")).toBe(true);
    expect(nodeVersionMeetsMuseAcpMinimum("v22.0.0")).toBe(true);
    expect(nodeVersionMeetsMuseAcpMinimum("v20.0.0")).toBe(true);
  });
  it("rejects Node < 20", () => {
    expect(nodeVersionMeetsMuseAcpMinimum("v18.19.0")).toBe(false);
  });
});

describe("uuidv7", () => {
  it("generates a valid UUIDv7 format", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("generates strictly monotonic/increasing UUIDv7 over time", async () => {
    const id1 = uuidv7();
    await new Promise((r) => setTimeout(r, 2));
    const id2 = uuidv7();
    expect(id1 < id2).toBe(true);
  });
});

describe("parseArgs", () => {
  it("parses CLI flags and defaults", () => {
    const res = parseArgs(["node", "muse-acp", "--model", "muse-spark-1.3", "--provider", "meta"]);
    expect(res.options.model).toBe("muse-spark-1.3");
    expect(res.options.provider).toBe("meta");
    expect(res.options.disableSandbox).toBe(true);
    expect(res.options.trustWorkspace).toBe(true);
    expect(res.showVersion).toBe(false);
  });

  it("defaults to DEFAULT_MUSE_LOCAL_MODEL when model flag is omitted", () => {
    const res = parseArgs(["node", "muse-acp"]);
    expect(res.options.model).toBe(DEFAULT_MUSE_LOCAL_MODEL);
  });

  it("detects --version flag", () => {
    const res = parseArgs(["node", "muse-acp", "--version"]);
    expect(res.showVersion).toBe(true);
  });
});

describe("MuseAcpBridge session config methods", () => {
  it("handles session/set_model and updates active model", async () => {
    const bridge = new MuseAcpBridge(parseArgs(["node", "muse-acp"]).options);
    const responses: any[] = [];
    vi.spyOn(bridge, "sendAcpResponse").mockImplementation((id, result, error) => {
      responses.push({ id, result, error });
    });

    await bridge.handleAcpRequest({
      jsonrpc: "2.0",
      id: 42,
      method: "session/set_model",
      params: { modelId: "muse-wonder-full-1.0" },
    });

    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      id: 42,
      result: { modelId: "muse-wonder-full-1.0" },
      error: undefined,
    });
  });

  it("handles session/set_config_option for model and effort", async () => {
    const bridge = new MuseAcpBridge(parseArgs(["node", "muse-acp"]).options);
    const responses: any[] = [];
    vi.spyOn(bridge, "sendAcpResponse").mockImplementation((id, result, error) => {
      responses.push({ id, result, error });
    });

    await bridge.handleAcpRequest({
      jsonrpc: "2.0",
      id: 43,
      method: "session/set_config_option",
      params: { configId: "model", value: "muse-spark-1.3" },
    });

    await bridge.handleAcpRequest({
      jsonrpc: "2.0",
      id: 44,
      method: "session/set_config_option",
      params: { configId: "effort", value: "high" },
    });

    expect(responses).toHaveLength(2);
    expect(responses[0].result.configOptions[0]).toEqual({ id: "model", currentValue: "muse-spark-1.3" });
    expect(responses[1].result.configOptions[0]).toEqual({ id: "effort", currentValue: "high" });
  });

  it("handles failed turns by returning a JSON-RPC error response with failure details", async () => {
    const bridge = new MuseAcpBridge(parseArgs(["node", "muse-acp"]).options);
    const responses: any[] = [];
    vi.spyOn(bridge, "sendAcpResponse").mockImplementation((id, result, error) => {
      responses.push({ id, result, error });
    });
    // Stub sendMsp so turn/start resolves immediately
    vi.spyOn(bridge as any, "sendMsp").mockResolvedValue({});

    const promptPromise = bridge.handleAcpRequest({
      jsonrpc: "2.0",
      id: 55,
      method: "session/prompt",
      params: { sessionId: "s-1", prompt: [{ type: "text", text: "Do something" }] },
    });

    // Simulate MSP notification from muse serve with failed terminal status
    (bridge as any).handleMspNotification("turn/completed", {
      terminal: "failed",
      error: { message: "Model context window exceeded" },
    });

    await promptPromise;

    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe(55);
    expect(responses[0].result).toBeUndefined();
    expect(responses[0].error).toEqual({
      code: -32603,
      message: "Model context window exceeded",
      data: {
        sessionId: "s-1",
        error: "Model context window exceeded",
      },
    });
  });
});
