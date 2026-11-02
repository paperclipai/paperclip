/** Provider mode identifiers are opaque to the runner. Adapters own their
 * supported values, defaults, native translation, and acknowledgement. */
export function isProviderMode(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && Array.from(value).length <= 240 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function parseProviderMode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isProviderMode(value)) throw new Error("Provider mode must be a nonempty identifier of at most 240 characters without control characters");
  return value;
}
