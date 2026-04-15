import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { execute, resolveSessionKey } from "./execute.js";

let gatewayServer: WebSocketServer | null = null;

afterEach(async () => {
  if (!gatewayServer) return;
  for (const client of gatewayServer.clients) {
    client.terminate();
  }
  gatewayServer.close();
  gatewayServer = null;
});

async function startGatewayServer(
  onAgentParams: (params: Record<string, unknown>) => void,
): Promise<{ url: string }> {
  gatewayServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gatewayServer, "listening");

  gatewayServer.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } }));

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        method?: string;
        params?: Record<string, unknown>;
      };

      if (frame.type !== "req" || !frame.id) return;

      if (frame.method === "connect") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 3 } }));
        return;
      }

      if (frame.method === "agent") {
        onAgentParams(frame.params ?? {});
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              status: "ok",
              runId: "gateway-run-1",
              result: { text: "done" },
              meta: {},
            },
          }),
        );
      }
    });
  });

  const { port } = gatewayServer.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}` };
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

  it("does not send a top-level paperclip payload to the gateway agent request", async () => {
    let capturedParams: Record<string, unknown> | null = null;
    const gateway = await startGatewayServer((params) => {
      capturedParams = params;
    });

    const ctx: AdapterExecutionContext = {
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Meridian",
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
        url: gateway.url,
        agentId: "meridian",
        disableDeviceAuth: true,
        payloadTemplate: {
          text: "Follow the existing checklist.",
          paperclip: {
            apiUrl: "https://paperclip.example.test",
            wakeReason: "comment_added",
          },
        },
      },
      context: {
        issueId: "issue-456",
        wakeReason: "comment_added",
      },
      onLog: async () => {},
    };

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(capturedParams).not.toBeNull();
    if (capturedParams === null) {
      throw new Error("gateway agent params were not captured");
    }
    const params = capturedParams;
    expect(params).not.toHaveProperty("paperclip");
    expect(params).not.toHaveProperty("text");
    expect(params).toMatchObject({
      agentId: "meridian",
      sessionKey: "agent:meridian:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
    });
    expect(String(params["message"])).toContain("Follow the existing checklist.");
    expect(String(params["message"])).toContain("PAPERCLIP_RUN_ID=run-123");
  });
});
