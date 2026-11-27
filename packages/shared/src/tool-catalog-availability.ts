import type { ToolCatalogEntryStatus } from "./constants.js";

type CatalogEntryState = { status: ToolCatalogEntryStatus; quarantineReason?: string | null };

export function isCatalogEntryRemovedByProvider(entry: CatalogEntryState): boolean {
  return entry.status === "removed" || (entry.status === "disabled" && entry.quarantineReason === "mcp_tool_removed");
}

export function isCatalogEntryOffered(entry: CatalogEntryState): boolean {
  return entry.status === "active" || entry.status === "quarantined";
}

export function isCatalogEntryBlocked(entry: CatalogEntryState): boolean {
  return !isCatalogEntryOffered(entry) && !isCatalogEntryRemovedByProvider(entry);
}
