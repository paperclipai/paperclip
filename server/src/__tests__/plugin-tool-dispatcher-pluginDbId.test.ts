/**
 * Regression test for plugin-loader → plugin-tool-dispatcher → plugin-tool-registry
 * worker-routing bug.
 *
 * Bug shape (pre-fix):
 *   - plugin-loader.ts called `toolDispatcher.registerPluginTools(pluginKey, manifest)`
 *     with only two args.
 *   - PluginToolDispatcher.registerPluginTools forwarded only those two args to
 *     `registry.registerPlugin(pluginKey, manifest)` — dropping the DB UUID.
 *   - PluginToolRegistry.executeTool calls `workerManager.isRunning(tool.pluginDbId)`
 *     for worker liveness — but pluginDbId fell back to `pluginKey` when undefined.
 *   - Workers are keyed by DB UUID in PluginWorkerManager, so isRunning(pluginKey)
 *     always returned false → every /api/plugins/tools/execute returned 502
 *     "worker for plugin X is not running" even when the worker process was alive.
 *
 * Fix:
 *   - Added optional `pluginDbId` parameter to PluginToolDispatcher.registerPluginTools.
 *   - plugin-loader now passes the DB UUID through.
 *   - The dispatcher forwards the UUID to the registry, which uses it for the
 *     worker.isRunning check.
 *
 * This test exercises the contract end-to-end with a stub worker manager that
 * only acknowledges the DB UUID — proving the dispatcher → registry → worker
 * routing path now uses the UUID and not the pluginKey.
 */

import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const PLUGIN_KEY = "acme.demo";
const PLUGIN_DB_ID = "00000000-0000-4000-8000-000000000001";

const MANIFEST: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Demo plugin",
  description: "Regression fixture",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
  tools: [
    {
      name: "ping",
      displayName: "Ping",
      description: "Test tool",
      parametersSchema: { type: "object", properties: {} },
    },
  ],
};

/**
 * Create a stub worker manager whose `isRunning` only accepts the DB UUID.
 * Any other lookup key (notably the pluginKey) reports the worker as down.
 */
function createUuidKeyedWorkerManager(): PluginWorkerManager {
  const isRunning = vi.fn((id: string) => id === PLUGIN_DB_ID);
  // call() throws if the worker is not running — matches real worker manager.
  const call = vi.fn(async (id: string) => {
    if (!isRunning(id)) {
      throw new Error(`worker for plugin "${id}" is not running`);
    }
    return { ok: true } as unknown;
  });
  return {
    startWorker: vi.fn(),
    stopWorker: vi.fn(),
    getWorker: vi.fn(),
    isRunning,
    stopAll: vi.fn(),
    diagnostics: vi.fn(() => []),
    call,
  } as unknown as PluginWorkerManager;
}

describe("plugin-tool-dispatcher pluginDbId propagation (regression)", () => {
  it("forwards the DB UUID so workerManager.isRunning resolves correctly", async () => {
    const workerManager = createUuidKeyedWorkerManager();
    const dispatcher = createPluginToolDispatcher({ workerManager });

    // Pre-fix: this call only passed (pluginKey, manifest) → registry fell back
    // to pluginKey for worker lookup → isRunning(pluginKey) === false.
    // Post-fix: third arg threads the DB UUID through so the worker check uses it.
    dispatcher.registerPluginTools(PLUGIN_KEY, MANIFEST, PLUGIN_DB_ID);

    const tool = dispatcher.getTool(`${PLUGIN_KEY}:ping`);
    expect(tool, "tool should be registered after registerPluginTools").not.toBeNull();
    expect(tool!.pluginDbId).toBe(PLUGIN_DB_ID);

    // The worker manager will fail any call keyed by pluginKey; only the UUID
    // resolves. If the dispatcher correctly threads the UUID, executeTool
    // will route via UUID and the isRunning check passes.
    await expect(
      dispatcher.executeTool(
        `${PLUGIN_KEY}:ping`,
        {},
        {
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-1",
          projectId: "project-1",
        },
      ),
      // We don't assert a happy-path result here because the stub call() returns
      // a shape the registry doesn't try to validate beyond the isRunning gate —
      // the regression is the gate, not the RPC happy path. We assert the
      // error message does NOT contain "is not running".
    ).resolves.toBeDefined();

    expect(workerManager.isRunning).toHaveBeenCalledWith(PLUGIN_DB_ID);
    expect(workerManager.isRunning).not.toHaveBeenCalledWith(PLUGIN_KEY);
  });

  it("falls back to pluginKey when pluginDbId is omitted (back-compat)", () => {
    const workerManager = createUuidKeyedWorkerManager();
    const dispatcher = createPluginToolDispatcher({ workerManager });

    // Back-compat: callers that omit the UUID still register tools (matching
    // pre-fix behavior so tests that exercise registry-only paths still work).
    dispatcher.registerPluginTools(PLUGIN_KEY, MANIFEST);

    const tool = dispatcher.getTool(`${PLUGIN_KEY}:ping`);
    expect(tool, "tool should still register without UUID").not.toBeNull();
    // pluginDbId falls back to pluginKey when UUID not supplied — matches the
    // documented contract (used for test/recovery scenarios that don't need
    // worker routing).
    expect(tool!.pluginDbId).toBe(PLUGIN_KEY);
  });
});
