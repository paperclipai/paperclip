import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import {
  createPluginWorkerManager,
  type PluginWorkerHandle,
  type PluginWorkerManager,
} from "../services/plugin-worker-manager.js";

const GATED_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plugin-worker-gated.cjs");
const MANIFEST: PaperclipPluginManifestV1 = {
  id: "gated.plugin", apiVersion: 1, version: "1.0.0", displayName: "Gated", description: "Gated",
  author: "Paperclip", categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" },
};

type GateEvent = { event: string; pid: number };

async function createGate() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-gate-"));
  const socketPath = path.join(dir, "gate.sock");
  const sockets: net.Socket[] = [];
  const events: GateEvent[] = [];
  const waiters: Array<{ match: (e: GateEvent) => boolean; resolve: (e: GateEvent) => void }> = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    const lines = readline.createInterface({ input: socket });
    lines.on("error", () => undefined);
    lines.on("line", (line) => {
      const event = JSON.parse(line) as GateEvent;
      events.push(event);
      for (const waiter of [...waiters]) {
        if (waiter.match(event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    events,
    next(name: string, seen = 0) {
      const existing = events.filter((e) => e.event === name)[seen];
      if (existing) return Promise.resolve(existing);
      return new Promise<GateEvent>((resolve) => {
        let count = events.filter((e) => e.event === name).length;
        waiters.push({ match: (e) => e.event === name && count++ === seen, resolve });
      });
    },
    release(name: string) {
      for (const socket of sockets) if (!socket.destroyed) socket.write(`${JSON.stringify({ release: name })}\n`);
    },
    crash() {
      for (const socket of sockets) if (!socket.destroyed) socket.write(`${JSON.stringify({ crash: true })}\n`);
    },
    spawned() {
      return events.filter((e) => e.event === "spawned").length;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function startOptions(socketPath: string, hold: string, extraEnv: Record<string, string> = {}) {
  return {
    entrypointPath: GATED_WORKER, manifest: MANIFEST, config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" }, apiVersion: 1, hostHandlers: {},
    env: { GATE_SOCKET: socketPath, GATE_HOLD: hold, ...extraEnv },
  };
}

function nextEvent(handle: PluginWorkerHandle, name: "crash" | "ready" | "exit") {
  return new Promise<void>((resolve) => {
    const listener = () => {
      handle.off(name, listener);
      resolve();
    };
    handle.on(name, listener);
  });
}

describe("plugin worker stop finality", () => {
  let manager: PluginWorkerManager | null = null;
  let closeGate: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await manager?.stopAll();
    await closeGate?.();
    manager = null;
    closeGate = null;
  });

  it("N6: a stop issued while initialize is in flight wins over a late initialize reply", async () => {
    const gate = await createGate();
    closeGate = gate.close;
    manager = createPluginWorkerManager();
    const starting = manager.startWorker("gated.plugin", startOptions(gate.socketPath, "initialize,shutdown"));
    const startResult = starting.then(() => "resolved", () => "rejected");
    await gate.next("initialize-received");
    const handle = manager.getWorker("gated.plugin")!;
    expect(handle.status).toBe("starting");
    const readyAfterStop: unknown[] = [];
    handle.on("ready", (payload) => readyAfterStop.push(payload));

    const stopping = manager.stopWorker("gated.plugin");
    await gate.next("shutdown-received");
    gate.release("initialize");
    await gate.next("initialize-replied");
    gate.release("shutdown");
    await stopping;

    expect(await startResult).toBe("rejected");
    expect(readyAfterStop).toEqual([]);
    expect(handle.status).toBe("stopped");
    expect(manager.getWorker("gated.plugin")).toBeUndefined();
  });

  it("N6: a stop that wins before initialize leaves the handle stopped, not crashed", async () => {
    const gate = await createGate();
    closeGate = gate.close;
    manager = createPluginWorkerManager();
    const starting = manager.startWorker("gated.plugin", startOptions(gate.socketPath, "initialize"));
    const startResult = starting.then(() => "resolved", () => "rejected");
    await gate.next("initialize-received");
    const handle = manager.getWorker("gated.plugin")!;
    const crashes: unknown[] = [];
    handle.on("crash", (payload) => crashes.push(payload));

    await manager.stopWorker("gated.plugin");

    expect(await startResult).toBe("rejected");
    expect(handle.status).toBe("stopped");
    expect(crashes).toEqual([]);
    expect(manager.getWorker("gated.plugin")).toBeUndefined();
  });

  it("revoked starts cannot spawn until allowed again", async () => {
    const gate = await createGate();
    closeGate = gate.close;
    manager = createPluginWorkerManager();
    manager.revokeStarts!("gated.plugin");
    await expect(manager.startWorker("gated.plugin", startOptions(gate.socketPath, ""))).rejects.toThrow("revoked");
    expect(gate.events).toEqual([]);
    manager.allowStarts!("gated.plugin");
    const handle = await manager.startWorker("gated.plugin", startOptions(gate.socketPath, ""));
    expect(handle.status).toBe("running");
  });

  async function startThenCrash(hold: string) {
    const gate = await createGate();
    closeGate = gate.close;
    manager = createPluginWorkerManager();
    const starting = manager.startWorker("gated.plugin", startOptions(gate.socketPath, hold));
    if (hold.includes("initialize")) {
      await gate.next("initialize-received");
      gate.release("initialize");
    }
    const handle = await starting;
    const crashed = nextEvent(handle, "crash");
    gate.crash();
    await crashed;
    return { gate, handle, manager };
  }

  it("a stop that joins a restart's stop phase prevents the restart from starting", async () => {
    const gate = await createGate();
    closeGate = gate.close;
    manager = createPluginWorkerManager();
    const handle = await manager.startWorker("gated.plugin", startOptions(gate.socketPath, "shutdown"));

    const restarting = handle.restart().then(() => "resolved", () => "rejected");
    await gate.next("shutdown-received");
    const stopping = manager.stopWorker("gated.plugin");
    gate.release("shutdown");
    await stopping;

    expect(await restarting).toBe("rejected");
    expect(handle.status).toBe("stopped");
    expect(manager.getWorker("gated.plugin")).toBeUndefined();
    expect(gate.spawned()).toBe(1);
  });

  it("N7e: normal crash recovery still restarts the worker", async () => {
    const { gate, handle } = await startThenCrash("");
    expect(handle.status).toBe("backoff");
    await nextEvent(handle, "ready");
    expect(handle.status).toBe("running");
    expect(gate.spawned()).toBe(2);
  });

  it("N7: a stop joins an in-flight crash retry and no retry follows", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = await createGate();
    closeGate = gate.close;
    manager = createPluginWorkerManager();
    const starting = manager.startWorker("gated.plugin", startOptions(gate.socketPath, "initialize,shutdown"));
    await gate.next("initialize-received");
    gate.release("initialize");
    const handle = await starting;
    const crashed = nextEvent(handle, "crash");
    gate.crash();
    await crashed;
    await vi.advanceTimersByTimeAsync(2_000);
    await gate.next("initialize-received", 1);
    expect(handle.status).toBe("starting");
    const ready: unknown[] = [];
    handle.on("ready", (payload) => ready.push(payload));

    const stopping = manager.stopWorker("gated.plugin");
    await gate.next("shutdown-received");
    gate.release("initialize");
    await gate.next("initialize-replied", 1);
    gate.release("shutdown");
    await stopping;

    expect(ready).toEqual([]);
    expect(handle.status).toBe("stopped");
    expect(handle.diagnostics().nextRestartAt).toBeNull();
    expect(manager.getWorker("gated.plugin")).toBeUndefined();
    expect(gate.spawned()).toBe(2);
  });

  it("N7b: revoking starts cancels a pending backoff retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { gate, handle, manager: workers } = await startThenCrash("");
    expect(handle.status).toBe("backoff");

    workers.revokeStarts!("gated.plugin");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(handle.status).toBe("crashed");
    expect(gate.spawned()).toBe(1);
    await workers.stopWorker("gated.plugin");
    expect(workers.getWorker("gated.plugin")).toBeUndefined();
  });

  it("N7c: revoking starts kills an in-flight retry instead of publishing running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { gate, handle, manager: workers } = await startThenCrash("initialize");
    await vi.advanceTimersByTimeAsync(2_000);
    await gate.next("initialize-received", 1);
    expect(handle.status).toBe("starting");
    const ready: unknown[] = [];
    handle.on("ready", (payload) => ready.push(payload));

    workers.revokeStarts!("gated.plugin");
    const exited = nextEvent(handle, "exit");
    gate.release("initialize");
    await gate.next("initialize-replied", 1);
    await exited;

    expect(ready).toEqual([]);
    expect(handle.status).not.toBe("running");
    expect(gate.spawned()).toBe(2);
    await workers.stopWorker("gated.plugin");
    expect(workers.getWorker("gated.plugin")).toBeUndefined();
  });

  it("N7d: loader teardown stops a backoff worker and reports a scheduler failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { gate, handle, manager: workers } = await startThenCrash("");
    expect(handle.status).toBe("backoff");
    const calls: string[] = [];
    const schedulerError = new Error("scheduler unavailable");
    const runtime = {
      workerManager: workers,
      jobScheduler: { unregisterPlugin: async () => { calls.push("scheduler"); throw schedulerError; } },
      eventBus: { clearPlugin: () => { calls.push("events"); } },
      toolDispatcher: { unregisterPluginTools: () => { calls.push("tools"); } },
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    } as unknown as PluginRuntimeServices;
    const loader = pluginLoader({} as never, {}, runtime);

    const unload = loader.unloadSingle("gated.plugin", "gated.plugin").then(() => null, (err: unknown) => err);
    const failure = await unload;

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([schedulerError]);
    expect(calls).toEqual(["scheduler", "events", "tools"]);
    expect(workers.getWorker("gated.plugin")).toBeUndefined();
    expect(handle.status).toBe("stopped");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gate.spawned()).toBe(1);
  });

  it("N13: a worker that survives SIGKILL keeps its registration and cannot be called", async () => {
    const gate = await createGate();
    closeGate = gate.close;
    manager = createPluginWorkerManager();
    const handle = await manager.startWorker(
      "gated.plugin",
      startOptions(gate.socketPath, "shutdown", { GATE_IGNORE_SIGTERM: "1" }),
    );
    const pid = handle.diagnostics().pid!;
    const realKill = ChildProcess.prototype.kill;
    vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal) {
      return signal === "SIGKILL" ? true : realKill.call(this, signal);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const stopping = manager.stopWorker("gated.plugin").then(() => null, (err: unknown) => err);
    await gate.next("shutdown-received");
    await vi.advanceTimersByTimeAsync(20_000);
    const failure = await stopping;

    expect((failure as Error | null)?.name).toBe("PluginWorkerStopError");
    expect(manager.getWorker("gated.plugin")).toBe(handle);
    expect(manager.isRunning("gated.plugin")).toBe(false);
    await expect(handle.call("getData", {} as never)).rejects.toThrow();

    vi.useRealTimers();
    vi.restoreAllMocks();
    const exited = nextEvent(handle, "exit");
    process.kill(pid, "SIGKILL");
    await exited;
    await manager.stopWorker("gated.plugin");
    expect(manager.getWorker("gated.plugin")).toBeUndefined();
  });
});
