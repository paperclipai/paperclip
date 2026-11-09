import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { createRequest, isJsonRpcResponse, JsonRpcCallError, parseMessage, serializeMessage, type JsonRpcResponse } from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";
import { PluginWorkspaceOperationError, readWorkspaceOperationFailureReason, workspaceOperationErrorData } from "../src/workspace-operation-error.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const params = {
  pluginId: id(1), companyId: id(2), projectId: id(3), executionWorkspaceId: id(4), agentId: id(9),
  operationId: "operation-1", generation: 0, deadline: "2099-01-01T00:00:00.000Z", runId: null,
  operation: { kind: "prepare", source: { id: id(5), revision: "source-v1", repoUrl: null, repoRef: null, defaultRef: null },
    mode: "shared_workspace", strategy: "project_primary", branchName: null, baseRef: null, existing: null },
};

async function invoke(method: string, error: unknown) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({
    async setup() {},
    async onWorkspaceOperation() { throw error; },
    async onEnvironmentProbe() { throw error; },
  }) });
  try {
    const response = new Promise<JsonRpcResponse>((resolve) => {
      lines.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcResponse(message)) resolve(message);
      });
    });
    stdin.write(serializeMessage(createRequest(method, params, "workspace-test")));
    return await response;
  } finally {
    worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
  }
}

describe("workspace operation failure reasons", () => {
  it("carries the closed reason across the real workspaceOperation RPC", async () => {
    const response = await invoke("workspaceOperation", new PluginWorkspaceOperationError("storage_grant_unavailable", "Project mount grants unavailable"));
    if (!("error" in response) || !response.error) throw new Error("Expected RPC error");
    expect(response.error.data).toEqual({ schema: "paperclip/workspace-operation-error/v1", reason: "storage_grant_unavailable" });
    const callError = new JsonRpcCallError(response.error);
    expect(readWorkspaceOperationFailureReason(callError)).toBe("storage_grant_unavailable");
    expect(readWorkspaceOperationFailureReason(new Error("wrapped", { cause: new Error("again", { cause: callError }) })))
      .toBe("storage_grant_unavailable");
  });

  it("forwards a provider error's own closed reason without the SDK class", async () => {
    // A provider built against an older SDK can carry the reason before it can import the class.
    const response = await invoke("workspaceOperation",
      Object.assign(new Error("Invalid runtime computer connection"), { workspaceFailureReason: "runtime_connection_invalid" }));
    if (!("error" in response) || !response.error) throw new Error("Expected RPC error");
    expect(readWorkspaceOperationFailureReason(new JsonRpcCallError(response.error))).toBe("runtime_connection_invalid");
  });

  it("never derives a reason from message text or forwards an unknown reason", async () => {
    for (const error of [new Error("configuration_unavailable"),
      Object.assign(new Error("private"), { workspaceFailureReason: "token=secret" })]) {
      const response = await invoke("workspaceOperation", error);
      expect("error" in response && response.error).not.toHaveProperty("data");
    }
  });

  it("only attaches the envelope to workspaceOperation calls", async () => {
    const response = await invoke("environmentProbe", new PluginWorkspaceOperationError("binding_mismatch"));
    expect("error" in response && response.error).not.toHaveProperty("data");
  });

  it("refuses reasons outside the closed set", () => {
    expect(() => new PluginWorkspaceOperationError("private" as never)).toThrow(TypeError);
    expect(workspaceOperationErrorData(new Error("plain"))).toBeUndefined();
    // Only an own property counts; an inherited one is not the error's reason.
    expect(workspaceOperationErrorData(Object.create({ workspaceFailureReason: "binding_mismatch" }))).toBeUndefined();
  });

  it.each([null, {}, { data: { schema: "other", reason: "binding_mismatch" } },
    { data: { schema: "paperclip/workspace-operation-error/v1", reason: "private" } }])(
    "rejects malformed envelopes %j", (value) => {
      expect(readWorkspaceOperationFailureReason(value)).toBeNull();
    });
});
