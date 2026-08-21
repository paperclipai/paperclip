import { createHash } from "node:crypto";

export type ManagedResourceStockStatus =
  | "missing"
  | "stock_current"
  | "stock_update_available"
  | "operator_modified";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stockHash(value: unknown) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function resourceStatus(input: {
  resourceId: string | null;
  currentHash: string | null;
  bindingStockHash: string | null;
  latestStockHash: string;
}): ManagedResourceStockStatus {
  if (!input.resourceId || !input.currentHash) return "missing";
  if (input.currentHash === input.latestStockHash) return "stock_current";
  if (input.bindingStockHash && input.currentHash === input.bindingStockHash) {
    return "stock_update_available";
  }
  return "operator_modified";
}
