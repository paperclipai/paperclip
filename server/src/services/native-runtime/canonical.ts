import { createHash } from "node:crypto";

export function canonicalNativeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalNativeJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalNativeJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function nativeSha256(value: unknown): string {
  return createHash("sha256").update(canonicalNativeJson(value), "utf8").digest("hex");
}
