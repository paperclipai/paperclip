import { createHash } from "node:crypto";

// Keep catalog discovery and native-provider admission on the same saved contract.
export function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value, Object.keys(flattenKeys(value)).sort()))
    .digest("hex");
}

function flattenKeys(
  value: unknown,
  keys: Record<string, true> = {},
): Record<string, true> {
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      keys[key] = true;
      flattenKeys(nested, keys);
    }
  }
  return keys;
}

export function descriptorHash(
  tool: { name: string; title?: string | null; description?: string | null; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> },
  riskLevel: string,
): string {
  return stableHash({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? {},
    annotations: tool.annotations ?? {},
    riskLevel,
  });
}
