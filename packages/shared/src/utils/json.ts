/**
 * Deterministic, key-stable JSON serialization.
 *
 * Object keys are sorted so two structurally-equal payloads always produce the
 * same string regardless of insertion order. This is the canonical
 * `stableStringify` used across Paperclip for deriving content-stable hashes
 * (payload hashes for event identity, idempotency keys, etc.).
 *
 * Mirrors the previously-duplicated implementations in
 * `external-objects-server.ts` and `telemetry/client.ts` — both of which should
 * be refactored to import from here.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
