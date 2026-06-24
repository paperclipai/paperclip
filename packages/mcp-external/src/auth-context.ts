import { AsyncLocalStorage } from "node:async_hooks";

interface AuthStore {
  /** Verbatim inbound Authorization header value (e.g. "Bearer pcp_..."), or null. */
  bearer: string | null;
}

const storage = new AsyncLocalStorage<AuthStore>();

/**
 * Run `fn` with the inbound caller's Authorization header in context.
 * Every REST call made inside `fn` reads this bearer (see client.ts).
 * `bearer` is the verbatim header value or null (stdio / unauthenticated).
 */
export function runWithBearer<T>(bearer: string | null, fn: () => T): T {
  return storage.run({ bearer: bearer ?? null }, fn);
}

/** The current request's inbound Authorization value, or null outside a scope. */
export function currentBearer(): string | null {
  return storage.getStore()?.bearer ?? null;
}
