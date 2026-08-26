import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Regression coverage for patches/postgres@3.4.9.patch.
 *
 * The unpatched driver crashes the whole process when a write races a
 * connection close: `write()` buffers small frames and flushes them from a
 * `setImmediate(nextWrite)`, and `nextWrite` called `socket.write()` without
 * checking that the socket still exists. A reserved connection (sql.reserve /
 * sql.begin) whose backend dies keeps accepting queries — its handler calls
 * `execute()` with no socket-state check — so the deferred flush fired with
 * `socket === null` and threw `TypeError: Cannot read properties of null
 * (reading 'write')` from a timer callback with no try/catch above it. In CI
 * that surfaced as vitest's "Vitest caught 1 unhandled error" failing suites
 * whose tests had all passed, whenever a test tore down its database while a
 * connection still had traffic.
 *
 * The fake server below speaks just enough wire protocol to hand the client
 * an open connection (startup auth, then an empty result set for the
 * fetch_types bootstrap query); the crash path itself never needs a real
 * query to succeed. Against the unpatched driver this test fails through
 * vitest's unhandled-error detection with exactly the CI signature; with the
 * patch, the late query settles through the normal CONNECTION_DESTROYED path.
 */
describe("postgres driver teardown race", () => {
  let server: net.Server | null = null;
  let sql: ReturnType<typeof postgres> | null = null;

  afterEach(async () => {
    if (sql) await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
  });

  it("does not crash the process when a reserved connection's backend dies before a write flushes", async () => {
    const backendSockets: net.Socket[] = [];

    // AuthenticationOk (R, code 0) + ReadyForQuery (Z, idle).
    const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
    const readyForQuery = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
    const emptyQueryReply = Buffer.concat([
      Buffer.from([0x31, 0, 0, 0, 4]), // ParseComplete
      Buffer.from([0x32, 0, 0, 0, 4]), // BindComplete
      Buffer.from([0x54, 0, 0, 0, 6, 0, 0]), // RowDescription, zero fields
      // CommandComplete "SELECT 0"
      Buffer.from([0x43, 0, 0, 0, 0x0d, 0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0x30, 0]),
    ]);

    server = net.createServer((socket) => {
      backendSockets.push(socket);
      let greeted = false;
      socket.on("data", () => {
        if (!greeted) {
          // First frame is the StartupMessage.
          greeted = true;
          socket.write(Buffer.concat([authOk, readyForQuery]));
          return;
        }
        // Any later frame (the fetch_types bootstrap query) gets an empty
        // result set + ReadyForQuery, enough for the client to finish
        // opening and resolve the reserve.
        socket.write(Buffer.concat([emptyQueryReply, readyForQuery]));
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const closed = new Promise<void>((resolve) => {
      sql = postgres({
        host: "127.0.0.1",
        port,
        user: "test",
        database: "test",
        max: 1,
        idle_timeout: 0,
        connect_timeout: 5,
        onclose: () => resolve(),
      });
    });

    // A reserved connection keeps routing queries straight to this one
    // physical connection — the same surface sql.begin() transactions use.
    const reserved = await sql!.reserve();

    // Kill the backend and wait until the client has fully processed the
    // close (socket nulled, pool notified).
    for (const socket of backendSockets) socket.destroy();
    await closed;

    // Late query on the dead reserved connection: unpatched, this buffered
    // its frame and scheduled the deferred flush that crashed the process
    // one tick later. Patched, execute() refuses it up front, so it settles
    // immediately — no pool shutdown required.
    const settled = await reserved`select 1`.catch((error: unknown) => error);
    expect(settled).toBeInstanceOf(Error);
    expect(String((settled as Error).message)).toContain("CONNECTION_CLOSED");

    // Let any stray deferred flush run before the test ends, so a regression
    // in the nextWrite guard still fails this test via the unhandled error.
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

    reserved.release();
  });
});
