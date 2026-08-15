import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import {
  createRequest,
  createErrorResponse,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcNotification,
  parseMessage,
  PLUGIN_RPC_ERROR_CODES,
  serializeMessage,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type PluginInvocationContext,
} from "../src/protocol.js";
import { isWorkerEntrypoint, startWorkerRpcHost } from "../src/worker-rpc-host.js";

describe("isWorkerEntrypoint", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function createTempRoot(): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sdk-worker-"));
    tempRoots.push(tempRoot);
    return tempRoot;
  }

  it("matches an entrypoint reached through a symlinked directory", () => {
    const tempRoot = createTempRoot();
    const realDir = path.join(tempRoot, "real");
    const linkDir = path.join(tempRoot, "link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir, "dir");

    const workerPath = path.join(realDir, "worker.js");
    fs.writeFileSync(workerPath, "");

    expect(
      isWorkerEntrypoint(
        path.join(linkDir, "worker.js"),
        pathToFileURL(workerPath).toString(),
      ),
    ).toBe(true);
  });

  it("does not match a different entrypoint", () => {
    const tempRoot = createTempRoot();
    const workerPath = path.join(tempRoot, "worker.js");
    const otherPath = path.join(tempRoot, "other.js");
    fs.writeFileSync(workerPath, "");
    fs.writeFileSync(otherPath, "");

    expect(
      isWorkerEntrypoint(
        otherPath,
        pathToFileURL(workerPath).toString(),
      ),
    ).toBe(false);
  });
});

describe("worker performAction context", () => {
  it("does not derive context companyId from caller params without host actor context", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    let nextRequestId = 1;
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("inspect", async (params, context) => ({
          paramsCompanyId: params.companyId,
          actor: context.actor,
          companyId: context.companyId,
        }));
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (!isJsonRpcResponse(message)) return;
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    });

    try {
      await expect(callWorker("initialize", {
        manifest: {
          id: "paperclip.test-worker-context",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Worker Context Test",
          description: "Test plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: [],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      })).resolves.toMatchObject({ ok: true });

      await expect(callWorker("performAction", {
        key: "inspect",
        params: { companyId: "spoofed-company" },
      })).resolves.toEqual({
        paramsCompanyId: "spoofed-company",
        actor: {
          type: "system",
          userId: null,
          agentId: null,
          runId: null,
          companyId: null,
        },
        companyId: null,
      });
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker invocation scope propagation", () => {
  it("keeps overlapping company scopes local to each getData invocation", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const nestedInvocationIds: string[] = [];
    const invocationCompanies = new Map([
      ["invocation-a", "company-a"],
      ["invocation-b", "company-b"],
    ]);
    let releaseCompanyA: (() => void) | null = null;
    let nextRequestId = 1;

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("probe", async (params) => {
          if (params.label === "a") {
            await new Promise<void>((resolve) => {
              releaseCompanyA = resolve;
            });
          }
          const company = await ctx.companies.get(String(params.requestedCompanyId));
          return { label: params.label, company };
        });
      },
    });

    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown, invocation?: PluginInvocationContext) {
      const id = `host-${nextRequestId++}`;
      const request = {
        ...createRequest(method, params, id),
        ...(invocation ? { paperclipInvocation: invocation } : {}),
      };
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(request));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }

      if (!isJsonRpcRequest(message)) return;
      if (message.method !== "companies.get") return;

      const invocationId = (message as { paperclipInvocationId?: string }).paperclipInvocationId ?? "";
      const requestedCompanyId = (message.params as { companyId?: string }).companyId;
      const allowedCompanyId = invocationCompanies.get(invocationId);
      nestedInvocationIds.push(invocationId);
      if (requestedCompanyId !== allowedCompanyId) {
        hostToWorker.write(serializeMessage(createErrorResponse(
          message.id,
          PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
          `requested company "${requestedCompanyId}" but invocation "${invocationId}" is scoped to "${allowedCompanyId}"`,
        )));
        return;
      }

      hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {
        id: requestedCompanyId,
      })));

      if (invocationId === "invocation-b") {
        releaseCompanyA?.();
      }
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.scope-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Scope test",
          description: "Scope test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["companies.read"],
          entrypoints: { worker: "dist/worker.js" },
        },
        config: {},
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
      });

      const companyARequest = callWorker(
        "getData",
        {
          key: "probe",
          companyId: "company-a",
          params: { label: "a", requestedCompanyId: "company-b" },
        },
        { id: "invocation-a", scope: { companyId: "company-a" } },
      );
      const companyAExpectation = expect(companyARequest).rejects.toThrow(
        /requested company "company-b"/,
      );
      const companyBRequest = callWorker(
        "getData",
        {
          key: "probe",
          companyId: "company-b",
          params: { label: "b", requestedCompanyId: "company-b" },
        },
        { id: "invocation-b", scope: { companyId: "company-b" } },
      );

      await expect(companyBRequest).resolves.toEqual({
        label: "b",
        company: { id: "company-b" },
      });
      await companyAExpectation;

      expect(nestedInvocationIds).toEqual(["invocation-b", "invocation-a"]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker configChanged cross-tenant guard", () => {
  // Spin up a worker-rpc-host wired to in-memory streams and expose a
  // request/response `callWorker` plus `initialize`/`stop` helpers.
  function makeWorker(plugin: ReturnType<typeof definePlugin>) {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    let nextRequestId = 1;

    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(
              Object.assign(new Error(response.error.message), {
                code: response.error.code,
              }),
            );
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (!isJsonRpcResponse(message)) return;
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    });

    async function initialize() {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.config-guard-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Config Guard Test",
          description: "Test plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: [],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      });
    }

    function stop() {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }

    return { callWorker, initialize, stop };
  }

  it("fails closed when a second, distinct company's config would overwrite a single-tenant worker", async () => {
    const applied: Array<{ companyId: string | null; token: unknown }> = [];
    const plugin = definePlugin({
      async setup() {},
      async onConfigChanged(newConfig, context) {
        applied.push({
          companyId: context?.companyId ?? null,
          token: newConfig.slackBotToken,
        });
      },
    });
    const { callWorker, initialize, stop } = makeWorker(plugin);

    try {
      await initialize();

      // Company A's config is delivered first (deterministic ORDER BY companyId
      // in the loader) and applied.
      await expect(
        callWorker("configChanged", {
          config: { companyId: "company-a", slackBotToken: "xoxb-A" },
          companyId: "company-a",
        }),
      ).resolves.toBeNull();

      // Company B's *distinct* config must be rejected rather than silently
      // collapsing the single worker onto B's bot token (the vulnerability).
      await expect(
        callWorker("configChanged", {
          config: { companyId: "company-b", slackBotToken: "xoxb-B" },
          companyId: "company-b",
        }),
      ).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.CROSS_TENANT_CONFIG,
      });

      // The worker stayed bound to company A; company B never reached the
      // plugin. Against the pre-fix code this array would be
      // [company-a, company-b] (last-write-wins collapse).
      expect(applied).toEqual([{ companyId: "company-a", token: "xoxb-A" }]);
    } finally {
      stop();
    }
  });

  it("allows an idempotent replay of the same config under a different scope row", async () => {
    // Mirrors the live single-tenant gateway: several plugin_config rows keyed
    // by distinct row companyIds but all embedding the same config. Replaying
    // them must be a no-op, not a fail-closed rejection.
    const appliedScopes: Array<string | null> = [];
    const plugin = definePlugin({
      async setup() {},
      async onConfigChanged(_newConfig, context) {
        appliedScopes.push(context?.companyId ?? null);
      },
    });
    const { callWorker, initialize, stop } = makeWorker(plugin);

    try {
      await initialize();
      const embedded = { companyId: "company-a", slackBotToken: "xoxb-A" };

      await callWorker("configChanged", {
        config: { ...embedded },
        companyId: "row-scope-1",
      });
      await expect(
        callWorker("configChanged", {
          config: { ...embedded },
          companyId: "row-scope-2",
        }),
      ).resolves.toBeNull();

      expect(appliedScopes).toEqual(["row-scope-1", "row-scope-2"]);
    } finally {
      stop();
    }
  });

  it("threads per-company config to a plugin that opts into multiCompanyConfig", async () => {
    const applied: Array<{ companyId: string | null; token: unknown }> = [];
    const plugin = definePlugin({
      multiCompanyConfig: true,
      async setup() {},
      async onConfigChanged(newConfig, context) {
        applied.push({
          companyId: context?.companyId ?? null,
          token: newConfig.slackBotToken,
        });
      },
    });
    const { callWorker, initialize, stop } = makeWorker(plugin);

    try {
      await initialize();

      await callWorker("configChanged", {
        config: { companyId: "company-a", slackBotToken: "xoxb-A" },
        companyId: "company-a",
      });
      await expect(
        callWorker("configChanged", {
          config: { companyId: "company-b", slackBotToken: "xoxb-B" },
          companyId: "company-b",
        }),
      ).resolves.toBeNull();

      // Both companies' configs delivered, each tagged with its own scope.
      expect(applied).toEqual([
        { companyId: "company-a", token: "xoxb-A" },
        { companyId: "company-b", token: "xoxb-B" },
      ]);
    } finally {
      stop();
    }
  });
});

describe("worker provider tracer", () => {
  it("default plugin tracer is a no-op that starts and ends a span without throwing", async () => {
    const { NOOP_PLUGIN_TRACER } = await import("../src/types.js");
    const span = NOOP_PLUGIN_TRACER.startSpan("pack", { attributes: { a: 1 } });
    expect(() => {
      span.setAttribute("b", 2);
      span.setStatus({ code: 1 });
      span.end();
    }).not.toThrow();
  });

  // Drive a plugin data handler that opens a provider span, and capture the
  // worker→host traffic. The host injects a `traceparent` on the invocation, so
  // the worker must emit one `span.record` request that echoes the invocation id
  // and carries the span name and attributes.
  async function runSpanProbe(invocation: PluginInvocationContext) {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const spanRecords: Array<{ params: unknown; invocationId?: string }> = [];
    let nextRequestId = 1;

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("probe", async () => {
          const span = ctx.tracer.startSpan("pack", {
            attributes: { "paperclip.sandbox.startup.pack.wall_ms": 12 },
          });
          span.setAttribute("paperclip.sandbox.startup.provider", "daytona");
          span.end();
          return { ok: true };
        });
      },
    });

    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

    function callWorker(method: string, params: unknown, inv?: PluginInvocationContext) {
      const id = `host-${nextRequestId++}`;
      const request = {
        ...createRequest(method, params, id),
        ...(inv ? { paperclipInvocation: inv } : {}),
      };
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(request));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (!isJsonRpcRequest(message)) return;
      if (message.method === "span.record") {
        spanRecords.push({
          params: message.params,
          invocationId: (message as { paperclipInvocationId?: string }).paperclipInvocationId,
        });
        hostToWorker.write(serializeMessage(createSuccessResponse(message.id, null)));
      }
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.tracer-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Tracer test",
          description: "Tracer test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["environment.drivers.register"],
          entrypoints: { worker: "dist/worker.js" },
        },
        config: {},
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
      });
      await callWorker("getData", { key: "probe", companyId: "company-a", params: {} }, invocation);
      // Let the fire-and-forget span.record flush.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return spanRecords;
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  }

  it("emits one span.record with the name and attributes when a host trace context is active", async () => {
    const spanRecords = await runSpanProbe({
      id: "invocation-a",
      scope: { companyId: "company-a" },
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(spanRecords).toHaveLength(1);
    const record = spanRecords[0]!;
    expect(record.invocationId).toBe("invocation-a");
    expect(record.params).toMatchObject({
      name: "pack",
      attributes: {
        "paperclip.sandbox.startup.pack.wall_ms": 12,
        "paperclip.sandbox.startup.provider": "daytona",
      },
    });
  });

  it("sends a finite startTimeMs and endTimeMs with endTimeMs >= startTimeMs", async () => {
    const spanRecords = await runSpanProbe({
      id: "invocation-a",
      scope: { companyId: "company-a" },
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(spanRecords).toHaveLength(1);
    const params = spanRecords[0]!.params as {
      startTimeMs?: number;
      endTimeMs?: number;
    };
    expect(Number.isFinite(params.startTimeMs)).toBe(true);
    expect(Number.isFinite(params.endTimeMs)).toBe(true);
    expect(params.endTimeMs!).toBeGreaterThanOrEqual(params.startTimeMs!);
  });

  it("emits no span.record when the invocation carries no traceparent (tracing off)", async () => {
    const spanRecords = await runSpanProbe({
      id: "invocation-a",
      scope: { companyId: "company-a" },
    });
    expect(spanRecords).toHaveLength(0);
  });
});

describe("worker execute.log emitter", () => {
  // Run one data handler that calls `ctx.execution.log`, and capture the
  // `execute.log` notifications the worker sends to the host.
  async function runExecuteLogProbe(
    invocation: PluginInvocationContext | undefined,
    entries: Array<{ stream: "stdout" | "stderr"; chunk: string }>,
  ) {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const logRecords: Array<{ params: unknown; invocationId?: string }> = [];
    let nextRequestId = 1;

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("emit-logs", async () => {
          for (const entry of entries) {
            ctx.execution.log(entry.stream, entry.chunk);
          }
          return { ok: true };
        });
      },
    });

    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

    function callWorker(method: string, params: unknown, inv?: PluginInvocationContext) {
      const id = `host-${nextRequestId++}`;
      const request = {
        ...createRequest(method, params, id),
        ...(inv ? { paperclipInvocation: inv } : {}),
      };
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(request));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      // `execute.log` is a fire-and-forget notification (no id), so it is not a
      // JSON-RPC request. Match on the method name directly.
      if ((message as { method?: string }).method === "execute.log") {
        logRecords.push({
          params: (message as { params?: unknown }).params,
          invocationId: (message as { paperclipInvocationId?: string }).paperclipInvocationId,
        });
      }
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.execute-log-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Execute log test",
          description: "Execute log test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["environment.drivers.register"],
          entrypoints: { worker: "dist/worker.js" },
        },
        config: {},
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
      });
      await callWorker("getData", { key: "emit-logs", companyId: "company-a", params: {} }, invocation);
      // Let the fire-and-forget execute.log notifications flush.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return logRecords;
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  }

  it("stamps the active invocation id on each execute.log notification", async () => {
    const records = await runExecuteLogProbe(
      { id: "invocation-a", scope: { companyId: "company-a" } },
      [
        { stream: "stdout", chunk: "one" },
        { stream: "stderr", chunk: "two" },
      ],
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      params: { stream: "stdout", chunk: "one" },
      invocationId: "invocation-a",
    });
    expect(records[1]).toEqual({
      params: { stream: "stderr", chunk: "two" },
      invocationId: "invocation-a",
    });
  });

  it("drops an empty chunk before it reaches the host", async () => {
    const records = await runExecuteLogProbe(
      { id: "invocation-a", scope: { companyId: "company-a" } },
      [
        { stream: "stdout", chunk: "" },
        { stream: "stdout", chunk: "kept" },
      ],
    );
    expect(records).toEqual([
      { params: { stream: "stdout", chunk: "kept" }, invocationId: "invocation-a" },
    ]);
  });
});

describe("worker setup-token pseudo-terminal dispatch", () => {
  it("dispatches open, input, stop, and close, and streams output and exit as notifications", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const notifications: JsonRpcNotification[] = [];
    let nextRequestId = 1;

    // The fake session the opener returns. The test drives its output and exit.
    let emitOutput: ((chunk: string) => void) | null = null;
    let resolveWait: ((value: { exitCode: number | null }) => void) | null = null;
    const inputs: string[] = [];
    let killed = 0;
    let closed = 0;

    // The worker emits output and exit through `ctx.setupTokenPty`, bound to the
    // worker session id. The test drives them through the captured emitters.
    const controllablePlugin = definePlugin({
      async setup(ctx) {
        emitOutput = (chunk: string) => ctx.setupTokenPty.output("ws-1", chunk);
        resolveWait = (value) => ctx.setupTokenPty.exit("ws-1", value.exitCode);
      },
      async onSetupTokenPtyOpen(params) {
        // The open carries the host route id and the fixed command. The worker
        // returns a worker session id for the output binding only.
        expect(params.hostRouteId).toBe("route-1");
        expect(params.command).toBe("claude setup-token");
        expect(params.providerLeaseId).toBe("lease-1");
        return { workerSessionId: "ws-1" };
      },
      async onSetupTokenPtyInput(params) {
        inputs.push(params.data);
      },
      async onSetupTokenPtyStop() {
        killed += 1;
      },
      async onSetupTokenPtyClose(params) {
        // The close keys on the host route id and returns a bound acknowledgement.
        closed += 1;
        return { hostRouteId: params.hostRouteId };
      },
    });

    const worker = startWorkerRpcHost({
      plugin: controllablePlugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (isJsonRpcNotification(message)) {
        notifications.push(message as JsonRpcNotification);
      }
    });

    try {
      await expect(
        callWorker("initialize", {
          manifest: {
            id: "paperclip.setup-token-pty",
            apiVersion: 1,
            version: "1.0.0",
            displayName: "Setup Token PTY Test",
            description: "Test plugin",
            author: "Paperclip",
            categories: ["automation"],
            capabilities: [],
            entrypoints: {},
          },
          config: {},
          databaseNamespace: null,
        }),
      ).resolves.toMatchObject({
        ok: true,
        supportedMethods: expect.arrayContaining([
          "setupTokenPtyOpen",
          "setupTokenPtyInput",
          "setupTokenPtyStop",
          "setupTokenPtyClose",
        ]),
      });

      await expect(
        callWorker("setupTokenPtyOpen", {
          hostRouteId: "route-1",
          driverKey: "daytona",
          companyId: "company-1",
          environmentId: "env-1",
          providerLeaseId: "lease-1",
          command: "claude setup-token",
        }),
      ).resolves.toEqual({ workerSessionId: "ws-1" });

      // The worker streams output as a notification bound to the worker session id.
      emitOutput?.("prompt output");
      await callWorker("setupTokenPtyInput", { workerSessionId: "ws-1", data: "browser-code" });
      await callWorker("setupTokenPtyStop", { workerSessionId: "ws-1" });
      resolveWait?.({ exitCode: 0 });
      await expect(
        callWorker("setupTokenPtyClose", { hostRouteId: "route-1" }),
      ).resolves.toEqual({ hostRouteId: "route-1" });

      await new Promise((resolve) => setImmediate(resolve));

      expect(inputs).toEqual(["browser-code"]);
      expect(killed).toBe(1);
      expect(closed).toBe(1);
      const outputNotes = notifications.filter(
        (note) => note.method === "setupTokenPty.output",
      );
      expect(outputNotes.map((note) => note.params)).toEqual([
        { workerSessionId: "ws-1", chunk: "prompt output" },
      ]);
      const exitNotes = notifications.filter(
        (note) => note.method === "setupTokenPty.exit",
      );
      expect(exitNotes.map((note) => note.params)).toEqual([
        { workerSessionId: "ws-1", exitCode: 0 },
      ]);
    } finally {
      worker.stop();
      hostReadline.close();
    }
  });
});
