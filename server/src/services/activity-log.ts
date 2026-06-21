import { createHash, randomUUID } from "node:crypto";
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
const ACTIVITY_ACTION_TO_PLUGIN_EVENT: Readonly<Record<string, PluginEventType>> = {
  issue_comment_added: "issue.comment.created",
  issue_comment_created: "issue.comment.created",
  issue_document_created: "issue.document.created",
  issue_document_updated: "issue.document.updated",
  issue_document_deleted: "issue.document.deleted",
  issue_blockers_updated: "issue.relations.updated",
  approval_approved: "approval.decided",
  approval_rejected: "approval.decided",
  approval_revision_requested: "approval.decided",
  budget_soft_threshold_crossed: "budget.incident.opened",
  budget_hard_threshold_crossed: "budget.incident.opened",
  budget_incident_resolved: "budget.incident.resolved",
};

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

function eventTypeForActivityAction(action: string): PluginEventType | null {
  if (PLUGIN_EVENT_SET.has(action)) return action as PluginEventType;
  return ACTIVITY_ACTION_TO_PLUGIN_EVENT[action.replaceAll(".", "_")] ?? null;
}

export function publishPluginDomainEvent(event: PluginEvent): void {
  if (!_pluginEventBus) return;
  void _pluginEventBus.emit(event).then(({ errors }) => {
    for (const { pluginId, error } of errors) {
      logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
    }
  }).catch(() => {});
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

const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_DEDUPE_MAX_ENTRIES = 50_000;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const DEDUPE_WINDOW_MS = readPositiveInt(
  "PAPERCLIP_ACTIVITY_LOG_DEDUPE_WINDOW_MS",
  DEFAULT_DEDUPE_WINDOW_MS,
);
const DEDUPE_MAX_ENTRIES = readPositiveInt(
  "PAPERCLIP_ACTIVITY_LOG_DEDUPE_MAX_ENTRIES",
  DEFAULT_DEDUPE_MAX_ENTRIES,
);
const DEDUPE_DISABLED = process.env.PAPERCLIP_ACTIVITY_LOG_DEDUPE_DISABLED === "1";

interface DedupeEntry {
  expiresAt: number;
  suppressed: number;
  lastLoggedSuppressed: number;
}

const dedupeCache = new Map<string, DedupeEntry>();
let dedupeSweepCursor = 0;

function dedupeKey(
  input: LogActivityInput,
  redactedDetails: Record<string, unknown> | null,
): string {
  const detailsJson = redactedDetails ? JSON.stringify(redactedDetails) : "";
  const hash = createHash("sha1");
  hash.update(input.companyId);
  hash.update("|");
  hash.update(input.actorType);
  hash.update("|");
  hash.update(input.actorId);
  hash.update("|");
  hash.update(input.action);
  hash.update("|");
  hash.update(input.entityType);
  hash.update("|");
  hash.update(input.entityId);
  hash.update("|");
  hash.update(detailsJson);
  return hash.digest("hex");
}

function shouldSuppressDuplicate(
  input: LogActivityInput,
  redactedDetails: Record<string, unknown> | null,
  now: number,
): { suppress: boolean; suppressedCount: number } {
  if (DEDUPE_DISABLED || DEDUPE_WINDOW_MS === 0) {
    return { suppress: false, suppressedCount: 0 };
  }
  const key = dedupeKey(input, redactedDetails);
  const existing = dedupeCache.get(key);
  if (existing && existing.expiresAt > now) {
    existing.suppressed += 1;
    // Avoid noisy logs: surface a warning when a single (actor, action, payload)
    // tuple has been silenced an order of magnitude more times than the last
    // notice. Catches runaway writers without flooding the log itself.
    if (existing.suppressed >= existing.lastLoggedSuppressed * 10) {
      logger.warn(
        {
          actorType: input.actorType,
          actorId: input.actorId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          suppressed: existing.suppressed,
          windowMs: DEDUPE_WINDOW_MS,
        },
        "activity_log dedupe suppressed repeated write",
      );
      existing.lastLoggedSuppressed = existing.suppressed;
    }
    return { suppress: true, suppressedCount: existing.suppressed };
  }
  // Bound memory: evict expired entries first, then cap total size.
  if (dedupeCache.size >= DEDUPE_MAX_ENTRIES) {
    sweepExpired(now, /* aggressive */ true);
  }
  dedupeCache.set(key, {
    expiresAt: now + DEDUPE_WINDOW_MS,
    suppressed: 0,
    lastLoggedSuppressed: 1,
  });
  return { suppress: false, suppressedCount: 0 };
}

function sweepExpired(now: number, aggressive: boolean): void {
  // Incremental sweep: scan a slice of entries each call so we don't block on
  // huge caches. Aggressive mode (cache at cap) walks the whole map.
  const sliceSize = aggressive ? dedupeCache.size : 1024;
  const keys = Array.from(dedupeCache.keys());
  const start = dedupeSweepCursor % Math.max(keys.length, 1);
  for (let i = 0; i < Math.min(sliceSize, keys.length); i++) {
    const key = keys[(start + i) % keys.length];
    const entry = dedupeCache.get(key);
    if (entry && entry.expiresAt <= now) {
      dedupeCache.delete(key);
    }
  }
  dedupeSweepCursor = start + sliceSize;
  // If still over cap after expiry sweep, drop the oldest entries by iteration
  // order (Map preserves insertion order).
  if (aggressive && dedupeCache.size >= DEDUPE_MAX_ENTRIES) {
    const overflow = dedupeCache.size - Math.floor(DEDUPE_MAX_ENTRIES * 0.9);
    let dropped = 0;
    for (const key of dedupeCache.keys()) {
      if (dropped >= overflow) break;
      dedupeCache.delete(key);
      dropped += 1;
    }
  }
}

export function __resetActivityLogDedupeForTests(): void {
  dedupeCache.clear();
  dedupeSweepCursor = 0;
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;

  const { suppress } = shouldSuppressDuplicate(input, redactedDetails, Date.now());
  if (suppress) {
    return;
  }

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
