/**
 * Walks an error's `.cause` chain (guarding against cycles) looking for the
 * first node for which `extract` returns a defined value. Drizzle/pg errors
 * are sometimes wrapped (e.g. by transaction retry logic or the driver
 * itself), so a Postgres error code or constraint name can show up a level
 * or two below the error actually thrown/caught -- this is the intended
 * consolidation point for that walk, shared by every "is this a Postgres
 * error with shape X" helper instead of each call site reimplementing (and
 * subtly diverging on) the same loop. It is not yet the only place this
 * pattern is implemented -- see also `isBuiltInAgentMarkerConflict` in
 * built-in-agents.ts, `isIssuePrefixConflict` in companies.ts, and several
 * flat top-level-only `error.code === ...` checks (documents.ts,
 * plugin-registry.ts, routines.ts, routes/pipelines.ts) that predate this
 * helper and may not correctly handle wrapped Drizzle errors.
 *
 * `extract`'s return type deliberately excludes `boolean`: a predicate like
 * `(node) => node.code === '23505'` would return `false` for a
 * non-matching node, and since `false !== undefined`, that would stop the
 * walk right there and swallow the real match a level or two deeper.
 * Callers that want a yes/no answer should have `extract` return the
 * matched value itself (e.g. the code or constraint name) and check the
 * overall result for `!== undefined`, as `isPostgresError` below does. The
 * walk itself also treats `false` the same as `undefined` (continue, don't
 * stop) as defense in depth, in case a node is ever produced through an
 * `as`/`@ts-expect-error` cast that bypasses the type constraint.
 *
 * The `T extends ...` constraint below excludes both `boolean` and
 * `unknown` from what `T` can be. Without it, a caller whose predicate is
 * typed `(node: object): unknown` would infer `T = unknown`, and
 * `Exclude<unknown, boolean>` evaluates to `unknown` (not `never`), so the
 * `Exclude<T, boolean>` constraint on `extract` alone doesn't reject an
 * `unknown`-returning predicate -- it's a type-level gap, not a runtime one,
 * since the `!== false` guard below still handles a stray `false` correctly
 * at runtime either way.
 */
export function findInErrorCauseChain<
  T extends object | string | number | symbol | null | undefined,
>(
  error: unknown,
  extract: (node: object) => Exclude<T, boolean> | undefined,
): T | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const result = extract(current);
    if (result !== undefined && (result as unknown) !== false) return result;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * True if `error`, or any error in its `.cause` chain, carries the given
 * Postgres error code (e.g. "23505" unique_violation, "42703"
 * undefined_column). Walks the cause chain because drizzle can wrap the
 * underlying `pg` error.
 */
export function isPostgresError(error: unknown, code: string): boolean {
  return (
    findInErrorCauseChain(error, (node) => {
      const maybe = node as { code?: string };
      return maybe.code === code ? maybe.code : undefined;
    }) !== undefined
  );
}

export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden", details?: unknown) {
  return new HttpError(403, message, details);
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

export function tooManyRequests(message = "Too many requests", details?: unknown) {
  return new HttpError(429, message, details);
}
