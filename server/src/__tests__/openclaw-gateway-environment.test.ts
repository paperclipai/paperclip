import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { testEnvironment } from "@paperclipai/adapter-openclaw-gateway/server";

async function createMockGatewayProbeServer(options?: {
  pairingScopeAvailable?: boolean;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const connectionScopes = new WeakMap<WebSocket, string[]>();

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-123" },
      }),
    );

    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        const scopes = Array.isArray(frame.params?.scopes)
          ? frame.params.scopes.filter((entry): entry is string => typeof entry === "string")
          : [];
        connectionScopes.set(socket, scopes);

        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              server: { version: "test", connId: "conn-1" },
              features: {
                methods: ["connect", "device.pair.list"],
                events: ["agent"],
              },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }),
        );
        return;
      }

      if (frame.method === "device.pair.list") {
        const scopes = connectionScopes.get(socket) ?? [];
        if (!options?.pairingScopeAvailable || !scopes.includes("operator.pairing")) {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: {
                code: "FORBIDDEN",
                message: "missing scope: operator.pairing",
              },
            }),
          );
          return;
        }

        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              pending: [],
              paired: [],
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("openclaw gateway environment probe", () => {
  it("warns when pairing scope is unavailable even though basic connect succeeds", async () => {
    const gateway = await createMockGatewayProbeServer({ pairingScopeAvailable: false });

    try {
      const result = await testEnvironment({
        adapterType: "openclaw_gateway",
        config: {
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
        },
      });

      expect(result.status).toBe("warn");
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "openclaw_gateway_probe_ok", level: "info" }),
          expect.objectContaining({ code: "openclaw_gateway_pairing_scope_missing", level: "warn" }),
        ]),
      );
    } finally {
      await gateway.close();
    }
  });

  it("passes when pairing methods are available to the configured credentials", async () => {
    const gateway = await createMockGatewayProbeServer({ pairingScopeAvailable: true });

    try {
      const result = await testEnvironment({
        adapterType: "openclaw_gateway",
        config: {
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "openclaw_gateway_probe_ok", level: "info" }),
          expect.objectContaining({ code: "openclaw_gateway_pairing_scope_ok", level: "info" }),
        ]),
      );
    } finally {
      await gateway.close();
    }
  });
});
