import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import {
  environmentTaskOperationSchema,
  environmentTaskResultSchema,
  parseEnvironmentTaskResult,
  type PluginEnvironmentTaskOperation,
  type PluginEnvironmentTaskParams,
  type PluginEnvironmentTaskResult,
} from "../src/environment-tasks.js";
import { createRequest, isJsonRpcResponse, parseMessage, serializeMessage, type JsonRpcResponse } from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "source-run",
  normalizedSessionId: "session", turnId: "turn", itemId: "item" };
const release = { kind: "release", identity } as const;
const resume = { kind: "resume", identity, bootstrapTicket: "fixture-ticket" } as const;
const ownership = {
  kind: "ensure_ownership", operationId: "9df4526f-36c5-4fba-9cf6-3c4fd317f531", identity,
  sourceTaskId: "source-task", sourceGeneration: "source-generation", targetGeneration: "target-generation", policy: "reclaim_if_needed",
} as const;
const description = { kind: "description", taskId: "task", runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } };
const submit = { kind: "submit", projectIds: [], bootstrapTicket: "fixture-ticket", runner: { harness: "claude", protocolMin: 1, protocolMax: 3,
  runnerId: "runner", leaseId: "lease", runId: "run", sessionId: "session", turnId: "turn", itemId: "item" } } as const;
const credentials: [string, unknown, boolean][] = [
  ["a Claude OAuth token", { type: "claude-env", environment: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth" } }, true],
  ["a Claude API key", { type: "claude-env", environment: { ANTHROPIC_API_KEY: "fixture-key" } }, true],
  ["a Codex auth file", { type: "codex-auth-json", authJson: "{\"tokens\":{}}" }, true],
  ["two Claude credentials", { type: "claude-env", environment: { CLAUDE_CODE_OAUTH_TOKEN: "a", ANTHROPIC_API_KEY: "b" } }, false],
  ["no Claude credential", { type: "claude-env", environment: {} }, false],
  ["an unsupported Claude variable", { type: "claude-env", environment: { ANTHROPIC_BASE_URL: "https://example.test" } }, false],
  ["an empty value", { type: "claude-env", environment: { CLAUDE_CODE_OAUTH_TOKEN: "" } }, false],
  ["a NUL byte", { type: "claude-env", environment: { CLAUDE_CODE_OAUTH_TOKEN: "a\0b" } }, false],
  ["an oversized value", { type: "codex-auth-json", authJson: "x".repeat(65_537) }, false],
  ["an unknown type", { type: "gemini-env", environment: { GEMINI_API_KEY: "fixture" } }, false],
  ["an extra field", { type: "codex-auth-json", authJson: "{}", path: "/home/agent/.codex" }, false],
];

async function invoke(operation: unknown, handler: (params: PluginEnvironmentTaskParams) => Promise<PluginEnvironmentTaskResult>) {
  const stdin = new PassThrough(), stdout = new PassThrough(), lines = createInterface({ input: stdout });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({ async setup() {}, onEnvironmentTask: handler }) });
  try {
    const response = new Promise<JsonRpcResponse>(resolve => lines.on("line", line => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) resolve(message);
    }));
    stdin.write(serializeMessage(createRequest("environmentTask", { companyId: "company", taskId: "task",
      runId: "claimant-run", lease: { providerLeaseId: "task" }, operation }, "lifecycle")));
    return await response;
  } finally { worker.stop(); lines.close(); stdin.destroy(); stdout.destroy(); }
}

describe("release and resume task contract", () => {
  it("keeps the capability optional and independent of warm and source recovery support", () => {
    for (const capabilities of [{}, { releaseResumeVersion: 1 }, { warmTaskVersion: 1 },
      { codexSourceRecoveryVersion: 1 }, { acpxSourceRecoveryVersion: 1 }]) {
      expect(environmentTaskResultSchema.parse({ ...description, ...capabilities })).toEqual({ ...description, ...capabilities });
    }
    expect(environmentTaskResultSchema.safeParse({ ...description, releaseResumeVersion: 2 }).success).toBe(false);
    expect(environmentTaskResultSchema.parse({ ...description, resumeCredentialVersion: 1 })).toEqual({ ...description, resumeCredentialVersion: 1 });
    expect(environmentTaskResultSchema.safeParse({ ...description, resumeCredentialVersion: 2 }).success).toBe(false);
  });

  it.each(credentials)("validates %s on resume as on submit", (_label, credential, valid) => {
    expect(environmentTaskOperationSchema.safeParse({ ...submit, credential }).success).toBe(valid);
    expect(environmentTaskOperationSchema.safeParse({ ...resume, credential }).success).toBe(valid);
  });

  it("dispatches a resume credential through the serialized worker RPC", async () => {
    const operation = { ...resume, credential: { type: "claude-env", environment: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth" } } } as const;
    const result = { kind: "resume", taskId: "task", outcome: "resumed" } as const;
    expect(await invoke(operation, async params => {
      expect(params.operation).toEqual(operation);
      return result;
    })).toMatchObject({ result });
  });

  it.each([release, resume])("requires the exact durable identity for $kind", operation => {
    expect(environmentTaskOperationSchema.parse(operation)).toEqual(operation);
    for (const field of Object.keys(identity)) {
      expect(environmentTaskOperationSchema.safeParse({ ...operation, identity: { ...identity, [field]: undefined } }).success).toBe(false);
    }
    expect(environmentTaskOperationSchema.safeParse({ ...operation, identity: { ...identity, targetRunId: "other" } }).success).toBe(false);
    expect(environmentTaskOperationSchema.safeParse({ ...operation, cancelActiveWork: true }).success).toBe(false);
  });

  it.each([undefined, "", "\0", "x".repeat(65_537)])("rejects a missing or invalid resume ticket", bootstrapTicket => {
    expect(environmentTaskOperationSchema.safeParse({ ...resume, bootstrapTicket }).success).toBe(false);
  });

  it("matches each operation to its own closed result and task", () => {
    const released = { kind: "released", taskId: "task" };
    expect(parseEnvironmentTaskResult(release, "task", released)).toEqual(released);
    for (const outcome of ["resumed", "unavailable"]) {
      const result = { kind: "resume", taskId: "task", outcome };
      expect(parseEnvironmentTaskResult(resume, "task", result)).toEqual(result);
      expect(() => parseEnvironmentTaskResult(release, "task", result)).toThrow();
    }
    for (const operation of [release, resume]) {
      expect(() => parseEnvironmentTaskResult(operation, "task", { kind: "accepted", taskId: "task" })).toThrow();
      const result = operation.kind === "release" ? released : { kind: "resume", taskId: "task", outcome: "resumed" };
      expect(() => parseEnvironmentTaskResult(operation, "other-task", result)).toThrow();
    }
    expect(() => parseEnvironmentTaskResult(resume, "task", { kind: "resume", taskId: "task", outcome: "unknown" })).toThrow();
    expect(environmentTaskResultSchema.safeParse({ ...released, retained: true }).success).toBe(false);
    expect(environmentTaskResultSchema.safeParse({ kind: "resume", taskId: "task", outcome: "resumed", bootstrapTicket: "fixture-ticket" }).success).toBe(false);
  });

  it.each([release, resume])("dispatches $kind through the serialized worker RPC", async operation => {
    const result: PluginEnvironmentTaskResult = operation.kind === "release" ? { kind: "released", taskId: "task" }
      : { kind: "resume", taskId: "task", outcome: "resumed" };
    const response = await invoke(operation, async params => {
      expect(params.operation).toEqual(operation);
      expect(params.runId).toBe("claimant-run");
      return result;
    });
    expect(response).toMatchObject({ result });
  });

  it("passes known absence through RPC without treating it as a successful reservation", async () => {
    expect(await invoke(resume, async () => ({ kind: "resume", taskId: "task", outcome: "unavailable" })))
      .toMatchObject({ result: { kind: "resume", taskId: "task", outcome: "unavailable" } });
  });

  it("binds a declarative ownership response to the exact worker request", async () => {
    for (const status of ["pending", "ready"] as const) {
      const result = { kind: "ownership", status, taskId: "task", operationId: ownership.operationId,
        targetGeneration: ownership.targetGeneration } as const;
      expect(await invoke(ownership, async params => {
        expect(params.operation).toEqual(ownership);
        return result;
      })).toMatchObject({ result });
      for (const changes of [
        { taskId: "another-task" },
        { operationId: "1f083ad0-a357-4f14-ad46-e9df981845b5" },
        { targetGeneration: "stale-generation" },
      ]) {
        expect(await invoke(ownership, async () => ({ ...result, ...changes }))).toHaveProperty("error");
      }
    }
  });

  it.each(["source mismatch", "claim conflict", "authentication failed", "transport timeout"])("keeps %s as an RPC error", async message => {
    expect(await invoke(resume, async () => { throw new Error(message); })).toHaveProperty("error");
  });

  it("rejects cross-task and wrong-kind replies at the worker boundary", async () => {
    for (const result of [{ kind: "resume", taskId: "other", outcome: "resumed" }, { kind: "accepted", taskId: "task" }] as PluginEnvironmentTaskResult[]) {
      expect(await invoke(resume, async () => result)).toHaveProperty("error");
    }
  });

  it("preserves legacy describe and stop replies through RPC", async () => {
    expect(await invoke({ kind: "describe" }, async () => description as PluginEnvironmentTaskResult)).toMatchObject({ result: description });
    const operation: PluginEnvironmentTaskOperation = { kind: "stop" };
    expect(await invoke(operation, async () => ({ kind: "accepted", taskId: "task" })))
      .toMatchObject({ result: { kind: "accepted", taskId: "task" } });
  });
});
