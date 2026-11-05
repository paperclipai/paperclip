import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { BrokerClientError, UnixBrokerClient } from "./broker-client.js";

const LENGTH_PREFIX_BYTES = 4;

/**
 * Minimal in-process broker that speaks the exact `[4-byte BE length][json]`
 * framing of the real socket server, so these tests exercise the client's
 * framing + parsing without linking the host-privileged broker package.
 */
function startFakeBroker(
  handler: (request: Record<string, unknown>) => unknown,
): { socketPath: string; server: net.Server } {
  const socketPath = path.join(os.tmpdir(), `tsh-broker-${randomUUID()}.sock`);
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let expected = -1;
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (expected < 0) {
        if (buf.byteLength < LENGTH_PREFIX_BYTES) return;
        expected = buf.readUInt32BE(0);
      }
      if (buf.byteLength < LENGTH_PREFIX_BYTES + expected) return;
      const body = buf.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + expected).toString("utf8");
      const request = JSON.parse(body) as Record<string, unknown>;
      const response = handler(request);
      const respBody = Buffer.from(JSON.stringify(response), "utf8");
      const frame = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + respBody.byteLength);
      frame.writeUInt32BE(respBody.byteLength, 0);
      respBody.copy(frame, LENGTH_PREFIX_BYTES);
      socket.end(frame);
    });
  });
  server.listen(socketPath);
  return { socketPath, server };
}

const servers: net.Server[] = [];
const sockets: string[] = [];

function fake(handler: (request: Record<string, unknown>) => unknown): string {
  const { socketPath, server } = startFakeBroker(handler);
  servers.push(server);
  sockets.push(socketPath);
  return socketPath;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const socketPath of sockets.splice(0)) {
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    }
  }
});

const RUNTIME_ID = "11111111-2222-4333-8444-555566667777";

describe("UnixBrokerClient", () => {
  it("round-trips reservation and expose requests", async () => {
    let seen: Record<string, unknown> | undefined;
    const socketPath = fake((request) => {
      seen = request;
      if (request.op === "reserve") {
        return { ok: true, op: "reserve", requestId: request.requestId, handle: "h".repeat(20), reservedPorts: [42000, 52000] };
      }
      return { ok: true, op: "expose", requestId: request.requestId, handle: "h".repeat(20), publicPorts: [42000, 52000] };
    });
    const client = new UnixBrokerClient({ socketPath });
    const reserved = await client.reserve(RUNTIME_ID, [
      { purpose: "app", port: 42000 },
      { purpose: "vite_hmr", port: 52000 },
    ]);
    expect(reserved).toEqual({ handle: "h".repeat(20), reservedPorts: [42000, 52000] });
    const result = await client.expose(RUNTIME_ID, reserved.handle);
    expect(result).toEqual({ handle: "h".repeat(20), publicPorts: [42000, 52000] });
    expect(seen).toMatchObject({
      v: 1,
      op: "expose",
      runtimeId: RUNTIME_ID,
      handle: "h".repeat(20),
    });
    expect(typeof seen?.requestId).toBe("string");
  });

  it("parses a remove response", async () => {
    const socketPath = fake((request) => ({
      ok: true,
      op: "remove",
      requestId: request.requestId,
      removedPorts: [42000],
    }));
    const client = new UnixBrokerClient({ socketPath });
    const result = await client.remove(RUNTIME_ID, "h".repeat(20));
    expect(result.removedPorts).toEqual([42000]);
  });

  it("parses a list response into owned listeners", async () => {
    const socketPath = fake((request) => ({
      ok: true,
      op: "list",
      requestId: request.requestId,
      listeners: [{ runtimeId: RUNTIME_ID, port: 42000, purpose: "app" }],
    }));
    const client = new UnixBrokerClient({ socketPath });
    const listeners = await client.list();
    expect(listeners).toEqual([{ runtimeId: RUNTIME_ID, port: 42000, purpose: "app" }]);
  });

  it("surfaces a broker error response as a coded BrokerClientError", async () => {
    const socketPath = fake((request) => ({
      ok: false,
      requestId: request.requestId,
      code: "port_not_allowlisted",
      message: "denied",
    }));
    const client = new UnixBrokerClient({ socketPath });
    await expect(client.reserve(RUNTIME_ID, [{ purpose: "app", port: 42000 }])).rejects.toMatchObject({
      name: "BrokerClientError",
      code: "port_not_allowlisted",
    });
  });

  it("rejects a malformed (non-ok) response shape", async () => {
    const socketPath = fake(() => ({ surprise: true }));
    const client = new UnixBrokerClient({ socketPath });
    await expect(client.list()).rejects.toBeInstanceOf(BrokerClientError);
  });

  it("rejects an expose response missing publicPorts", async () => {
    const socketPath = fake((request) => ({ ok: true, op: "expose", requestId: request.requestId, handle: "h".repeat(20) }));
    const client = new UnixBrokerClient({ socketPath });
    await expect(client.expose(RUNTIME_ID, "h".repeat(20))).rejects.toMatchObject({
      code: "malformed_response",
    });
  });

  it("times out when the broker accepts but never responds", async () => {
    await expect(silentTimeout()).resolves.toBe(true);
  });

  it("errors when the socket path does not exist (transport error)", async () => {
    const client = new UnixBrokerClient({
      socketPath: path.join(os.tmpdir(), `missing-${randomUUID()}.sock`),
      timeoutMs: 500,
    });
    await expect(client.list()).rejects.toMatchObject({ code: "transport_error" });
  });
});

/** Build a truly-silent broker and assert the client times out against it. */
async function silentTimeout(): Promise<boolean> {
  const socketPath = path.join(os.tmpdir(), `silent-${randomUUID()}.sock`);
  const connections: net.Socket[] = [];
  const server = net.createServer((socket) => {
    // Accept, never respond. Swallow the abortive close the client sends when
    // it times out so the connection socket does not emit an unhandled error.
    socket.on("error", () => {});
    connections.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  try {
    const client = new UnixBrokerClient({ socketPath, timeoutMs: 150 });
    try {
      await client.list();
      return false;
    } catch (error) {
      return error instanceof BrokerClientError && error.code === "cli_timeout";
    }
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    }
  }
}
