import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolApplications, toolCatalogEntries, toolConnections } from "@paperclipai/db";
import { readMcpIcons, type ProviderToolIconEntry } from "@paperclipai/shared";
import { shortStableId, slugSegment } from "../../tool-gateway.js";
import { assignedToolName } from "../../native-runtime/assigned-mcp-tools.js";

/** Most icon entries returned per company. The chat only needs the tools that declare icons. */
const MAX_ICON_ENTRIES = 500;

/**
 * Provider icons (SEP-973) for a company's connected tools, keyed the way the
 * tool gateway names them (`mcp.<app>-<connection>:<tool>`), so the task chat
 * can find a transcript row's icon without a request per row. Only tools that
 * declare icons, on connections the caller may see, are listed. Icons are re-sanitized on the way out.
 */
export async function listCompanyProviderToolIcons(db: Db, companyId: string, connectionIds: readonly string[]): Promise<ProviderToolIconEntry[]> {
  if (connectionIds.length === 0) return [];
  const rows = await db.select({
    toolName: toolCatalogEntries.toolName,
    icons: toolCatalogEntries.icons,
    connectionId: toolConnections.id,
    connectionName: toolConnections.name,
    transport: toolConnections.transport,
    applicationKey: toolApplications.applicationKey,
    applicationName: toolApplications.name,
  })
    .from(toolCatalogEntries)
    .innerJoin(toolConnections, eq(toolConnections.id, toolCatalogEntries.connectionId))
    .innerJoin(toolApplications, eq(toolApplications.id, toolCatalogEntries.applicationId))
    .where(and(
      eq(toolCatalogEntries.companyId, companyId),
      eq(toolConnections.companyId, companyId),
      inArray(toolConnections.id, [...connectionIds]),
      isNotNull(toolCatalogEntries.icons),
      eq(toolCatalogEntries.status, "active"),
      ne(toolConnections.status, "archived"),
    ))
    .limit(MAX_ICON_ENTRIES);
  return rows.flatMap((row) => {
    const icons = readMcpIcons(row.icons);
    if (!icons) return [];
    const namespace = `${row.transport === "rest_api" ? "app" : "mcp"}.${slugSegment(row.applicationKey ?? row.connectionName ?? row.applicationName, "mcp")}-${shortStableId(row.connectionId)}`;
    const gatewayToolName = `${namespace}:${slugSegment(row.toolName, "tool")}`;
    return [{ gatewayToolName, nativeToolName: assignedToolName(gatewayToolName), icons }];
  });
}
