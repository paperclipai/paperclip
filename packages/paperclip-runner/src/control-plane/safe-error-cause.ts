/** A bounded identifier: an error code such as `40001` or `ECONNRESET`, or a class name. */
export const SAFE_ERROR_CAUSE_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * The first safe error code in an error and up to three nested `cause`
 * objects, else the outer error's class name, else `unknown_error`.
 *
 * Database and transport adapters wrap their coded failure in Error.cause.
 * Read only bounded codes: messages can contain SQL, arguments or secrets.
 */
export function safeErrorCauseCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth++) {
    const code = current.code;
    if (typeof code === "string" && SAFE_ERROR_CAUSE_PATTERN.test(code)) return code;
    current = current.cause;
  }
  const name = error instanceof Error ? error.name : typeof error;
  return SAFE_ERROR_CAUSE_PATTERN.test(name) ? name : "unknown_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
