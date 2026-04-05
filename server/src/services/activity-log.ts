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

/**
 * Suppress routine-execution events from reaching the plugin bus (e.g. Slack)
 * so that heartbeat runs don't spam notifications every few minutes.
 *
 * Suppressed:
 *  - issue.created  where originKind === "routine_execution"
 *  - issue.updated  where originKind === "routine_execution" AND new status is "done"
 *
 * NOT suppressed (operator needs visibility):
 *  - routine issues that end in cancelled / blocked / error
 *  - all non-routine events
 */
function shouldSuppressRoutinePluginEvent(input: LogActivityInput): boolean {
  const details = input.details as Record<string, unknown> | null | undefined;
  if (!details || details.originKind !== "routine_execution") return false;

  if (input.action === "issue.created") return true;

  if (input.action === "issue.updated") {
    const newStatus = details.status as string | undefined;
    if (newStatus === "done") return true;
  }

  return false;
}

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
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    details: redactedDetails,
  });

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

  if (_pluginEventBus && PLUGIN_EVENT_SET.has(input.action) && !shouldSuppressRoutinePluginEvent(input)) {
    const event: PluginEvent = {
      eventId: randomUUID(),
      eventType: input.action as PluginEventType,
      occurredAt: new Date().toISOString(),
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
}
