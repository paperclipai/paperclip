import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
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

/**
 * In-process cache of run IDs already ensured in heartbeat_runs.
 * Avoids a redundant DB round-trip on every logActivity call within the same
 * server process once a run has been confirmed or stub-inserted.
 */
const _ensuredRunIds = new Set<string>();

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
  // Ensure the run exists in heartbeat_runs before writing it as a FK.
  // Gateway agents (openclaw, http adapters) send X-Paperclip-Run-Id values
  // that may arrive before the heartbeat system has registered the run.
  // Upserting a stub row means the FK on activity_log.run_id never fails.
  //
  // When agentId is absent we cannot satisfy the NOT NULL constraint on
  // heartbeat_runs.agent_id, so we drop runId from the insert instead.
  // The heartbeat system owns these rows; our stub is overwritten once the
  // real run record arrives, making status:"running" safe as a placeholder.
  const effectiveRunId = (input.runId && input.agentId) ? input.runId : null;
  if (effectiveRunId && !_ensuredRunIds.has(effectiveRunId)) {
    await db
      .insert(heartbeatRuns)
      .values({
        id: effectiveRunId,
        companyId: input.companyId,
        agentId: input.agentId as string,
        invocationSource: "on_demand",
        status: "running",
      })
      .onConflictDoNothing();
    _ensuredRunIds.add(effectiveRunId);
  }

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
    runId: effectiveRunId,
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
      runId: effectiveRunId,
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
        runId: effectiveRunId,
      },
    };
    void _pluginEventBus.emit(event).then(({ errors }) => {
      for (const { pluginId, error } of errors) {
        logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
      }
    }).catch(() => {});
  }
}
