import { toolApplications } from "@paperclipai/db";
import type { ToolApplication } from "@paperclipai/shared";

export function toApplication(
  row: typeof toolApplications.$inferSelect,
): ToolApplication {
  return {
    id: row.id,
    companyId: row.companyId,
    applicationKey: row.applicationKey ?? undefined,
    name: row.name,
    description: row.description,
    type: row.type,
    status: row.status,
    pluginId: row.pluginId,
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    metadata: row.metadata ?? null,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
