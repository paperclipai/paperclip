import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatEndpoints,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolProfileEntries,
} from "@paperclipai/db";
import { githubBotToolName } from "./chat-github-tools.js";
import { slackBotToolName } from "./connectors/slack-catalog.js";
import { connectedGatewayToolNames } from "./tool-gateway.js";

export type ToolProfileMigrationResult = {
  scannedEntries: number;
  migratedEntries: number;
  unresolvedEntries: number;
};

const BOT_TOOL_NAMES: Partial<Record<string, (endpointId: string, toolName: string) => string>> = {
  slack: slackBotToolName,
  github: githubBotToolName,
};

export async function migrateLegacyProfileToolNameEntries(
  db: Db,
): Promise<ToolProfileMigrationResult> {
  const entries = await db
    .select()
    .from(toolProfileEntries)
    .where(
      and(
        eq(toolProfileEntries.selectorType, "tool_name"),
        isNotNull(toolProfileEntries.toolName),
      ),
    );
  if (entries.length === 0) {
    return { scannedEntries: 0, migratedEntries: 0, unresolvedEntries: 0 };
  }

  const companyIds = [...new Set(entries.map((entry) => entry.companyId))];
  const catalogRows = await db
    .select({
      catalogEntryId: toolCatalogEntries.id,
      companyId: toolCatalogEntries.companyId,
      toolName: toolCatalogEntries.toolName,
      transport: toolConnections.transport,
      connectionId: toolConnections.id,
      connectionName: toolConnections.name,
      applicationId: toolApplications.id,
      applicationKey: toolApplications.applicationKey,
      applicationName: toolApplications.name,
    })
    .from(toolCatalogEntries)
    .innerJoin(toolConnections, eq(toolCatalogEntries.connectionId, toolConnections.id))
    .innerJoin(toolApplications, eq(toolConnections.applicationId, toolApplications.id))
    .where(
      and(
        inArray(toolCatalogEntries.companyId, companyIds),
        eq(toolCatalogEntries.entryKind, "tool"),
        eq(toolCatalogEntries.status, "active"),
        isNull(toolCatalogEntries.quarantinedAt),
      ),
    );
  const endpoints = await db
    .select({
      id: chatEndpoints.id,
      connectionId: chatEndpoints.connectionId,
      provider: chatEndpoints.provider,
    })
    .from(chatEndpoints)
    .where(inArray(chatEndpoints.companyId, companyIds));

  const catalogToolNames = new Set<string>();
  const catalogEntryIdsByGatewayName = new Map<string, Set<string>>();
  const addGatewayName = (companyId: string, name: string, catalogEntryId: string) => {
    const key = `${companyId}\u0000${name}`;
    const ids = catalogEntryIdsByGatewayName.get(key) ?? new Set<string>();
    ids.add(catalogEntryId);
    catalogEntryIdsByGatewayName.set(key, ids);
  };
  for (const row of catalogRows) {
    catalogToolNames.add(`${row.companyId}\u0000${row.toolName}`);
    const names = connectedGatewayToolNames({
      transport: row.transport,
      applicationKey: row.applicationKey ?? null,
      connectionName: row.connectionName,
      applicationName: row.applicationName,
      connectionId: row.connectionId,
      applicationId: row.applicationId,
      catalogEntryId: row.catalogEntryId,
      toolName: row.toolName,
    });
    addGatewayName(row.companyId, names.baseName, row.catalogEntryId);
    addGatewayName(row.companyId, names.disambiguatedName, row.catalogEntryId);
    for (const endpoint of endpoints) {
      const botToolName = BOT_TOOL_NAMES[endpoint.provider];
      if (botToolName && endpoint.connectionId === row.connectionId) {
        addGatewayName(row.companyId, botToolName(endpoint.id, row.toolName), row.catalogEntryId);
      }
    }
  }

  let migratedEntries = 0;
  let unresolvedEntries = 0;
  for (const entry of entries) {
    const toolName = entry.toolName!;
    const key = `${entry.companyId}\u0000${toolName}`;
    if (catalogToolNames.has(key)) continue;
    const matches = catalogEntryIdsByGatewayName.get(key);
    if (!matches) continue;
    if (matches.size > 1 && entry.effect !== "exclude") {
      unresolvedEntries += 1;
      continue;
    }
    const [first, ...rest] = [...matches];
    const migrated = await db.transaction(async (tx) => {
      const now = new Date();
      const updated = await tx
        .update(toolProfileEntries)
        .set({ selectorType: "catalog_entry", catalogEntryId: first, toolName: null, updatedAt: now })
        .where(
          and(
            eq(toolProfileEntries.id, entry.id),
            eq(toolProfileEntries.selectorType, "tool_name"),
            eq(toolProfileEntries.toolName, toolName),
          ),
        )
        .returning({ id: toolProfileEntries.id });
      if (updated.length === 0) return false;
      if (rest.length > 0) {
        await tx.insert(toolProfileEntries).values(rest.map((catalogEntryId) => ({
          companyId: entry.companyId,
          profileId: entry.profileId,
          selectorType: "catalog_entry" as const,
          effect: entry.effect,
          catalogEntryId,
          conditions: entry.conditions,
          createdAt: now,
          updatedAt: now,
        })));
      }
      return true;
    });
    if (migrated) migratedEntries += 1;
  }

  return { scannedEntries: entries.length, migratedEntries, unresolvedEntries };
}
