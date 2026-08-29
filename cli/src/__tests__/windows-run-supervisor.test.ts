import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireWindowsRunSupervisorLock,
  createIdempotentShutdown,
  supervisedRunChildArgs,
  stopWindowsServerChild,
  WindowsRunSupervisor,
  type WindowsRunHealth,
} from "../commands/windows-run-supervisor.js";

class FakeChild extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  constructor(readonly pid: number) { super(); }
  kill() { this.killed = true; this.signalCode = "SIGTERM"; this.emit("exit", null, "SIGTERM"); return true; }
}

let temporaryHome: string | undefined;
let previousHome: string | undefined;

afterEach(() => {
  if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousHome;
  if (temporaryHome) fs.rmSync(temporaryHome, { recursive: true, force: true });
  temporaryHome = undefined;
  previousHome = undefined;
});

function healthy(databaseBackupStatus: string | null = "ok"): WindowsRunHealth {
  return { listenerOk: true, databaseBackupOk: databaseBackupStatus === "ok", databaseBackupStatus };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  return address.port;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for test condition");
}

describe("Windows foreground run supervision", () => {
  it("replaces a real node process whose HTTP listener closes while the process stays alive", async () => {
    const port = await freePort();
    const script = [
      "const http = require('node:http');",
      "const server = http.createServer((req, res) => {",
      "  if (req.url === '/drop') { res.end('dropping'); setTimeout(() => server.close(), 0); return; }",
      "  res.end('ok');",
      "});",
      "server.listen(Number(process.argv[1]), '127.0.0.1');",
      "setInterval(() => {}, 1_000);",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join("\n");
    const children: ReturnType<typeof spawn>[] = [];
    const probe = async (): Promise<WindowsRunHealth> => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        return { listenerOk: response.ok, databaseBackupOk: response.ok, databaseBackupStatus: "ok" };
      } catch {
        return { listenerOk: false, databaseBackupOk: false, databaseBackupStatus: null };
      }
    };
    const supervisor = new WindowsRunSupervisor({
      instanceId: "default",
      failureThreshold: 1,
      startChild: () => {
        const child = spawn(process.execPath, ["-e", script, String(port)], { stdio: "ignore" });
        children.push(child);
        return child;
      },
      stopChild: async (child) => {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
        });
      },
      probeHealth: async () => probe(),
      log: () => undefined,
    });

    try {
      supervisor.start();
      await waitFor(async () => (await probe()).listenerOk);
      await supervisor.tick();
      const firstPid = supervisor.childPid;
      await fetch(`http://127.0.0.1:${port}/drop`);
      await waitFor(async () => !(await probe()).listenerOk);
      expect(children[0]!.exitCode).toBeNull();

      await supervisor.tick();
      expect(supervisor.childPid).not.toBe(firstPid);
      await waitFor(async () => (await probe()).listenerOk);
    } finally {
      await supervisor.stop();
    }
  }, 15_000);

  it("restarts a live node child after its listener disappears", async () => {
    const children = [new FakeChild(101), new FakeChild(202)];
    const logs: string[] = [];
    let nextChild = 0;
    let probeCount = 0;
    const supervisor = new WindowsRunSupervisor({
      instanceId: "default",
      startChild: () => children[nextChild++]!,
      stopChild: async (child) => { child.kill("SIGTERM"); },
      log: (message) => logs.push(message),
      probeHealth: async () => {
        probeCount += 1;
        // The first node process remains alive, but its listener is gone.
        return probeCount === 1 ? healthy() : { listenerOk: false, databaseBackupOk: false, databaseBackupStatus: null };
      },
    });

    supervisor.start();
    await supervisor.tick();
    await supervisor.tick();
    await supervisor.tick();
    await supervisor.tick();

    expect(children[0]!.killed).toBe(true);
    expect(supervisor.childPid).toBe(202);
    expect(logs).toContainEqual(expect.stringContaining("reason=listener_loss oldPid=101"));
  });

  it("allows a bounded startup window before treating a missing listener as a fault", async () => {
    const child = new FakeChild(101);
    const supervisor = new WindowsRunSupervisor({
      instanceId: "default",
      failureThreshold: 1,
      startupGraceMs: 60_000,
      now: () => 1_000,
      startChild: () => child,
      stopChild: async () => undefined,
      probeHealth: async () => ({ listenerOk: false, databaseBackupOk: false, databaseBackupStatus: null }),
      log: () => undefined,
    });

    supervisor.start();
    await supervisor.tick();
    expect(child.killed).toBe(false);
  });

  it("serializes overlapping health ticks so an old probe cannot restart a replacement child", async () => {
    const child = new FakeChild(101);
    let probeCount = 0;
    let releaseProbe!: () => void;
    const pendingProbe = new Promise<WindowsRunHealth>((resolve) => { releaseProbe = () => resolve(healthy()); });
    const supervisor = new WindowsRunSupervisor({
      instanceId: "default",
      startChild: () => child,
      stopChild: async () => undefined,
      probeHealth: async () => { probeCount += 1; return pendingProbe; },
      log: () => undefined,
    });

    supervisor.start();
    const first = supervisor.tick();
    const second = supervisor.tick();
    expect(probeCount).toBe(1);
    releaseProbe();
    await Promise.all([first, second]);
    expect(supervisor.childPid).toBe(101);
  });

  it("uses an explicit run child invocation when onboarding calls runCommand programmatically", () => {
    const args = supervisedRunChildArgs({
      config: "C:/Paperclip/config.json",
      instance: "team-a",
      bind: "loopback",
      repair: false,
      force: true,
    });

    expect(args.slice(1)).toEqual([
      "run",
      "--config", "C:/Paperclip/config.json",
      "--instance", "team-a",
      "--bind", "loopback",
      "--no-repair",
      "--force",
      "--supervised-child",
    ]);
  });

  it("waits for an in-flight listener-loss restart before releasing shutdown ownership", async () => {
    const children = [new FakeChild(101), new FakeChild(202)];
    let nextChild = 0;
    let releaseStop!: () => void;
    const oldChildStop = new Promise<void>((resolve) => { releaseStop = resolve; });
    const supervisor = new WindowsRunSupervisor({
      instanceId: "default",
      failureThreshold: 1,
      startupGraceMs: 0,
      startChild: () => children[nextChild++]!,
      stopChild: async (child) => {
        if (child.pid === 101) {
          await oldChildStop;
          child.kill("SIGTERM");
          return;
        }
        child.kill("SIGTERM");
      },
      probeHealth: async () => ({ listenerOk: false, databaseBackupOk: false, databaseBackupStatus: null }),
      log: () => undefined,
    });

    supervisor.start();
    const restart = supervisor.tick();
    const shutdown = supervisor.stop();
    releaseStop();
    await Promise.all([restart, shutdown]);

    expect(nextChild).toBe(1);
    expect(supervisor.childPid).toBeNull();
    expect(children[0]!.killed).toBe(true);
  });

  it("coalesces repeated termination signals into one shutdown transaction", async () => {
    let calls = 0;
    let releaseShutdown!: () => void;
    const pendingShutdown = new Promise<void>((resolve) => { releaseShutdown = resolve; });
    const shutdown = createIdempotentShutdown(async () => {
      calls += 1;
      await pendingShutdown;
    });

    const firstSignal = shutdown();
    const repeatedSignal = shutdown();
    expect(repeatedSignal).toBe(firstSignal);
    expect(calls).toBe(1);

    releaseShutdown();
    await Promise.all([firstSignal, repeatedSignal]);
    expect(calls).toBe(1);
  });

  it("retains shutdown ownership after a failed stop and allows a later retry", async () => {
    let stopAttempts = 0;
    let releaseCalls = 0;
    const shutdown = createIdempotentShutdown(async () => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error("child process tree is still alive");
      releaseCalls += 1;
    });

    await expect(shutdown()).rejects.toThrow("child process tree is still alive");
    expect(releaseCalls).toBe(0);

    await expect(shutdown()).resolves.toBeUndefined();
    expect(stopAttempts).toBe(2);
    expect(releaseCalls).toBe(1);
  });

  it("retries a failed child stop without starting a second server", async () => {
    const children = [new FakeChild(101), new FakeChild(202)];
    let nextChild = 0;
    let stopAttempts = 0;
    const supervisor = new WindowsRunSupervisor({
      instanceId: "default",
      failureThreshold: 1,
      startupGraceMs: 0,
      startChild: () => children[nextChild++]!,
      stopChild: async (child) => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error("first stop timed out");
        child.kill("SIGTERM");
      },
      probeHealth: async () => ({ listenerOk: false, databaseBackupOk: false, databaseBackupStatus: null }),
      log: () => undefined,
    });

    supervisor.start();
    await supervisor.tick();
    expect(supervisor.childPid).toBe(101);
    expect(nextChild).toBe(1);
    await supervisor.tick();
    expect(supervisor.childPid).toBe(202);
  });

  it("uses the child IPC channel for ordered shutdown before force-killing the process tree", async () => {
    const child = new FakeChild(101);
    let message: unknown;
    child.send = (sent) => {
      message = sent;
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return true;
    };

    await stopWindowsServerChild(child);
    expect(message).toEqual({ type: "paperclip:graceful-shutdown" });
    expect(child.killed).toBe(false);
  });

  it("does not allow a second Windows supervisor for the same instance", () => {
    previousHome = process.env.PAPERCLIP_HOME;
    temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-windows-supervisor-"));
    process.env.PAPERCLIP_HOME = temporaryHome;
    const release = acquireWindowsRunSupervisorLock("default");
    expect(() => acquireWindowsRunSupervisorLock("default")).toThrow("already supervised");
    release();
    expect(() => acquireWindowsRunSupervisorLock("default")).not.toThrow();
  });

  it("reports recovery only after the replacement listener and backup health return", async () => {
    const children = [new FakeChild(101), new FakeChild(202)];
    const logs: string[] = [];
    let nextChild = 0;
    let probeCount = 0;
    const supervisor = new WindowsRunSupervisor({
      instanceId: "default",
      startChild: () => children[nextChild++]!,
      stopChild: async (child) => { child.kill("SIGTERM"); },
      log: (message) => logs.push(message),
      probeHealth: async () => {
        probeCount += 1;
        if (probeCount === 1 || probeCount >= 6) return healthy("ok");
        if (probeCount === 5) return healthy("stale");
        return { listenerOk: false, databaseBackupOk: false, databaseBackupStatus: null };
      },
    });

    supervisor.start();
    for (let index = 0; index < 6; index += 1) await supervisor.tick();

    expect(logs).toContainEqual(expect.stringContaining("database backup is not healthy"));
    expect(logs).toContainEqual(expect.stringContaining("oldPid=101 newPid=202 health=ok databaseBackup=ok"));
  });
});
