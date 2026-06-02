import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { execute, resolveSessionKey } from "./execute.js";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  it("does not send paperclip as a root agent param", async () => {
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected a TCP server address");
    }

    const agentParamsPromise = new Promise<Record<string, unknown>>((resolve) => {
      server.on("connection", (socket) => {
        socket.send(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "test-nonce" },
          }),
        );

        socket.on("message", (raw) => {
          const frame = JSON.parse(raw.toString()) as {
            id: string;
            method: string;
            params?: Record<string, unknown>;
          };

          if (frame.method === "connect") {
            socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 3 } }));
            return;
          }

          if (frame.method === "agent") {
            resolve(frame.params ?? {});
            socket.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: { status: "ok", runId: "run-1" },
              }),
            );
          }
        });
      });
    });

    const logs: string[] = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenClaw Agent",
        adapterType: "openclaw_gateway",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        url: `ws://127.0.0.1:${address.port}`,
        agentId: "agent-1",
        authToken: "test-token",
        disableDeviceAuth: true,
        payloadTemplate: {
          paperclip: { legacy: true },
        },
      },
      context: {
        issueId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: "issue-1", identifier: "NOX-1" },
        },
      },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    };

    try {
      // The mock gateway resolves agentParams before replying to the agent request, so a successful execute()
      // guarantees the captured params are available while the timeout still guards failure paths.
      const result = await execute(ctx);
      const agentParams = await withTimeout(
        agentParamsPromise,
        500,
        "timed out waiting for OpenClaw gateway agent params",
      );

      expect(result.exitCode).toBe(0);
      expect(agentParams).not.toHaveProperty("paperclip");
      expect(agentParams).toMatchObject({ idempotencyKey: "run-1" });
      expect(agentParams.sessionKey).toBe(["agent:agent-1", "paperclip:issue:issue-1"].join(":"));
      expect(logs.join("")).toContain("run completed");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
