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
  parseMessage,
  PLUGIN_RPC_ERROR_CODES,
  serializeMessage,
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

describe("startWorkerRpcHost runtime company context", () => {
  function collectJsonLines(stream: PassThrough) {
    const queue: unknown[] = [];
    const waiters: Array<(value: unknown) => void> = [];
    let buffer = "";

    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          const message = JSON.parse(line);
          const waiter = waiters.shift();
          if (waiter) waiter(message);
          else queue.push(message);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });

    return async function nextMessage(): Promise<any> {
      const queued = queue.shift();
      if (queued) return queued;
      return new Promise((resolve) => waiters.push(resolve));
    };
  }

  function writeMessage(stream: PassThrough, message: unknown): void {
    stream.write(`${JSON.stringify(message)}\n`);
  }

  it("passes executeTool company context into config and secret host calls", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const nextMessage = collectJsonLines(stdout);

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.tools.register(
          "check-context",
          {
            displayName: "Check Context",
            description: "Checks runtime context propagation",
            parametersSchema: { type: "object", properties: {} },
          },
          async () => {
            const config = await ctx.config.get();
            const token = await ctx.secrets.resolve("77777777-7777-4777-8777-777777777777");
            return { content: `${config.mode}:${token}` };
          },
        );
      },
    });

    const host = startWorkerRpcHost({ plugin, stdin, stdout });

    try {
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          manifest: { id: "test-plugin", name: "test-plugin", version: "1.0.0" },
          config: {},
          instanceInfo: { instanceId: "inst-1", hostVersion: "0.0.0-test" },
          apiVersion: 1,
        },
      });
      await expect(nextMessage()).resolves.toMatchObject({ id: 1, result: { ok: true } });

      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: 2,
        method: "executeTool",
        params: {
          toolName: "check-context",
          parameters: {},
          runContext: {
            agentId: "agent-1",
            runId: "run-1",
            companyId: "company-1",
            projectId: "project-1",
          },
        },
      });

      const configRequest = await nextMessage();
      expect(configRequest).toMatchObject({
        method: "config.get",
        params: { companyId: "company-1" },
      });
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: configRequest.id,
        result: { mode: "company-config" },
      });

      const secretRequest = await nextMessage();
      expect(secretRequest).toMatchObject({
        method: "secrets.resolve",
        params: {
          secretRef: "77777777-7777-4777-8777-777777777777",
          companyId: "company-1",
        },
      });
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: secretRequest.id,
        result: "company-secret",
      });

      await expect(nextMessage()).resolves.toMatchObject({
        id: 2,
        result: { content: "company-config:company-secret" },
      });
    } finally {
      host.stop();
      stdin.destroy();
      stdout.destroy();
    }
  });

  it("preserves explicit null company context in config and secret host calls", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const nextMessage = collectJsonLines(stdout);

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.tools.register(
          "check-explicit-null",
          {
            displayName: "Check Explicit Null",
            description: "Checks explicit null runtime context propagation",
            parametersSchema: { type: "object", properties: {} },
          },
          async () => {
            const config = await ctx.config.get({ companyId: null });
            const token = await ctx.secrets.resolve(
              "77777777-7777-4777-8777-777777777777",
              null,
            );
            return { content: `${config.mode}:${token}` };
          },
        );
      },
    });

    const host = startWorkerRpcHost({ plugin, stdin, stdout });

    try {
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          manifest: { id: "test-plugin", name: "test-plugin", version: "1.0.0" },
          config: {},
          instanceInfo: { instanceId: "inst-1", hostVersion: "0.0.0-test" },
          apiVersion: 1,
        },
      });
      await expect(nextMessage()).resolves.toMatchObject({ id: 1, result: { ok: true } });

      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: 2,
        method: "executeTool",
        params: {
          toolName: "check-explicit-null",
          parameters: {},
          runContext: {
            agentId: "agent-1",
            runId: "run-1",
            companyId: "company-1",
            projectId: "project-1",
          },
        },
      });

      const configRequest = await nextMessage();
      expect(configRequest).toMatchObject({
        method: "config.get",
        params: { companyId: null },
      });
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: configRequest.id,
        result: { mode: "global-config" },
      });

      const secretRequest = await nextMessage();
      expect(secretRequest).toMatchObject({
        method: "secrets.resolve",
        params: {
          secretRef: "77777777-7777-4777-8777-777777777777",
          companyId: null,
        },
      });
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: secretRequest.id,
        result: "global-secret",
      });

      await expect(nextMessage()).resolves.toMatchObject({
        id: 2,
        result: { content: "global-config:global-secret" },
      });
    } finally {
      host.stop();
      stdin.destroy();
      stdout.destroy();
    }
  });
});
