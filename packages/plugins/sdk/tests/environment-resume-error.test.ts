import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { environmentResumeErrorData, readEnvironmentResumeErrorDiagnostic } from "../src/environment-resume-error.js";
import { createRequest, isJsonRpcResponse, JsonRpcCallError, parseMessage, serializeMessage, type JsonRpcResponse } from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

async function invoke(method: string, error: unknown) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({
    async setup() {},
    async onEnvironmentResumeLease() { throw error; },
    async onEnvironmentProbe() { throw error; },
  }) });
  try {
    const response = new Promise<JsonRpcResponse>((resolve) => {
      lines.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcResponse(message)) resolve(message);
      });
    });
    stdin.write(serializeMessage(createRequest(method, {}, "resume-test")));
    return await response;
  } finally {
    worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
  }
}

describe("environment resume refusal diagnostics", () => {
  it("carries the provider HTTP status and errno across the real resume RPC without provider text", async () => {
    const providerError = Object.assign(new Error("Sandbox private-id is stopping at /home/private"), { statusCode: 409 });
    const wrapped = Object.assign(new Error("resume failed", { cause: Object.assign(providerError, { cause: { code: "ECONNRESET" } }) }), {});
    const response = await invoke("environmentResumeLease", wrapped);
    if (!("error" in response) || !response.error) throw new Error("Expected RPC error");
    const callError = new JsonRpcCallError(response.error);
    // The JSON-RPC error itself has only a numeric RPC code; the status needs the envelope.
    expect(callError).not.toHaveProperty("status");
    expect(readEnvironmentResumeErrorDiagnostic(callError)).toEqual({ httpStatus: 409, errorCode: "ECONNRESET" });
    expect(JSON.stringify(response.error.data)).not.toContain("private");
  });

  it("reads a response status and omits the envelope when nothing safe is known", async () => {
    expect(environmentResumeErrorData({ response: { status: 503 } })).toEqual({
      schema: "paperclip/environment-resume-error/v1", diagnostic: { httpStatus: 503 } });
    const response = await invoke("environmentResumeLease", Object.assign(new Error("private"), { code: "PRIVATE_CODE", status: 42 }));
    expect("error" in response && response.error).not.toHaveProperty("data");
  });

  it("only attaches the envelope to resume calls", async () => {
    const response = await invoke("environmentProbe", Object.assign(new Error("x"), { status: 409 }));
    expect("error" in response && response.error).not.toHaveProperty("data");
  });

  it.each([null, {}, { data: { schema: "other", diagnostic: { httpStatus: 409 } } },
    { data: { schema: "paperclip/environment-resume-error/v1", diagnostic: { httpStatus: 9000, errorCode: "secret" } } }])(
    "rejects malformed envelopes %j", (value) => {
      expect(readEnvironmentResumeErrorDiagnostic(value)).toBeNull();
    });
});
