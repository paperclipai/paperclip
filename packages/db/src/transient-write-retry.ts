import type { Sql } from "postgres";

/**
 * Replays a query whose bytes never reached the server.
 *
 * Behind a connection pooler (Neon's PgBouncer), the server side of an idle
 * connection can be recycled while the client still holds the socket. The
 * next query then fails at the socket write — postgres.js reports it as
 * `write CONNECTION_CLOSED <host>:<port>` with `code: "CONNECTION_CLOSED"`.
 * Because the write itself failed, the server never saw the query, so
 * replaying it on a fresh connection cannot double-execute anything — the
 * replay is safe for reads and writes alike. Every other error, including a
 * connection lost mid-query (where the server may have acted), propagates
 * untouched.
 *
 * Drizzle routes every non-transactional query through the root client's
 * `unsafe`; queries inside `db.transaction()` run on the scoped client
 * `sql.begin()` hands out, which this wrapper deliberately does not touch —
 * a transaction that loses its connection must abort, not replay.
 */
const TRANSIENT_WRITE_ATTEMPTS = 3;
const TRANSIENT_WRITE_BACKOFF_MS = 50;

export function isTransientWritePhaseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "CONNECTION_CLOSED" &&
    error.message.startsWith("write CONNECTION_CLOSED")
  );
}

type UnsafeFn = (query: string, parameters?: unknown[]) => {
  values: () => Promise<unknown>;
} & PromiseLike<unknown>;

export function withTransientWriteRetry<T extends Sql>(sql: T): T {
  const runWithRetry = async (execute: () => Promise<unknown>): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await execute();
      } catch (error) {
        if (attempt >= TRANSIENT_WRITE_ATTEMPTS - 1 || !isTransientWritePhaseError(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_WRITE_BACKOFF_MS * (attempt + 1)));
      }
    }
  };

  return new Proxy(sql, {
    get(target, property, receiver) {
      if (property !== "unsafe") return Reflect.get(target, property, receiver);
      const unsafe = target.unsafe.bind(target) as UnsafeFn;
      const retryingUnsafe = (query: string, parameters?: unknown[], ...rest: unknown[]) => {
        if (rest.length > 0) {
          // An options argument selects driver surfaces this wrapper does not
          // model; leave those calls exactly as they were.
          return (target.unsafe as (...args: unknown[]) => unknown)(query, parameters, ...rest);
        }
        // postgres.js queries execute lazily, exactly once, and `.values()`
        // selects the row shape of that one execution rather than starting a
        // second one. Mirror both halves: the execution starts when a consumer
        // first settles the query, `.values()` marks the shape and returns the
        // same pending query, and every later handler joins the same run. A
        // shape chosen after the run started cannot change it — the same as
        // the driver, and the reason a mutation can never execute twice here.
        let started: Promise<unknown> | undefined;
        let wantsValues = false;
        const runOnce = () =>
          (started ??= runWithRetry(() =>
            wantsValues
              ? unsafe(query, parameters).values()
              : Promise.resolve(unsafe(query, parameters)),
          ));
        const pending = {
          then: (onFulfilled?: ((value: unknown) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) =>
            runOnce().then(onFulfilled, onRejected),
          catch: (onRejected?: ((reason: unknown) => unknown) | null) => runOnce().catch(onRejected),
          finally: (onFinally?: (() => void) | null) => runOnce().finally(onFinally),
          values: () => {
            if (!started) wantsValues = true;
            return pending;
          },
        };
        return pending;
      };
      return retryingUnsafe;
    },
  }) as T;
}
