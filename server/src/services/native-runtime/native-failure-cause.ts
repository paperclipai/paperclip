/**
 * Cause-chain extraction for native finalization failures.
 *
 * Measured on the live control plane 2026-10-06: 105 `heartbeat_runs` rows ended
 * with `error` starting `Failed query: update "heartbeat_runs" set "status" = $1`
 * and 105/105 of them had `exit_code = NULL`. The statement is the
 * ownership-guarded finalization write, so the crash evidence it carried was
 * destroyed by the failure it was reporting.
 *
 * The cause is irretrievable after that point because `DrizzleQueryError`
 * builds its message from the query and params only, and both catch sites in
 * `native-run-finalizer.ts` persisted `error.message` alone. The Postgres
 * SQLSTATE lives in `error.cause.code`, which is exactly the field that was
 * dropped. This module walks the chain so the SQLSTATE reaches a queryable
 * column instead of a log nobody reads.
 */

/** Postgres SQLSTATE is a five-character class/code string such as `40P01`. */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Hops are bounded so a self-referential or cyclic `cause` chain cannot spin.
 * Five hops covers `DrizzleQueryError` -> `DatabaseError` -> pool/socket error
 * with room to spare.
 */
export const MAX_NATIVE_FAILURE_CAUSE_HOPS = 5;

/** Per-hop message cap. A failed statement's rendered message is the bulk of it. */
export const MAX_NATIVE_FAILURE_CAUSE_MESSAGE_CHARS = 2_000;

export interface NativeFailureCauseHop {
  depth: number;
  name: string | null;
  message: string | null;
  /** `code` for a Postgres `DatabaseError`; the SQLSTATE. Driver codes otherwise. */
  code: string | null;
  /** True when `code` parses as a Postgres SQLSTATE. */
  sqlstate: boolean;
}

export interface NativeFailureCauseDetail {
  /**
   * Deepest non-null SQLSTATE in the chain, falling back to the deepest driver
   * code. This is the field that answers "was it a deadlock, a lock timeout, or
   * a dropped socket?".
   */
  causeCode: string | null;
  /** True when `causeCode` is a Postgres SQLSTATE rather than a driver code. */
  sqlstate: boolean;
  causeChain: NativeFailureCauseHop[];
}

function readMessage(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return null;
}

function readName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

function readCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { code?: unknown }).code;
  if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  return null;
}

function clipMessage(value: string | null): string | null {
  if (value === null) return null;
  return value.length > MAX_NATIVE_FAILURE_CAUSE_MESSAGE_CHARS
    ? `${value.slice(0, MAX_NATIVE_FAILURE_CAUSE_MESSAGE_CHARS)}... [truncated]`
    : value;
}

function nextHop(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  // `originalError` is the name several transports use for the same link.
  return (value as { cause?: unknown }).cause ?? (value as { originalError?: unknown }).originalError ?? null;
}

/**
 * Walks the `cause` / `originalError` chain and reports every hop with its
 * machine code. Safe to call with any value, including non-Error throws.
 */
export function describeNativeFailureCause(error: unknown): NativeFailureCauseDetail {
  const hops: NativeFailureCauseHop[] = [];
  // Identity, not value: two distinct wrappers can legitimately carry the same
  // message and no code, and the deeper SQLSTATE behind them is still new
  // information. Comparing rendered values treated those as a cycle and hid
  // the code we came for.
  const visited = new Set<object>();
  let cursor: unknown = error;
  let guard = 0;
  while (cursor !== null && cursor !== undefined && guard < MAX_NATIVE_FAILURE_CAUSE_HOPS) {
    guard += 1;
    if (typeof cursor === "object" || typeof cursor === "function") {
      if (visited.has(cursor as object)) break;
      visited.add(cursor as object);
    }
    hops.push({
      depth: hops.length,
      name: readName(cursor),
      message: clipMessage(readMessage(cursor)),
      code: readCode(cursor),
      sqlstate: (() => {
        const code = readCode(cursor);
        return code !== null && SQLSTATE_PATTERN.test(code);
      })(),
    });
    cursor = nextHop(cursor);
  }

  const sqlstateHop = [...hops].reverse().find((hop) => hop.sqlstate) ?? null;
  const codedHop = [...hops].reverse().find((hop) => hop.code !== null) ?? null;
  const chosen = sqlstateHop ?? codedHop;
  return {
    causeCode: chosen?.code ?? null,
    sqlstate: chosen?.sqlstate ?? false,
    causeChain: hops,
  };
}

/**
 * Result-json payload for a finalization failure. Kept flat on purpose: the
 * reconciler copies `failureDetail` into `heartbeat_runs`, so a query can reach
 * the SQLSTATE with `result_json->>'finalizationCauseCode'` instead of parsing
 * the rendered statement out of the `error` text.
 *
 * Every key is emitted unconditionally. `recordRetryableFailure` merges this
 * payload into the previous attempt's json with `||`, so a retry that lands a
 * different kind of failure would otherwise inherit the old classification: an
 * `ECONNRESET` after a `40P01` overwrote the code but kept
 * `finalizationSqlstate: true`, and a failure with no code at all kept the
 * previous code. Writing the falsy values makes each attempt replace the last.
 */
export function buildNativeFailureCauseResultJson(
  detail: NativeFailureCauseDetail,
): Record<string, unknown> {
  return {
    finalizationCauseCode: detail.causeCode,
    finalizationSqlstate: detail.sqlstate,
    finalizationCauseChain: detail.causeChain,
  };
}
