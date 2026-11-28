/** A bounded identifier: an error code such as `40001` or `ECONNRESET`, or a class name. */
export const SAFE_ERROR_CAUSE_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

/** A lower snake_case code that is a whole message or precedes its first colon. */
const MESSAGE_CODE_PATTERN = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?::|$)/;
const CAUSE_DEPTH = 4;

/**
 * The first safe error code in an error and up to three nested `cause`
 * objects, else the outer error's class name, else `unknown_error`.
 *
 * Database and transport adapters wrap their coded failure in Error.cause.
 * Read only bounded codes: messages can contain SQL, arguments or secrets.
 */
export function safeErrorCauseCode(error: unknown): string {
  return firstErrorCode(error) ?? safeClassName(error);
}

/**
 * Like {@link safeErrorCauseCode}, but a refusal thrown as
 * `new Error("native_result_not_persisted")` is named by that code instead of
 * by its class name. Only a lower snake_case identifier that is the whole
 * message, or precedes its first colon, is read; free text never matches.
 * Error codes still win over message codes.
 */
export function safeErrorReasonCode(error: unknown): string {
  return firstErrorCode(error) ?? firstMessageCode(error) ?? safeClassName(error);
}

function firstErrorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < CAUSE_DEPTH && isRecord(current); depth++) {
    const code = current.code;
    if (typeof code === "string" && SAFE_ERROR_CAUSE_PATTERN.test(code)) return code;
    current = current.cause;
  }
  return null;
}

function firstMessageCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < CAUSE_DEPTH && isRecord(current); depth++) {
    const code = typeof current.message === "string" ? MESSAGE_CODE_PATTERN.exec(current.message)?.[1] : undefined;
    if (code !== undefined && code.length <= 80) return code;
    current = current.cause;
  }
  return null;
}

function safeClassName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return SAFE_ERROR_CAUSE_PATTERN.test(name) ? name : "unknown_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
