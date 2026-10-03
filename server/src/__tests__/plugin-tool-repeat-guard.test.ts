import { describe, expect, it, vi } from "vitest";
import {
  REPEAT_TOOL_REMINDER_THRESHOLDS,
  buildRepeatToolNotice,
  createRepeatToolTracker,
} from "../services/plugin-tool-repeat-guard.js";
import { validateToolContent } from "../services/tool-content-guards.js";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const PLUGIN_KEY = "acme.repeat";
const PLUGIN_DB_ID = "00000000-0000-4000-8000-000000000003";

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Repeat plugin",
    description: "Repeat fixture",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "dist/worker.js" },
    tools: [
      {
        name: "lookup",
        displayName: "Lookup",
        description: "Looks things up",
        parametersSchema: { type: "object", properties: {} },
      },
    ],
  } as unknown as PaperclipPluginManifestV1;
}

const runContext = { agentId: "agent-1", runId: "run-1", companyId: "company-1", projectId: null };

describe("repeat tool tracker", () => {
  it("counts consecutive identical calls regardless of argument key order", () => {
    const tracker = createRepeatToolTracker();
    const first = tracker.observe({ ...runContext, toolName: "t", parameters: { a: 1, b: 2 }, result: { content: "r" } });
    expect(first).toEqual({ repeatCount: 1, notice: null });
    const second = tracker.observe({ ...runContext, toolName: "t", parameters: { b: 2, a: 1 }, result: { content: "r" } });
    expect(second.repeatCount).toBe(2);
    expect(second.notice).toBeNull();
  });

  it("fires gentle then detailed notices at the configured thresholds", () => {
    const tracker = createRepeatToolTracker();
    const fired: number[] = [];
    for (let index = 0; index < 9; index += 1) {
      const { repeatCount, notice } = tracker.observe({ ...runContext, toolName: "t", parameters: { q: "x" }, result: { content: "r" } });
      if (notice) fired.push(repeatCount);
    }
    expect(fired).toEqual([3, 5, 8]);
  });

  it("resets on a different call and scopes chains per run", () => {    const tracker = createRepeatToolTracker();
    tracker.observe({ ...runContext, toolName: "t", parameters: { q: "x" }, result: { content: "r" } });
    tracker.observe({ ...runContext, toolName: "t", parameters: { q: "x" }, result: { content: "r" } });
    const changed = tracker.observe({ ...runContext, toolName: "t", parameters: { q: "y" }, result: { content: "r" } });
    expect(changed).toEqual({ repeatCount: 1, notice: null });
    const otherRun = tracker.observe({ ...runContext, runId: "run-2", toolName: "t", parameters: { q: "x" }, result: { content: "r" } });
    expect(otherRun).toEqual({ repeatCount: 1, notice: null });
  });

  it("resets when identical calls return different outcomes", () => {
    const tracker = createRepeatToolTracker();
    tracker.observe({ ...runContext, toolName: "t", parameters: { q: "x" }, result: { content: "poll 1" } });
    tracker.observe({ ...runContext, toolName: "t", parameters: { q: "x" }, result: { content: "poll 1" } });
    const changed = tracker.observe({ ...runContext, toolName: "t", parameters: { q: "x" }, result: { content: "poll 2" } });
    expect(changed).toEqual({ repeatCount: 1, notice: null });
  });

  it("never chains oversized or unserializable outcomes", () => {
    const tracker = createRepeatToolTracker();
    const big = "z".repeat(5_000);
    const first = tracker.observe({ ...runContext, toolName: "t", parameters: { q: "x" }, result: { content: big } });
    const second = tracker.observe({ ...runContext, toolName: "t", parameters: { q: "x" }, result: { content: big } });
    expect(first.repeatCount).toBe(1);
    expect(second.repeatCount).toBe(1);
    expect(second.notice).toBeNull();
  });

  it("builds notices only at thresholds", () => {
    expect(buildRepeatToolNotice("t", 2, "{}")).toBeNull();
    expect(buildRepeatToolNotice("t", 4, "{}")).toBeNull();
    expect(buildRepeatToolNotice("t", 3, "{}")).toContain("Loop guard");
    expect(REPEAT_TOOL_REMINDER_THRESHOLDS).toEqual([3, 5, 8]);
  });

  it("produces notices the result content guard never blocks", () => {
    for (const count of [3, 5, 8]) {
      const notice = buildRepeatToolNotice("lookup", count, '{"query":"x"}');
      expect(notice).toBeTruthy();
      expect(() =>
        validateToolContent({ value: { content: `found it\n\n${notice}` }, direction: "result" }),
      ).not.toThrow();
    }
  });
});

describe("registry repeat nudge", () => {
  function registryWith(content: string) {
    const call = vi.fn(async () => ({ content }));
    const manager = {
      isRunning: () => true,
      call: call as unknown as PluginWorkerManager["call"],
    } as unknown as PluginWorkerManager;
    const registry = createPluginToolRegistry(manager);
    registry.registerPlugin(PLUGIN_KEY, manifest(), PLUGIN_DB_ID);
    return { registry, call };
  }

  it("appends the reminder on the third identical call", async () => {
    const { registry } = registryWith("found it");
    const params = { query: "outage" };
    const first = await registry.executeTool("acme.repeat:lookup", params, runContext);
    expect(first.result.content).toBe("found it");
    await registry.executeTool("acme.repeat:lookup", params, runContext);
    const third = await registry.executeTool("acme.repeat:lookup", params, runContext);
    expect(third.result.content).toContain("found it");
    expect(third.result.content).toContain("Loop guard");
  });

  it("leaves data-only results untouched", async () => {
    const call = vi.fn(async () => ({ data: { rows: [1] } }));
    const manager = {
      isRunning: () => true,
      call: call as unknown as PluginWorkerManager["call"],
    } as unknown as PluginWorkerManager;
    const registry = createPluginToolRegistry(manager);
    registry.registerPlugin(PLUGIN_KEY, manifest(), PLUGIN_DB_ID);
    const context = { ...runContext, runId: "run-data-only" };
    const params = { query: "outage" };
    await registry.executeTool("acme.repeat:lookup", params, context);
    await registry.executeTool("acme.repeat:lookup", params, context);
    const third = await registry.executeTool("acme.repeat:lookup", params, context);
    expect(third.result).toEqual({ data: { rows: [1] } });
  });
});
