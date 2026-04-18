import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginToolRegistry,
  TOOL_NAMESPACE_SEPARATOR,
} from "../services/plugin-tool-registry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(
  tools: Array<{ name: string; displayName?: string; description?: string }> = [],
): PaperclipPluginManifestV1 {
  return {
    name: "test-plugin",
    version: "1.0.0",
    tools: tools.map((t) => ({
      name: t.name,
      displayName: t.displayName ?? t.name,
      description: t.description ?? `Tool ${t.name}`,
      parametersSchema: { type: "object" },
    })),
  } as PaperclipPluginManifestV1;
}

function makeWorkerManager(overrides?: Partial<PluginWorkerManager>): PluginWorkerManager {
  return {
    startWorker: vi.fn(),
    stopWorker: vi.fn(),
    getWorker: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
    stopAll: vi.fn(),
    diagnostics: vi.fn(),
    call: vi.fn().mockResolvedValue({ content: "ok" } satisfies ToolResult),
    ...overrides,
  } as unknown as PluginWorkerManager;
}

function makeEventBus(overrides?: Partial<PluginEventBus>): PluginEventBus {
  return {
    emit: vi.fn().mockResolvedValue({ errors: [] }),
    forPlugin: vi.fn(),
    clearPlugin: vi.fn(),
    subscriptionCount: vi.fn().mockReturnValue(0),
    ...overrides,
  } as unknown as PluginEventBus;
}

const PLUGIN_ID = "acme.linear";
const TOOL_NAME = "search-issues";
const NAMESPACED = `${PLUGIN_ID}${TOOL_NAMESPACE_SEPARATOR}${TOOL_NAME}`;

const RUN_CONTEXT: ToolRunContext = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "company-1",
  projectId: "project-1",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PluginToolRegistry — tool event lifecycle", () => {
  let workerManager: PluginWorkerManager;
  let eventBus: PluginEventBus;

  beforeEach(() => {
    workerManager = makeWorkerManager();
    eventBus = makeEventBus();
  });

  // -------------------------------------------------------------------------
  // pre_execute
  // -------------------------------------------------------------------------

  it("emits pre_execute with correct payload before workerManager.call()", async () => {
    const registry = createPluginToolRegistry(workerManager, eventBus);
    registry.registerPlugin(PLUGIN_ID, makeManifest([{ name: TOOL_NAME }]));

    const callOrder: string[] = [];
    (eventBus.emit as ReturnType<typeof vi.fn>).mockImplementation(async (event: any) => {
      if (event.eventType === "agent.tool.pre_execute") {
        callOrder.push("pre_execute");
      }
      return { errors: [] };
    });
    (workerManager.call as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("worker_call");
      return { content: "ok" };
    });

    await registry.executeTool(NAMESPACED, { query: "test" }, RUN_CONTEXT);

    // pre_execute fires before worker call
    expect(callOrder).toEqual(["pre_execute", "worker_call"]);

    // Verify payload shape
    const preCall = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([e]: [any]) => e.eventType === "agent.tool.pre_execute",
    );
    expect(preCall).toBeDefined();
    const preEvent = preCall![0];
    expect(preEvent.eventType).toBe("agent.tool.pre_execute");
    expect(preEvent.companyId).toBe("company-1");
    expect(preEvent.actorId).toBe("agent-1");
    expect(preEvent.actorType).toBe("agent");
    expect(preEvent.payload).toMatchObject({
      callId: expect.any(String),
      pluginId: PLUGIN_ID,
      toolName: TOOL_NAME,
      namespacedName: NAMESPACED,
      agentId: "agent-1",
      runId: "run-1",
      projectId: "project-1",
    });
  });

  // -------------------------------------------------------------------------
  // post_execute — success path
  // -------------------------------------------------------------------------

  it("emits post_execute on success with hasContent, hasError: false, error: null", async () => {
    const registry = createPluginToolRegistry(workerManager, eventBus);
    registry.registerPlugin(PLUGIN_ID, makeManifest([{ name: TOOL_NAME }]));

    (workerManager.call as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: "some result",
      error: undefined,
    } satisfies ToolResult);

    await registry.executeTool(NAMESPACED, {}, RUN_CONTEXT);

    const postCall = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([e]: [any]) => e.eventType === "agent.tool.post_execute",
    );
    expect(postCall).toBeDefined();
    const postEvent = postCall![0];
    expect(postEvent.eventType).toBe("agent.tool.post_execute");
    expect(postEvent.payload).toMatchObject({
      callId: expect.any(String),
      pluginId: PLUGIN_ID,
      toolName: TOOL_NAME,
      success: true,
      hasContent: true,
      hasError: false,
      error: null,
    });
  });

  // -------------------------------------------------------------------------
  // post_execute — worker throws
  // -------------------------------------------------------------------------

  it("emits post_execute on worker throw with success: false, hasError: true, and re-throws", async () => {
    const registry = createPluginToolRegistry(workerManager, eventBus);
    registry.registerPlugin(PLUGIN_ID, makeManifest([{ name: TOOL_NAME }]));

    const workerError = new Error("RPC timeout");
    (workerManager.call as ReturnType<typeof vi.fn>).mockRejectedValue(workerError);

    await expect(
      registry.executeTool(NAMESPACED, {}, RUN_CONTEXT),
    ).rejects.toThrow("RPC timeout");

    const postCall = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([e]: [any]) => e.eventType === "agent.tool.post_execute",
    );
    expect(postCall).toBeDefined();
    const postEvent = postCall![0];
    expect(postEvent.payload).toMatchObject({
      callId: expect.any(String),
      pluginId: PLUGIN_ID,
      toolName: TOOL_NAME,
      success: false,
      hasContent: false,
      hasError: true,
      error: "RPC timeout",
    });
  });

  // -------------------------------------------------------------------------
  // Event bus failure is caught — tool call still succeeds
  // -------------------------------------------------------------------------

  it("catches eventBus.emit() rejection and still returns the tool result", async () => {
    const registry = createPluginToolRegistry(workerManager, eventBus);
    registry.registerPlugin(PLUGIN_ID, makeManifest([{ name: TOOL_NAME }]));

    (eventBus.emit as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("event bus down"),
    );
    (workerManager.call as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: "result",
    } satisfies ToolResult);

    const result = await registry.executeTool(NAMESPACED, {}, RUN_CONTEXT);

    expect(result.result.content).toBe("result");
    expect(result.pluginId).toBe(PLUGIN_ID);
    expect(result.toolName).toBe(TOOL_NAME);
  });

  // -------------------------------------------------------------------------
  // No eventBus — existing behavior unchanged
  // -------------------------------------------------------------------------

  it("executes tool normally when no eventBus is provided", async () => {
    const registry = createPluginToolRegistry(workerManager); // no eventBus
    registry.registerPlugin(PLUGIN_ID, makeManifest([{ name: TOOL_NAME }]));

    (workerManager.call as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: "no-bus result",
    } satisfies ToolResult);

    const result = await registry.executeTool(NAMESPACED, { q: "test" }, RUN_CONTEXT);

    expect(result.result.content).toBe("no-bus result");
    expect(result.pluginId).toBe(PLUGIN_ID);
    expect(result.toolName).toBe(TOOL_NAME);
  });

  // -------------------------------------------------------------------------
  // Shared callId between pre and post events
  // -------------------------------------------------------------------------

  it("uses the same callId for pre_execute and post_execute in a single invocation", async () => {
    const registry = createPluginToolRegistry(workerManager, eventBus);
    registry.registerPlugin(PLUGIN_ID, makeManifest([{ name: TOOL_NAME }]));

    await registry.executeTool(NAMESPACED, {}, RUN_CONTEXT);

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const preEvent = emitCalls.find(([e]: [any]) => e.eventType === "agent.tool.pre_execute")?.[0];
    const postEvent = emitCalls.find(([e]: [any]) => e.eventType === "agent.tool.post_execute")?.[0];

    expect(preEvent).toBeDefined();
    expect(postEvent).toBeDefined();
    expect(preEvent.payload.callId).toBe(postEvent.payload.callId);
    expect(typeof preEvent.payload.callId).toBe("string");
    expect(preEvent.payload.callId.length).toBeGreaterThan(0);
  });
});
