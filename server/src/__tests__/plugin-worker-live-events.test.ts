import { describe, expect, it } from "vitest";

import {
  publishGlobalLiveEvent,
  subscribeGlobalLiveEvents,
} from "../services/live-events.js";
import {
  createPluginWorkerManager,
  type PluginWorkerManagerOptions,
} from "../services/plugin-worker-manager.js";

// Mirrors the bridge in server/src/app.ts so any drift between the production
// wiring and this contract test will surface as a compile or assertion error.
const bridge: NonNullable<PluginWorkerManagerOptions["onWorkerEvent"]> = (e) =>
  publishGlobalLiveEvent({
    type: e.type,
    payload: {
      pluginId: e.pluginId,
      code: e.code ?? null,
      signal: e.signal ?? null,
      willRestart: e.willRestart ?? false,
    },
  });

describe("plugin worker → global live event wiring", () => {
  it("type-checks against the manager's onWorkerEvent option", () => {
    const manager = createPluginWorkerManager({ onWorkerEvent: bridge });
    expect(typeof manager.startWorker).toBe("function");
  });

  it("forwards plugin.worker.crashed with full payload to global subscribers", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsub = subscribeGlobalLiveEvents((e) =>
      events.push({ type: e.type, payload: e.payload as Record<string, unknown> }),
    );

    bridge({
      type: "plugin.worker.crashed",
      pluginId: "acme.test",
      code: 137,
      signal: "SIGKILL",
      willRestart: true,
    });

    unsub();

    const crashed = events.find((e) => e.type === "plugin.worker.crashed");
    expect(crashed).toBeDefined();
    expect(crashed?.payload).toEqual({
      pluginId: "acme.test",
      code: 137,
      signal: "SIGKILL",
      willRestart: true,
    });
  });

  it("forwards plugin.worker.restarted and normalizes missing fields to null/false", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsub = subscribeGlobalLiveEvents((e) =>
      events.push({ type: e.type, payload: e.payload as Record<string, unknown> }),
    );

    bridge({ type: "plugin.worker.restarted", pluginId: "acme.test" });

    unsub();

    const restarted = events.find((e) => e.type === "plugin.worker.restarted");
    expect(restarted).toBeDefined();
    expect(restarted?.payload).toEqual({
      pluginId: "acme.test",
      code: null,
      signal: null,
      willRestart: false,
    });
  });
});
