/**
 * Regression tests for JEN-27: plugin tools/execute 502 after reinstall.
 *
 * Root cause: activatePlugin called registerPluginTools(pluginKey, manifest)
 * without the DB UUID. The tool registry stored pluginDbId = pluginKey.
 * workerManager.isRunning(pluginKey) always returned false because the workers
 * map is keyed by DB UUID, not pluginKey. Result: 502 on every tools/execute call.
 *
 * Fix: registerPluginTools now accepts an optional pluginDbId parameter.
 * activatePlugin passes the DB UUID so isRunning checks resolve correctly.
 */

import { describe, it, expect, vi } from "vitest";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const PLUGIN_KEY = "acme.test-plugin";
const PLUGIN_DB_UUID = "00000000-0000-0000-0000-000000000001";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Plugin",
  description: "Used for JEN-27 regression",
  author: "test",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
  tools: [
    {
      name: "do-thing",
      displayName: "Do Thing",
      description: "Does a thing",
      parametersSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  ],
};

const runContext = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "co-1",
  projectId: "proj-1",
};

describe("plugin-tool-registry reinstall regression (JEN-27)", () => {
  it("registers tools with DB UUID so isRunning resolves correctly", async () => {
    const workerManager = {
      isRunning: vi.fn((id: string) => id === PLUGIN_DB_UUID),
      call: vi.fn().mockResolvedValue({ result: "ok" }),
    } as unknown as PluginWorkerManager;

    const registry = createPluginToolRegistry(workerManager);

    // Simulate what activatePlugin does AFTER the fix: pass pluginDbId
    registry.registerPlugin(PLUGIN_KEY, manifest, PLUGIN_DB_UUID);

    const result = await registry.executeTool(
      `${PLUGIN_KEY}:do-thing`,
      {},
      runContext,
    );

    expect(workerManager.isRunning).toHaveBeenCalledWith(PLUGIN_DB_UUID);
    expect(result).toMatchObject({ pluginId: PLUGIN_KEY, toolName: "do-thing", result: { result: "ok" } });
  });

  it("fails with worker-not-running when pluginDbId is omitted (regression guard)", async () => {
    const workerManager = {
      isRunning: vi.fn((id: string) => id === PLUGIN_DB_UUID),
      call: vi.fn(),
    } as unknown as PluginWorkerManager;

    const registry = createPluginToolRegistry(workerManager);

    // Simulate the OLD (buggy) behavior: no pluginDbId passed → falls back to pluginKey
    registry.registerPlugin(PLUGIN_KEY, manifest);

    await expect(
      registry.executeTool(`${PLUGIN_KEY}:do-thing`, {}, runContext),
    ).rejects.toThrow(/not running/);

    // isRunning was called with the pluginKey (not UUID), which returned false
    expect(workerManager.isRunning).toHaveBeenCalledWith(PLUGIN_KEY);
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("re-registration on reinstall uses the new UUID and tool calls succeed", async () => {
    const UUID_BEFORE = "00000000-0000-0000-0000-000000000001";
    const UUID_AFTER = "00000000-0000-0000-0000-000000000002";

    const workerManager = {
      isRunning: vi.fn((id: string) => id === UUID_AFTER),
      call: vi.fn().mockResolvedValue({ result: "reinstall-ok" }),
    } as unknown as PluginWorkerManager;

    const registry = createPluginToolRegistry(workerManager);

    // First install with UUID_BEFORE
    registry.registerPlugin(PLUGIN_KEY, manifest, UUID_BEFORE);

    // Uninstall / unregister
    registry.unregisterPlugin(PLUGIN_KEY);

    // Reinstall with UUID_AFTER (e.g. hard-delete + fresh install creates new UUID)
    registry.registerPlugin(PLUGIN_KEY, manifest, UUID_AFTER);

    const result = await registry.executeTool(
      `${PLUGIN_KEY}:do-thing`,
      {},
      runContext,
    );

    expect(workerManager.isRunning).toHaveBeenCalledWith(UUID_AFTER);
    expect(result).toMatchObject({ result: { result: "reinstall-ok" } });
  });
});
