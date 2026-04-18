import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  const inserted = await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    details: redactedDetails,
  }).returning({ id: activityLog.id, createdAt: activityLog.createdAt });
  const activityRow = inserted[0];
  const activityId = activityRow?.id ?? randomUUID();
  const occurredAt = activityRow?.createdAt?.toISOString() ?? new Date().toISOString();

  publishLiveEvent({
    companyId: input.companyId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      details: redactedDetails,
    },
  });

  if (_pluginEventBus) {
    // 1) If the originating action is itself a PluginEventType, fan it out as
    //    that specific event (legacy behavior — e.g. future paths might emit
    //    `issue.created` via logActivity).
    if (PLUGIN_EVENT_SET.has(input.action) && input.action !== "activity.logged") {
      const event: PluginEvent = {
        eventId: randomUUID(),
        eventType: input.action as PluginEventType,
        occurredAt,
        actorId: input.actorId,
        actorType: input.actorType,
        entityId: input.entityId,
        entityType: input.entityType,
        companyId: input.companyId,
        payload: {
          ...redactedDetails,
          agentId: input.agentId ?? null,
          runId: input.runId ?? null,
        },
      };
      void _pluginEventBus.emit(event).then(({ errors }) => {
        for (const { pluginId, error } of errors) {
          logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
        }
      }).catch(() => {});
    }

    // 2) Always emit `activity.logged` for every activity_log row. This is the
    //    canonical unified audit-trail event plugins subscribe to per
    //    PLUGIN_SPEC §16 — the `entityId` on the envelope is the activity_log
    //    row id (so plugins can correlate), and the original action/entity are
    //    preserved in the payload.
    const loggedEvent: PluginEvent = {
      eventId: randomUUID(),
      eventType: "activity.logged",
      occurredAt,
      actorId: input.actorId,
      actorType: input.actorType,
      entityId: activityId,
      entityType: "activity_log",
      companyId: input.companyId,
      payload: {
        activityId,
        action: input.action,
        originalEntityType: input.entityType,
        originalEntityId: input.entityId,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        details: redactedDetails,
      },
    };
    void _pluginEventBus.emit(loggedEvent).then(({ errors }) => {
      for (const { pluginId, error } of errors) {
        logger.warn({ pluginId, eventType: loggedEvent.eventType, err: error }, "plugin event handler failed");
      }
    }).catch(() => {});
  }
}
