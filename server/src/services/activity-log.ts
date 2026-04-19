import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { PLUGIN_EVENT_TYPES, WEBHOOK_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { dispatchWebhookEvent, type WebhookEvent } from "./webhooks.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

let _pluginEventBus: PluginEventBus | null = null;
let _webhookDb: Db | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

/** Wire the webhook dispatcher so domain events are forwarded to outbound webhooks. */
export function setWebhookDb(db: Db): void {
  _webhookDb = db;
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

  // Validate runId exists in heartbeat_runs to avoid FK constraint violations
  // (e.g. chat processes use a chatId that is not a heartbeat run)
  let resolvedRunId: string | null = input.runId ?? null;
  if (resolvedRunId) {
    const runExists = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, resolvedRunId))
      .then((rows) => rows.length > 0);
    if (!runExists) {
      resolvedRunId = null;
    }
  }

  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: resolvedRunId,
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
      runId: resolvedRunId,
      details: redactedDetails,
    },
  });

  if (_pluginEventBus && PLUGIN_EVENT_SET.has(input.action)) {
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
        runId: resolvedRunId,
      },
    };
    void _pluginEventBus
      .emit(event)
      .then(({ errors }) => {
        for (const { pluginId, error } of errors) {
          logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
        }
      })
      .catch(() => {});
  }

  // Dispatch to outbound webhooks
  if (_webhookDb && WEBHOOK_EVENT_SET.has(input.action)) {
    const webhookEvent: WebhookEvent = {
      eventId: randomUUID(),
      eventType: input.action,
      companyId: input.companyId,
      entityType: input.entityType,
      entityId: input.entityId,
      actorType: input.actorType,
      actorId: input.actorId,
      occurredAt: new Date().toISOString(),
      payload: {
        ...redactedDetails,
        agentId: input.agentId ?? null,
        runId: resolvedRunId,
      },
    };
    void dispatchWebhookEvent(_webhookDb, webhookEvent).catch((err) => {
      logger.warn({ err, eventType: webhookEvent.eventType }, "webhook dispatch failed");
    });
  }
}
