import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { environmentTaskErrorData, readEnvironmentTaskErrorDiagnostic } from "../src/environment-task-error.js";
import { createRequest, isJsonRpcResponse, JsonRpcCallError, parseMessage, serializeMessage, type JsonRpcResponse } from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

const submit = { kind: "submit", preparedLaunchId: "configuration", projectIds: [], bootstrapTicket: "fixture-ticket", resumeFrom: "source-task",
  runner: { protocolMin: 1, protocolMax: 3, harness: "codex", runnerId: "runner", leaseId: "lease", runId: "run",
    sessionId: "session", turnId: "turn", itemId: "item" } };
const failure = (reason = "unresolved_operation") => Object.assign(new Error("synthetic-private-provider-text"), {
  status: 409, code: "SESSION_STATE_UNAVAILABLE", reason, operationId: "forged-operation", callId: "forged-call",
});

async function invoke(error: unknown, operation: unknown = submit) {
  const stdin = new PassThrough(), stdout = new PassThrough(), lines = createInterface({ input: stdout });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({ async setup() {}, async onEnvironmentTask() { throw error; } }) });
  try {
    const response = new Promise<JsonRpcResponse>(resolve => lines.on("line", line => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) resolve(message);
    }));
    stdin.write(serializeMessage(createRequest("environmentTask", { taskId: "task", operation }, "task-error")));
    const reply = await response;
    if (!("error" in reply) || !reply.error) throw new Error("Expected RPC error");
    return reply.error;
  } finally { worker.stop(); lines.close(); stdin.destroy(); stdout.destroy(); }
}

describe("source task refusal diagnostics", () => {
  it.each(["unresolved_operation", "source_state_unverified"])("carries only the closed %s diagnostic across real worker RPC", async reason => {
    const reply = await invoke(failure(reason));
    expect(readEnvironmentTaskErrorDiagnostic(new JsonRpcCallError(reply))).toEqual({ httpStatus: 409, errorCode: "SESSION_STATE_UNAVAILABLE", reason });
    expect(reply.message).toBe("Plugin Runner source state unavailable");
    expect(JSON.stringify(reply)).not.toMatch(/synthetic-private|forged/);
  });

  it.each([{ kind: "status" }, { ...submit, resumeFrom: undefined }])("does not attach the envelope outside a source submit", async operation => {
    expect(await invoke(failure(), operation)).not.toHaveProperty("data");
  });

  it.each([null, {}, { ...failure(), status: 503 }, { ...failure(), code: "OTHER" }, { ...failure(), reason: "provider text" }])(
    "rejects unrecognized failures %j", error => { expect(environmentTaskErrorData(error)).toBeUndefined(); },
  );

  it("does not trust a malformed envelope or copy its extra fields", () => {
    expect(readEnvironmentTaskErrorDiagnostic({ data: { schema: "foreign", diagnostic: failure() } })).toBeNull();
    expect(readEnvironmentTaskErrorDiagnostic({ data: { schema: "paperclip/environment-task-error/v1", diagnostic: {
      httpStatus: 409, errorCode: "SESSION_STATE_UNAVAILABLE", reason: "provider text",
    } } })).toBeNull();
    const data = environmentTaskErrorData(failure())!;
    expect(readEnvironmentTaskErrorDiagnostic({ data: { ...data, diagnostic: { ...data.diagnostic, operationId: "forged" } } }))
      .toEqual(data.diagnostic);
    expect(environmentTaskErrorData(Object.defineProperty({}, "status", { get() { throw new Error("unsafe getter"); } }))).toBeUndefined();
  });
});
