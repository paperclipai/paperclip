import {
  HARNESS_MAX_FRAME_BYTES, HARNESS_MAX_JSON_DEPTH, HARNESS_MAX_JSON_NODES,
  HarnessProtocolError, type JsonObject, type JsonValue,
} from "./types.js";

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new HarnessProtocolError(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const unexpected = Object.keys(value).find(key => !keys.includes(key));
  if (unexpected !== undefined) throw new HarnessProtocolError(`${path} contains unknown field ${unexpected}`);
}

export function text(value: unknown, path: string, max = 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > max
    || /[\u0000-\u001f\u007f]/u.test(value) || !isUnicodeScalarText(value)) {
    throw new HarnessProtocolError(`${path} must be bounded non-empty text without control characters`);
  }
  return value;
}

function isUnicodeScalarText(value: string): boolean {
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

export function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new HarnessProtocolError(`${path} must be a positive safe integer`);
  }
  return Number(value);
}

/** Validate before serializing: JSON.stringify must not silently drop values. */
export function jsonValue(value: unknown, path = "value"): JsonValue {
  let nodes = 0;
  const active = new Set<object>();
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > HARNESS_MAX_JSON_NODES || depth > HARNESS_MAX_JSON_DEPTH) {
      throw new HarnessProtocolError(`${path} exceeds the JSON complexity limit`);
    }
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (typeof entry === "string" && isUnicodeScalarText(entry)) return;
    if (typeof entry !== "object" || entry === null || active.has(entry)) {
      throw new HarnessProtocolError(`${path} must contain only finite, acyclic JSON values`);
    }
    active.add(entry);
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) visit(entry[index], depth + 1);
    } else {
      const fields = record(entry, path);
      for (const [key, child] of Object.entries(fields)) {
        if (!isUnicodeScalarText(key)) throw new HarnessProtocolError(`${path} contains invalid Unicode`);
        visit(child, depth + 1);
      }
    }
    active.delete(entry);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  // TextEncoder keeps the browser-safe contract surface independent of Node.
  if (new TextEncoder().encode(serialized).length > HARNESS_MAX_FRAME_BYTES) {
    throw new HarnessProtocolError(`${path} exceeds the frame byte limit`);
  }
  return JSON.parse(serialized) as JsonValue;
}

export function jsonObject(value: unknown, path: string): JsonObject {
  record(value, path);
  return jsonValue(value, path) as JsonObject;
}
