import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createRequest, definePlugin, isJsonRpcResponse, JsonRpcCallError, parseMessage,
  readEnvironmentSyncErrorDiagnostic, withEnvironmentSyncTransferStep, recordEnvironmentSyncError,
  PLUGIN_RPC_ERROR_CODES, serializeMessage, startWorkerRpcHost, type JsonRpcResponse,
} from "@paperclipai/plugin-sdk";
import {
  getWorkspaceRestoreDiagnostic, withWorkspaceRestoreDiagnostics, withWorkspaceRestoreStep,
} from "@paperclipai/adapter-utils/workspace-restore-diagnostics";
import { preserveEnvironmentSyncOutErrorDiagnostic } from "../services/environment-sync-out-error.js";

async function roundTrip(method: string, error: unknown): Promise<{ error: JsonRpcCallError; wire: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({
    async setup() {},
    async onEnvironmentSyncOut() { throw error; },
    async onEnvironmentSyncIn() { throw error; },
    async onEnvironmentExecute() { throw error; },
  }) });
  try {
    const response = new Promise<{ message: JsonRpcResponse; wire: string }>((resolve) => {
      lines.on("line", (wire) => {
        const message = parseMessage(wire);
        if (isJsonRpcResponse(message)) resolve({ message, wire });
      });
    });
    stdin.write(serializeMessage(createRequest(method, {}, "sync-out-test")));
    const { message, wire } = await response;
    if (!("error" in message) || !message.error) throw new Error("Expected RPC failure");
    return { error: new JsonRpcCallError(message.error), wire };
  } finally {
    worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
  }
}

describe("environment sync-out restore diagnostics", () => {
  it("retains bounded evidence through the real worker RPC roundtrip and host restore classifier", async () => {
    const failure = Object.assign(new Error("Workspace export failed"), {
      name: "private-provider-class", code: "ETIMEDOUT", statusCode: 504,
      response: { data: { apiKey: "private-token" } }, path: "/private-path",
      cause: new Error("private-cause"), data: { credentials: "private-credentials" },
    });
    const { error, wire } = await roundTrip("environmentSyncOut", failure);
    expect(wire).not.toContain("private-");
    expect(wire.length).toBeLessThan(400);
    expect(error.code).toBe(PLUGIN_RPC_ERROR_CODES.WORKER_ERROR);
    expect(error.message).toBe(failure.message);
    const before = structuredClone({ message: error.message, code: error.code, data: error.data });
    const logs: string[] = [];
    await expect(withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("workspace_transfer", async () => {
      throw preserveEnvironmentSyncOutErrorDiagnostic(error);
    }), async (line) => { logs.push(line); })).rejects.toBe(error);
    expect(getWorkspaceRestoreDiagnostic(error)).toEqual({ phase: "workspace", step: "workspace_transfer", errorCode: "ETIMEDOUT", httpStatus: 504, rpcCode: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].slice(logs[0].indexOf("{")))).toEqual(getWorkspaceRestoreDiagnostic(error));
    expect({ message: error.message, code: error.code, data: error.data }).toEqual(before);
    expect(error).not.toHaveProperty("cause");
  });

  it.each(["environmentSyncIn", "environmentExecute"])("does not add the sync-out envelope to %s", async (method) => {
    const { error } = await roundTrip(method, Object.assign(new Error("Provider failure"), { code: "EACCES", status: 503 }));
    expect(error.data).toBeUndefined();
    expect(preserveEnvironmentSyncOutErrorDiagnostic(error)).toBe(error);
    expect(getWorkspaceRestoreDiagnostic(error)).toBeUndefined();
  });

  it("keeps old workers and unknown diagnostics compatible without changing policy fields", async () => {
    const { error } = await roundTrip("environmentSyncOut", new Error("daytona_sandbox_not_found"));
    expect(error.data).toBeUndefined();
    expect(preserveEnvironmentSyncOutErrorDiagnostic(error)).toBe(error);
    expect(error.message).toBe("daytona_sandbox_not_found");
    const original = Object.freeze(new JsonRpcCallError({ code: -32001, message: "Existing worker failure" }));
    expect(preserveEnvironmentSyncOutErrorDiagnostic(original)).toBe(original);
    expect(preserveEnvironmentSyncOutErrorDiagnostic(null)).toBeNull();
  });
});


it("isolates overlapping and sequential worker calls that throw the same object", async () => {
  const original = Object.freeze(new Error("Transfer failed"));
  const before = Object.getOwnPropertyDescriptors(original);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({
    async setup() {},
    async onEnvironmentSyncOut(params) {
      if (params.operations?.[0]?.operationId === "first") {
        return withEnvironmentSyncTransferStep("archive_create", async () => {
          recordEnvironmentSyncError(original, { exitCode: 2, transferFailureKind: "command_failed" });
          started(); await gate; throw original;
        });
      }
      if (params.operations?.[0]?.operationId === "second") {
        return withEnvironmentSyncTransferStep("file_download", async () => { throw original; });
      }
      throw original;
    },
    async onEnvironmentSyncIn() { throw original; },
  }) });
  const call = (id: string, method = "environmentSyncOut") => new Promise<JsonRpcCallError>((resolve) => {
    const listener = (wire: string) => {
      const message = parseMessage(wire);
      if (isJsonRpcResponse(message) && message.id === id && message.error) {
        lines.off("line", listener); resolve(new JsonRpcCallError(message.error));
      }
    };
    lines.on("line", listener);
    stdin.write(serializeMessage(createRequest(method, { operations: [{ operationId: id, files: [] }] }, id)));
  });
  try {
    const first = call("first");
    await ready;
    const second = await call("second");
    expect(readEnvironmentSyncErrorDiagnostic(second)).toEqual({ errorCode: "unknown", transferStep: "file_download" });
    release();
    expect(readEnvironmentSyncErrorDiagnostic(await first)).toEqual({
      errorCode: "unknown", transferStep: "archive_create", transferFailureKind: "command_failed", exitCode: 2,
    });
    expect((await call("third")).data).toBeUndefined();
    expect((await call("unrelated", "environmentSyncIn")).data).toBeUndefined();
    expect(Object.getOwnPropertyDescriptors(original)).toEqual(before);
  } finally { release(); worker.stop(); lines.close(); stdin.destroy(); stdout.destroy(); }
});

it.each([
  [new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT, message: "private-rpc-message" }), PLUGIN_RPC_ERROR_CODES.TIMEOUT],
  [new JsonRpcCallError({ code: 123, message: "private-rpc-message" }), undefined],
  [Object.assign(new Error("private-rpc-message"), { code: PLUGIN_RPC_ERROR_CODES.TIMEOUT }), undefined],
])("records known typed RPC codes without interpreting arbitrary errors", async (error, rpcCode) => {
  const logs: string[] = [];
  await expect(withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("workspace_transfer", async () => {
    throw preserveEnvironmentSyncOutErrorDiagnostic(error);
  }), async line => { logs.push(line); })).rejects.toBe(error);
  expect(getWorkspaceRestoreDiagnostic(error)?.rpcCode).toBe(rpcCode);
  expect(getWorkspaceRestoreDiagnostic(error)?.transferStep).toBeUndefined();
  expect(JSON.stringify(logs)).not.toContain("private-");
});
