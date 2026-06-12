import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

/**
 * Regression test for the "worker not running" bug where tools/execute
 * always 502s even though the worker is alive.
 *
 * Root cause: `dispatcher.registerPluginTools(pluginKey, manifest)` dropped
 * the `pluginDbId` parameter, so the registry stored tools with
 * `pluginDbId = pluginKey` (fallback). At dispatch time, the registry calls
 * `workerManager.isRunning(tool.pluginDbId)` — but `workerManager` keys
 * workers by DB UUID, not pluginKey, so the check returns false even though
 * the worker is running. Plugin cron jobs work (they don't go through the
 * dispatcher) but `tools/execute` always 502s.
 *
 * Manifests as: `notifications.sent` metrics flow but agent tool calls fail.
 */
describe("plugin-tool-dispatcher: registerPluginTools forwards pluginDbId", () => {
  const pluginKey = "paperclip-plugin-slack";
  const pluginDbId = "9ab29423-a0d3-438c-9310-5b6120fa7a5c";

  const manifest: PaperclipPluginManifestV1 = {
    id: pluginKey,
    apiVersion: 1,
    displayName: "Slack",
    version: "2.1.1",
    capabilities: [],
    tools: [
      {
        name: "slack_send_dm",
        description: "Send a DM",
        parametersSchema: { type: "object", properties: {} },
      },
    ],
  } as unknown as PaperclipPluginManifestV1;

  it("stores pluginDbId on the registered tool when passed (production path)", () => {
    const dispatcher = createPluginToolDispatcher({});
    dispatcher.registerPluginTools(pluginKey, manifest, pluginDbId);

    const tool = dispatcher.getTool(`${pluginKey}:slack_send_dm`);
    expect(tool).not.toBeNull();
    expect(tool?.pluginDbId).toBe(pluginDbId);
    expect(tool?.pluginId).toBe(pluginKey);
  });

  it("throws when pluginDbId is omitted", () => {
    const dispatcher = createPluginToolDispatcher({});
    expect(() =>
      // @ts-expect-error - verifies the runtime guard for legacy callers.
      dispatcher.registerPluginTools(pluginKey, manifest),
    ).toThrow(/pluginDbId is required/);
  });

  it("uses pluginDbId for workerManager.isRunning() at executeTool", async () => {
    const calls: string[] = [];
    const mockWorkerManager = {
      isRunning: (id: string) => {
        calls.push(id);
        return id === pluginDbId; // worker registered under DB UUID
      },
      call: async () => ({ ok: true, result: { ok: true } }),
      getWorker: () => undefined,
      startWorker: async () => undefined,
      stopWorker: async () => undefined,
      restartWorker: async () => undefined,
    };

    const dispatcher = createPluginToolDispatcher({
      workerManager: mockWorkerManager as never,
    });
    dispatcher.registerPluginTools(pluginKey, manifest, pluginDbId);

    const runContext = {
      agentId: "a-1",
      runId: "r-1",
      companyId: "c-1",
      projectId: "p-1",
    };

    const result = await dispatcher.executeTool(
      `${pluginKey}:slack_send_dm`,
      { user: "U123", text: "test" },
      runContext,
    );

    expect(calls).toContain(pluginDbId);
    expect(calls).not.toContain(pluginKey);
    expect(result).toBeDefined();
  });
});
