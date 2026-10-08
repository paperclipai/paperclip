import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { startTaskDrain, stopTaskDrain } from "../services/task-admission.js";

const manifest = { id: "test.idle", apiVersion: 1 as const, version: "1.0.0", displayName: "Idle fixture",
  description: "Idle fixture", author: "Paperclip", categories: ["automation" as const], capabilities: [], entrypoints: { worker: "worker.cjs" } };
function worker(write = false, hostHandler = async () => undefined) {
  return createPluginWorkerHandle("test.idle", {
    entrypointPath: fileURLToPath(new URL("./fixtures/plugin-worker-idle.cjs", import.meta.url)),
    execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
    manifest, config: {}, instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" }, apiVersion: 1,
    env: { IDLE_TEST_WRITE: write ? "1" : "0" }, hostHandlers: { "state.set": hostHandler },
  });
}
function hold() {
  const lease = startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
  return { ownerId: lease.ownerId!, expiresAt: lease.expiresAt!.getTime() };
}

describe("plugin manager idle receipts", () => {
  afterEach(() => stopTaskDrain());
  it("retains timed-out worker operations and admits work after the owned hold releases", async () => {
    const handle = worker();
    await handle.start();
    try {
      await expect(handle.call("environmentProbe", { driverKey: "fixture", companyId: "fixture", environmentId: "fixture", config: { delayMs: 200 } }, 10)).rejects.toThrow("timed out");
      const lease = hold();
      expect(await handle.prepareIdleSleep!(lease)).toBe("present");
      await expect.poll(() => handle.prepareIdleSleep!(lease)).toBe("none");
      await expect(handle.call("health", {})).rejects.toThrow("held");
      expect(await handle.prepareIdleSleep!({ ...lease, ownerId: "stale" })).toBe("unknown");
      stopTaskDrain(); handle.releaseIdleSleep!();
      expect(await handle.call("health", {})).toMatchObject({ status: "ok" });
    } finally { stopTaskDrain(); await handle.stop(); }
  });

  it("keeps a host write counted after the caller stops waiting", async () => {
    let finish!: () => void;
    const handle = worker(true, () => new Promise<void>((resolve) => { finish = resolve; }));
    await handle.start();
    try {
      await expect(handle.call("health", {}, 30)).rejects.toThrow("timed out");
      const lease = hold();
      expect(await handle.prepareIdleSleep!(lease)).toBe("present");
      finish();
      await expect.poll(() => handle.prepareIdleSleep!(lease)).toBe("none");
    } finally { stopTaskDrain(); await handle.stop(); }
  });
});
