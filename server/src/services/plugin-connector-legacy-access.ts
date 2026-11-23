/**
 * Keeps today's agent access to legacy plugin tools.
 *
 * Before plugin connectors, every agent could use the tools a plugin declared
 * with the top-level manifest `tools`. Those tools now belong to the plugin's
 * implicit connector, and an agent gets them only from a connection installed
 * for it or for the whole company. The migration that introduced connectors
 * recorded each plugin installed at that time, per company, in
 * `plugin_connector_legacy_access`. This job turns each pending row into one
 * connection of the implicit connector, installed for the whole company, so
 * those agents keep exactly the tools they had. Plugins installed later have
 * no row and follow the normal activation rules.
 *
 * A row stays pending while its plugin is not ready (for example disabled)
 * or its worker is down, and is completed the next time the worker starts.
 */
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { pluginConnectorLegacyAccess, toolConnections, type Db } from "@paperclipai/db";
import { pluginAppSlug } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { LEGACY_PLUGIN_TOOLS_APP_SLUG, loadPluginAppCatalog } from "./plugin-app-catalog.js";

/** A claim older than this belongs to a server that stopped mid-way. */
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * Turn pending rows into connections. Each row is claimed first, so servers
 * sharing the database never work on the same row; a failed row is released
 * and retried the next time the plugin's worker starts (boot, enable,
 * upgrade, reload or restart).
 */
export async function completeLegacyPluginToolAccess(db: Db, pluginKey?: string): Promise<number> {
  const pending = await db
    .select()
    .from(pluginConnectorLegacyAccess)
    .where(and(
      isNull(pluginConnectorLegacyAccess.completedAt),
      pluginKey ? eq(pluginConnectorLegacyAccess.pluginKey, pluginKey) : undefined,
    ));
  if (pending.length === 0) return 0;
  const catalog = await loadPluginAppCatalog(db);
  const { toolAccessService } = await import("./tool-access.js");
  const access = toolAccessService(db);
  let completed = 0;
  for (const row of pending) {
    const slug = pluginAppSlug(row.pluginKey, LEGACY_PLUGIN_TOOLS_APP_SLUG);
    if (!catalog.definitions.some((candidate) => candidate.slug === slug)) continue;
    const [claimed] = await db
      .update(pluginConnectorLegacyAccess)
      .set({ claimedAt: new Date() })
      .where(and(
        eq(pluginConnectorLegacyAccess.id, row.id),
        isNull(pluginConnectorLegacyAccess.completedAt),
        or(
          isNull(pluginConnectorLegacyAccess.claimedAt),
          lt(pluginConnectorLegacyAccess.claimedAt, new Date(Date.now() - STALE_CLAIM_MS)),
        ),
      ))
      .returning({ id: pluginConnectorLegacyAccess.id });
    if (!claimed) continue;
    try {
      // A retry after the connection was made but before completion was
      // recorded finishes that same connection instead of adding another.
      const [existing] = await db.select({ id: toolConnections.id, status: toolConnections.status }).from(toolConnections).where(and(
        eq(toolConnections.companyId, row.companyId),
        ne(toolConnections.status, "archived"),
        sql`${toolConnections.config}->>'sourceTemplateKey' = ${slug}`,
        sql`${toolConnections.config}->>'legacyPluginTools' = 'true'`,
      )).limit(1);
      const connectionId = existing?.id ?? (await access.connectGalleryApp(row.companyId, {
        galleryKey: slug,
        connectionMethodKey: LEGACY_PLUGIN_TOOLS_APP_SLUG,
      })).connectionId;
      // Finish a new connection, or a draft an interrupted attempt left. An
      // active connection is already configured (perhaps restricted by an
      // operator since); keep its saved permissions as they are.
      if (!existing || existing.status === "draft") {
        const entries = await access.listCatalog(connectionId);
        await access.finishGalleryAppConnection(row.companyId, connectionId, {
          enabledCatalogEntryIds: entries.filter((entry) => entry.status === "active").map((entry) => entry.id),
          askFirstCatalogEntryIds: [],
          access: "all_agents",
        });
      }
      await db
        .update(pluginConnectorLegacyAccess)
        .set({ connectionId, completedAt: new Date(), claimedAt: null })
        .where(eq(pluginConnectorLegacyAccess.id, row.id));
      completed += 1;
    } catch (error) {
      await db.update(pluginConnectorLegacyAccess).set({ claimedAt: null }).where(eq(pluginConnectorLegacyAccess.id, row.id))
        .catch(() => undefined);
      logger.warn({ err: error, pluginKey: row.pluginKey, companyId: row.companyId }, "Could not keep legacy plugin tool access");
    }
  }
  return completed;
}
