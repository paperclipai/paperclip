export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns the ORIGINAL string (not trimmed) when non-blank; null otherwise. */
export function readNonEmptyString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

/** Returns the TRIMMED string when non-blank; null otherwise. */
export function readNonEmptyTrimmedString(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}
