import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  executeCodexViaAppServer,
  testCodexAppServerEnvironment,
} from "../adapters/codex-app-server.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

type MockServerOptions = {
  failResume?: boolean;
  authMethod?: string | null;
  requiresOpenaiAuth?: boolean | null;
  turnStatus?: "completed" | "failed";
  turnErrorMessage?: string;
};

function createThread(id: string, cwd = "/srv/paperclip") {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "Remote Codex thread",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: "test",
    source: "codex app-server",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function createTurn(
  id: string,
  status: "inProgress" | "completed" | "failed" = "inProgress",
  errorMessage: string | null = null,
) {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error: errorMessage ? { message: errorMessage } : null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 100,
  };
}

async function startMockCodexAppServer(options: MockServerOptions = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const receivedMethods: string[] = [];
  const receivedAuthorizationHeaders: string[] = [];
  const receivedTurnInputs: string[] = [];

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
              userAgent: "codex-test",
              codexHome: "/tmp/codex",
              platformFamily: "unix",
              platformOs: "linux",
            },
          }),
        );
        return;
      }

      if (method === "initialized") {
        return;
      }

      if (method === "getAuthStatus") {
        ws.send(
          JSON.stringify({
            id: message.id,
            result: {
              authMethod: options.authMethod ?? "apikey",
              authToken: null,
              requiresOpenaiAuth: options.requiresOpenaiAuth ?? true,
            },
          }),
        );
        return;
      }

      if (method === "thread/resume") {
        if (options.failResume) {
          ws.send(
            JSON.stringify({
              id: message.id,
              error: {
                code: -32001,
                message: "thread dead-thread not found",
              },
            }),
          );
          return;
        }
        ws.send(
          JSON.stringify({
            id: message.id,
            result: {
              thread: createThread("thread-resumed"),
            },
          }),
        );
        return;
      }

      if (method === "thread/start") {
        ws.send(
          JSON.stringify({
            id: message.id,
            result: {
              thread: createThread("thread-started"),
              model: "gpt-5.4",
              modelProvider: "openai",
              serviceTier: null,
              cwd: "/srv/paperclip",
              instructionSources: [],
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: { type: "dangerFullAccess" },
              reasoningEffort: null,
            },
          }),
        );
        ws.send(
          JSON.stringify({
            method: "thread/started",
            params: {
              thread: createThread("thread-started"),
            },
          }),
        );
        return;
      }

      if (method === "turn/start") {
        const params =
          typeof message.params === "object" && message.params !== null
            ? (message.params as Record<string, unknown>)
            : null;
        const input = Array.isArray(params?.input) ? params.input : [];
        const firstInput =
          input.length > 0 && typeof input[0] === "object" && input[0] !== null
            ? (input[0] as Record<string, unknown>)
            : null;
        if (typeof firstInput?.text === "string") {
          receivedTurnInputs.push(firstInput.text);
        }
        const turnStatus = options.turnStatus ?? "completed";
        const turnErrorMessage = options.turnErrorMessage ?? "Codex App Server turn failed";
        ws.send(
          JSON.stringify({
            id: message.id,
            result: {
              turn: createTurn("turn-1"),
            },
          }),
        );
        ws.send(JSON.stringify({ method: "turn/started", params: { threadId: "thread-started", turnId: "turn-1" } }));
        ws.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-started",
              turnId: "turn-1",
              completedAtMs: Date.now(),
              item: {
                id: "msg-1",
                type: "agentMessage",
                text: "hello from remote codex",
                phase: null,
                memoryCitation: null,
              },
            },
          }),
        );
        ws.send(
          JSON.stringify({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-started",
              turnId: "turn-1",
              tokenUsage: {
                total: {
                  totalTokens: 16,
                  inputTokens: 10,
                  cachedInputTokens: 2,
                  outputTokens: 4,
                  reasoningOutputTokens: 0,
                },
                last: {
                  totalTokens: 16,
                  inputTokens: 10,
                  cachedInputTokens: 2,
                  outputTokens: 4,
                  reasoningOutputTokens: 0,
                },
                modelContextWindow: 200000,
              },
            },
          }),
        );
        ws.send(
          JSON.stringify({
            method: "turn/completed",
            params: {
              threadId: "thread-started",
              turn: createTurn(
                "turn-1",
                turnStatus,
                turnStatus === "failed" ? turnErrorMessage : null,
              ),
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
    receivedTurnInputs,
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
      name: "Remote Agent",
      adapterType: "codex_local",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
      ...runtime,
    },
    config,
    context: {},
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

describe("codex app-server adapter", () => {
  it("executes a remote turn over websocket and preserves Codex JSONL semantics", async () => {
    const mock = await startMockCodexAppServer();
    cleanup.push(() => mock.close());

    const { ctx, logs } = createExecutionContext({
      appServerUrl: mock.url,
      cwd: "/srv/paperclip",
      model: "gpt-5.4",
      dangerouslyBypassApprovalsAndSandbox: true,
      promptTemplate: "Continue work for {{agent.name}}.",
    });

    const result = await executeCodexViaAppServer(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("thread-started");
    expect(result.summary).toBe("hello from remote codex");
    expect(result.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
    });
    expect(logs.stdout.join("")).toContain('"type":"thread.started"');
    expect(logs.stdout.join("")).toContain('"type":"turn.completed"');
    expect(mock.receivedMethods).toEqual(
      expect.arrayContaining(["initialize", "thread/start", "turn/start"]),
    );
    expect(mock.receivedAuthorizationHeaders).toEqual([]);
  });

  it("uses the shared Paperclip heartbeat prompt when no custom prompt template is configured", async () => {
    const mock = await startMockCodexAppServer();
    cleanup.push(() => mock.close());

    const { ctx } = createExecutionContext({
      appServerUrl: mock.url,
      dangerouslyBypassApprovalsAndSandbox: true,
    });

    const result = await executeCodexViaAppServer(ctx);

    expect(result.exitCode).toBe(0);
    expect(mock.receivedTurnInputs[0]).toContain("clear final disposition");
    expect(mock.receivedTurnInputs[0]).toContain(
      "Use child issues for parallel or long delegated work instead of polling agents, sessions, or processes.",
    );
  });

  it("includes wake payload and task markdown in the remote Codex prompt", async () => {
    const mock = await startMockCodexAppServer();
    cleanup.push(() => mock.close());

    const { ctx } = createExecutionContext({
      appServerUrl: mock.url,
      dangerouslyBypassApprovalsAndSandbox: true,
    });
    ctx.context = {
      paperclipWake: {
        reason: "issue_assigned",
        issue: { id: "issue-1", identifier: "PAP-1", title: "Answer the question" },
        requestedCount: 1,
        includedCount: 1,
        latestCommentId: "comment-1",
        fallbackFetchNeeded: false,
        comments: [],
      },
      paperclipTaskMarkdown: "## Current task\n\nAnswer PAP-1 and close it if complete.",
    };

    const result = await executeCodexViaAppServer(ctx);

    expect(result.exitCode).toBe(0);
    expect(mock.receivedTurnInputs[0]).toContain("## Paperclip Wake Payload");
    expect(mock.receivedTurnInputs[0]).toContain("PAP-1");
    expect(mock.receivedTurnInputs[0]).toContain("## Current task");
    expect(mock.receivedTurnInputs[0]).toContain("Answer PAP-1 and close it if complete.");
  });

  it("returns a failed result when Codex reports a failed turn/completed notification", async () => {
    const mock = await startMockCodexAppServer({
      turnStatus: "failed",
      turnErrorMessage: "remote turn blew up",
    });
    cleanup.push(() => mock.close());

    const { ctx, logs } = createExecutionContext({
      appServerUrl: mock.url,
      dangerouslyBypassApprovalsAndSandbox: true,
    });

    const result = await executeCodexViaAppServer(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("remote turn blew up");
    expect(logs.stdout.join("")).toContain('"type":"turn.failed"');
    expect(logs.stdout.join("")).toContain("remote turn blew up");
  });

  it("sends Authorization bearer auth only when a remote token is configured", async () => {
    const mock = await startMockCodexAppServer();
    cleanup.push(() => mock.close());

    const { ctx } = createExecutionContext({
      appServerUrl: mock.url,
      appServerBearerToken: "paperclip-remote-token",
      dangerouslyBypassApprovalsAndSandbox: true,
    });

    const result = await executeCodexViaAppServer(ctx);

    expect(result.exitCode).toBe(0);
    expect(mock.receivedAuthorizationHeaders).toEqual(["Bearer paperclip-remote-token"]);
  });

  it("falls back to a fresh thread when the saved remote thread is missing", async () => {
    const mock = await startMockCodexAppServer({ failResume: true });
    cleanup.push(() => mock.close());

    const { ctx } = createExecutionContext(
      {
        appServerUrl: mock.url,
        cwd: "/srv/paperclip",
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      {
        sessionId: "dead-thread",
        sessionParams: { sessionId: "dead-thread", cwd: "/srv/paperclip" },
        sessionDisplayId: "dead-thread",
      },
    );

    const result = await executeCodexViaAppServer(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("thread-started");
    expect(mock.receivedMethods).toEqual(
      expect.arrayContaining(["thread/resume", "thread/start"]),
    );
  });

  it("probes remote app-server connectivity and auth status", async () => {
    const mock = await startMockCodexAppServer({ authMethod: "apikey", requiresOpenaiAuth: true });
    cleanup.push(() => mock.close());

    const result = await testCodexAppServerEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        appServerUrl: mock.url,
        dangerouslyBypassApprovalsAndSandbox: true,
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "codex_app_server_connect_ok")).toBe(true);
    expect(result.checks.some((check) => check.code === "codex_app_server_auth_ready")).toBe(true);
  });

});
