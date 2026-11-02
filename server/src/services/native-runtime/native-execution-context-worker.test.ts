import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import { createPluginWorkerManager } from "../plugin-worker-manager.js";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { NativeExecutionContext } from "./native-execution-context.js";

const execution = { binding: { companyId: "company", agentId: "agent", runId: "run" } } as NativeExecutionInput;
const manifest: PaperclipPluginManifestV1 = {
  id: "test.execution-context", apiVersion: 1, version: "1.0.0", displayName: "Execution context fixture",
  description: "Execution context fixture", author: "Paperclip", categories: ["automation"], capabilities: [],
  entrypoints: { worker: "worker.cjs" },
};
const params = {
  companyId: "company", agentId: "agent", runId: "run", environmentId: "environment", issueId: "issue",
  driverKey: "tasks", taskId: "task", config: {}, projectIds: [],
  lease: { providerLeaseId: "task" }, operation: { kind: "describe" as const },
};

let directory: string;
let entrypointPath: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "paperclip-startup-worker-"));
  entrypointPath = path.join(directory, "worker.cjs");
  await writeFile(entrypointPath, `
const readline = require("node:readline");
const held = [];
const invocations = [];
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\\n");
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, {ok:true,supportedMethods:["environmentTask","configChanged","health"]});
  else if (message.method === "environmentTask" || message.method === "environmentDestroyLease") {
    held.push(message.id);
    invocations.push(message.paperclipInvocation?.id);
    if (message.params.config.hostWrite) process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:"host-"+message.id,method:"companies.get",params:{companyId:"company"},paperclipInvocationId:message.paperclipInvocation.id})+"\\n");
    if (message.params.config.replyEarly) { held.splice(held.indexOf(message.id),1); send(message.id,{kind:"description",taskId:"task"}); }
  }
  else if (message.method === "health") send(message.id, {status:"ok",details:{pending:held.length}});
  else if (message.method === "configChanged") {
    if (message.params.config.exit) process.exit(1);
    if (message.params.config.hostAfter) process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:"late-host",method:"companies.get",params:{companyId:"company"},paperclipInvocationId:invocations.at(-1)})+"\\n");
    if (message.params.config.release) for (const id of held.splice(0)) send(id, {kind:"description",taskId:"task"});
    send(message.id, {});
  } else if (message.method === "shutdown") {send(message.id, {});setImmediate(()=>process.exit(0));}
});
`, { mode: 0o600 });
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function startWorker(hostHandlers: Record<string, unknown> = {}) {
  const manager = createPluginWorkerManager();
  await manager.startWorker(manifest.id, { entrypointPath, manifest, config: {},
    instanceInfo: { instanceId: "instance", hostVersion: "1.0.0" }, apiVersion: 1, hostHandlers: hostHandlers as never, autoRestart: false });
  return manager;
}

describe("Core startup responsibility across real worker IPC", () => {
  it.each(["stop", "replace", "stopAll"])("keeps stopped startup work reachable through %s until verified retirement", async mode => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const manager = await startWorker({ "companies.get": async () => { entered(); await gate; return {}; } });
    const original = manager.getWorker(manifest.id)!, settled = vi.fn();
    try {
      const request = manager.call(manifest.id, "environmentTask", { ...params, config: { hostWrite: true } }, 50, undefined, settled, "stopped-context");
      const rejected = expect(request).rejects.toThrow("timed out");
      await started; await rejected;
      if (mode === "stop") await manager.stopWorker(manifest.id);
      else if (mode === "replace") await original.stop();
      else await manager.stopAll();
      if (mode !== "stopAll") await manager.startWorker(manifest.id, { entrypointPath, manifest, config: {},
        instanceInfo: { instanceId: "replacement", hostVersion: "1.0.0" }, apiVersion: 1, hostHandlers: {} });
      let drained = false, retired = false;
      const draining = manager.drainStartup!("stopped-context").then(() => { drained = true; });
      const retiring = manager.retireStartup!("stopped-context").then(() => { retired = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
      expect(retired).toBe(false);
      expect(settled).not.toHaveBeenCalled();
      release(); await Promise.all([draining, retiring]);
      expect(settled).toHaveBeenCalledOnce();
      const oldDrain = vi.spyOn(original, "drainStartup");
      await manager.drainStartup!("stopped-context");
      expect(oldDrain).not.toHaveBeenCalled();
    } finally { release(); await manager.stopAll(); }
  });

  it("prunes a stopped handle after its last accepted startup host call settles", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const manager = await startWorker({ "companies.get": async () => { entered(); await gate; return {}; } });
    const original = manager.getWorker(manifest.id)!, settled = vi.fn();
    try {
      const request = manager.call(manifest.id, "environmentTask", { ...params, config: { hostWrite: true, replyEarly: true } }, 5_000, undefined, settled, "host-only-context");
      await started; await request;
      expect(settled).toHaveBeenCalledOnce();
      await manager.stopWorker(manifest.id);
      let drained = false;
      const draining = manager.drainStartup!("host-only-context").then(() => { drained = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
      release(); await draining;
      const oldDrain = vi.spyOn(original, "drainStartup");
      await manager.drainStartup!("host-only-context");
      expect(oldDrain).not.toHaveBeenCalled();
    } finally { release(); await manager.stopAll(); }
  });

  it("keeps a stopped handle owned after bounded retirement fails and permits verified retry", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const manager = await startWorker({ "companies.get": async () => { entered(); await gate; return {}; } }), settled = vi.fn();
    try {
      const request = manager.call(manifest.id, "environmentTask", { ...params, config: { hostWrite: true } }, 50, undefined, settled, "stopped-retry");
      const rejected = expect(request).rejects.toThrow("timed out");
      await started; await rejected;
      await manager.stopWorker(manifest.id);
      vi.useFakeTimers();
      const failed = manager.retireStartup!("stopped-retry").catch(error => error.message);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await failed).toBe("Task cleanup is still pending");
      expect(settled).not.toHaveBeenCalled();
      vi.useRealTimers();
      let retired = false;
      const retry = manager.retireStartup!("stopped-retry").then(() => { retired = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(retired).toBe(false);
      release(); await retry;
      expect(settled).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); release(); await manager.stopAll(); }
  });

  it.each(["stop", "stopAll"])("preserves a replacement registered while %s is finishing", async mode => {
    const manager = await startWorker(), original = manager.getWorker(manifest.id)!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), stopped = new Promise<void>(resolve => { entered = resolve; });
    const stop = original.stop.bind(original);
    let replacement: Awaited<ReturnType<typeof manager.startWorker>> | undefined;
    vi.spyOn(original, "stop").mockImplementation(async () => { await stop(); entered(); await gate; });
    try {
      const stopping = mode === "stop" ? manager.stopWorker(manifest.id) : manager.stopAll();
      await stopped;
      replacement = await manager.startWorker(manifest.id, { entrypointPath, manifest, config: {},
        instanceInfo: { instanceId: "replacement", hostVersion: "1.0.0" }, apiVersion: 1, hostHandlers: {} });
      release(); await stopping;
      expect(manager.getWorker(manifest.id)).toBe(replacement);
      expect(await manager.call(manifest.id, "health", {})).toMatchObject({ status: "ok" });
    } finally { release(); await replacement?.stop(); await manager.stopAll(); }
  });

  it("refuses new calls while the same startup group retires and joins concurrent retirement", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const write = vi.fn(async () => { entered(); await gate; return {}; });
    const handlers = createHostClientHandlers({ pluginId: manifest.id, capabilities: ["companies.read"], services: { companies: { get: write } } as never });
    const manager = await startWorker(handlers), firstSettled = vi.fn(), secondSettled = vi.fn();
    try {
      const request = manager.call(manifest.id, "environmentTask", { ...params, config: { hostWrite: true } }, 5_000, undefined, firstSettled, "retiring-context");
      void request.catch(() => undefined);
      await started;
      let retired = false;
      const retiring = manager.retireStartup!("retiring-context").then(() => { retired = true; });
      const joined = manager.retireStartup!("retiring-context");
      await expect(manager.call(manifest.id, "environmentTask", { ...params, config: { hostWrite: true } }, 100, undefined, secondSettled, "retiring-context"))
        .rejects.toThrow("retiring");
      expect(write).toHaveBeenCalledOnce();
      expect(firstSettled).not.toHaveBeenCalled();
      expect(secondSettled).toHaveBeenCalledOnce();
      expect(retired).toBe(false);
      expect(await manager.call(manifest.id, "health", {})).toMatchObject({ status: "ok" });
      release(); await Promise.all([retiring, joined]);
      expect(firstSettled).toHaveBeenCalledOnce();
      await manager.call(manifest.id, "configChanged", { companyId: "company", config: { release: true } });
      await request;
      expect(firstSettled).toHaveBeenCalledOnce();
    } finally { release(); await manager.stopAll(); }
  });

  it("revokes a cleanup invocation created after the initial drain and waits for its accepted host handler", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const write = vi.fn(async () => { entered(); await gate; return {}; });
    const handlers = createHostClientHandlers({ pluginId: manifest.id, capabilities: ["companies.read"], services: { companies: { get: write } } as never });
    const manager = await startWorker(handlers), settled = vi.fn();
    try {
      await manager.drainStartup!("cleanup-context");
      const request = manager.call(manifest.id, "environmentDestroyLease", { companyId: "company", environmentId: "environment", issueId: "issue", driverKey: "tasks",
        config: { hostWrite: true }, providerLeaseId: "task", leaseMetadata: { runnerTaskStartupCleanup: { contextId: "cleanup-context", requiresPreparationStop: true } } },
        5_000, undefined, settled);
      await started;
      let retired = false;
      const retiring = manager.retireStartup!("cleanup-context").then(() => { retired = true; });
      await manager.call(manifest.id, "configChanged", { companyId: "company", config: { hostAfter: true } });
      expect(write).toHaveBeenCalledOnce();
      expect(retired).toBe(false);
      release(); await retiring;
      expect(settled).toHaveBeenCalledOnce();
      await manager.call(manifest.id, "configChanged", { companyId: "company", config: { release: true } });
      await request;
      expect(settled).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
    } finally { release(); await manager.stopAll(); }
  });
  it("bounds the cleanup wait without discarding an accepted host handler", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const manager = await startWorker({ "companies.get": async () => { entered(); await gate; return {}; } }), settled = vi.fn();
    try {
      const request = manager.call(manifest.id, "environmentTask", { ...params, config: { hostWrite: true } }, 100, undefined, settled, "bounded-context");
      const rejected = expect(request).rejects.toThrow("timed out");
      await started; await rejected;
      vi.useFakeTimers();
      const waiting = manager.retireStartup!("bounded-context");
      const pending = expect(waiting).rejects.toThrow("cleanup is still pending");
      await vi.advanceTimersByTimeAsync(15_000); await pending;
      expect(settled).not.toHaveBeenCalled();
      vi.useRealTimers();
      const retried = vi.fn();
      const retry = manager.call(manifest.id, "environmentTask", params, 5_000, undefined, retried, "bounded-context");
      void retry.catch(() => undefined);
      expect(await manager.call(manifest.id, "health", {})).toMatchObject({ details: { pending: 2 } });
      expect(retried).not.toHaveBeenCalled();
      release();
      await manager.drainStartup!("bounded-context");
      await manager.retireStartup!("bounded-context");
      expect(settled).toHaveBeenCalledOnce();
      expect(retried).toHaveBeenCalledOnce();
      await manager.call(manifest.id, "configChanged", { companyId: "company", config: { release: true } });
      await retry;
    } finally { vi.useRealTimers(); release(); await manager.stopAll(); }
  });
  it.each(["startup", "cleanup"])("drains accepted %s host writes before retiring only verified bookkeeping", async mode => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const manager = await startWorker({ "companies.get": async () => { entered(); await gate; return {}; } });
    const verified = vi.fn(), unrelated = vi.fn();
    try {
      const request = mode === "startup"
        ? manager.call(manifest.id, "environmentTask", { ...params, config: { hostWrite: true } }, 100, undefined, verified, "verified-context")
        : manager.call(manifest.id, "environmentDestroyLease", { companyId: "company", environmentId: "environment", issueId: "issue", driverKey: "tasks",
          config: { hostWrite: true }, providerLeaseId: "task", leaseMetadata: { runnerTaskStartupCleanup: { contextId: "verified-context", requiresPreparationStop: true } } },
          100, undefined, verified);
      const rejected = expect(request).rejects.toThrow("timed out");
      await started;
      await rejected;
      await expect(manager.call(manifest.id, "environmentTask", params, 10, undefined, unrelated, "other-context")).rejects.toThrow("timed out");
      let drained = false;
      const drain = manager.drainStartup!("verified-context").then(() => { drained = true; });
      await manager.call(manifest.id, "health", {});
      expect(drained).toBe(false);
      expect(verified).not.toHaveBeenCalled();
      release(); await drain;
      expect(verified).not.toHaveBeenCalled();
      await manager.retireStartup!("verified-context");
      expect(verified).toHaveBeenCalledOnce();
      expect(unrelated).not.toHaveBeenCalled();
      await manager.call(manifest.id, "configChanged", { companyId: "company", config: { release: true } });
      expect(verified).toHaveBeenCalledOnce();
      expect(unrelated).toHaveBeenCalledOnce();
    } finally { release(); await manager.stopAll(); }
  });

  it("can retire a verified startup after worker death without declaring unrelated work settled", async () => {
    const manager = await startWorker(), verified = vi.fn(), unrelated = vi.fn();
    try {
      await expect(manager.call(manifest.id, "environmentTask", params, 10, undefined, verified, "verified-context")).rejects.toThrow("timed out");
      await expect(manager.call(manifest.id, "environmentTask", params, 10, undefined, unrelated, "other-context")).rejects.toThrow("timed out");
      await expect(manager.call(manifest.id, "configChanged", { companyId: "company", config: { exit: true } })).rejects.toThrow("exited");
      expect(verified).not.toHaveBeenCalled();
      await manager.drainStartup!("verified-context");
      await manager.retireStartup!("verified-context");
      expect(verified).toHaveBeenCalledOnce();
      expect(unrelated).not.toHaveBeenCalled();
    } finally { await manager.stopAll(); }
  });
  it("keeps a timed-out caller pending until the actual late worker reply", async () => {
    const manager = await startWorker();
    const context = new NativeExecutionContext(execution, 5_000);
    const settled = vi.fn(context.trackWorker());
    try {
      await expect(manager.call(manifest.id, "environmentTask", params, 10, undefined, settled)).rejects.toThrow("timed out");
      expect(context.pending).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      context.abort(new Error("Stop requested"));
      let drained = false;
      const drain = context.drain().then(result => { drained = true; return result; });
      expect(await manager.call(manifest.id, "health", {})).toMatchObject({ details: { pending: 1 } });
      expect(drained).toBe(false);
      await manager.call(manifest.id, "configChanged", { companyId: "company", config: { release: true } });
      expect(await drain).toBe(true);
      expect(context.pending).toBe(false);
      expect(settled).toHaveBeenCalledOnce();
      expect(() => context.assertOpen()).toThrow("Stop requested");
    } finally { context.finish(); await manager.stopAll(); }
  });

  it("does not treat the startup deadline as a worker completion receipt", async () => {
    const manager = await startWorker();
    const context = new NativeExecutionContext(execution, 100);
    const settled = vi.fn(context.trackWorker());
    try {
      await expect(manager.call(manifest.id, "environmentTask", params, 10, undefined, settled)).rejects.toThrow("timed out");
      if (!context.signal.aborted) await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      expect(await context.drain()).toBe(false);
      expect(context.pending).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      expect(await manager.call(manifest.id, "health", {})).toMatchObject({ details: { pending: 1 } });
      await manager.call(manifest.id, "configChanged", { companyId: "company", config: { release: true } });
      expect(settled).toHaveBeenCalledOnce();
      expect(context.pending).toBe(false);
      expect(await context.drain()).toBe(true);
      expect(() => context.assertOpen()).toThrow("startup_expired");
    } finally { context.finish(); await manager.stopAll(); }
  });
});
