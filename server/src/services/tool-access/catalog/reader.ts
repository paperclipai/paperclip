import { isGitHubAppConnection } from "../../github-app-credentials.js";
import { singleFlight } from "../single-flight.js";
import type { ActorInfo } from "../types.js";
import { descriptorHash } from "../../tool-catalog-hash.js";
import { nativeProviderCatalogFor } from "../../native-provider-catalogs.js";
import { restConnectorFor } from "../../connectors/rest-registry.js";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolCatalogEntries, toolConnections } from "@paperclipai/db";
import type { ToolCatalogEntry } from "@paperclipai/shared";

import type { RefreshConnectionCatalog } from "./contracts.js";
export function createToolCatalogReader(db: Db, options: { catalogCacheTtlMs?: number }, now: () => Date, getConnectionRow: (idOrUid: string, companyId?: string) => Promise<typeof toolConnections.$inferSelect>, refreshCatalog: RefreshConnectionCatalog, toCatalogEntryForConnection: (row: typeof toolCatalogEntries.$inferSelect, connection: typeof toolConnections.$inferSelect) => ToolCatalogEntry) {
  const catalogRefreshFlights = new Map<string, Promise<unknown>>();
  const catalogCacheTtlMs = Math.max(
    0,
    options.catalogCacheTtlMs ?? 15 * 60 * 1000,
  );
  return {
    listCatalog: async (
      connectionId: string,
      companyId?: string,
      actor?: ActorInfo,
    ): Promise<ToolCatalogEntry[]> => {
      const connection = await getConnectionRow(connectionId, companyId);
      let rows = await db
        .select()
        .from(toolCatalogEntries)
        .where(eq(toolCatalogEntries.connectionId, connection.id))
        .orderBy(desc(toolCatalogEntries.updatedAt));
      // Native provider catalogs change with the deployed code. Upgrade saved
      // connections too; an earlier catalog must not survive merely because
      // REST discovery has no remote MCP cache timer.
      const nativeProvider = nativeProviderCatalogFor(connection);
      const restConnector = restConnectorFor(connection);
      const nativeRest = Boolean(nativeProvider || restConnector);
      const rowsByName = new Map(rows.map((row) => [row.toolName, row]));
      const nativeCatalogChanged = Boolean(nativeProvider) && connection.status === "active" && (
        rows.some((row) => row.status !== "removed" && !nativeProvider!.isToolName(row.toolName))
        || nativeProvider!.tools.some((tool) => {
          const existing = rowsByName.get(tool.name);
          return !existing || existing.versionHash !== descriptorHash(tool, nativeProvider!.risk(tool.name));
        })
      );
      const restCatalogChanged = restConnector && connection.status === "active" && (
        rows.some(row => row.status !== "removed" && !restConnector.tools.some(tool => tool.name === row.toolName))
        || restConnector.tools.some(tool => {
          const existing = rowsByName.get(tool.name);
          return !existing || !restConnector.isCurrent(existing);
        })
      );
      const cacheExpired = nativeCatalogChanged || restCatalogChanged || (
        (connection.transport === "mcp_remote" || isGitHubAppConnection(connection)) &&
        connection.status !== "archived" &&
        (rows.length === 0 ||
          !connection.lastCatalogRefreshAt ||
          connection.lastCatalogRefreshAt.getTime() <=
            now().getTime() - catalogCacheTtlMs));
      if (cacheExpired) {
        try {
          await singleFlight(catalogRefreshFlights, connection.id, () =>
            refreshCatalog(connection.id, nativeRest && actor ? actor : {
              actorType: "system",
              actorId: "tool_catalog_cache",
            }),
          );
          rows = await db
            .select()
            .from(toolCatalogEntries)
            .where(eq(toolCatalogEntries.connectionId, connection.id))
            .orderBy(desc(toolCatalogEntries.updatedAt));
        } catch (error) {
          // A stale catalog remains useful when the remote server is temporarily
          // unavailable. Empty caches still fail so callers never mistake “no
          // actions discovered” for a successful lookup.
          if (rows.length === 0) throw error;
        }
      }
      // Even failed discovery must not keep retired native tools visible.
      // Their database rows remain available to historical invocation records.
      return rows
        .filter((row) => !nativeRest || (row.status !== "removed" && (
          nativeProvider ? nativeProvider.isToolName(row.toolName) : restConnector!.tools.some(tool => tool.name === row.toolName)
        )))
        .map((row) => toCatalogEntryForConnection(row, connection));
    }
  };
}
