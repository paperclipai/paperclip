import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import {
  createRequest,
  isJsonRpcResponse,
  parseMessage,
  PLUGIN_RPC_ERROR_CODES,
  serializeMessage,
  type JsonRpcResponse,
  type PluginEnvironmentSyncInParams,
  type PluginEnvironmentSyncOutParams,
  type PluginEnvironmentSyncResult,
} from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

const MANIFEST = {
  id: "paperclip.sync-negotiation-test",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Sync Negotiation Test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: {},
} as const;

function startTestWorker(plugin: ReturnType<typeof definePlugin>) {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const hostReadline = createInterface({ input: workerToHost });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  let nextRequestId = 1;

  hostReadline.on("line", (line) => {
    const message = parseMessage(line);
    if (!isJsonRpcResponse(message)) return;
    pending.get(String(message.id))?.(message);
    pending.delete(String(message.id));
  });

  const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

  function callWorker<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = `host-${nextRequestId++}`;
    const result = new Promise<T>((resolve, reject) => {
      pending.set(id, (response) => {
        if ("error" in response && response.error) {
          reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
          return;
        }
        resolve((response as { result?: T }).result as T);
      });
    });
    hostToWorker.write(serializeMessage(createRequest(method, params, id)));
    return result;
  }

  function stop() {
    worker.stop();
    hostReadline.close();
    hostToWorker.destroy();
    workerToHost.destroy();
  }

  return { callWorker, stop };
}

describe("environment sync verb negotiation", () => {
  it("advertises environmentSyncIn/environmentSyncOut only when the hooks are defined", async () => {
    const withHooks = startTestWorker(
      definePlugin({
        async setup() {},
        async onEnvironmentSyncIn(): Promise<PluginEnvironmentSyncResult> {
          return { operations: [] };
        },
        async onEnvironmentSyncOut(): Promise<PluginEnvironmentSyncResult> {
          return { operations: [] };
        },
      }),
    );
    try {
      const result = await withHooks.callWorker<{ ok: boolean; supportedMethods: string[] }>(
        "initialize",
        { manifest: MANIFEST, config: {}, databaseNamespace: null },
      );
      expect(result.supportedMethods).toContain("environmentSyncIn");
      expect(result.supportedMethods).toContain("environmentSyncOut");
    } finally {
      withHooks.stop();
    }

    const withoutHooks = startTestWorker(definePlugin({ async setup() {} }));
    try {
      const result = await withoutHooks.callWorker<{ ok: boolean; supportedMethods: string[] }>(
        "initialize",
        { manifest: MANIFEST, config: {}, databaseNamespace: null },
      );
      expect(result.supportedMethods).not.toContain("environmentSyncIn");
      expect(result.supportedMethods).not.toContain("environmentSyncOut");
    } finally {
      withoutHooks.stop();
    }
  });

  it("routes environmentSyncIn/environmentSyncOut to the hooks when defined", async () => {
    const seen: string[] = [];
    const worker = startTestWorker(
      definePlugin({
        async setup() {},
        async onEnvironmentSyncIn(params): Promise<PluginEnvironmentSyncResult> {
          seen.push("in");
          return {
            operations: params.operations.map((op) => ({
              operationId: op.operationId,
              filesTransferred: op.files.length,
              bytesTransferred: 0,
            })),
          };
        },
        async onEnvironmentSyncOut(params): Promise<PluginEnvironmentSyncResult> {
          seen.push("out");
          return {
            operations: params.operations.map((op) => ({
              operationId: op.operationId,
              filesTransferred: op.files.length,
              bytesTransferred: 0,
            })),
          };
        },
      }),
    );
    try {
      await worker.callWorker("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      const baseParams = {
        driverKey: "sandbox",
        companyId: "company",
        environmentId: "env",
        config: {},
        lease: { providerLeaseId: "lease-1" },
      };
      const inParams: PluginEnvironmentSyncInParams = {
        ...baseParams,
        operations: [
          { operationId: "op-a", files: [{ sourcePath: "/host/a", targetPath: "/remote/a", kind: "file" }] },
        ],
      };
      const inResult = await worker.callWorker<PluginEnvironmentSyncResult>("environmentSyncIn", inParams);
      expect(inResult.operations[0]).toMatchObject({ operationId: "op-a", filesTransferred: 1 });

      const outParams: PluginEnvironmentSyncOutParams = {
        ...baseParams,
        operations: [
          { operationId: "op-b", files: [{ sourcePath: "/remote/b", targetPath: "/host/b", kind: "directory" }] },
        ],
      };
      const outResult = await worker.callWorker<PluginEnvironmentSyncResult>("environmentSyncOut", outParams);
      expect(outResult.operations[0]).toMatchObject({ operationId: "op-b", filesTransferred: 1 });
      expect(seen).toEqual(["in", "out"]);
    } finally {
      worker.stop();
    }
  });

  it("throws METHOD_NOT_IMPLEMENTED when the sync hooks are absent", async () => {
    const worker = startTestWorker(definePlugin({ async setup() {} }));
    try {
      await worker.callWorker("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      const params = {
        driverKey: "sandbox",
        companyId: "company",
        environmentId: "env",
        config: {},
        lease: { providerLeaseId: "lease-1" },
        operations: [],
      };
      await expect(worker.callWorker("environmentSyncIn", params)).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
      });
      await expect(worker.callWorker("environmentSyncOut", params)).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
      });
    } finally {
      worker.stop();
    }
  });
});
