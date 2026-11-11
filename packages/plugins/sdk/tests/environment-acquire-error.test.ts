import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { readEnvironmentAcquireErrorDiagnostic } from "../src/environment-acquire-error.js";
import { PluginEnvironmentCreationCleanupError, readEnvironmentCreationCleanupError } from "../src/environment-creation-cleanup.js";
import { createRequest, isJsonRpcResponse, JsonRpcCallError, parseMessage, serializeMessage, type JsonRpcResponse } from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

async function acquire(error: unknown) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({
    async setup() {},
    async onEnvironmentAcquireLease() { throw error; },
  }) });
  try {
    const response = new Promise<JsonRpcResponse>((resolve) => {
      lines.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcResponse(message)) resolve(message);
      });
    });
    stdin.write(serializeMessage(createRequest("environmentAcquireLease", {}, "acquire-test")));
    const result = await response;
    if (!("error" in result) || !result.error) throw new Error("Expected RPC error");
    return new JsonRpcCallError(result.error);
  } finally {
    worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
  }
}

const cleanup = {
  providerLeaseId: "paperclip-create-05f81d77", companyId: "company-1", environmentId: "environment-1",
  attemptId: "05f81d77", accountFingerprint: "a".repeat(64), labels: { "paperclip-provider": "daytona" },
};

describe("environment acquisition refusal diagnostics", () => {
  it("carries a create status across the real acquire RPC without provider text", async () => {
    const providerError = Object.assign(new Error("Bad gateway at https://private.example/api"), { statusCode: 502 });
    const callError = await acquire(providerError);
    expect(readEnvironmentAcquireErrorDiagnostic(callError)).toEqual({ httpStatus: 502 });
    expect(JSON.stringify(callError.data)).not.toContain("private.example");
  });

  it("reports the create status, not the compensating lookup's, and keeps the cleanup envelope", async () => {
    const createError = Object.assign(new Error("create failed"), { statusCode: 502 });
    const lookupError = Object.assign(new Error("not found"), { statusCode: 404 });
    const callError = await acquire(new PluginEnvironmentCreationCleanupError([createError, lookupError],
      "Daytona sandbox creation failed (HTTP 502); cleanup could not be confirmed for paperclip-create-05f81d77", cleanup));
    expect(readEnvironmentAcquireErrorDiagnostic(callError)).toEqual({ httpStatus: 502 });
    // The ownership envelope that drives cleanup reconciliation is unchanged.
    expect(readEnvironmentCreationCleanupError(callError)).toMatchObject({ providerLeaseId: cleanup.providerLeaseId, attemptId: cleanup.attemptId });
  });

  it("carries a closed connection errno and omits unstructured failures", async () => {
    expect(readEnvironmentAcquireErrorDiagnostic(await acquire(Object.assign(new Error("reset"), { code: "ECONNRESET" }))))
      .toEqual({ errorCode: "ECONNRESET" });
    const plain = await acquire(new Error("Daytona sandbox creation failed (HTTP 502)"));
    expect(plain.data).toBeUndefined();
    expect(readEnvironmentAcquireErrorDiagnostic(plain)).toBeNull();
  });

  it("rejects forged or out-of-range envelopes", () => {
    const forged = (data: unknown) => Object.assign(new Error("x"), { data });
    expect(readEnvironmentAcquireErrorDiagnostic(forged({ schema: "other", providerDiagnostic: { httpStatus: 502 } }))).toBeNull();
    expect(readEnvironmentAcquireErrorDiagnostic(forged({ schema: "paperclip/environment-acquire-error/v1",
      providerDiagnostic: { httpStatus: 9000, errorCode: "EVIL" } }))).toBeNull();
  });
});
