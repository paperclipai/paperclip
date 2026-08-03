import { createHash } from "node:crypto";

export type NormalizedSha256 = `sha256:${string}`;

export function normalizedContentHash(value: unknown): NormalizedSha256 {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sha256HexOfBytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
