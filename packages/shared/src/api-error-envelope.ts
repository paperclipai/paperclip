/**
 * The additive `ok: false` discriminator for API error envelopes (RBR-924).
 *
 * ## Why this exists
 *
 * An error body is `{ "error": "..." }`. A success body is the issue/comment
 * object itself. The two are distinguishable only by the *absence* of keys, and
 * absence is exactly what a hand-rolled client cannot see: `jq '.id'` renders a
 * missing key as `null`, which reads as success. RBR-882 recorded two live
 * repros of agents losing writes to a 403 they never noticed.
 *
 * `ok: false` gives every error body one positive field a client can test.
 * `jq '.ok // true'` degrades safely on success bodies (absent → `true`), so no
 * existing client has to change and no success response is restructured.
 *
 * ## Scope contract (RBR-924 guardrails)
 *
 * **Purely additive.** This module only ever *adds* `ok: false` to a body that
 * already carries a populated `error` string. It never removes or renames
 * `error`, never touches success bodies, and never introduces a wrapping
 * envelope. If a body already declares `ok`, that value is left alone — the
 * caller is assumed to know better than the shim.
 */

/**
 * A body is treated as an error envelope when it is a plain object carrying a
 * non-empty top-level `error` string.
 *
 * Deliberately narrow. Arrays are excluded (list endpoints return them on
 * success), and a body whose `error` is an object/array is left alone because
 * the `ok: false` promise is "there is a human-readable `error` next to me".
 */
export function isApiErrorEnvelope(body: unknown): body is { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error.trim().length > 0;
}

/**
 * Add `ok: false` to an error envelope, in place of nothing else.
 *
 * Returns the body unchanged when it is not an error envelope (success bodies,
 * arrays, primitives, streams) or when `ok` is already present. `ok` is
 * inserted *first* so a human reading a raw curl body sees the verdict before
 * the prose.
 */
export function withApiErrorDiscriminator<T>(body: T): T {
  if (!isApiErrorEnvelope(body)) return body;
  if ("ok" in (body as Record<string, unknown>)) return body;
  return { ok: false as const, ...(body as Record<string, unknown>) } as T;
}
