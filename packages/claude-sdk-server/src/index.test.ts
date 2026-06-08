import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createClaudeSdkServer } from "./index.js";
import type { ClaudeBridgeExecutionContext, ClaudeBridgeExecutionResult } from "./types.js";

type RpcMessage = Record<string, unknown>;

async function connect(url: string, headers?: Record<string, string>) {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
  return ws;
}

function waitForMessage(ws: WebSocket): Promise<RpcMessage> {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => {
      try {
        resolve(JSON.parse(raw.toString("utf8")) as RpcMessage);
      } catch (err) {
        reject(err);
      }
    });
    ws.once("error", reject);
  });
}

async function waitForMessages(ws: WebSocket, count: number): Promise<RpcMessage[]> {
  const messages: RpcMessage[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${count} websocket messages`));
    }, 2_000);
    const onMessage = (raw: WebSocket.RawData) => {
      messages.push(JSON.parse(raw.toString("utf8")) as RpcMessage);
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve();
      }
    };
    ws.on("message", onMessage);
  });
  return messages;
}

async function request(ws: WebSocket, id: number, method: string, params?: unknown) {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
  return waitForMessage(ws);
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) await close();
  }
});

describe("claude sdk server", () => {
  it("serves initialize, health, and run/execute over websocket", async () => {
    const calls: ClaudeBridgeExecutionContext[] = [];
    const bridge = createClaudeSdkServer({
      listenUrl: "ws://127.0.0.1:0",
      healthCheck: async () => ({
        bridge: "test-bridge",
        authConfigured: true,
        authMethod: null,
        subscriptionType: null,
      }),
      executor: async (ctx): Promise<ClaudeBridgeExecutionResult> => {
        calls.push(ctx);
        await ctx.onSpawn?.({
          pid: 123,
          processGroupId: 456,
          startedAt: "2026-06-07T00:00:00.000Z",
        });
        await ctx.onLog("stdout", "hello from claude\n");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          sessionId: "claude-session-1",
          sessionParams: { sessionId: "claude-session-1" },
          sessionDisplayId: "claude-session-1",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          billingType: "unknown",
          costUsd: null,
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
          },
          resultJson: { ok: true },
          summary: "done",
          clearSession: false,
        };
      },
    });
    cleanup.push(() => bridge.close());
    const listening = await bridge.listen();

    const ws = await connect(listening.url);
    cleanup.push(async () => {
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    const init = await request(ws, 1, "initialize", {
      clientInfo: { name: "test" },
    });
    expect((init.result as Record<string, unknown>).serverInfo).toMatchObject({
      name: "paperclip-claude-sdk-server",
    });

    const health = await request(ws, 2, "health/check", {});
    expect(health.result).toMatchObject({ bridge: "test-bridge", authConfigured: true });

    const waitForRunFrames = waitForMessages(ws, 3);
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "run/execute",
        params: {
          runId: "run-1",
          agent: {
            id: "agent-1",
            companyId: "company-1",
            name: "Claude",
            adapterType: "claude_local",
            adapterConfig: { cwd: "/srv/claude" },
          },
          runtime: {
            sessionId: "claude-session-prev",
            sessionParams: { sessionId: "claude-session-prev" },
            sessionDisplayId: "claude-session-prev",
            taskKey: "issue:1",
          },
          config: { cwd: "/srv/claude" },
          context: { issueId: "issue-1" },
          authToken: "paperclip-api-key",
        },
      }),
    );

    const messages = await waitForRunFrames;
    const spawn = messages.find((message) => message.method === "run/spawn");
    const log = messages.find((message) => message.method === "run/log");
    const result = messages.find((message) => "result" in message);

    expect(spawn?.method).toBe("run/spawn");
    expect(log?.method).toBe("run/log");
    expect((log?.params as Record<string, unknown>).chunk).toBe("hello from claude\n");
    expect((result?.result as Record<string, unknown>).summary).toBe("done");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.authToken).toBe("paperclip-api-key");
    expect(calls[0]?.runtime.sessionId).toBe("claude-session-prev");
  });

  it("passes forwarded instructions through to the executor context", async () => {
    const calls: ClaudeBridgeExecutionContext[] = [];
    const bridge = createClaudeSdkServer({
      listenUrl: "ws://127.0.0.1:0",
      executor: async (ctx): Promise<ClaudeBridgeExecutionResult> => {
        calls.push(ctx);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          clearSession: false,
        };
      },
    });
    cleanup.push(() => bridge.close());
    const listening = await bridge.listen();

    const ws = await connect(listening.url);
    cleanup.push(async () => {
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    await request(ws, 1, "run/execute", {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: {},
      authToken: null,
      resolvedInstructions: {
        sourcePath: "/paperclip/agent/AGENTS.md",
        contents: "Forwarded instructions",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.resolvedInstructions).toEqual({
      sourcePath: "/paperclip/agent/AGENTS.md",
      contents: "Forwarded instructions",
    });
  });

  it("tees per-run logs to local stdout and stderr", async () => {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const bridge = createClaudeSdkServer({
        listenUrl: "ws://127.0.0.1:0",
        executor: async (ctx): Promise<ClaudeBridgeExecutionResult> => {
          await ctx.onLog("stdout", "stdout line\n");
          await ctx.onLog("stderr", "stderr line\n");
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            clearSession: false,
          };
        },
      });
      cleanup.push(() => bridge.close());
      const listening = await bridge.listen();

      const ws = await connect(listening.url);
      cleanup.push(async () => {
        ws.close();
        await new Promise<void>((resolve) => ws.once("close", () => resolve()));
      });

      const waitForRunFrames = waitForMessages(ws, 3);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "run/execute",
          params: {
            runId: "run-log-test",
            agent: {
              id: "agent-1",
              companyId: "company-1",
              name: "Claude",
              adapterType: "claude_local",
              adapterConfig: {},
            },
            runtime: {},
            config: {},
            context: {},
            authToken: null,
          },
        }),
      );

      await waitForRunFrames;

      expect(stdoutWrites.join("")).toContain("[paperclip-claude-sdk-server:run-log-test] stdout line\n");
      expect(stderrWrites.join("")).toContain("[paperclip-claude-sdk-server:run-log-test] stderr line\n");
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  });

  it("rejects websocket upgrades without the configured bearer token", async () => {
    const bridge = createClaudeSdkServer({
      listenUrl: "ws://127.0.0.1:0",
      bearerToken: "secret-token",
      executor: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        clearSession: false,
      }),
    });
    cleanup.push(() => bridge.close());
    const listening = await bridge.listen();

    await expect(connect(listening.url)).rejects.toBeTruthy();

    const ws = await connect(listening.url, {
      Authorization: "Bearer secret-token",
    });
    cleanup.push(async () => {
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });
    const init = await request(ws, 1, "initialize", {});
    expect((init.result as Record<string, unknown>).serverInfo).toBeTruthy();
  });
});
