/**
 * Wraps a postgres.js client so every query passes through a
 * {@link ConnectionCircuitBreaker}.
 *
 * The wrapper is deliberately thin. It guards the three ways a query enters
 * the driver — the tagged template, `unsafe()`, and `begin()` — and observes
 * how each one settles so the breaker learns whether the database is
 * reachable. Everything else (`end`, `listen`, `notify`, the `sql(value)`
 * fragment helpers, `options`) is passed through untouched, including while
 * the breaker is open: shutting a pool down must not depend on the database
 * being up.
 *
 * postgres.js queries are lazy — the driver only dials out when the query is
 * awaited — so the wrapper preserves that laziness. It never subscribes on the
 * caller's behalf; it only decorates the caller's own `then`/`catch`/`finally`.
 */

import type postgres from "postgres";
import { ConnectionCircuitBreaker, DatabaseUnavailableError } from "./connection-circuit-breaker.js";

type Sql = ReturnType<typeof postgres>;

/** Query methods that configure the pending query and return it unchanged. */
const SELF_RETURNING_QUERY_METHODS = new Set([
  "cursor",
  "describe",
  "execute",
  "forEach",
  "raw",
  "simple",
  "values",
]);

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * A stand-in for a pending query that rejects immediately. Returned instead of
 * throwing synchronously so that callers who never expected `sql.unsafe(...)`
 * to throw — drizzle among them — keep seeing a rejected thenable.
 */
function rejectedQuery(error: DatabaseUnavailableError): unknown {
  const rejection = Promise.reject(error);
  // Nobody is guaranteed to await the stub (a caller may build a query and
  // drop it), so pre-handle the rejection to keep it off the unhandled path.
  // The chained promise below is what callers actually subscribe to.
  rejection.catch(() => {});

  const stub: Record<string, unknown> = {
    then: (...args: unknown[]) => (rejection.then as (...a: unknown[]) => unknown)(...args),
    catch: (...args: unknown[]) => (rejection.catch as (...a: unknown[]) => unknown)(...args),
    finally: (...args: unknown[]) => (rejection.finally as (...a: unknown[]) => unknown)(...args),
    cancel: () => undefined,
  };
  for (const method of SELF_RETURNING_QUERY_METHODS) {
    stub[method] = () => stub;
  }
  return stub;
}

/**
 * Wraps a pending query so the breaker sees how it settles, without forcing it
 * to run. `values()`/`raw()`/... return the query itself, so those come back as
 * the wrapper to keep the chain observed.
 */
function observePendingQuery(query: object, breaker: ConnectionCircuitBreaker): unknown {
  let settled: Promise<unknown> | undefined;
  const settle = (): Promise<unknown> => {
    settled ??= (query as PromiseLike<unknown>).then(
      (value) => {
        breaker.recordSuccess();
        return value;
      },
      (error: unknown) => {
        breaker.recordFailure(error);
        throw error;
      },
    ) as Promise<unknown>;
    return settled;
  };

  const wrapper: ProxyHandler<object> = {
    get(target, property, receiver) {
      if (property === "then" || property === "catch" || property === "finally") {
        return (...args: unknown[]) => {
          const promise = settle() as unknown as Record<string, (...a: unknown[]) => unknown>;
          return promise[property as string](...args);
        };
      }

      const value = Reflect.get(target, property, target);
      if (typeof value === "function" && SELF_RETURNING_QUERY_METHODS.has(property as string)) {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result === target ? receiver : result;
        };
      }
      return value;
    },
  };

  return new Proxy(query, wrapper);
}

function guard<T>(
  breaker: ConnectionCircuitBreaker,
  run: () => T,
): T | unknown {
  try {
    breaker.assertAvailable();
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) return rejectedQuery(error);
    throw error;
  }

  const result = run();
  return isThenable(result) ? observePendingQuery(result as object, breaker) : result;
}

/**
 * Returns `sql` wrapped in a breaker, or `sql` itself when no breaker is
 * configured.
 */
export function withConnectionCircuitBreaker(sql: Sql, breaker: ConnectionCircuitBreaker | null): Sql {
  if (breaker === null) return sql;

  return new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      // Only a tagged-template call is a query. `sql(identifier)` and
      // `sql(rows)` build fragments that must keep flowing through untouched,
      // breaker open or not.
      const isTaggedTemplate = Array.isArray((args[0] as { raw?: unknown } | undefined)?.raw);
      if (!isTaggedTemplate) return Reflect.apply(target as never, thisArg, args);
      return guard(breaker, () => Reflect.apply(target as never, target, args));
    },

    get(target, property) {
      if (property === "unsafe" || property === "file" || property === "begin") {
        const method = Reflect.get(target, property, target) as
          | ((...args: unknown[]) => unknown)
          | undefined;
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => guard(breaker, () => method.apply(target, args));
      }
      // `circuitBreaker` is not part of the postgres.js surface; it is exposed
      // so callers (health endpoints, tests) can read the breaker's state.
      if (property === "circuitBreaker") return breaker;
      return Reflect.get(target, property, target);
    },
  }) as Sql;
}
