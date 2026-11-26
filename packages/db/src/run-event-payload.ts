import { customType } from "drizzle-orm/pg-core";

// Reserved only in the on-disk representation, never in a decoded event.
const originalJsonKey = "$paperclipRunEventJsonV1";

/** Keep JSONB routing fields queryable while retaining JSON strings containing NUL. */
export function encodeRunEventPayload(payload: Record<string, unknown>): string {
  const originalJson = JSON.stringify(payload);
  if (!originalJson.includes("\\u0000") && !originalJson.includes(originalJsonKey)) {
    return originalJson;
  }

  const original = JSON.parse(originalJson) as Record<string, unknown>;
  let needsEncoding = Object.hasOwn(original, originalJsonKey);
  function projectString(value: string): string {
    if (!value.includes("\u0000")) return value;
    needsEncoding = true;
    return value.replaceAll("\u0000", "\\u0000");
  }
  function project(value: unknown): unknown {
    if (typeof value === "string") return projectString(value);
    if (Array.isArray(value)) return value.map(project);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        projectString(key), project(entry),
      ]));
    }
    return value;
  }

  const projection = project(original) as Record<string, unknown>;
  if (!needsEncoding) return originalJson;
  // JSON.stringify escapes the original JSON a second time: PostgreSQL receives
  // literal backslashes, not an unsupported U+0000. Decode before hashing/replay.
  return JSON.stringify({ ...projection, [originalJsonKey]: originalJson });
}

export function decodeRunEventPayload(value: string | Record<string, unknown>): Record<string, unknown> {
  const payload = typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value;
  if (Object.hasOwn(payload, originalJsonKey)) {
    const originalJson = payload[originalJsonKey];
    if (typeof originalJson !== "string") throw new Error("Invalid run-event payload encoding");
    const original: unknown = JSON.parse(originalJson);
    if (original === null || typeof original !== "object" || Array.isArray(original)) {
      throw new Error("Invalid run-event payload encoding");
    }
    return original as Record<string, unknown>;
  }
  return payload;
}

// The SQL type stays JSONB; existing rows and SQL routing queries are unchanged.
export const runEventPayload = customType<{
  data: Record<string, unknown>;
  driverData: string;
}>({
  dataType: () => "jsonb",
  toDriver: encodeRunEventPayload,
  fromDriver: decodeRunEventPayload,
});
