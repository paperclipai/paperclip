// Child-process fixture for the postgres driver null-socket write crash.
//
// A single process cannot prove its own survival — a test in the same
// process as an unguarded crash would take the whole test run down with
// it. This script runs in its own forked process. It reproduces the crash
// sequence against a fake wire-protocol server, then reports each
// checkpoint to the parent test over IPC. The parent asserts on those
// messages and on this process's own exit code.
//
// This is not a real PostgreSQL server. It speaks only the small subset of
// the wire protocol the driver needs for a startup handshake and a simple
// query: no SSL negotiation, no authentication challenge, no extended
// query protocol. `fetch_types: false` on the client skips the driver's
// own startup catalog query, and every query used here carries no bind
// parameters, so the driver always uses the simple query protocol.
//
// A note on "the client recovers": the driver's own write-scheduling state
// (a buffered chunk and a scheduled-write flag, both private to one
// connection's closure) is never reset on the throw path this guard
// neutralizes — the two statements that would reset them sit after the
// line that throws. A later query on that exact same connection can
// therefore never send another byte; it silently times out instead of
// failing fast. A pool with more than one connection is not stuck: the
// pool's other connections are separate closures the crash never touches,
// so a query on any of them succeeds normally. This fixture proves both
// outcomes — see the "same connection" and "pool" scenarios below.
import net from "node:net";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { registerPostgresNullSocketGuard } from "../postgres-null-socket-guard.js";

const scenario = process.argv[2];

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function beMessage(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

function authenticationOkMessage(): Buffer {
  return beMessage("R", Buffer.alloc(4));
}

function readyForQueryMessage(status: "I" | "T"): Buffer {
  return beMessage("Z", Buffer.from(status, "ascii"));
}

function commandCompleteMessage(tag: string): Buffer {
  return beMessage("C", Buffer.from(`${tag}\0`, "ascii"));
}

/**
 * Speaks just enough of the wire protocol for one connection: an untyped
 * startup packet, then a stream of typed messages. The only typed message
 * this test ever sends is a simple-protocol query ('Q'). A `begin` query
 * gets a `BEGIN` response, followed at once by the server closing the
 * socket — standing in for a database backend that drops a connection
 * while a transaction still holds it. Every other query gets a generic
 * success response and the socket stays open.
 */
function attachFakeBackend(socket: net.Socket): void {
  let buffer = Buffer.alloc(0);
  let startupDone = false;

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      if (!startupDone) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        startupDone = true;
        socket.write(authenticationOkMessage());
        socket.write(readyForQueryMessage("I"));
        continue;
      }

      if (buffer.length < 5) return;
      const type = String.fromCharCode(buffer[0] ?? 0);
      const length = buffer.readUInt32BE(1);
      const total = 1 + length;
      if (buffer.length < total) return;
      const payload = buffer.subarray(5, total);
      buffer = buffer.subarray(total);

      if (type === "Q") {
        const text = payload
          .toString("utf8", 0, Math.max(payload.length - 1, 0))
          .trim()
          .toLowerCase();
        if (text.startsWith("begin")) {
          socket.write(commandCompleteMessage("BEGIN"));
          socket.write(readyForQueryMessage("T"));
          socket.end();
        } else {
          socket.write(commandCompleteMessage("SELECT 0"));
          socket.write(readyForQueryMessage("I"));
        }
      }
    }
  });
}

async function startFakeServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => attachFakeBackend(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake wire server did not bind a TCP port");
  }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runDriverCrashScenario(withGuard: boolean, poolMax: number): Promise<void> {
  if (withGuard) registerPostgresNullSocketGuard();

  const { port, close } = await startFakeServer();

  let resolveClosed = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const client = postgres({
    host: "127.0.0.1",
    port,
    user: "test",
    password: "test",
    database: "test",
    max: poolMax,
    fetch_types: false,
    idle_timeout: null,
    max_lifetime: null,
    keep_alive: false,
    connect_timeout: 3,
    // Fires once the driver has fully processed the closed connection —
    // after the transaction's own rejection, per the ordering documented
    // in the module this fixture exercises. Gates the next query so the
    // crash reproduces deterministically instead of racing a real close.
    onclose: () => resolveClosed(),
  });

  const db = drizzle(client);

  const transactionPromise = db.transaction(async (tx) => {
    await closedPromise;
    // Triggers the defect: the driver defers this write to a timer
    // callback, which throws once it runs because the socket is already
    // null. That promise never settles, so it is deliberately not awaited.
    void tx.execute(sql`select 1`).catch(() => {});
    // Keeps this transaction scope from following up with a commit
    // attempt on the same dead connection, which would throw a second
    // time and add noise this test does not need.
    return await new Promise<void>(() => {});
  });

  transactionPromise.then(
    () => send({ type: "transaction-resolved-unexpectedly" }),
    (error: unknown) => {
      send({
        type: "transaction-rejected",
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );

  // Gives the deferred write time to fire — and, with the guard registered,
  // time to be neutralized — before this process checks whether it is
  // still the one running.
  await delay(300);
  send({ type: "still-alive" });

  try {
    const recovery = await db.execute(sql`select 1`);
    send({ type: "recovery-ok", rowCount: Array.isArray(recovery) ? recovery.length : null });
  } catch (error) {
    // See the module comment above `runDriverCrashScenario`: with a
    // single-connection pool, the crashed connection's own write-scheduling
    // state is never reset on the throw path, so it can never send another
    // byte. This is expected and reported, not swallowed.
    send({
      type: "recovery-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await client.end({ timeout: 1 });
  await close();
  send({ type: "survived" });
  process.exit(0);
}

async function runUnrelatedCrashScenario(): Promise<void> {
  registerPostgresNullSocketGuard();
  setImmediate(() => {
    throw new TypeError("an unrelated failure the guard must not swallow");
  });
  // If the guard wrongly neutralized this unrelated error, this process
  // would still be alive to send this message. Give the throw time to
  // reach the guard and end the process first.
  await delay(500);
  send({ type: "unexpected-survival" });
}

async function main(): Promise<void> {
  switch (scenario) {
    case "guarded-crash-same-connection":
      await runDriverCrashScenario(true, 1);
      return;
    case "guarded-crash-pool":
      await runDriverCrashScenario(true, 2);
      return;
    case "unguarded-crash":
      await runDriverCrashScenario(false, 1);
      return;
    case "unrelated-crash":
      await runUnrelatedCrashScenario();
      return;
    default:
      throw new Error(`Unknown fixture scenario: ${scenario}`);
  }
}

void main();
