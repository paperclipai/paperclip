import { randomUUID } from "node:crypto";
import { companies } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { PluginRecord } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";

export type PluginLifecycleEventType =
  | "plugin.installed"
  | "plugin.uninstalled"
  | "plugin.enabled"
  | "plugin.disabled";

export type LifecycleEventPublisher = (
  eventType: PluginLifecycleEventType,
  record: PluginRecord,
) => Promise<void>;

const log = logger.child({ service: "plugin-lifecycle-event-bridge" });

/**
 * Creates an async publisher function that fans out a lifecycle event to every
 * active company on the instance. Plugin installations are instance-scoped, so
 * one event per company is emitted so that any plugin worker can filter by
 * companyId if desired.
 *
 * Note: "plugin.*" wildcard subscriptions will receive these host lifecycle
 * events in addition to plugin-to-plugin events. This is an intentional
 * semantic extension documented in the PR body.
 */
export function createLifecycleEventPublisher(
  bus: PluginEventBus,
  db: Db,
): LifecycleEventPublisher {
  return async function publishLifecycleEvent(
    eventType: PluginLifecycleEventType,
    record: PluginRecord,
  ): Promise<void> {
    let companyRows: { id: string }[];
    try {
      companyRows = await db.select({ id: companies.id }).from(companies);
    } catch (err) {
      log.warn({ err, eventType, pluginId: record.id }, "lifecycle-bridge: failed to fetch companies; event not delivered");
      return;
    }

    if (companyRows.length === 0) return;

    const payload = {
      pluginId: record.id,
      pluginKey: record.pluginKey,
      manifest: record.manifestJson,
    };
    const occurredAt = new Date().toISOString();

    await Promise.all(
      companyRows.map(async (row) => {
        try {
          const result = await bus.emit({
            eventId: randomUUID(),
            eventType,
            companyId: row.id,
            occurredAt,
            actorType: "system",
            entityId: record.id,
            entityType: "plugin",
            payload,
          });
          for (const { pluginId, error } of result.errors) {
            log.warn({ pluginId, eventType, err: error }, "lifecycle-bridge: plugin event handler failed");
          }
        } catch (err) {
          log.warn({ err, eventType, companyId: row.id, pluginId: record.id }, "lifecycle-bridge: bus.emit threw for company; skipping");
        }
      }),
    );
  };
}
