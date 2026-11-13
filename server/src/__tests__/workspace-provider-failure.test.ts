import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createRequest,
  definePlugin,
  isJsonRpcResponse,
  JsonRpcCallError,
  parseMessage,
  PLUGIN_RPC_ERROR_CODES,
  PluginWorkspaceOperationError,
  serializeMessage,
  startWorkerRpcHost,
  WORKSPACE_OPERATION_FAILURE_REASONS,
  type JsonRpcResponse,
} from "@paperclipai/plugin-sdk";
import { HttpError } from "../errors.js";
import { findPluginWorkerUnavailableError, PluginWorkerUnavailableError } from "../services/plugin-worker-unavailable-error.js";
import { findWorkspaceProviderFailure, workspaceProviderCallFailure } from "../services/workspace-provider-failure.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const params = {
  pluginId: id(1), companyId: id(2), projectId: id(3), executionWorkspaceId: id(4), agentId: id(9),
  operationId: "operation-1", generation: 0, deadline: "2099-01-01T00:00:00.000Z", runId: null,
  operation: { kind: "prepare", source: { id: id(5), revision: "source-v1", repoUrl: null, repoRef: null, defaultRef: null },
    mode: "shared_workspace", strategy: "project_primary", branchName: null, baseRef: null, existing: null },
};

/** The error Core receives when a real worker's `onWorkspaceOperation` throws. */
async function providerRejection(error: unknown): Promise<JsonRpcCallError> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({
    async setup() {},
    async onWorkspaceOperation() { throw error; },
  }) });
  try {
    const response = await new Promise<JsonRpcResponse>((resolve) => {
      lines.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcResponse(message)) resolve(message);
      });
      stdin.write(serializeMessage(createRequest("workspaceOperation", params, "workspace-test")));
    });
    if (!("error" in response) || !response.error) throw new Error("Expected RPC error");
    return new JsonRpcCallError(response.error);
  } finally {
    worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
  }
}

describe("workspace provider call failures", () => {
  it("tells transport failures apart and keeps the retry hint only where the outcome is unknown", () => {
    const refusal = new PluginWorkerUnavailableError({ pluginId: "plugin-1", workerStatus: null, message: "worker is not running" });
    const cases = [
      [refusal, "worker_unavailable", "Workspace storage provider is not running; retry the same workspace"],
      [new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT, message: "timed out after 310000ms" }), "timeout",
        "Workspace storage operation timed out; retry the same workspace"],
      [new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE, message: "Worker process exited (code=1)" }), "worker_exited",
        "Workspace storage provider stopped during the operation; retry the same workspace"],
      [new Error("Plugin is held for idle sleep"), "transport", "Workspace storage operation is incomplete; retry the same workspace"],
    ] as const;
    for (const [error, kind, message] of cases) {
      const failure = workspaceProviderCallFailure(error);
      expect(failure).toBeInstanceOf(HttpError);
      expect(failure).toMatchObject({ status: 409, message, kind, reason: null, retryable: true,
        details: { code: "workspace_provider_failed", kind, reason: null, retryable: true } });
    }
    // No request reached the worker, so setup's bounded bootstrap retry still recognizes the refusal.
    expect(findPluginWorkerUnavailableError(workspaceProviderCallFailure(refusal))).toBe(refusal);
    expect(workspaceProviderCallFailure(cases[1][0]).cause).toBeUndefined();
  });

  it("passes a provider's closed reason through and says when retrying cannot help", async () => {
    const rejection = await providerRejection(new PluginWorkspaceOperationError("storage_grant_unavailable", "Project mount grants unavailable"));
    expect(rejection.code).toBe(PLUGIN_RPC_ERROR_CODES.WORKER_ERROR);
    const failure = workspaceProviderCallFailure(rejection);
    expect(failure.summary()).toEqual({ kind: "provider", reason: "storage_grant_unavailable", retryable: false });
    expect(failure.message).toBe("Project storage access is unavailable or out of date; reconcile the project's storage before retrying");
    expect(failure.message).not.toContain("retry the same workspace");
    // The provider's message and RPC error never become the run's error or cause.
    expect(failure.message).not.toContain("mount grants");
    expect(failure.cause).toBeUndefined();
  });

  it("gives every reason a fixed message and a retry decision", () => {
    const transient = new Set(["storage_pending", "runtime_unavailable", "remote_incomplete", "context_changed", "deadline_exceeded"]);
    for (const reason of WORKSPACE_OPERATION_FAILURE_REASONS) {
      const failure = workspaceProviderCallFailure(new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "private provider text",
        data: { schema: "paperclip/workspace-operation-error/v1", reason } }));
      expect(failure.summary()).toEqual({ kind: "provider", reason, retryable: transient.has(reason) });
      expect(failure.message).not.toContain("private");
      expect(failure.message.includes("retry the same workspace")).toBe(transient.has(reason));
    }
  });

  it("treats a provider error without a known reason as a reported failure, never parsing its text", async () => {
    for (const error of [new Error("configuration_unavailable"), Object.assign(new Error("x"), { workspaceFailureReason: "private" })]) {
      const failure = workspaceProviderCallFailure(await providerRejection(error));
      expect(failure.summary()).toEqual({ kind: "provider", reason: null, retryable: true });
      expect(failure.message).toBe("Workspace storage provider reported a failure; retry the same workspace");
    }
  });

  it("is found through setup's error wrappers", () => {
    const failure = workspaceProviderCallFailure(new Error("lost"));
    expect(findWorkspaceProviderFailure(new Error("setup failed", { cause: failure }))).toBe(failure);
    expect(findWorkspaceProviderFailure(new Error("other"))).toBeNull();
  });
});
