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
 * `NAME=<value>` for each name, where `<value>` is the run of secret-token
 * characters (base64 / hex / url-safe alphabet) following the `=`. pg_dump plain
 * COPY escapes real newlines, tabs and backslashes, so a secret value never
 * spans a physical line and always terminates at a column separator, whitespace,
 * or any character outside the token alphabet. The value alphabet excludes `[`
 * and `]`, so re-running redaction over `NAME=[REDACTED]` is a no-op (redaction
 * is idempotent). Throws on an empty list rather than compiling a regex that
 * would match nothing (or, worse, everything).
 */
export function buildSecretAssignmentRegex(secretEnvVars: SecretEnvVars): RegExp {
  if (secretEnvVars.length === 0) {
    throw new Error("buildSecretAssignmentRegex: secretEnvVars must not be empty");
  }
  return new RegExp(
    `(${secretEnvVars.map(escapeRegExp).join("|")})=[A-Za-z0-9+/=_-]+`,
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
 * Redact known secret env-assignments within text. The value alphabet excludes
 * `\n`, so matches never cross a line boundary; callers that stream bytes MUST
 * still redact on whole lines (see {@link createLineRedactor}) so a value split
 * across two chunks is not partially matched.
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
 * Stateful, line-buffered redactor for streamed dump bytes. Only complete lines
 * (terminated by `\n`) are redacted and returned; a trailing partial line is held
 * as carry until the next chunk or {@link flush} completes it. This guarantees the
 * full secret value is present before the regex runs, so a value straddling a
 * chunk boundary can never be half-redacted (which would both leak a fragment and
 * corrupt the dump). The regex is compiled once per redactor, not per chunk.
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
