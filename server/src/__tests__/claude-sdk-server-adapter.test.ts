import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  executeClaudeViaSdkServer,
  testClaudeSdkServerEnvironment,
} from "../adapters/claude-sdk-server.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

type MockServerOptions = {
  authConfigured?: boolean;
};

async function startMockClaudeSdkServer(options: MockServerOptions = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const receivedMethods: string[] = [];
  const receivedAuthorizationHeaders: string[] = [];
  const executePayloads: Array<Record<string, unknown>> = [];

  wss.on("connection", (ws, req) => {
    if (typeof req.headers.authorization === "string") {
      receivedAuthorizationHeaders.push(req.headers.authorization);
    }
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const method = typeof message.method === "string" ? message.method : null;
      if (!method) return;
      receivedMethods.push(method);

      if (method === "initialize") {
        ws.send(
          JSON.stringify({
            id: message.id,
            result: {
              serverInfo: {
                name: "paperclip-claude-sdk-server",
                version: "test",
              },
            },
          }),
        );
        return;
      }

      if (method === "health/check") {
        ws.send(
          JSON.stringify({
            id: message.id,
            result: {
              bridge: "paperclip-claude-sdk-server",
              authConfigured: options.authConfigured ?? true,
            },
          }),
        );
        return;
      }

      if (method === "run/execute") {
        executePayloads.push(message);
        ws.send(
          JSON.stringify({
            method: "run/log",
            params: {
              stream: "stdout",
              chunk: `${JSON.stringify({
                type: "system",
                subtype: "init",
                session_id: "claude-session-1",
                model: "claude-sonnet-4-6",
              })}\n`,
            },
          }),
        );
        ws.send(
          JSON.stringify({
            method: "run/log",
            params: {
              stream: "stdout",
              chunk: `${JSON.stringify({
                type: "assistant",
                session_id: "claude-session-1",
                message: {
                  content: [{ type: "text", text: "hello from remote claude" }],
                },
              })}\n`,
            },
          }),
        );
        ws.send(
          JSON.stringify({
            method: "run/log",
            params: {
              stream: "stdout",
              chunk: `${JSON.stringify({
                type: "result",
                session_id: "claude-session-1",
                subtype: "success",
                is_error: false,
                result: "hello from remote claude",
                usage: {
                  input_tokens: 9,
                  cache_read_input_tokens: 1,
                  output_tokens: 3,
                },
              })}\n`,
            },
          }),
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            result: {
              exitCode: 0,
              signal: null,
              timedOut: false,
              errorMessage: null,
              sessionId: "claude-session-1",
              sessionParams: { sessionId: "claude-session-1", cwd: "/srv/claude" },
              sessionDisplayId: "claude-session-1",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              billingType: "unknown",
              costUsd: null,
              usage: {
                inputTokens: 9,
                cachedInputTokens: 1,
                outputTokens: 3,
              },
              resultJson: {
                type: "result",
                session_id: "claude-session-1",
                subtype: "success",
                is_error: false,
                result: "hello from remote claude",
              },
              summary: "hello from remote claude",
              clearSession: false,
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}`,
    receivedMethods,
    receivedAuthorizationHeaders,
    executePayloads,
    async close() {
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function createExecutionContext(config: Record<string, unknown>, runtime?: Partial<AdapterExecutionContext["runtime"]>) {
  const logs = {
    stdout: [] as string[],
    stderr: [] as string[],
  };

  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Remote Claude Agent",
      adapterType: "claude_local",
      adapterConfig: config,
    },
    runtime: {
      sessionId: "claude-session-previous",
      sessionParams: { sessionId: "claude-session-previous", cwd: "/srv/claude" },
      sessionDisplayId: "claude-session-previous",
      taskKey: "issue:1",
      ...runtime,
    },
    config,
    context: { issueId: "issue-1" },
    authToken: "paperclip-api-key",
    onLog: async (stream, chunk) => {
      logs[stream].push(chunk);
    },
    onMeta: async () => {},
  };

  return { ctx, logs };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) await close();
  }
});

describe("claude sdk server adapter", () => {
  it("executes a remote Claude run over websocket and forwards stdout stream events", async () => {
    const mock = await startMockClaudeSdkServer();
    cleanup.push(() => mock.close());

    const { ctx, logs } = createExecutionContext({
      agentSdkServerUrl: mock.url,
      model: "claude-sonnet-4-6",
      cwd: "/srv/claude",
      dangerouslySkipPermissions: true,
    });

    const result = await executeClaudeViaSdkServer(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("claude-session-1");
    expect(result.summary).toBe("hello from remote claude");
    expect(result.usage).toEqual({
      inputTokens: 9,
      cachedInputTokens: 1,
      outputTokens: 3,
    });
    expect(logs.stdout.join("")).toContain('"type":"assistant"');
    expect(logs.stdout.join("")).toContain("hello from remote claude");
    expect(mock.receivedMethods).toEqual(expect.arrayContaining(["initialize", "run/execute"]));

    const executeMessage = mock.executePayloads[0] ?? {};
    const params = (executeMessage.params as Record<string, unknown>) ?? {};
    const forwardedConfig = (params.config as Record<string, unknown>) ?? {};
    const forwardedAgent = (params.agent as Record<string, unknown>) ?? {};
    const forwardedAgentConfig =
      forwardedAgent.adapterConfig && typeof forwardedAgent.adapterConfig === "object"
        ? (forwardedAgent.adapterConfig as Record<string, unknown>)
        : {};
    expect(forwardedConfig.agentSdkServerUrl).toBeUndefined();
    expect(forwardedConfig.agentSdkServerBearerToken).toBeUndefined();
    expect(forwardedAgentConfig.agentSdkServerUrl).toBeUndefined();
    expect(forwardedConfig.env).toMatchObject({
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_API_URL: "http://localhost:3100",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_API_KEY: "paperclip-api-key",
    });
  });

  it("forwards local agent instructions contents to the remote bridge", async () => {
    const mock = await startMockClaudeSdkServer();
    cleanup.push(() => mock.close());

    const instructionsPath = "/tmp/paperclip-claude-remote-instructions.md";
    await fs.writeFile(instructionsPath, "Remote bridge instructions go here.\n", "utf8");
    cleanup.push(async () => {
      await fs.rm(instructionsPath, { force: true });
    });

    const { ctx } = createExecutionContext({
      agentSdkServerUrl: mock.url,
      instructionsFilePath: instructionsPath,
      dangerouslySkipPermissions: true,
    });

    const result = await executeClaudeViaSdkServer(ctx);

    expect(result.exitCode).toBe(0);
    const executeMessage = mock.executePayloads[0] ?? {};
    const params = (executeMessage.params as Record<string, unknown>) ?? {};
    const resolvedInstructions =
      params.resolvedInstructions && typeof params.resolvedInstructions === "object"
        ? (params.resolvedInstructions as Record<string, unknown>)
        : {};
    expect(resolvedInstructions.sourcePath).toBe(instructionsPath);
    expect(resolvedInstructions.contents).toContain("Remote bridge instructions go here.");
  });

  it("sends Authorization bearer auth only when a remote token is configured", async () => {
    const mock = await startMockClaudeSdkServer();
    cleanup.push(() => mock.close());

    const { ctx } = createExecutionContext({
      agentSdkServerUrl: mock.url,
      agentSdkServerBearerToken: "paperclip-remote-token",
      dangerouslySkipPermissions: true,
    });

    const result = await executeClaudeViaSdkServer(ctx);

    expect(result.exitCode).toBe(0);
    expect(mock.receivedAuthorizationHeaders).toEqual(["Bearer paperclip-remote-token"]);
  });

  it("probes remote Claude SDK bridge connectivity and health", async () => {
    const mock = await startMockClaudeSdkServer({ authConfigured: true });
    cleanup.push(() => mock.close());

    const result = await testClaudeSdkServerEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        agentSdkServerUrl: mock.url,
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "claude_sdk_server_connect_ok")).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_sdk_server_health_ok")).toBe(true);
  });
});
