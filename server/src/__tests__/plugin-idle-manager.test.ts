import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
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
    env: { IDLE_TEST_WRITE: write ? "1" : "0" },
    hostHandlers: { "state.set": hostHandler, "events.subscribe": async () => ({}) },
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
      expect(await handle.prepareIdleSleep!(hold())).toBe("none");
      stopTaskDrain();
      // No intervening request or explicit worker release: the next controller
      // attempt must discard the worker manager's previous ownership record.
      expect(await handle.prepareIdleSleep!(hold())).toBe("none");
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

  it("lets a queued notification finish its write while idle preparation is in flight", async () => {
    let finish!: () => void;
    let writes = 0;
    const handle = worker(false, () => new Promise<void>((resolve) => {
      writes++;
      finish = resolve;
    }));
    await handle.start();
    try {
      // Finish setup and its subscription receipt before queuing the event.
      await handle.call("health", {});
      handle.notify("onEvent", { event: { eventType: "fixture.write" } });
      // No await: the host has set its hold before it can read the event's
      // worker-to-host write. The worker must still be allowed to complete it.
      const lease = hold();
      const preparation = handle.prepareIdleSleep!(lease);
      expect(await preparation).not.toBe("none");
      await expect.poll(() => writes).toBe(1);
      expect(await handle.prepareIdleSleep!(lease)).toBe("present");
      finish();
      await expect.poll(() => handle.prepareIdleSleep!(lease)).toBe("none");
    } finally { finish?.(); stopTaskDrain(); await handle.stop(); }
  });

  it("resumes crash recovery after an idle hold without discarding the restart", async () => {
    const handle = worker();
    await handle.start();
    handle.on("crash", () => { hold(); });
    try {
      await expect(handle.call("environmentProbe", { driverKey: "fixture", companyId: "fixture", environmentId: "fixture", config: { crash: true } })).rejects.toThrow();
      await delay(1_600);
      expect(handle.status).toBe("backoff");
      expect(handle.diagnostics().nextRestartAt).not.toBeNull();
      stopTaskDrain();
      await expect.poll(() => handle.status, { timeout: 5_000 }).toBe("running");
      // Recovery restores service, but lost completion receipts remain unsafe.
      expect(await handle.prepareIdleSleep!(hold())).toBe("unknown");
    } finally { stopTaskDrain(); await handle.stop(); }
  });
});
