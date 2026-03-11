import { afterEach, describe, expect, it } from "vitest";
import { execute, setSandboxProviderFactoryForTests } from "./execute.js";

describe("sandbox adapter execute", () => {
  afterEach(() => {
    setSandboxProviderFactoryForTests(null);
  });

  it("runs the inner codex agent, wraps stdout, and persists sandbox session params", async () => {
    const stdoutEvents = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "sandbox hello" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 },
      }),
    ].join("\n");

    const execCalls: Array<{ command: string; stdin?: string }> = [];

    setSandboxProviderFactoryForTests(() => ({
      type: "cloudflare",
      async create(opts) {
        return {
          id: opts.sandboxId,
          async exec(command, execOpts = {}) {
            execCalls.push({ command, stdin: execOpts.stdin });
            await execOpts.onStdout?.(`${stdoutEvents}\n`);
            return { exitCode: 0, signal: null, timedOut: false };
          },
          async writeFile() {},
          async readFile() {
            return "";
          },
          async status() {
            return { status: "running", endpoint: null };
          },
          async destroy() {},
        };
      },
      async reconnect(id) {
        return {
          id,
          async exec() {
            return { exitCode: 0, signal: null, timedOut: false };
          },
          async writeFile() {},
          async readFile() {
            return "";
          },
          async status() {
            return { status: "running", endpoint: null };
          },
          async destroy() {},
        };
      },
      async testConnection() {
        return { ok: true };
      },
    }));

    const logs: string[] = [];

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Sandbox Agent",
        adapterType: "sandbox",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        providerType: "cloudflare",
        sandboxAgentType: "codex_local",
        keepAlive: true,
        promptTemplate: "Do the thing",
        providerConfig: {
          baseUrl: "https://example.workers.dev",
          namespace: "paperclip",
        },
      },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onMeta: async () => {},
      authToken: "jwt-token",
    });

    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]?.command).toBe('sh -lc \'mkdir -p \'"\'"\'/workspace\'"\'"\'\'');
    expect(execCalls[1]?.stdin).toContain("Do the thing");
    expect(result.summary).toBe("sandbox hello");
    expect(result.usage).toEqual({
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 4,
    });
    expect(result.sessionParams).toEqual({
      sandboxId: expect.any(String),
      agentType: "codex_local",
      cliSession: { sessionId: "thread-123" },
    });
    expect(logs.join("")).toContain('"type":"paperclip.sandbox.stdout"');
    expect(logs.join("")).toContain('"agentType":"codex_local"');
  });

  it("runs sandbox bootstrap before invoking the inner agent", async () => {
    const execCalls: string[] = [];

    setSandboxProviderFactoryForTests(() => ({
      type: "e2b",
      async create(opts) {
        return {
          id: opts.sandboxId,
          async exec(command, execOpts = {}) {
            execCalls.push(command);
            if (command === "sh -lc 'echo bootstrap-ready >/tmp/bootstrap.txt'") {
              return { exitCode: 0, signal: null, timedOut: false };
            }
            await execOpts.onStdout?.(`${JSON.stringify({ type: "thread.started", thread_id: "thread-bootstrap" })}\n`);
            await execOpts.onStdout?.(
              `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "bootstrapped" } })}\n`,
            );
            return { exitCode: 0, signal: null, timedOut: false };
          },
          async writeFile() {},
          async readFile() {
            return "";
          },
          async status() {
            return { status: "running", endpoint: null };
          },
          async destroy() {},
        };
      },
      async reconnect(id) {
        return {
          id,
          async exec() {
            return { exitCode: 0, signal: null, timedOut: false };
          },
          async writeFile() {},
          async readFile() {
            return "";
          },
          async status() {
            return { status: "running", endpoint: null };
          },
          async destroy() {},
        };
      },
      async testConnection() {
        return { ok: true };
      },
    }));

    const result = await execute({
      runId: "run-bootstrap",
      agent: {
        id: "agent-bootstrap",
        companyId: "company-1",
        name: "Sandbox Agent",
        adapterType: "sandbox",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        providerType: "e2b",
        sandboxAgentType: "codex_local",
        keepAlive: false,
        promptTemplate: "Do the thing",
        bootstrapCommand: "sh -lc 'echo bootstrap-ready >/tmp/bootstrap.txt'",
        providerConfig: {
          template: "codex",
        },
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      authToken: "jwt-token",
    });

    expect(execCalls[0]).toBe('sh -lc \'mkdir -p \'"\'"\'/home/user/workspace\'"\'"\'\'');
    expect(execCalls[1]).toBe("sh -lc 'echo bootstrap-ready >/tmp/bootstrap.txt'");
    expect(execCalls).toHaveLength(3);
    expect(result.summary).toBe("bootstrapped");
  });

  it("treats successful claude result events as success, not failure", async () => {
    setSandboxProviderFactoryForTests(() => ({
      type: "e2b",
      async create(opts) {
        return {
          id: opts.sandboxId,
          async exec(_command, execOpts = {}) {
            await execOpts.onStdout?.(
              [
                JSON.stringify({
                  type: "system",
                  subtype: "init",
                  session_id: "claude-session-1",
                  model: "claude-sonnet-4-20250514",
                }),
                JSON.stringify({
                  type: "assistant",
                  session_id: "claude-session-1",
                  message: {
                    content: [
                      { type: "text", text: "sandbox claude ok" },
                    ],
                  },
                }),
                JSON.stringify({
                  type: "result",
                  subtype: "success",
                  session_id: "claude-session-1",
                  result: "sandbox claude ok",
                  usage: {
                    input_tokens: 5,
                    cache_read_input_tokens: 1,
                    output_tokens: 2,
                  },
                  total_cost_usd: 0.25,
                }),
                "",
              ].join("\n"),
            );
            return { exitCode: 0, signal: null, timedOut: false };
          },
          async writeFile() {},
          async readFile() {
            return "";
          },
          async status() {
            return { status: "running", endpoint: null };
          },
          async destroy() {},
        };
      },
      async reconnect(id) {
        return {
          id,
          async exec() {
            return { exitCode: 0, signal: null, timedOut: false };
          },
          async writeFile() {},
          async readFile() {
            return "";
          },
          async status() {
            return { status: "running", endpoint: null };
          },
          async destroy() {},
        };
      },
      async testConnection() {
        return { ok: true };
      },
    }));

    const result = await execute({
      runId: "run-claude",
      agent: {
        id: "agent-claude",
        companyId: "company-1",
        name: "Sandbox Claude",
        adapterType: "sandbox",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        providerType: "e2b",
        sandboxAgentType: "claude_local",
        keepAlive: false,
        promptTemplate: "Do the thing",
        providerConfig: {
          template: "base",
        },
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      authToken: "jwt-token",
    });

    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("sandbox claude ok");
    expect(result.costUsd).toBe(0.25);
    expect(result.usage).toEqual({
      inputTokens: 5,
      cachedInputTokens: 1,
      outputTokens: 2,
    });
  });
});
