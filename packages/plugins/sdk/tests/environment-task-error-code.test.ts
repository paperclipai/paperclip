import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { environmentTaskErrorCodeData, PluginEnvironmentTaskError, readEnvironmentTaskErrorCode } from "../src/environment-task-error.js";
import { createRequest, isJsonRpcResponse, JsonRpcCallError, parseMessage, serializeMessage, type JsonRpcResponse } from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

async function invoke(method: string, error: unknown) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({
    async setup() {},
    async onEnvironmentTask() { throw error; },
    async onEnvironmentProbe() { throw error; },
  }) });
  try {
    const response = new Promise<JsonRpcResponse>((resolve) => {
      lines.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcResponse(message)) resolve(message);
      });
    });
    stdin.write(serializeMessage(createRequest(method, { taskId: "task-1", operation: { kind: "describe" } }, "task-test")));
    return await response;
  } finally {
    worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
  }
}

describe("environment task error codes", () => {
  it("does not read the source refusal diagnostic envelope as a code", () => {
    expect(readEnvironmentTaskErrorCode({ data: { schema: "paperclip/environment-task-error/v1", errorCode: "runner_revision_mismatch" } })).toBeNull();
  });
  it("carries runner_revision_mismatch across the real environmentTask RPC", async () => {
    const response = await invoke("environmentTask", new PluginEnvironmentTaskError("runner_revision_mismatch"));
    if (!("error" in response) || !response.error) throw new Error("Expected RPC error");
    expect(response.error.data).toEqual({ schema: "paperclip/environment-task-error-code/v1", errorCode: "runner_revision_mismatch" });
    const callError = new JsonRpcCallError(response.error);
    expect(callError.message).toBe("The installed Runner does not match the expected revision");
    expect(readEnvironmentTaskErrorCode(callError)).toBe("runner_revision_mismatch");
    expect(readEnvironmentTaskErrorCode(new Error("wrapped", { cause: new Error("again", { cause: callError }) })))
      .toBe("runner_revision_mismatch");
  });

  it("never derives a code from message text", async () => {
    const response = await invoke("environmentTask", new Error("The installed Runner does not match the expected revision"));
    expect("error" in response && response.error).not.toHaveProperty("data");
    if (!("error" in response) || !response.error) throw new Error("Expected RPC error");
    expect(readEnvironmentTaskErrorCode(new JsonRpcCallError(response.error))).toBeNull();
  });

  it("only attaches the envelope to environmentTask calls", async () => {
    const response = await invoke("environmentProbe", new PluginEnvironmentTaskError("runner_revision_mismatch"));
    expect("error" in response && response.error).not.toHaveProperty("data");
  });

  it("refuses codes outside the closed set", () => {
    expect(() => new PluginEnvironmentTaskError("private" as never)).toThrow(TypeError);
    expect(environmentTaskErrorCodeData(Object.assign(new Error("forged"), { errorCode: "runner_revision_mismatch" }))).toBeUndefined();
  });

  it.each([null, {}, { data: { schema: "other", errorCode: "runner_revision_mismatch" } },
    { data: { schema: "paperclip/environment-task-error-code/v1", errorCode: "private" } }])(
    "rejects malformed envelopes %j", (value) => {
      expect(readEnvironmentTaskErrorCode(value)).toBeNull();
    });
});
