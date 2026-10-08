import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createRequest, definePlugin, isJsonRpcResponse, JsonRpcCallError, parseMessage,
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
    expect(getWorkspaceRestoreDiagnostic(error)).toEqual({ phase: "workspace", step: "workspace_transfer", errorCode: "ETIMEDOUT", httpStatus: 504 });
    expect(logs).toEqual(['[paperclip] Workspace restore diagnostic: {"phase":"workspace","step":"workspace_transfer","errorCode":"ETIMEDOUT","httpStatus":504}\n']);
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
