import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayWsClient } from "./execute.js";

async function createServer() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    wss,
  };
}

describe("GatewayWsClient", () => {
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
    servers.length = 0;
  });

  it("rejects pending requests on abnormal close without unhandled rejections", async () => {
    const { url, wss } = await createServer();
    servers.push(wss);

    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-1" } }));

      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { id: string; method: string };
        if (frame.method === "connect") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "connected" } }));
          return;
        }
        socket.terminate();
      });
    });

    const unhandled: unknown[] = [];
    // This is intentionally process-wide because the failure mode we care about is
    // a leaked unhandled rejection escaping the adapter request lifecycle.
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const client = new GatewayWsClient({
      url,
      headers: {},
      onEvent: () => {},
      onLog: async () => {},
    });

    try {
      await client.connect(() => ({ role: "operator" }), 1_000);

      await expect(client.request("agent.wait", {}, { timeoutMs: 1_000 })).rejects.toThrow("gateway closed (1006)");

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      client.close();
    }
  });

  it("rejects connect challenge failures without unhandled rejections", async () => {
    const { url, wss } = await createServer();
    servers.push(wss);

    wss.on("connection", (socket) => {
      socket.terminate();
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const client = new GatewayWsClient({
      url,
      headers: {},
      onEvent: () => {},
      onLog: async () => {},
    });

    try {
      await expect(client.connect(() => ({ role: "operator" }), 1_000)).rejects.toThrow("gateway closed");

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      client.close();
    }
  });
});
