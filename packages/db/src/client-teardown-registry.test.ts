import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeRegisteredClients, createDb } from "./client.js";

/**
 * A fake wire-protocol server. It speaks just enough of the startup and
 * query flow to hand a postgres.js client an open connection: it replies to
 * the startup message with `AuthenticationOk` plus `ReadyForQuery`, then
 * replies to any later message with an empty result set plus
 * `ReadyForQuery`. No real query needs to succeed for this test.
 */
function startFakePostgresServer(): Promise<{ server: net.Server; port: number; backendSockets: net.Socket[] }> {
  const backendSockets: net.Socket[] = [];
  const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
  const readyForQuery = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
  const emptyQueryReply = Buffer.concat([
    Buffer.from([0x31, 0, 0, 0, 4]), // ParseComplete
    Buffer.from([0x32, 0, 0, 0, 4]), // BindComplete
    Buffer.from([0x54, 0, 0, 0, 6, 0, 0]), // RowDescription, zero fields
    Buffer.from([0x43, 0, 0, 0, 0x0d, 0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0x30, 0]), // CommandComplete "SELECT 0"
  ]);

  const server = net.createServer((socket) => {
    backendSockets.push(socket);
    let greeted = false;
    socket.on("data", () => {
      if (!greeted) {
        greeted = true;
        socket.write(Buffer.concat([authOk, readyForQuery]));
        return;
      }
      socket.write(Buffer.concat([emptyQueryReply, readyForQuery]));
    });
    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ server, port, backendSockets });
    });
  });
}

describe("closeRegisteredClients", () => {
  let server: net.Server | null = null;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
  });

  it("ends a reserved connection before its backend dies, so no query can reach a null socket", async () => {
    const started = await startFakePostgresServer();
    server = started.server;
    const url = `postgres://test:test@127.0.0.1:${started.port}/test`;

    const db = createDb(url, { connectTimeoutSeconds: 5 });
    // `sql.reserve()` pins one physical connection. Drizzle `db.transaction()`
    // reaches the same surface through `sql.begin()`, so this stands in for a
    // suite that left a transaction connection open.
    const reserved = await db.$client.reserve();

    const order: string[] = [];

    // This is the order our fixture owns: end every registered client for
    // this host and port before a caller stops the cluster it points at.
    await closeRegisteredClients(url);
    order.push("clients-closed");

    // Simulate the cluster stop that follows in the real fixture. Before the
    // fix, killing the backend here while a client still held the reserved
    // connection open crashed the process on a later deferred write.
    for (const socket of started.backendSockets) socket.destroy();
    order.push("cluster-stopped");

    expect(order).toEqual(["clients-closed", "cluster-stopped"]);

    // Let any timer the driver's teardown scheduled run to completion. If a
    // deferred write still fired against a null socket, it would surface here
    // as an unhandled error and fail this test file.
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

    // A query on the reserved connection rejects through the ordinary
    // closed-connection path; it does not throw past this call.
    const settled = await reserved`select 1`.catch((error: unknown) => error);
    expect(settled).toBeInstanceOf(Error);
  });

  it("does nothing when no client is registered for a host and port", async () => {
    await expect(closeRegisteredClients("postgres://test:test@127.0.0.1:1/test")).resolves.toBeUndefined();
  });
});
