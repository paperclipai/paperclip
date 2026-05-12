import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { execute, resolveSessionKey } from "./execute.js";

const serversToClose: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    serversToClose.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    ),
  );
});

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("execute", () => {
  it("does not send top-level paperclip metadata in outbound agent params", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    serversToClose.push(wss);
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("expected WebSocketServer to bind to an ephemeral TCP port");
    }

    let capturedAgentParams: Record<string, unknown> | null = null;

    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString("utf8")) as {
          id: string;
          method: string;
          params?: Record<string, unknown>;
        };

        if (frame.method === "connect") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 3 } }));
          return;
        }

        if (frame.method === "agent") {
          capturedAgentParams = (frame.params ?? null) as Record<string, unknown> | null;
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { status: "ok", runId: "run-123", result: { text: "done" }, meta: {} },
            }),
          );
        }
      });
    });

    const logs: string[] = [];
    const result = await execute({
      runId: "run-123",
      agent: { id: "agent-1", companyId: "company-1", name: "Rook" },
      config: {
        url: `ws://127.0.0.1:${address.port}/`,
        headers: { "x-openclaw-token": "token-1234567890123456" },
        disableDeviceAuth: true,
        paperclipApiUrl: "http://127.0.0.1:3100/",
      },
      context: {},
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(logs.join("")).toContain("agent accepted");
    expect(capturedAgentParams).toBeTruthy();
    expect(capturedAgentParams).not.toHaveProperty("paperclip");
  });
});
