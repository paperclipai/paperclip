import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Default environment-variable names whose values are secret signing keys and
 * must never leave the machine inside a database dump. The hourly `*.sql.gz`
 * dumps are backed up offsite with no exclusions, and run-event rows can carry a
 * serialised process environment that includes these assignments in the clear.
 *
 * This is only a sensible default. Every public function in this module accepts
 * an optional `secretEnvVars` list, so an operator (or the `server` package,
 * which owns the authoritative `RUNTIME_SECRET_ENV_VARS`) can inject its own set
 * at the call site. Injection — rather than importing the list from `server` —
 * keeps the dependency direction clean: `@paperclip/db` must not depend on
 * `server`. The default below is a safety net for callers that do not inject.
 */
export const REDACTED_SECRET_ENV_VARS = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "BETTER_AUTH_SECRET",
] as const;

export const SECRET_REDACTION_PLACEHOLDER = "[REDACTED]";

/** A list of secret env-var names to redact. Accepts the default `as const`
 * tuple or any operator-supplied array. */
export type SecretEnvVars = readonly string[];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the redaction regex for a list of secret env-var names. Matches
 * `NAME=<value>` for each name.
 *
 * - **Value grammar (`[^\s"']+`).** The value is the run of characters up to the
 *   next whitespace or quote — the real field delimiters in the serialised forms
 *   a secret assignment appears in (a `KEY=VALUE` pair ends at whitespace; a
 *   JSON/array-quoted `"KEY=VALUE"` ends at the quote). The value is matched in
 *   full rather than to a restricted token alphabet, so an operator-supplied
 *   secret containing punctuation (e.g. `abc.def!`) is redacted completely
 *   instead of leaving the suffix in the dump. In pg_dump plain COPY a real
 *   newline or tab is escaped (`\n`, `\t`), so a value never contains an
 *   unescaped whitespace/quote and never spans a physical line — the grammar
 *   stops exactly at the true boundary and cannot swallow the next column.
 * - **Left name boundary (`(?<![A-Za-z0-9_])`).** The name must not be preceded
 *   by another env-name character, so `NOT_PAPERCLIP_AGENT_JWT_SECRET=...` does
 *   not match on the embedded suffix and corrupt an unrelated variable.
 * - **Idempotent.** The placeholder `[REDACTED]` contains no whitespace or quote,
 *   so re-running redaction over `NAME=[REDACTED]` matches and re-writes it to
 *   the same `NAME=[REDACTED]`.
 *
 * Throws on an empty list rather than compiling a regex that would match nothing.
 */
export function buildSecretAssignmentRegex(secretEnvVars: SecretEnvVars): RegExp {
  if (secretEnvVars.length === 0) {
    throw new Error("buildSecretAssignmentRegex: secretEnvVars must not be empty");
  }
  return new RegExp(
    `(?<![A-Za-z0-9_])(${secretEnvVars.map(escapeRegExp).join("|")})=[^\\s"']+`,
    "g",
  );
}

/** Precompiled regex for the default list — the hot path avoids recompilation. */
const DEFAULT_SECRET_ASSIGNMENT_REGEX = buildSecretAssignmentRegex(REDACTED_SECRET_ENV_VARS);

/** Resolve a list to its regex, reusing the precompiled default when possible. */
function regexFor(secretEnvVars: SecretEnvVars): RegExp {
  return secretEnvVars === REDACTED_SECRET_ENV_VARS
    ? DEFAULT_SECRET_ASSIGNMENT_REGEX
    : buildSecretAssignmentRegex(secretEnvVars);
}

function redactWithRegex(text: string, regex: RegExp): string {
  // A global regex reused across `.replace` calls is safe: `replace` resets
  // `lastIndex` on completion, so no state leaks between invocations.
  return text.replace(regex, `$1=${SECRET_REDACTION_PLACEHOLDER}`);
}

/**
 * Redact known secret env-assignments within text. The value grammar excludes
 * whitespace, so a match never crosses a line boundary; callers that stream bytes
 * MUST still redact on whole lines (see {@link createLineRedactor}) so a value
 * split across two chunks is not partially matched.
 *
 * @param secretEnvVars names to redact; defaults to {@link REDACTED_SECRET_ENV_VARS}.
 */
export function redactSecretAssignments(
  text: string,
  secretEnvVars: SecretEnvVars = REDACTED_SECRET_ENV_VARS,
): string {
  return redactWithRegex(text, regexFor(secretEnvVars));
}

/**
 * Force-flush threshold for a single line with no newline. PostgreSQL COPY
 * escapes newlines inside text and JSON values, so one very large row stays on
 * one physical line; without a cap the carry would grow to the full row size in
 * memory. Once the carry passes this size we emit a redacted prefix instead of
 * holding the whole row.
 */
const MAX_CARRY_BYTES = 1 << 20; // 1 MiB

/**
 * Bytes retained after a forced flush. Any realistic `NAME=value` secret
 * assignment is far shorter than this, so retaining this much guarantees a
 * forced-flush cut lands between assignments (see {@link lastValueBoundary}) and
 * never bisects one — which would half-redact and leak a fragment.
 */
const CARRY_SAFE_TAIL_BYTES = 64 * 1024; // 64 KiB

/**
 * Index (inclusive) of the last whitespace or quote at or before `limit`, or -1
 * if none. A whitespace/quote is a value delimiter (the value grammar excludes
 * both), so a cut immediately after such a character cannot fall inside a
 * `NAME=value` match.
 */
function lastValueBoundary(text: string, limit: number): number {
  for (let i = Math.min(limit, text.length - 1); i >= 0; i--) {
    const c = text.charCodeAt(i);
    // space, tab, LF, CR, FF, VT, or a quote (" ')
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 34 || c === 39) {
      return i;
    }
  }
  return -1;
}

/**
 * Stateful, line-buffered redactor for streamed dump bytes. Only complete lines
 * (terminated by `\n`) are redacted and returned; a trailing partial line is held
 * as carry until the next chunk or {@link flush} completes it. This guarantees the
 * full secret value is present before the regex runs, so a value straddling a
 * chunk boundary can never be half-redacted (which would both leak a fragment and
 * corrupt the dump). The regex is compiled once per redactor, not per chunk.
 *
 * To bound memory on a pathologically long single line (a COPY row can escape its
 * newlines and stay physically unbroken), once the carry exceeds
 * {@link MAX_CARRY_BYTES} the redactor emits the redacted prefix up to the last
 * value delimiter that leaves a {@link CARRY_SAFE_TAIL_BYTES} tail, so no secret
 * assignment is bisected. If no delimiter is found in that window the line is a
 * single delimiter-free token; it is kept whole (correctness over the bound).
 *
 * @param secretEnvVars names to redact; defaults to {@link REDACTED_SECRET_ENV_VARS}.
 */
export function createLineRedactor(secretEnvVars: SecretEnvVars = REDACTED_SECRET_ENV_VARS) {
  const decoder = new StringDecoder("utf8");
  const regex = regexFor(secretEnvVars);
  let carry = "";
  return {
    push(chunk: Buffer | string): string {
      const text = carry + (typeof chunk === "string" ? chunk : decoder.write(chunk));
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) {
        if (text.length > MAX_CARRY_BYTES) {
          const boundary = lastValueBoundary(text, text.length - CARRY_SAFE_TAIL_BYTES);
          if (boundary >= 0) {
            carry = text.slice(boundary + 1);
            return redactWithRegex(text.slice(0, boundary + 1), regex);
          }
        }
        carry = text;
        return "";
      }
      const complete = text.slice(0, lastNewline + 1);
      carry = text.slice(lastNewline + 1);
      return redactWithRegex(complete, regex);
    },
    flush(): string {
      const text = carry + decoder.end();
      carry = "";
      return text === "" ? "" : redactWithRegex(text, regex);
    },
  };
}

/**
 * A `stream.Transform` that line-redacts known secret assignments from a dump
 * byte stream. Insert between `pg_dump` stdout and gzip so secrets are scrubbed
 * at generation, before the compressed artefact is ever written to disk.
 *
 * @param secretEnvVars names to redact; defaults to {@link REDACTED_SECRET_ENV_VARS}.
 */
export function createSecretRedactionTransform(
  secretEnvVars: SecretEnvVars = REDACTED_SECRET_ENV_VARS,
): Transform {
  const redactor = createLineRedactor(secretEnvVars);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        const out = redactor.push(chunk);
        callback(null, out.length > 0 ? out : undefined);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        const out = redactor.flush();
        callback(null, out.length > 0 ? out : undefined);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}
