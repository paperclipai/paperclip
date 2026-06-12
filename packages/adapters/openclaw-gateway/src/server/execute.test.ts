import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { resolveSessionKey } from "./execute.js";
import {
  OPENCLAW_GATEWAY_PROTOCOL_RANGE,
  OPENCLAW_GATEWAY_PROTOCOL_VERSION,
} from "./protocol.js";
import { testEnvironment } from "./test.js";

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

describe("OpenClaw gateway protocol", () => {
  it("uses OpenClaw gateway protocol 4 for connect negotiation", () => {
    expect(OPENCLAW_GATEWAY_PROTOCOL_VERSION).toBe(4);
    expect(OPENCLAW_GATEWAY_PROTOCOL_RANGE).toEqual({
      minProtocol: 4,
      maxProtocol: 4,
    });
  });

  it("sends protocol 4 from the environment probe connect request", async () => {
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected a TCP server address");
    }

    const receivedParams = new Promise<Record<string, unknown>>((resolve) => {
      server.on("connection", (socket) => {
        socket.send(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "probe-nonce" },
          }),
        );

        socket.on("message", (raw) => {
          const frame = JSON.parse(raw.toString()) as {
            id: string;
            params?: Record<string, unknown>;
          };
          resolve(frame.params ?? {});
          socket.send(
            JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 4 } }),
          );
        });
      });
    });

    try {
      const context: AdapterEnvironmentTestContext = {
        companyId: "company-1",
        adapterType: "openclaw_gateway",
        config: {
          url: `ws://127.0.0.1:${address.port}`,
          authToken: "test-token",
        },
      };
      const result = await testEnvironment(context);

      const params = await withTimeout(
        receivedParams,
        500,
        "timed out waiting for OpenClaw gateway probe connect params",
      );
      expect(params).toMatchObject({
        minProtocol: 4,
        maxProtocol: 4,
      });
      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "openclaw_gateway_probe_ok")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
