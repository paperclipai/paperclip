import { pluginCompanySettings, pluginLifecycleAcknowledgments, plugins, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import type { ResourceLifecycleEvent } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";

/** Durable pull delivery. Provider work stays outside tenant transactions. */
export function pluginLifecycleInbox(db: Db, pluginId: string) {
  const unacknowledged = sql`NOT EXISTS (
    SELECT 1 FROM plugin_lifecycle_acknowledgments ack
    WHERE ack.plugin_id = ${pluginId} AND ack.event_id = ${resourceLifecycleEvents.id}
  )`;
  const firstForResource = sql`NOT EXISTS (
    SELECT 1 FROM resource_lifecycle_events older
    WHERE older.company_id = ${resourceLifecycleEvents.companyId}
      AND older.resource_type = ${resourceLifecycleEvents.resourceType}
      AND older.resource_id = ${resourceLifecycleEvents.resourceId}
      AND older.id < ${resourceLifecycleEvents.id}
      AND NOT EXISTS (SELECT 1 FROM plugin_lifecycle_acknowledgments ack
        WHERE ack.plugin_id = ${pluginId} AND ack.event_id = older.id)
  )`;

  async function assertAvailable(database: Db, companyId: string) {
    if (!z.string().uuid().safeParse(companyId).success) throw badRequest("companyId must be a UUID");
    const [plugin] = await database.select({ status: plugins.status }).from(plugins).where(eq(plugins.id, pluginId));
    const [settings] = await database.select({ enabled: pluginCompanySettings.enabled }).from(pluginCompanySettings)
      .where(and(eq(pluginCompanySettings.pluginId, pluginId), eq(pluginCompanySettings.companyId, companyId)));
    if (plugin?.status !== "ready" || settings?.enabled === false) throw forbidden("Plugin is not enabled for this company");
  }

  return {
    async list(companyId: string, limit = 50, afterId?: string): Promise<ResourceLifecycleEvent[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest("limit must be an integer from 1 to 100");
      if (afterId !== undefined && (typeof afterId !== "string" || !/^[1-9]\d*$/.test(afterId) || !Number.isSafeInteger(Number(afterId)))) throw badRequest("Invalid lifecycle page id");
      await assertAvailable(db, companyId);
      const rows = await db.select().from(resourceLifecycleEvents)
        .where(and(eq(resourceLifecycleEvents.companyId, companyId), unacknowledged, firstForResource, afterId === undefined ? undefined : gt(resourceLifecycleEvents.id, Number(afterId))))
        .orderBy(asc(resourceLifecycleEvents.id)).limit(limit);
      return rows.map(row => ({ ...row, id: String(row.id), createdAt: row.createdAt.toISOString() })) as ResourceLifecycleEvent[];
    },
    async acknowledge(companyId: string, eventId: string): Promise<void> {
      if (typeof eventId !== "string" || !/^[1-9]\d*$/.test(eventId) || !Number.isSafeInteger(Number(eventId))) throw badRequest("Invalid lifecycle event id");
      await db.transaction(async tx => {
        const txDb = tx as unknown as Db;
        await assertAvailable(txDb, companyId);
        const [event] = await tx.select().from(resourceLifecycleEvents)
          .where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.id, Number(eventId)))).for("update");
        if (!event) throw notFound("Lifecycle event not found");
        const [eligible] = await tx.select({ id: resourceLifecycleEvents.id }).from(resourceLifecycleEvents)
          .where(and(eq(resourceLifecycleEvents.id, event.id), firstForResource));
        if (!eligible) throw conflict("Acknowledge earlier lifecycle events for this resource first");
        await tx.insert(pluginLifecycleAcknowledgments).values({ pluginId, eventId: event.id }).onConflictDoNothing();
      });
    },
  };
}
