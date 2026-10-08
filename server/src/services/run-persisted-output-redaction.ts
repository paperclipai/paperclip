import type { heartbeatRuns } from "@paperclipai/db";
import { redactSensitiveText } from "../redaction.js";
import { redactRunFailureSecretValues } from "./run-failure-diagnostics.js";

type RunWritePatch = Partial<typeof heartbeatRuns.$inferInsert>;

function redactPersistedRunString(
  value: string,
  secretValues: readonly string[],
): string {
  return redactRunFailureSecretValues(redactSensitiveText(value), secretValues);
}

export function redactPersistedRunJsonValue<T>(
  value: T,
  secretValues: readonly string[],
): T {
  if (typeof value === "string") {
    return redactPersistedRunString(value, secretValues) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactPersistedRunJsonValue(entry, secretValues),
    ) as T;
  }
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactPersistedRunJsonValue(entry, secretValues),
      ]),
    ) as T;
  }
  return value;
}

export function redactPersistedRunWritePatch(
  patch: RunWritePatch,
  secretValues: readonly string[],
): RunWritePatch {
  if (secretValues.length === 0 && !patch.resultJson && !patch.stdoutExcerpt && !patch.stderrExcerpt && typeof patch.error !== "string") {
    return patch;
  }
  const redacted: RunWritePatch = { ...patch };
  if (patch.resultJson) {
    redacted.resultJson = redactPersistedRunJsonValue(
      patch.resultJson,
      secretValues,
    );
  }
  if (typeof patch.stdoutExcerpt === "string") {
    redacted.stdoutExcerpt = redactPersistedRunString(
      patch.stdoutExcerpt,
      secretValues,
    );
  }
  if (typeof patch.stderrExcerpt === "string") {
    redacted.stderrExcerpt = redactPersistedRunString(
      patch.stderrExcerpt,
      secretValues,
    );
  }
  if (typeof patch.error === "string") {
    redacted.error = redactPersistedRunString(patch.error, secretValues);
  }
  return redacted;
}
