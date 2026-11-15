import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { projectInstanceSecretService, type ProjectSecretSnapshot } from "./project-instance-secrets.js";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import { pluginCompanySettings, pluginLifecycleAcknowledgments, pluginLifecycleResourceCursors, plugins, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import type { ResourceLifecycleEvent } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";

type ResourceType = ResourceLifecycleEvent["resourceType"];

/**
 * Durable delivery inbox. Provider work stays outside tenant transactions.
 *
 * Progress for each resource stream has two parts. The resource cursor says that every event of
 * the stream at or below `acknowledged_through_id` is acknowledged. Rows in
 * `plugin_lifecycle_acknowledgments` record each acknowledgment, including those above the
 * cursor, such as one written by an earlier release. An event is acknowledged when either part
 * says so. Writers record a resource's events while they hold that resource's row lock, so an
 * event that commits later for the same resource always has a higher id than the cursor.
 */
export function pluginLifecycleInbox(db: Db, pluginId: string) {
  const acknowledged = (event: SQL) => sql`EXISTS (
    SELECT 1 FROM plugin_lifecycle_acknowledgments ack WHERE ack.plugin_id = ${pluginId} AND ack.event_id = ${event})`;
  const unacknowledgedCreation = (companyId: string, type: SQL, resource: SQL, through: SQL) => sql`
    SELECT e.id FROM resource_lifecycle_events e
    WHERE e.company_id = ${companyId} AND e.resource_type = ${type} AND e.resource_id = ${resource}
      AND e.action = 'create' AND e.id > ${through} AND NOT ${acknowledged(sql`e.id`)}`;

  /**
   * Ids of each resource's deliverable head: its unacknowledged creation, else its oldest
   * unacknowledged transition. A backward loose index scan visits each resource stream once and
   * reads its latest event id. A stream whose latest event is at or below its cursor is settled,
   * so only streams with newer events are probed. Cost follows the number of resource streams
   * and pending events, not the length of acknowledged history.
   */
  function heads(companyId: string, types: ResourceType[]) {
    // A manifest may repeat a type. Duplicate streams would repeat heads and shorten the page.
    const typeArray = sql`ARRAY[${sql.join([...new Set(types)].map(type => sql`${type}`), sql`, `)}]::text[]`;
    const through = sql`COALESCE(stream_cursor.acknowledged_through_id, 0)`;
    return sql`
      WITH RECURSIVE streams(resource_type, resource_id, last_id) AS (
        SELECT t.resource_type, first_stream.resource_id, first_stream.id FROM unnest(${typeArray}) AS t(resource_type)
        CROSS JOIN LATERAL (
          SELECT e.resource_id, e.id FROM resource_lifecycle_events e
          WHERE e.company_id = ${companyId} AND e.resource_type = t.resource_type
          ORDER BY e.resource_id DESC, e.id DESC LIMIT 1) first_stream
        UNION ALL
        SELECT s.resource_type, next_stream.resource_id, next_stream.id FROM streams s
        CROSS JOIN LATERAL (
          SELECT e.resource_id, e.id FROM resource_lifecycle_events e
          WHERE e.company_id = ${companyId} AND e.resource_type = s.resource_type AND e.resource_id < s.resource_id
          ORDER BY e.resource_id DESC, e.id DESC LIMIT 1) next_stream
      )
      SELECT head.id FROM streams s
      LEFT JOIN plugin_lifecycle_resource_cursors stream_cursor ON stream_cursor.plugin_id = ${pluginId}
        AND stream_cursor.company_id = ${companyId} AND stream_cursor.resource_type = s.resource_type
        AND stream_cursor.resource_id = s.resource_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          (${unacknowledgedCreation(companyId, sql`s.resource_type`, sql`s.resource_id`, through)}),
          (SELECT e.id FROM resource_lifecycle_events e
            WHERE e.company_id = ${companyId} AND e.resource_type = s.resource_type AND e.resource_id = s.resource_id
              AND e.id > ${through} AND e.action <> 'create' AND NOT ${acknowledged(sql`e.id`)}
            ORDER BY e.id LIMIT 1)) AS id
        -- Keep the head probes evaluated once per stream.
        OFFSET 0
      ) head
      WHERE s.last_id > ${through} AND head.id IS NOT NULL`;
  }

  async function assertAvailable(database: Db, companyId: string) {
    if (!z.string().uuid().safeParse(companyId).success) throw badRequest("companyId must be a UUID");
    const [plugin] = await database.select({ status: plugins.status }).from(plugins).where(eq(plugins.id, pluginId));
    const [settings] = await database.select({ enabled: pluginCompanySettings.enabled }).from(pluginCompanySettings)
      .where(and(eq(pluginCompanySettings.pluginId, pluginId), eq(pluginCompanySettings.companyId, companyId)));
    if (plugin?.status !== "ready" || settings?.enabled === false) throw forbidden("Plugin is not enabled for this company");
  }

  return {
    async list(companyId: string, limit = 50, afterId?: string, resourceTypes?: ResourceType[]): Promise<ResourceLifecycleEvent[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest("limit must be an integer from 1 to 100");
      if (afterId !== undefined && (typeof afterId !== "string" || !/^[1-9]\d*$/.test(afterId) || !Number.isSafeInteger(Number(afterId)))) throw badRequest("Invalid lifecycle page id");
      await assertAvailable(db, companyId);
      const page = sql`SELECT page.id FROM (${heads(companyId, resourceTypes ?? ["agent", "project"])}) page
        ${afterId === undefined ? sql`` : sql`WHERE page.id > ${Number(afterId)}`}
        ORDER BY page.id LIMIT ${limit}`;
      const rows = await db.select().from(resourceLifecycleEvents)
        .where(and(eq(resourceLifecycleEvents.companyId, companyId), sql`${resourceLifecycleEvents.id} IN (${page})`))
        .orderBy(asc(resourceLifecycleEvents.id));
      return rows.map(row => ({ ...row, id: String(row.id), createdAt: row.createdAt.toISOString() })) as ResourceLifecycleEvent[];
    },
    /** Whether `list` would return any event. */
    async hasPending(companyId: string, resourceTypes?: ResourceType[]): Promise<boolean> {
      await assertAvailable(db, companyId);
      const [row] = await db.execute<{ pending: boolean }>(sql`SELECT EXISTS (${heads(companyId, resourceTypes ?? ["agent", "project"])}) AS pending`);
      return row?.pending === true;
    },
    async acknowledge(companyId: string, eventId: string, credentials?: { snapshot: ProjectSecretSnapshot; changes: unknown }): Promise<void> {
      if (typeof eventId !== "string" || !/^[1-9]\d*$/.test(eventId) || !Number.isSafeInteger(Number(eventId))) throw badRequest("Invalid lifecycle event id");
      const commit = () => db.transaction(async tx => {
        const publications: ActivityPublication[] = [];
        const txDb = tx as unknown as Db;
        await assertAvailable(txDb, companyId);
        const [event] = await tx.select().from(resourceLifecycleEvents)
          .where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.id, Number(eventId)))).for("update");
        if (!event) throw notFound("Lifecycle event not found");
        const [cursor] = await tx.select({ through: pluginLifecycleResourceCursors.acknowledgedThroughId }).from(pluginLifecycleResourceCursors)
          .where(and(eq(pluginLifecycleResourceCursors.pluginId, pluginId), eq(pluginLifecycleResourceCursors.companyId, companyId),
            eq(pluginLifecycleResourceCursors.resourceType, event.resourceType), eq(pluginLifecycleResourceCursors.resourceId, event.resourceId)));
        const through = cursor?.through ?? 0;
        if (event.id <= through) return publications;
        const [acked] = await tx.select().from(pluginLifecycleAcknowledgments).where(and(eq(pluginLifecycleAcknowledgments.pluginId, pluginId), eq(pluginLifecycleAcknowledgments.eventId, event.id)));
        if (acked) return publications;
        // Events at or below the cursor are acknowledged, so each check reads only the range above it.
        const earlierTransition = sql`(SELECT e.id FROM resource_lifecycle_events e
          WHERE e.company_id = ${companyId} AND e.resource_type = ${event.resourceType} AND e.resource_id = ${event.resourceId}
            AND e.id > ${through} AND e.id < ${event.id} AND e.action <> 'create' AND NOT ${acknowledged(sql`e.id`)}
          ORDER BY e.id LIMIT 1)`;
        const creation = sql`(${unacknowledgedCreation(companyId, sql`${event.resourceType}`, sql`${event.resourceId}::uuid`, sql`${through}`)})`;
        // A creation is always deliverable. A transition waits for the creation and every earlier
        // transition. The earlier pending transition takes precedence, so for a creation the
        // blocker is the creation itself only when no earlier transition is pending.
        const [row] = await tx.execute<{ id: number | string | null }>(sql`SELECT COALESCE(${earlierTransition}, ${creation}) AS id`);
        const blocker = row?.id == null ? undefined : { id: row.id };
        if (event.action !== "create" && blocker) throw conflict("Acknowledge earlier lifecycle events for this resource first");
        if (credentials) {
          if (event.resourceType !== "project") throw forbidden("Project instance secret event required");
          publications.push(...await projectInstanceSecretService(txDb, pluginId).apply({ ...event, id: String(event.id), createdAt: event.createdAt.toISOString() } as ResourceLifecycleEvent, credentials.snapshot, credentials.changes));
        }
        // Keep the per-event row as well, so an earlier release reads the same progress after a rollback.
        await tx.insert(pluginLifecycleAcknowledgments).values({ pluginId, eventId: event.id }).onConflictDoNothing();
        // The cursor moves only over a contiguous acknowledged prefix. A creation recorded after
        // transitions that are still pending leaves the cursor in place.
        if (event.action !== "create" || Number(blocker?.id) === event.id) {
          await tx.insert(pluginLifecycleResourceCursors)
            .values({ pluginId, companyId, resourceType: event.resourceType, resourceId: event.resourceId, acknowledgedThroughId: event.id })
            .onConflictDoUpdate({
              target: [pluginLifecycleResourceCursors.pluginId, pluginLifecycleResourceCursors.companyId, pluginLifecycleResourceCursors.resourceType, pluginLifecycleResourceCursors.resourceId],
              set: { acknowledgedThroughId: sql`GREATEST(${pluginLifecycleResourceCursors.acknowledgedThroughId}, excluded.acknowledged_through_id)`, updatedAt: sql`now()` },
            });
        }
        return publications;
      });
      const publications = credentials ? await withAccountHomeSecretMutationLock(undefined, companyId, commit) : await commit();
      for (const publication of publications) publishActivity(publication);
    },
  };
}
