import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  createPluginToolRegistry,
} from "../services/plugin-tool-registry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const PLUGIN_KEY = "acme.timeout";
const PLUGIN_DB_ID = "00000000-0000-4000-8000-000000000002";

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Timeout plugin",
    description: "Timeout fixture",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "dist/worker.js" },
    tools: [
      {
        name: "slow",
        displayName: "Slow",
        description: "Hangs",
        parametersSchema: { type: "object", properties: {} },
        timeoutMs: 5_000,
      },
      {
        name: "defaulted",
        displayName: "Defaulted",
        description: "No declared timeout",
        parametersSchema: { type: "object", properties: {} },
      },
    ],
  } as unknown as PaperclipPluginManifestV1;
}

function timeoutError() {
  return new JsonRpcCallError({
    code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
    message: 'RPC call "executeTool" timed out after 5000ms',
  });
}

function managerWith(call: (...args: never[]) => Promise<never>): PluginWorkerManager {
  return {
    isRunning: () => true,
    call: call as unknown as PluginWorkerManager["call"],
  } as unknown as PluginWorkerManager;
}

const runContext = { agentId: "agent-1", runId: "run-1", companyId: "company-1", projectId: null };

describe("plugin tool timeouts", () => {
  it("carries the declared timeout into registration", () => {
    const registry = createPluginToolRegistry(managerWith(async () => {
      throw new Error("must not run");
    }));
    registry.registerPlugin(PLUGIN_KEY, manifest(), PLUGIN_DB_ID);
    expect(registry.getTool("acme.timeout:slow")?.timeoutMs).toBe(5_000);
    expect(registry.getTool("acme.timeout:defaulted")?.timeoutMs).toBeUndefined();
  });

  it("forwards the declared timeout to the worker call", async () => {
    const call = vi.fn(async () => ({ content: "ok" }));
    const registry = createPluginToolRegistry(managerWith(call));
    registry.registerPlugin(PLUGIN_KEY, manifest(), PLUGIN_DB_ID);
    const result = await registry.executeTool("acme.timeout:slow", {}, runContext);
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]?.[3]).toBe(5_000);
    expect(result.result).toEqual({ content: "ok" });
  });

  it("maps transport timeouts to structured timeout results", async () => {
    const registry = createPluginToolRegistry(managerWith(async () => {
      throw timeoutError();
    }));
    registry.registerPlugin(PLUGIN_KEY, manifest(), PLUGIN_DB_ID);
    const result = await registry.executeTool("acme.timeout:slow", {}, runContext);
    expect(result).toEqual({
      pluginId: PLUGIN_KEY,
      toolName: "slow",
      result: {
        content: expect.stringContaining("timed out after 5000ms"),
        error: expect.stringContaining("acme.timeout:slow"),
        timedOut: true,
        timeoutMs: 5_000,
      },
    });
  });

  it("labels transport-default timeouts with the default budget", async () => {
    const call = vi.fn(async () => {
      throw timeoutError();
    });
    const registry = createPluginToolRegistry(managerWith(call));
    registry.registerPlugin(PLUGIN_KEY, manifest(), PLUGIN_DB_ID);
    const result = await registry.executeTool("acme.timeout:defaulted", {}, runContext);
    expect(call.mock.calls[0]?.[3]).toBeUndefined();
    expect(result.result).toMatchObject({
      timedOut: true,
      timeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
    });
    expect(DEFAULT_TOOL_CALL_TIMEOUT_MS).toBe(30_000);
  });

  it("rethrows non-timeout failures unchanged", async () => {
    const boom = new Error("worker exploded");
    const other = new JsonRpcCallError({ code: -32603, message: "Internal error" });
    for (const failure of [boom, other]) {
      const registry = createPluginToolRegistry(managerWith(async () => {
        throw failure;
      }));
      registry.registerPlugin(PLUGIN_KEY, manifest(), PLUGIN_DB_ID);
      await expect(registry.executeTool("acme.timeout:slow", {}, runContext)).rejects.toBe(failure);
    }
  });
});
