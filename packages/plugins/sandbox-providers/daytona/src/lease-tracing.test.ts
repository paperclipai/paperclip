import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOOP_PLUGIN_TRACER, startWorkerRpcHost, type PluginInvocationContext, type PluginTracer } from "@paperclipai/plugin-sdk";
import plugin, { __resetDaytonaSandboxHandleCacheForTest, __setDaytonaPluginContextForTest } from "./plugin.js";
import manifest from "./manifest.js";
import { leaseStateAttributes, withLeaseSpan } from "./lease-tracing.js";

const { get, create } = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn() }));
vi.mock("@daytonaio/sdk", () => ({
  Daytona: class { get = get; create = create; },
  DaytonaNotFoundError: class extends Error {},
  DaytonaTimeoutError: class extends Error {},
}));

type Receipt = {
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  attributes?: Record<string, unknown>;
  status?: { code: number };
  children: Receipt[];
};

function sandbox(id = "fixture-sandbox", state = "archived") {
  return {
    id, state, target: "us", recoverable: true, errorReason: null as string | null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    refreshData: vi.fn().mockResolvedValue(undefined),
    recover: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    getWorkDir: vi.fn().mockResolvedValue("/home/daytona"),
    fs: { createFolder: vi.fn().mockResolvedValue(undefined), uploadFile: vi.fn().mockResolvedValue(undefined) },
    process: { executeCommand: vi.fn(async (command: string) => ({
      exitCode: 0, result: command.startsWith("cat ") ? '{"token":"private-token"}' : "bash",
    })) },
  };
}

const params = {
  driverKey: "daytona", companyId: "fixture-company", environmentId: "fixture-environment",
  providerLeaseId: "fixture-sandbox", config: { apiKey: "private-api-key", timeoutMs: 300000, reuseLease: true },
  leaseMetadata: { workspaceSentinel: { token: "private-token", result: "written" } },
};

function workerHarness() {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const receipts: Array<{ invocationId: string; span: Receipt }> = [];
  let sequence = 0;
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.method) {
      if (message.method === "span.record") receipts.push({ invocationId: message.paperclipInvocationId, span: message.params });
      if (message.id !== undefined) stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }) + "\n");
    } else {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    }
  });
  const worker = startWorkerRpcHost({ plugin, stdin, stdout });
  function call(method: string, input: unknown, invocation?: PluginInvocationContext): Promise<unknown> {
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: input,
        ...(invocation ? { paperclipInvocation: invocation } : {}) }) + "\n");
    });
  }
  return {
    call, receipts,
    initialize: () => call("initialize", { manifest, config: {}, apiVersion: 1,
      instanceInfo: { instanceId: "fixture", hostVersion: "0.0.0" } }),
    close() { worker.stop(); lines.close(); stdin.destroy(); stdout.destroy(); },
  };
}

function invocation(id: string, enabled = true): PluginInvocationContext {
  return { id, scope: { companyId: "fixture-company" },
    ...(enabled ? { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } : {}) };
}

describe("Daytona lease worker tracing", () => {
  beforeEach(() => { get.mockReset(); create.mockReset(); __resetDaytonaSandboxHandleCacheForTest(); });
  afterEach(() => { __setDaytonaPluginContextForTest(null); __resetDaytonaSandboxHandleCacheForTest(); });

  it.each([true, false])("records the archived start and nested verification only with trace context: %s", async enabled => {
    const resource = sandbox(); get.mockResolvedValue(resource);
    const worker = workerHarness();
    try {
      await worker.initialize();
      expect(await worker.call("environmentResumeLease", params, invocation("resume", enabled)))
        .toMatchObject({ providerLeaseId: resource.id, metadata: { resumedFromState: "archived" } });
      expect(resource.start).toHaveBeenCalledExactlyOnceWith(300);
      expect(get).toHaveBeenCalledExactlyOnceWith(resource.id);
      if (!enabled) { expect(worker.receipts).toEqual([]); return; }
      expect(worker.receipts).toHaveLength(1);
      const root = worker.receipts[0].span;
      expect(root.name).toBe("plugin.worker");
      expect(root.children.map(span => span.name)).toEqual(["lease.lookup", "lease.channel_cleanup", "lease.start", "lease.verify"]);
      expect(root.children[2].attributes).toMatchObject({ "paperclip.sandbox.startup.state": "archived" });
      expect(root.children[3].children.map(span => span.name)).toEqual(["lease.workspace", "lease.sentinel", "lease.shell"]);
      function checkBounds(parent: Receipt) {
        for (const child of parent.children) {
          expect(child.startTimeMs).toBeGreaterThanOrEqual(parent.startTimeMs);
          expect(child.endTimeMs).toBeGreaterThanOrEqual(child.startTimeMs);
          expect(child.endTimeMs).toBeLessThanOrEqual(parent.endTimeMs);
          checkBounds(child);
        }
      }
      checkBounds(root);
      expect(JSON.stringify(root)).not.toMatch(/private-|fixture-sandbox|fixture-company|\/home\//);
    } finally { worker.close(); }
  });

  it("keeps simultaneous resume receipts separate and closes failed starts", async () => {
    const slow = sandbox(), failed = sandbox("failed-sandbox", "stopped");
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    slow.start.mockImplementation(async () => { started(); await waiting; });
    failed.start.mockRejectedValue(new Error("private-provider-error"));
    get.mockImplementation(async id => id === slow.id ? slow : failed);
    const worker = workerHarness();
    try {
      await worker.initialize();
      const first = worker.call("environmentResumeLease", params, invocation("slow"));
      await entered;
      await expect(worker.call("environmentResumeLease", { ...params, providerLeaseId: failed.id }, invocation("failed")))
        .rejects.toThrow("private-provider-error");
      release(); await first;
      expect(worker.receipts.map(record => record.invocationId)).toEqual(["failed", "slow"]);
      const failure = worker.receipts[0].span;
      expect(failure.status).toEqual({ code: 2 });
      expect(failure.children.find(span => span.name === "lease.start")?.status).toEqual({ code: 2 });
      expect(failure.children.some(span => span.name === "lease.verify")).toBe(false);
      expect(JSON.stringify(worker.receipts)).not.toContain("private-provider-error");
      expect(slow.start).toHaveBeenCalledTimes(1);
      expect(failed.start).toHaveBeenCalledTimes(1);
    } finally { release(); worker.close(); }
  });

  it("waits for a pending teardown and records the wait under the resume worker", async () => {
    const resource = sandbox("fixture-sandbox", "started"); get.mockResolvedValue(resource);
    let release!: () => void, stopping!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { stopping = resolve; });
    resource.stop.mockImplementation(async () => { stopping(); await waiting; resource.state = "stopped"; });
    const worker = workerHarness();
    try {
      await worker.initialize();
      const teardown = worker.call("environmentReleaseLease", params, invocation("release"));
      await entered;
      let settled = false;
      const resume = worker.call("environmentResumeLease", params, invocation("resume"))
        .then(result => { settled = true; return result; });
      // Process the resume request while the actual provider stop is held open.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(get).toHaveBeenCalledTimes(1);
      expect(resource.start).not.toHaveBeenCalled();
      release();
      await teardown;
      expect(await resume).toMatchObject({ providerLeaseId: resource.id });
      const root = worker.receipts.find(receipt => receipt.invocationId === "resume")!.span;
      expect(root.name).toBe("plugin.worker");
      expect(root.children.filter(span => span.name === "lease.wait_for_teardown")).toHaveLength(1);
      expect(root.children[0].name).toBe("lease.wait_for_teardown");
      expect(root.children[0].endTimeMs).toBeLessThanOrEqual(root.children[1].startTimeMs);
      expect(get).toHaveBeenCalledTimes(2);
      expect(resource.start).toHaveBeenCalledTimes(1);
    } finally { release(); worker.close(); }
  });

  it.each([false, true])("records missing-container confirmation and preserves refresh failures: %s", async fails => {
    const resource = sandbox("fixture-sandbox", "error");
    resource.recoverable = false;
    resource.errorReason = `not found: failed to inspect sandbox container ${resource.id}: Error response from daemon: No such container: ${resource.id}`;
    get.mockResolvedValue(resource);
    resource.refreshData.mockImplementation(async () => {
      if (fails) throw new Error("private-refresh-failure");
      resource.state = "started";
    });
    const worker = workerHarness();
    try {
      await worker.initialize();
      const result = worker.call("environmentResumeLease", params, invocation("resume"));
      if (fails) await expect(result).rejects.toThrow("private-refresh-failure");
      else expect(await result).toMatchObject({ providerLeaseId: resource.id });
      expect(resource.refreshData).toHaveBeenCalledTimes(1);
      const root = worker.receipts[0].span;
      expect(root.children.map(span => span.name)).toEqual(fails
        ? ["lease.lookup", "lease.refresh"] : ["lease.lookup", "lease.refresh", "lease.verify"]);
      expect(root.children[1].status).toEqual(fails ? { code: 2 } : undefined);
      expect(resource.start).not.toHaveBeenCalled();
      expect(resource.delete).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(JSON.stringify(worker.receipts)).not.toContain("private-refresh-failure");
    } finally { worker.close(); }
  });

  it.each(["started", "error"])("traces a %s sandbox without adding a provider start", async state => {
    const resource = sandbox("fixture-sandbox", state); get.mockResolvedValue(resource);
    const worker = workerHarness();
    try {
      await worker.initialize();
      await worker.call("environmentResumeLease", params, invocation("resume"));
      expect(resource.start).not.toHaveBeenCalled();
      expect(resource.recover).toHaveBeenCalledTimes(state === "error" ? 1 : 0);
      const phases = worker.receipts[0].span.children;
      expect(phases.some(span => span.name === "lease.start")).toBe(false);
      expect(phases.some(span => span.name === "lease.recover")).toBe(state === "error");
    } finally { worker.close(); }
  });

  it("closes the verification group and failing workspace child", async () => {
    const resource = sandbox(); get.mockResolvedValue(resource);
    resource.getWorkDir.mockRejectedValue(new Error("private-workspace-error"));
    const worker = workerHarness();
    try {
      await worker.initialize();
      await expect(worker.call("environmentResumeLease", params, invocation("resume")))
        .rejects.toThrow("private-workspace-error");
      const verify = worker.receipts[0].span.children.find(span => span.name === "lease.verify")!;
      expect(verify.status).toEqual({ code: 2 });
      expect(verify.children.map(span => span.name)).toEqual(["lease.workspace"]);
      expect(verify.children[0].status).toEqual({ code: 2 });
      expect(resource.delete).not.toHaveBeenCalled();
    } finally { worker.close(); }
  });

  it("records setup failure and compensating cleanup as siblings", async () => {
    const resource = sandbox(); create.mockResolvedValue(resource);
    resource.getWorkDir.mockRejectedValue(new Error("private-workspace-error"));
    const worker = workerHarness();
    try {
      await worker.initialize();
      await expect(worker.call("environmentAcquireLease", { ...params, runId: "fixture-run" }, invocation("acquire")))
        .rejects.toThrow("private-workspace-error");
      expect(resource.delete).toHaveBeenCalledTimes(1);
      const root = worker.receipts[0].span;
      expect(root.children.map(span => span.name)).toEqual(["lease.create", "lease.workspace", "lease.cleanup"]);
      expect(root.children[1].status).toEqual({ code: 2 });
      expect(root.children[2].status).toBeUndefined();
    } finally { worker.close(); }
  });
});

describe("lease tracing cannot change provider work", () => {
  it.each(["missing", "before", "after", "during"])("preserves the result and error with a %s tracer failure", async mode => {
    const tracer: PluginTracer = { ...NOOP_PLUGIN_TRACER,
      ...(mode === "missing" ? {} : { async withSpan<T>(_name: string, work: () => T | Promise<T>): Promise<T> {
        if (mode === "before") throw new Error("trace failure");
        const result = work();
        if (mode === "during") throw new Error("trace failure");
        await result;
        throw new Error("trace failure");
      } }),
    };
    const success = vi.fn(async () => 42), error = new Error("provider failure"), failure = vi.fn(async () => { throw error; });
    expect(await withLeaseSpan(tracer, "lease.lookup", success)).toBe(42);
    await expect(withLeaseSpan(tracer, "lease.lookup", failure)).rejects.toBe(error);
    expect(success).toHaveBeenCalledTimes(1); expect(failure).toHaveBeenCalledTimes(1);
  });

  it("normalizes unknown provider states before recording", () => {
    expect(leaseStateAttributes("provider-private-state")).toEqual({ "paperclip.sandbox.startup.state": "other" });
  });
});
