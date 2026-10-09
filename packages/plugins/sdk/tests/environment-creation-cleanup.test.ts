import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { PluginEnvironmentCreationCleanupError, environmentCreationCleanupErrorData, readEnvironmentCreationCleanupError } from "../src/environment-creation-cleanup.js";
import { createRequest, isJsonRpcResponse, JsonRpcCallError, parseMessage, serializeMessage, type JsonRpcResponse } from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

const ownership = {
  providerLeaseId: "paperclip-create-attempt-1", companyId: "company-1", environmentId: "environment-1",
  runId: "run-1", attemptId: "attempt-1", accountFingerprint: "a".repeat(64),
  labels: { "paperclip-provider": "daytona" },
};
const schema = "paperclip/environment-creation-cleanup/v1";

async function invoke(method: string, error: Error) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({
    async setup() {},
    async onEnvironmentAcquireLease() { throw error; },
    async onEnvironmentProbe() { throw error; },
    async onEnvironmentDestroyLease() { throw error; },
  }) });
  try {
    const response = new Promise<JsonRpcResponse>((resolve) => {
      lines.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcResponse(message)) resolve(message);
      });
    });
    stdin.write(serializeMessage(createRequest(method, {}, "cleanup-test")));
    return await response;
  } finally {
    worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
  }
}

describe("failed environment creation ownership", () => {
  it.each(["environmentAcquireLease", "environmentDestroyLease"])("crosses %s RPC as allowlisted ownership only", async (method) => {
    const cleanup = { ...ownership, accessToken: "secret-token", config: { apiKey: "secret-key" } };
    const error = new PluginEnvironmentCreationCleanupError([new Error("secret-provider-response")], "Cleanup required", cleanup);
    const response = await invoke(method, error);
    expect("error" in response && response.error).toMatchObject({ data: { schema, cleanup: ownership } });
    if (!("error" in response) || !response.error) throw new Error("Expected RPC error");
    expect(readEnvironmentCreationCleanupError(new JsonRpcCallError(response.error))).toEqual(ownership);
    expect(JSON.stringify(response)).not.toContain("secret-");
  });

  it.each(["environmentAcquireLease", "environmentDestroyLease", "environmentProbe"])("does not forward arbitrary error data for %s", async (method) => {
    const response = await invoke(method, Object.assign(new Error("provider failure"), { data: { apiKey: "secret-key", schema, cleanup: ownership } }));
    expect("error" in response && response.error).not.toHaveProperty("data");
  });

  it("only forwards the typed envelope on supported acquisition calls", async () => {
    const response = await invoke("environmentProbe", new PluginEnvironmentCreationCleanupError([], "Cleanup required", ownership));
    expect("error" in response && response.error).not.toHaveProperty("data");
  });

  it.each([
    { providerLeaseId: "../other" }, { companyId: "" }, { environmentId: null }, { attemptId: "a".repeat(201) },
    { runId: "other/run" }, { observedProviderLeaseId: "../other" }, { accountFingerprint: "secret-key" }, { labels: { apiKey: "secret-key" } },
    { labels: { "paperclip-provider": "Bearer secret-key" } }, { labels: [] },
    { labels: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`paperclip-${String.fromCharCode(97 + i)}`, "x"])) },
  ])("rejects malformed evidence %j", (invalid) => {
    const cleanup = { ...ownership, ...invalid } as typeof ownership;
    expect(readEnvironmentCreationCleanupError({ data: { schema, cleanup } })).toBeNull();
    expect(environmentCreationCleanupErrorData(new PluginEnvironmentCreationCleanupError([], "invalid", cleanup))).toBeUndefined();
  });

  it.each([null, {}, { data: { schema: "unknown", cleanup: ownership } }, { data: { schema, cleanup: [] } }])("rejects malformed envelopes %j", (value) => {
    expect(readEnvironmentCreationCleanupError(value)).toBeNull();
  });
});
