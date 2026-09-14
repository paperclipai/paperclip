import net from "node:net";
import { sql as drizzleSql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { closeRegisteredClients, createDb } from "./client.js";
import { isTransientWritePhaseError, withTransientWriteRetry } from "./transient-write-retry.js";

/** The exact shape postgres.js raises when the socket write fails. */
function writeClosedError(): Error {
  const error = new Error("write CONNECTION_CLOSED db.example.internal:5432");
  (error as Error & { code: string }).code = "CONNECTION_CLOSED";
  return error;
}

/** A stub standing in for the root postgres.js client's `unsafe` surface. */
function stubSql(behavior: { failures: number; error?: () => Error }) {
  let calls = 0;
  const state = {
    get calls() {
      return calls;
    },
  };
  const unsafe = (_query: string, _parameters?: unknown[]) => {
    calls += 1;
    const attempt = calls;
    const shouldFail = attempt <= behavior.failures;
    const outcome = () =>
      shouldFail
        ? Promise.reject((behavior.error ?? writeClosedError)())
        : Promise.resolve([{ attempt }]);
    return {
      then: (onFulfilled?: ((value: unknown) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) =>
        outcome().then(onFulfilled, onRejected),
      values: () => outcome().then(() => [[attempt]]),
    };
  };
  const sql = { unsafe } as unknown as Sql;
  return { sql, state };
}

describe("isTransientWritePhaseError", () => {
  it("matches only the write-phase connection-closed shape", () => {
    expect(isTransientWritePhaseError(writeClosedError())).toBe(true);

    const midQuery = new Error("read CONNECTION_CLOSED db.example.internal:5432");
    (midQuery as Error & { code: string }).code = "CONNECTION_CLOSED";
    expect(isTransientWritePhaseError(midQuery)).toBe(false);

    const ended = new Error("write CONNECTION_ENDED db.example.internal:5432");
    (ended as Error & { code: string }).code = "CONNECTION_ENDED";
    expect(isTransientWritePhaseError(ended)).toBe(false);

    expect(isTransientWritePhaseError(new Error("write CONNECTION_CLOSED x:1"))).toBe(false); // no code
    expect(isTransientWritePhaseError(null)).toBe(false);
  });
});

describe("withTransientWriteRetry", () => {
  it("replays a query whose socket write failed, and returns the replay's rows", async () => {
    const { sql, state } = stubSql({ failures: 1 });
    const rows = await withTransientWriteRetry(sql).unsafe("select 1", []);
    expect(rows).toEqual([{ attempt: 2 }]);
    expect(state.calls).toBe(2);
  });

  it("replays the .values() form drizzle uses", async () => {
    const { sql, state } = stubSql({ failures: 2 });
    const values = await withTransientWriteRetry(sql).unsafe("select 1", []).values();
    expect(values).toEqual([[3]]);
    expect(state.calls).toBe(3);
  });

  it("gives up after the attempt budget and surfaces the driver error", async () => {
    const { sql, state } = stubSql({ failures: Number.POSITIVE_INFINITY });
    await expect(withTransientWriteRetry(sql).unsafe("select 1", [])).rejects.toThrow(
      "write CONNECTION_CLOSED",
    );
    expect(state.calls).toBe(3);
  });

  it("does not replay an error that may have reached the server", async () => {
    const midQuery = () => {
      const error = new Error("read CONNECTION_CLOSED db.example.internal:5432");
      (error as Error & { code: string }).code = "CONNECTION_CLOSED";
      return error;
    };
    const { sql, state } = stubSql({ failures: Number.POSITIVE_INFINITY, error: midQuery });
    await expect(withTransientWriteRetry(sql).unsafe("select 1", [])).rejects.toThrow(
      "read CONNECTION_CLOSED",
    );
    expect(state.calls).toBe(1);
  });

  it("runs one execution no matter how many handlers attach to the pending query", async () => {
    const { sql, state } = stubSql({ failures: 0 });
    const pending = withTransientWriteRetry(sql).unsafe("select 1", []);
    await Promise.all([pending, pending.catch(() => undefined), pending.then((rows) => rows)]);
    expect(state.calls).toBe(1);
  });

  it("never executes a query twice when a caller both awaits it and takes its values", async () => {
    // `.values()` selects the row shape of the one execution, like the driver.
    // Starting a second execution here would repeat a mutation's effect.
    const { sql, state } = stubSql({ failures: 0 });
    const pending = withTransientWriteRetry(sql).unsafe("insert into t values (1)", []);
    const rows = await pending;
    const values = await pending.values();
    expect(state.calls).toBe(1);
    expect(values).toBe(rows);
  });

  it("takes the values shape when it is chosen before the query runs", async () => {
    const { sql, state } = stubSql({ failures: 0 });
    const pending = withTransientWriteRetry(sql).unsafe("select 1", []);
    expect(await pending.values()).toEqual([[1]]);
    expect(state.calls).toBe(1);
  });
});

describe("createDb with the retrying client", () => {
  // The same minimal wire-protocol fake as client-teardown-registry.test.ts:
  // enough of the startup and query flow for drizzle to run a real query
  // through the proxied client, proving the retry face is transparent.
  function startFakePostgresServer(): Promise<{ server: net.Server; port: number }> {
    const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
    const readyForQuery = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
    const emptyQueryReply = Buffer.concat([
      Buffer.from([0x31, 0, 0, 0, 4]),
      Buffer.from([0x32, 0, 0, 0, 4]),
      Buffer.from([0x54, 0, 0, 0, 6, 0, 0]),
      Buffer.from([0x43, 0, 0, 0, 0x0d, 0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0x30, 0]),
    ]);
    const server = net.createServer((socket) => {
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
        resolve({ server, port: (server.address() as net.AddressInfo).port });
      });
    });
  }

  let server: net.Server | null = null;
  let url: string | null = null;

  afterEach(async () => {
    if (url) await closeRegisteredClients(url);
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
    url = null;
  });

  it("still answers ordinary drizzle queries through the proxy", async () => {
    const started = await startFakePostgresServer();
    server = started.server;
    url = `postgres://test:test@127.0.0.1:${started.port}/test`;
    const db = createDb(url, { connectTimeoutSeconds: 5, prepare: false });
    await expect(db.execute(drizzleSql`select 0`)).resolves.toBeDefined();
  });

  it("leaves every other client surface reachable through the proxy", async () => {
    // Drizzle itself only awaits `unsafe()` or takes its `.values()`, but the
    // client is reachable as `db.$client`, and callers use it as a tagged
    // template, open transactions on it, and end it. A wrapper that broke any
    // of those would fail far from here, so pin them against the real driver.
    const started = await startFakePostgresServer();
    server = started.server;
    url = `postgres://test:test@127.0.0.1:${started.port}/test`;
    const db = createDb(url, { connectTimeoutSeconds: 5, prepare: false });
    const client = (db as unknown as { $client: Sql }).$client;

    await expect(client`select 1`).resolves.toBeDefined();
    await expect(client.unsafe("select 1", [])).resolves.toBeDefined();
    await expect(
      client.begin(async (tx) => {
        await tx.unsafe("select 1", []);
        return "transaction result";
      }),
    ).resolves.toBe("transaction result");
    await expect(client.end({ timeout: 1 })).resolves.toBeUndefined();
  });
});
