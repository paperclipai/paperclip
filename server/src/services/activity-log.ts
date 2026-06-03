import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog, pluginEventOutbox } from "@paperclipai/db";
import { PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const ACTIVITY_ACTION_TO_PLUGIN_EVENT: Readonly<Record<string, PluginEventType>> = {
  issue_comment_added: "issue.comment.created",
  issue_comment_created: "issue.comment.created",
  issue_document_created: "issue.document.created",
  issue_document_updated: "issue.document.updated",
  issue_document_deleted: "issue.document.deleted",
  issue_blockers_updated: "issue.relations.updated",
  issue_thread_interaction_created: "issue.thread_interaction.created",
  approval_approved: "approval.decided",
  approval_rejected: "approval.decided",
  approval_revision_requested: "approval.decided",
  budget_soft_threshold_crossed: "budget.incident.opened",
  budget_hard_threshold_crossed: "budget.incident.opened",
  budget_incident_resolved: "budget.incident.resolved",
};

let _pluginEventBus: PluginEventBus | null = null;
let _outboxDb: Db | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

/**
 * Wire the db used to enqueue plugin domain events into the cross-tier outbox.
 * Mirrors setPluginEventBus; both are set once at app boot on every tier.
 */
export function setPluginEventOutboxDb(db: Db): void {
  _outboxDb = db;
}

/** Accessor for the worker-tier outbox poller (the sole emitter). */
export function getPluginEventBus(): PluginEventBus | null {
  return _pluginEventBus;
}

function eventTypeForActivityAction(action: string): PluginEventType | null {
  if (PLUGIN_EVENT_SET.has(action)) return action as PluginEventType;
  return ACTIVITY_ACTION_TO_PLUGIN_EVENT[action.replaceAll(".", "_")] ?? null;
}

/**
 * Enqueue a plugin domain event into the cross-tier outbox. This does NOT emit
 * in-process: the worker-tier poller (plugin-event-outbox.ts) is the sole
 * emitter, so events raised on any tier (notably the API tier, where plugins
 * are not loaded) reliably reach subscribed plugins. One writer + one emitter
 * ⇒ no double-delivery. Fire-and-forget to keep the signature synchronous.
 */
export function publishPluginDomainEvent(event: PluginEvent): void {
  if (!_outboxDb) {
    logger.warn(
      { eventType: event.eventType, eventId: event.eventId },
      "plugin event outbox db not set; dropping event",
    );
    return;
  }
  void _outboxDb
    .insert(pluginEventOutbox)
    .values({
      eventId: event.eventId,
      companyId: event.companyId,
      eventType: event.eventType,
      payload: event as unknown as Record<string, unknown>,
    })
    .catch((err) =>
      logger.warn({ err, eventType: event.eventType }, "failed to enqueue plugin event to outbox"),
    );
}

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
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

  const pluginEventType = eventTypeForActivityAction(input.action);
  if (pluginEventType) {
    const event: PluginEvent = {
      eventId: randomUUID(),
      eventType: pluginEventType,
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
    publishPluginDomainEvent(event);
  }
}
