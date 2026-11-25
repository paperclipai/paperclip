const MAX_DESCRIPTION_LENGTH = 500;
const TEXT_FIELDS = ["message", "reason", "code", "statusCode", "status"] as const;
const NESTED_FIELDS = ["error", "body"] as const;

function readField(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function textFields(value: object): string[] {
  const parts: string[] = [];
  for (const key of TEXT_FIELDS) {
    const text = asText(readField(value, key));
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts;
}

function constructorName(value: object): string | null {
  try {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name && name !== "Object" ? name : null;
  } catch {
    return null;
  }
}

function toOneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_DESCRIPTION_LENGTH ? `${line.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...` : line;
}

export function describeThrownValue(value: unknown): string {
  try {
    if (value instanceof Error) return value.message;
    if (value === null || value === undefined) return String(value);
    if (typeof value !== "object") return toOneLine(String(value));

    const parts = textFields(value);
    for (const key of NESTED_FIELDS) {
      const nested = readField(value, key);
      if (!nested || typeof nested !== "object") continue;
      for (const text of textFields(nested)) if (!parts.includes(text)) parts.push(text);
    }
    const name = constructorName(value);
    if (parts.length === 0) return name ? `${name} (no message)` : "Unknown error (no message)";
    return toOneLine(name ? `${name}: ${parts.join(": ")}` : parts.join(": "));
  } catch {
    return "Unknown error (no message)";
  }
}
