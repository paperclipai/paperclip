import net from "node:net";
import type { Db } from "@paperclipai/db";

export type MeteredStatement = { sql: string; parameters: number; rows: number; ms: number; inTransaction: boolean };

type Method = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Counts what a database client sends and receives: the statements, also the
 * ones inside a transaction and the BEGIN and COMMIT of each transaction, the
 * rows they return, and the bytes the server sends back on the connections of
 * the client. `waits` counts the times the client went from no statement in
 * flight to one: statements sent together wait one time, statements sent one
 * after the other wait one time each. Install the meter before the first
 * statement of the client.
 */
export function meterDatabaseStatements(db: Db, databaseUrl: string) {
  const port = Number(new URL(databaseUrl).port);
  const sockets = new Set<net.Socket>();
  const connect = net.Socket.prototype.connect as Method;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const first = args[0] as number | { port?: number } | undefined;
    if ((typeof first === "object" ? first?.port : first) === port) sockets.add(this);
    return Reflect.apply(connect, this, args);
  } as typeof net.Socket.prototype.connect;

  const totals = { statements: 0, transactions: 0, waits: 0, rows: 0, sqlBytes: 0 };
  let inFlight = 0;
  let log: MeteredStatement[] | null = null;
  const visited = new WeakSet<object>();
  const visit = (value: unknown, inTransaction: boolean) => {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
    if (visited.has(value)) return;
    visited.add(value);
    const target = value as Record<string, unknown>;
    const unsafe = target.unsafe;
    if (typeof unsafe === "function") {
      target.unsafe = function (this: unknown, ...args: unknown[]) {
        const query = String(args[0]), started = performance.now();
        totals.statements += 1;
        totals.sqlBytes += Buffer.byteLength(query);
        if (inFlight === 0) totals.waits += 1;
        inFlight += 1;
        const pending = Reflect.apply(unsafe, this, args) as PromiseLike<{ length: number }>;
        const entry = { sql: query, parameters: Array.isArray(args[1]) ? args[1].length : 0, rows: 0, ms: 0, inTransaction };
        log?.push(entry);
        // The query starts one microtask after its first `then`, so a caller
        // can still select the result format on the returned query.
        pending.then((result) => {
          inFlight -= 1;
          totals.rows += result.length;
          entry.rows = result.length;
          entry.ms = performance.now() - started;
        }, () => { inFlight -= 1; });
        return pending;
      };
    }
    for (const method of ["begin", "savepoint"]) {
      const original = target[method];
      if (typeof original !== "function") continue;
      target[method] = function (this: unknown, ...args: unknown[]) {
        // The driver sends BEGIN through `unsafe`, which counts it above. It
        // sends COMMIT, ROLLBACK and SAVEPOINT on its own, one for each call.
        totals.statements += 1;
        totals.waits += 1;
        if (method === "begin") totals.transactions += 1;
        return Reflect.apply(original, this, args.map(arg => typeof arg !== "function" ? arg
          : function (this: unknown, ...inner: unknown[]) {
            visit(inner[0], true);
            return Reflect.apply(arg, this, inner);
          }));
      } satisfies Method;
    }
  };
  visit(db.$client, false);

  const bytesReceived = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0);
  return {
    /** The totals since the client started. Subtract two readings to meter one request. */
    read: () => ({ ...totals, bytesReceived: bytesReceived() }),
    /** Records every statement until `stopLog`. */
    startLog: () => { log = []; },
    stopLog: () => {
      const recorded = log ?? [];
      log = null;
      return recorded;
    },
    uninstall: () => { net.Socket.prototype.connect = connect as typeof net.Socket.prototype.connect; },
  };
}
