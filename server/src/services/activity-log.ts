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
import { dispatchNotification } from "./notification-dispatcher.js";

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
        runId: input.runId ?? null,
      },
    };
    void _pluginEventBus.emit(event).then(({ errors }) => {
      for (const { pluginId, error } of errors) {
        logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
      }
    }).catch(() => {});
  }

  // Notify human when agent needs help
  void dispatchHumanEscalation(input).catch(() => {});
}

const HELP_KEYWORDS = /\b(need(?:s)? help|blocked|stuck|cannot proceed|human (?:input|needed|required)|escalat)/i;

async function dispatchHumanEscalation(input: LogActivityInput): Promise<void> {
  const details = input.details as Record<string, unknown> | null;
  if (!details) return;

  const identifier = (details.identifier as string) ?? null;
  const issueTitle = (details.title as string) ?? (details.issueTitle as string) ?? null;

  // Trigger 1: Issue status changed to "blocked" by an agent
  if (
    input.action === "issue.updated" &&
    input.actorType === "agent" &&
    details.status === "blocked"
  ) {
    await dispatchNotification({
      title: "Agent blocked — needs human input",
      body: `An agent marked ${identifier ?? input.entityId.slice(0, 8)} as blocked.`,
      issueIdentifier: identifier,
      issueTitle,
    });
    return;
  }

  // Trigger 2: Agent comment contains help-seeking keywords
  if (
    input.action === "issue.comment_added" &&
    input.actorType === "agent" &&
    typeof details.bodySnippet === "string" &&
    HELP_KEYWORDS.test(details.bodySnippet)
  ) {
    await dispatchNotification({
      title: "Agent requesting help",
      body: `${(details.bodySnippet as string).slice(0, 200)}`,
      issueIdentifier: identifier,
      issueTitle,
    });
    return;
  }
}
