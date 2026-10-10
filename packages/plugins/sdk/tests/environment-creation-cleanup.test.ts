import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { PluginEnvironmentCreationCleanupError, environmentCreationCleanupErrorData, readEnvironmentCreationCleanupError, readEnvironmentAcquisitionDiagnostic } from "../src/environment-creation-cleanup.js";
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


describe("acquisition failure observations", () => {
  const diagnostic = { phase: "shell", elapsedMs: 300_000, budgetMs: 300_000 } as const;

  it("crosses the real acquire RPC without provider causes or ownership in the diagnostic", async () => {
    const input = { ...diagnostic, url: "private-url", command: "private-command", token: "private-token" };
    const response = await invoke("environmentAcquireLease", new PluginEnvironmentCreationCleanupError(
      [new Error("private-provider-cause")], "Cleanup required", ownership, input,
    ));
    if (!("error" in response) || !response.error) throw new Error("Expected RPC error");
    expect(response.error.data).toEqual({ schema, cleanup: ownership, acquisitionDiagnostic: diagnostic });
    expect(readEnvironmentAcquisitionDiagnostic(new JsonRpcCallError(response.error))).toEqual(diagnostic);
    expect(JSON.stringify(response)).not.toContain("private-");
    // The old ownership reader and envelope version remain valid.
    expect(readEnvironmentCreationCleanupError(new JsonRpcCallError(response.error))).toEqual(ownership);
    expect(readEnvironmentAcquisitionDiagnostic({ data: { schema, cleanup: ownership } })).toBeNull();
  });

  it.each(["environmentDestroyLease", "environmentProbe"])("omits acquisition diagnostics from %s", async method => {
    const response = await invoke(method, new PluginEnvironmentCreationCleanupError([], "Cleanup required", ownership, diagnostic));
    expect("error" in response && response.error).not.toHaveProperty("data.acquisitionDiagnostic");
    if (method === "environmentDestroyLease") expect("error" in response && response.error?.data).toEqual({ schema, cleanup: ownership });
  });

  it.each([
    null, [], {}, { ...diagnostic, phase: "cleanup" }, { ...diagnostic, phase: "private-command" },
    { ...diagnostic, elapsedMs: -1 }, { ...diagnostic, elapsedMs: NaN }, { ...diagnostic, elapsedMs: Infinity },
    { ...diagnostic, elapsedMs: 604_800_001 }, { ...diagnostic, elapsedMs: 0.5 }, { ...diagnostic, elapsedMs: "300000" },
    { ...diagnostic, budgetMs: 0 }, { ...diagnostic, budgetMs: 86_400_001 }, { ...diagnostic, budgetMs: Infinity },
    { ...diagnostic, budgetMs: "private-token" }, Object.create(diagnostic),
  ])("omits malformed optional diagnostics without rejecting cleanup (%j)", invalid => {
    const error = new PluginEnvironmentCreationCleanupError([], "Cleanup required", ownership, invalid as typeof diagnostic);
    expect(readEnvironmentAcquisitionDiagnostic(error)).toBeNull();
    expect(environmentCreationCleanupErrorData(error, true)).toEqual({ schema, cleanup: ownership });
  });

  it("omits accessor diagnostics without invoking their getters", () => {
    let reads = 0;
    const invalid = Object.defineProperty({ ...diagnostic }, "phase", { get() { reads++; throw new Error("private-getter"); } });
    const error = new PluginEnvironmentCreationCleanupError([], "Cleanup required", ownership, invalid);
    expect(environmentCreationCleanupErrorData(error, true)).toEqual({ schema, cleanup: ownership });
    expect(reads).toBe(0);
  });

  it("does not read an inherited or accessor acquisitionDiagnostic envelope field", () => {
    let reads = 0;
    const accessor = Object.defineProperty({ schema, cleanup: ownership }, "acquisitionDiagnostic", {
      get() { reads++; throw new Error("private-getter"); },
    });
    const inherited = Object.assign(Object.create({ acquisitionDiagnostic: diagnostic }), { schema, cleanup: ownership });
    for (const data of [accessor, inherited]) {
      expect(readEnvironmentAcquisitionDiagnostic({ data })).toBeNull();
      expect(readEnvironmentCreationCleanupError({ data })).toEqual(ownership);
    }
    const typed = new PluginEnvironmentCreationCleanupError([], "Cleanup required", ownership);
    Object.defineProperty(typed, "acquisitionDiagnostic", { get() { reads++; throw new Error("private-getter"); } });
    expect(environmentCreationCleanupErrorData(typed, true)).toEqual({ schema, cleanup: ownership });
    expect(reads).toBe(0);
  });

  it("does not serialize forged error properties or accept invalid ownership with valid diagnostics", async () => {
    const forged = Object.assign(new Error("Cleanup required"), { acquisitionDiagnostic: diagnostic,
      data: { schema, cleanup: ownership, acquisitionDiagnostic: diagnostic } });
    const response = await invoke("environmentAcquireLease", forged);
    expect("error" in response && response.error).not.toHaveProperty("data");
    expect(readEnvironmentAcquisitionDiagnostic({ data: { schema, cleanup: { ...ownership, runId: "private/path" }, acquisitionDiagnostic: diagnostic } })).toBeNull();
  });
});
