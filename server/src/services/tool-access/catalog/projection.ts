import { toolCatalogEntries } from "@paperclipai/db";
import type { ToolCatalogEntry } from "@paperclipai/shared";

export function toCatalogEntry(
  row: typeof toolCatalogEntries.$inferSelect,
): ToolCatalogEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    entryKind: row.entryKind,
    name: row.name,
    toolName: row.toolName,
    title: row.title,
    description: row.description,
    inputSchema: row.inputSchema ?? {},
    outputSchema: row.outputSchema ?? null,
    annotations: row.annotations ?? {},
    riskLevel: row.riskLevel,
    isReadOnly: row.isReadOnly,
    isWrite: row.isWrite,
    isDestructive: row.isDestructive,
    status: row.status,
    addedAt: row.firstSeenAt,
    version: row.version,
    versionHash: row.versionHash,
    schemaHash: row.schemaHash,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    reviewedAt: row.reviewedAt,
    reviewedByAgentId: row.reviewedByAgentId,
    reviewedByUserId: row.reviewedByUserId,
    quarantinedAt: row.quarantinedAt,
    quarantineReason: row.quarantineReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
