/**
 * RunId — branded canonical-UUID value object.
 *
 * `X-Paperclip-Run-Id`, `PAPERCLIP_RUN_ID`, the JWT `run_id` claim, and
 * `actor.runId` all flow into Postgres `uuid` columns
 * (`issues.checkout_run_id`, `issue_comments.created_by_run_id`,
 * `issues.execution_run_id`). Drizzle/Postgres reject anything that is not
 * a canonical lowercase UUID with a 500 + stack trace — so every untrusted
 * boundary that produces a runId must validate before handing it to the
 * service layer.
 *
 * Validate once at each trust boundary (HTTP middleware, env reader, CLI
 * arg parser), brand the result, and let the type system propagate the
 * guarantee. Service-layer code accepts `RunId` and trusts it.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

declare const RunIdBrand: unique symbol;

/** A canonical lowercase UUID known to be safe for `uuid` columns. */
export type RunId = string & { readonly [RunIdBrand]: "RunId" };

/** Where an attempted RunId came from. Surfaces in errors for caller-side debugging. */
export type RunIdSource = "header" | "env" | "claim" | "config" | "cli";

export type RunIdParseError = {
  readonly kind: "invalid_run_id";
  readonly source: RunIdSource;
  readonly got: string;
};

export function isRunIdParseError(value: unknown): value is RunIdParseError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "invalid_run_id"
  );
}

/**
 * Parse a value that must be a runId.
 *
 * Empty string, whitespace, non-string, and non-UUID-shaped input all
 * return a `RunIdParseError`. Uppercase UUIDs are accepted and normalized
 * to lowercase (header casing drift from `curl`/scripts is common).
 *
 * Use `parseOptional` when the input is allowed to be absent.
 */
export function parseRunId(input: unknown, source: RunIdSource): RunId | RunIdParseError {
  const got = typeof input === "string" ? input : "";
  const normalized = got.trim().toLowerCase();
  if (UUID_PATTERN.test(normalized)) return normalized as RunId;
  return { kind: "invalid_run_id", source, got };
}

/**
 * Parse a value that may be absent (`undefined` / `null`).
 *
 * - Absent input → `null` (caller falls through to a backup source, e.g. a
 *   JWT claim).
 * - Present-but-invalid (including empty string) → `RunIdParseError`. An
 *   empty header is a caller bug; either send the header with a real UUID
 *   or omit it entirely.
 */
export function parseOptionalRunId(
  input: unknown,
  source: RunIdSource,
): RunId | RunIdParseError | null {
  if (input === undefined || input === null) return null;
  return parseRunId(input, source);
}

/**
 * Brand a string already known to be a valid UUID (e.g. freshly minted by
 * `crypto.randomUUID()` or returned from `runs.id`) without re-validating.
 *
 * Use only when the caller already controls the value. Untrusted input
 * (headers, env, CLI args) must go through `parseRunId` / `parseOptionalRunId`.
 */
export function unsafeRunId(uuid: string): RunId {
  return uuid as RunId;
}

/** Type guard for narrowing arbitrary strings. */
export function isRunId(value: unknown): value is RunId {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
