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

    // The driver calls this only after it has fully processed a connection
    // close: its socket reference cleared and any in-flight query failed.
    // Waiting for it, instead of a fixed number of ticks, is what the
    // historical crash reproduction does — it is real observed state from
    // the driver, not a guess at timing.
    const driverProcessedClose = new Promise<void>((resolve) => {
      db.$client.options.onclose = () => resolve();
    });

    // This is the order our fixture owns: end every registered client for
    // this host and port before a caller stops the cluster it points at.
    await closeRegisteredClients(url);

    // Simulate the cluster stop that follows in the real fixture. Before the
    // fix, killing the backend here while a client still held the reserved
    // connection open crashed the process on a later deferred write.
    for (const socket of started.backendSockets) socket.destroy();
    await driverProcessedClose;

    // A query sent only after the driver finished processing the close still
    // buffers its frame for a deferred flush one tick later. If the fix let
    // the reserved connection outlive the backend, that flush reaches a
    // cleared socket reference and throws from inside the timer callback —
    // this specific promise then never settles, because nothing on that
    // path ever calls its resolve or reject. This test's own timeout (the
    // suite default) is what turns that hang into a reported failure,
    // alongside the unhandled exception the crash raises separately.
    const settled = await reserved`select 1`.catch((error: unknown) => error);
    expect(settled).toBeInstanceOf(Error);

    // Let the deferred flush actually run. If it still fires against a null
    // socket, it surfaces here as an unhandled error and fails this test
    // file — the exact signature the fix protects against.
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  });

  it("does nothing when no client is registered for a host and port", async () => {
    await expect(closeRegisteredClients("postgres://test:test@127.0.0.1:1/test")).resolves.toBeUndefined();
  });

  it("does not throw when createDb receives a URL that new URL() cannot parse", async () => {
    let db: ReturnType<typeof createDb> | undefined;
    expect(() => {
      db = createDb("", { connectTimeoutSeconds: 1 });
    }).not.toThrow();

    await db?.$client.end({ timeout: 0 }).catch(() => {});
  });
});
