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
  it("negotiates recovery execution independently of ordinary execute and read-only recovery", async () => {
    const seen: unknown[] = [];
    const worker = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentRunnerRecoveryExecute(params) {
      seen.push(params); return { state: "unverified" };
    } }));
    const input = { execution: { command: "tar" } };
    try {
      const initialized = await worker.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).toContain("environmentRunnerRecoveryExecute");
      expect(await worker.callWorker("environmentRunnerRecoveryExecute", input)).toEqual({ state: "unverified" }); expect(seen).toEqual([input]);
    } finally { worker.stop(); }
    const legacy = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentExecute() { throw new Error("Must not wake compute"); },
      async onEnvironmentRunnerRecovery() { return { state: "unverified" }; } }));
    try {
      const initialized = await legacy.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).not.toContain("environmentRunnerRecoveryExecute");
      await expect(legacy.callWorker("environmentRunnerRecoveryExecute", input)).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED });
    } finally { legacy.stop(); }
  });
  it("negotiates recovery independently of ingress that can wake compute", async () => {
    const seen: unknown[] = [];
    const worker = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentRunnerRecovery(params) {
      seen.push(params); return { state: "unverified" };
    } }));
    const input = { operation: "read_state", runId: "original-run" };
    try {
      const initialized = await worker.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).toContain("environmentRunnerRecovery");
      expect(await worker.callWorker("environmentRunnerRecovery", input)).toEqual({ state: "unverified" }); expect(seen).toEqual([input]);
    } finally { worker.stop(); }
    const legacy = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentRunnerIngressEndpoint() { throw new Error("Must not wake compute"); } }));
    try {
      const initialized = await legacy.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).not.toContain("environmentRunnerRecovery");
      await expect(legacy.callWorker("environmentRunnerRecovery", input)).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED });
    } finally { legacy.stop(); }
  });
  it("negotiates run process control separately from arbitrary execution and service handoff", async () => {
    const seen: unknown[] = [];
    const worker = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentRunProcessControl(params) {
      seen.push(params); return { state: "running", workspaceConnection: params.workspaceConnection };
    } }));
    const input = { driverKey: "daytona", companyId: "company", environmentId: "environment", providerLeaseId: "sandbox", config: {},
      workspaceConnection: { scopeId: "run", fingerprint: "a".repeat(64) }, operation: { action: "inspect" },
      owner: { version: 1, pid: 40, uid: 1000, processGroupId: 40, bootId: "boot", startTicks: "1" } };
    try {
      const initialized = await worker.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).toContain("environmentRunProcessControl");
      expect(await worker.callWorker("environmentRunProcessControl", input)).toEqual({ state: "running", workspaceConnection: input.workspaceConnection });
      expect(seen).toEqual([input]);
    } finally { worker.stop(); }
    const legacy = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentExecute() { throw new Error("No general-execution fallback"); } }));
    try {
      const initialized = await legacy.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).not.toContain("environmentRunProcessControl");
      await expect(legacy.callWorker("environmentRunProcessControl", input)).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED });
    } finally { legacy.stop(); }
  });

  it("negotiates process handoff independently and dispatches capture and stop", async () => {
    const seen: unknown[] = [];
    const worker = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentProcessHandoff(params) {
      seen.push(params); return params.operation.action === "capture" ? { state: "captured", key: "key", receipt: { opaque: true } } : { state: "stopped" };
    } }));
    const base = { driverKey: "daytona", companyId: "company", environmentId: "environment", providerLeaseId: "sandbox", config: {}, workspaceConnection: { scopeId: "run", fingerprint: "a".repeat(64) } };
    const capture = { ...base, operation: { action: "capture", sourcePid: 42, owner: { version: 1, pid: 40, uid: 1000, processGroupId: 40, bootId: "boot", startTicks: "1" }, cwd: "/workspace", workspaceRoot: "/workspace" } };
    const stop = { ...base, operation: { action: "stop", receipt: { opaque: true } } };
    try {
      const initialized = await worker.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).toContain("environmentProcessHandoff");
      expect(await worker.callWorker("environmentProcessHandoff", capture)).toEqual({ state: "captured", key: "key", receipt: { opaque: true } });
      expect(await worker.callWorker("environmentProcessHandoff", stop)).toEqual({ state: "stopped" });
      expect(seen).toEqual([capture, stop]);
    } finally { worker.stop(); }
    const legacy = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentService() { throw new Error("No service-operation fallback"); } }));
    try {
      const initialized = await legacy.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).not.toContain("environmentProcessHandoff");
      await expect(legacy.callWorker("environmentProcessHandoff", capture)).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED });
    } finally { legacy.stop(); }
  });

  it("negotiates task-workspace deletion separately from standalone service and run destruction", async () => {
    const seen: unknown[] = [];
    const worker = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentDeleteTaskWorkspaceData(params) {
      seen.push(params); return { providerLeaseId: params.providerLeaseId, executionWorkspaceId: params.ownership.executionWorkspaceId, deletionId: params.deletionId, state: "destroyed" };
    } }));
    const params = { driverKey: "daytona", companyId: "company", environmentId: "environment", providerLeaseId: "sandbox", deletionId: "intent", config: {},
      workspaceConnection: { scopeId: "original-run", fingerprint: "a".repeat(64) }, ownership: { version: 1, executionWorkspaceId: "workspace", createdByRunId: "original-run", sandboxName: "task" } };
    try {
      const initialized = await worker.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).toContain("environmentDeleteTaskWorkspaceData");
      expect(await worker.callWorker("environmentDeleteTaskWorkspaceData", params)).toEqual({ providerLeaseId: "sandbox", executionWorkspaceId: "workspace", deletionId: "intent", state: "destroyed" });
      expect(seen).toEqual([params]);
    } finally { worker.stop(); }
    const legacy = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentDeleteServiceData() { throw new Error("Must not fall back"); }, async onEnvironmentDestroyLease() { throw new Error("Must not fall back"); } }));
    try {
      const initialized = await legacy.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).not.toContain("environmentDeleteTaskWorkspaceData");
      await expect(legacy.callWorker("environmentDeleteTaskWorkspaceData", params)).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED });
    } finally { legacy.stop(); }
  });

  it("negotiates explicit service data deletion without falling back to run destruction", async () => {
    const seen: unknown[] = [];
    const worker = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentDeleteServiceData(params) {
      seen.push(params); return { providerLeaseId: params.providerLeaseId, serviceAllocationId: params.serviceAllocationId, deletionId: params.deletionId, state: "destroyed" };
    } }));
    const params = { driverKey: "daytona", companyId: "company", environmentId: "environment", serviceAllocationId: "allocation",
      providerLeaseId: "sandbox", deletionId: "committed-intent", serviceConnectionFingerprint: "a".repeat(64), config: {} };
    try {
      const initialized = await worker.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).toContain("environmentDeleteServiceData");
      expect(await worker.callWorker("environmentDeleteServiceData", params)).toEqual({ providerLeaseId: "sandbox", serviceAllocationId: "allocation", deletionId: "committed-intent", state: "destroyed" });
      expect(seen).toEqual([params]);
    } finally { worker.stop(); }
    const legacy = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentDestroyLease() { throw new Error("Must not fall back to ordinary destruction"); } }));
    try {
      const initialized = await legacy.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).not.toContain("environmentDeleteServiceData");
      await expect(legacy.callWorker("environmentDeleteServiceData", params)).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED });
    } finally { legacy.stop(); }
  });

  it("negotiates durable service acquisition separately from ordinary run acquisition", async () => {
    const seen: string[] = [];
    const worker = startTestWorker(definePlugin({ async setup() {},
      async onEnvironmentGetServiceConnection(params) { return { fingerprint: "a".repeat(64), ...(params.checkResources ? { resourcesVerified: params.config.cpu === 4 } : {}) }; },
      async onEnvironmentAcquireServiceLease(params) {
        seen.push(params.serviceAllocationId); return { providerLeaseId: "durable-sandbox" };
      },
    }));
    try {
      const initialized = await worker.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).toContain("environmentAcquireServiceLease");
      expect(initialized.supportedMethods).toContain("environmentGetServiceConnection");
      const params = { driverKey: "daytona", companyId: "company", environmentId: "environment", runId: "allocation", serviceAllocationId: "allocation", serviceConnectionFingerprint: "a".repeat(64), config: {} };
      expect(await worker.callWorker("environmentGetServiceConnection", params)).toEqual({ fingerprint: "a".repeat(64) });
      expect(await worker.callWorker("environmentGetServiceConnection", { ...params, checkResources: true, config: { cpu: 4 } }))
        .toEqual({ fingerprint: "a".repeat(64), resourcesVerified: true });
      expect(await worker.callWorker("environmentGetServiceConnection", { ...params, checkResources: true, config: { cpu: 8 } }))
        .toEqual({ fingerprint: "a".repeat(64), resourcesVerified: false });
      expect(await worker.callWorker("environmentAcquireServiceLease", params)).toEqual({ providerLeaseId: "durable-sandbox" });
      expect(seen).toEqual(["allocation"]);
    } finally { worker.stop(); }
    const legacy = startTestWorker(definePlugin({ async setup() {}, async onEnvironmentAcquireLease() { throw new Error("Must not acquire an ordinary run sandbox"); } }));
    try {
      const initialized = await legacy.callWorker<{ supportedMethods: string[] }>("initialize", { manifest: MANIFEST, config: {}, databaseNamespace: null });
      expect(initialized.supportedMethods).not.toContain("environmentAcquireServiceLease");
      expect(initialized.supportedMethods).not.toContain("environmentGetServiceConnection");
      await expect(legacy.callWorker("environmentAcquireServiceLease", {})).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED });
      await expect(legacy.callWorker("environmentGetServiceConnection", {})).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED });
    } finally { legacy.stop(); }
  });

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

  it("test_sync_in_forwards_post_upload_commands_to_plugin_hook", async () => {
    // Phase 1 (PAP-3222): the optional ordered `postUploadCommands` must survive
    // the host→worker JSON-RPC hop to `onEnvironmentSyncIn` UNCHANGED — same
    // order, same fields — and an operation that omits the field must arrive with
    // it `undefined` (byte-identical to a pre-contract operation).
    const received: PluginEnvironmentSyncInParams["operations"][] = [];
    const worker = startTestWorker(
      definePlugin({
        async setup() {},
        async onEnvironmentSyncIn(params): Promise<PluginEnvironmentSyncResult> {
          received.push(params.operations);
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
      const inParams: PluginEnvironmentSyncInParams = {
        driverKey: "sandbox",
        companyId: "company",
        environmentId: "env",
        config: {},
        lease: { providerLeaseId: "lease-1" },
        operations: [
          {
            operationId: "op-with-commands",
            files: [{ sourcePath: "/host/a", targetPath: "/remote/a", kind: "directory" }],
            postUploadCommands: [
              { command: "tar -xf /remote/a.tar -C /remote/a" },
              { command: "merge-auth /remote/a", cwd: "/remote/a", timeoutMs: 30_000 },
            ],
          },
          {
            operationId: "op-without-commands",
            files: [{ sourcePath: "/host/b", targetPath: "/remote/b", kind: "directory" }],
          },
        ],
      };
      await worker.callWorker<PluginEnvironmentSyncResult>("environmentSyncIn", inParams);

      expect(received).toHaveLength(1);
      const [withCommands, withoutCommands] = received[0];
      // Present: forwarded unchanged, order preserved, no rewriting.
      expect(withCommands.postUploadCommands).toEqual([
        { command: "tar -xf /remote/a.tar -C /remote/a" },
        { command: "merge-auth /remote/a", cwd: "/remote/a", timeoutMs: 30_000 },
      ]);
      // Absent: arrives undefined (backward compatible).
      expect(withoutCommands.postUploadCommands).toBeUndefined();
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
