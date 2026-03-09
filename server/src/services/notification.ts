import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { notificationChannels } from "@paperclipai/db";
import type { LiveEvent, NotificationEvent, NotificationChannelType } from "@paperclipai/shared";
import { getBackend } from "../notifications/registry.js";
import { logger } from "../middleware/logger.js";
import { conflict, notFound, unprocessable } from "../errors.js";

const MAX_CHANNELS_PER_COMPANY = 20;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === "23505";
}

/* ── Config redaction ─────────────────────────────────────────────── */

const SENSITIVE_FIELDS: Record<string, string[]> = {
  webhook: ["url", "secret"],
  discord: ["webhookUrl"],
  ntfy: ["topic"],
};

function redactValue(value: unknown): string {
  const s = String(value ?? "");
  if (s.length <= 4) return "****";
  return "****" + s.slice(-4);
}

function isRedacted(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("****");
}

function redactConfig(
  channelType: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const fields = SENSITIVE_FIELDS[channelType] ?? [];
  const redacted = { ...config };
  for (const field of fields) {
    if (field in redacted) {
      redacted[field] = redactValue(redacted[field]);
    }
  }
  return redacted;
}

/** Merge incoming config with stored config, preserving stored values for redacted fields. */
function mergeConfigUpdate(
  channelType: string,
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const fields = SENSITIVE_FIELDS[channelType] ?? [];
  const merged = { ...incoming };
  for (const field of fields) {
    if (field in merged && isRedacted(merged[field])) {
      // Client sent back the redacted value — keep the stored original
      if (field in stored) {
        merged[field] = stored[field];
      }
    }
  }
  return merged;
}

/* ── Event mapping: LiveEvent → NotificationEvent ─────────────────── */

interface MappedEvent {
  type: string;
  actor: { type: "agent" | "user" | "system"; id: string };
  entity: { type: string; id: string };
}

const ACTIVITY_ACTION_MAP: Record<string, string> = {
  "approval.created": "approval.created",
  "approval.approved": "approval.decided",
  "approval.rejected": "approval.decided",
  "approval.revision_requested": "approval.decided",
  "issue.created": "issue.created",
  "issue.updated": "issue.updated",
  "issue.comment_added": "issue.comment.created",
  "cost.reported": "cost_event.created",
};

function mapLiveEvent(event: LiveEvent): MappedEvent | null {
  const p = event.payload;

  if (event.type === "heartbeat.run.status") {
    const status = p.status as string | undefined;
    const agentId = (p.agentId as string) || "unknown";
    const runId = (p.runId as string) || "unknown";
    const actor = { type: "agent" as const, id: agentId };
    const entity = { type: "run", id: runId };

    if (status === "succeeded") return { type: "agent.run.finished", actor, entity };
    if (status === "failed" || status === "timed_out") return { type: "agent.run.failed", actor, entity };
    if (status === "cancelled") return { type: "agent.run.cancelled", actor, entity };
    return null;
  }

  if (event.type === "agent.status") {
    const agentId = (p.agentId as string) || "unknown";
    return {
      type: "agent.status_changed",
      actor: { type: "system", id: "heartbeat" },
      entity: { type: "agent", id: agentId },
    };
  }

  if (event.type === "activity.logged") {
    const action = p.action as string | undefined;
    if (!action) return null;
    const notifType = ACTIVITY_ACTION_MAP[action];
    if (!notifType) return null;

    const actorType = (p.actorType as "agent" | "user" | "system") || "system";
    const actorId = (p.actorId as string) || "unknown";
    const entityType = (p.entityType as string) || "unknown";
    const entityId = (p.entityId as string) || "unknown";

    return {
      type: notifType,
      actor: { type: actorType, id: actorId },
      entity: { type: entityType, id: entityId },
    };
  }

  return null;
}

/* ── Service factory ──────────────────────────────────────────────── */

export function notificationService(db: Db) {
  function toApiShape(row: typeof notificationChannels.$inferSelect) {
    return {
      id: row.id,
      companyId: row.companyId,
      channelType: row.channelType,
      name: row.name,
      config: redactConfig(row.channelType, row.config),
      eventFilter: row.eventFilter,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  return {
    list: async (companyId: string) => {
      const rows = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.companyId, companyId));
      return rows.map(toApiShape);
    },

    get: async (id: string) => {
      const row = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Notification channel not found");
      return toApiShape(row);
    },

    getRaw: async (id: string) => {
      const row = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Notification channel not found");
      return row;
    },

    create: async (
      companyId: string,
      input: {
        channelType: NotificationChannelType;
        name: string;
        config: Record<string, unknown>;
        eventFilter?: string[];
        enabled?: boolean;
      },
    ) => {
      const backend = getBackend(input.channelType);
      if (!backend) throw unprocessable(`Unknown channel type: ${input.channelType}`);

      // Enforce per-company limit
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notificationChannels)
        .where(eq(notificationChannels.companyId, companyId));
      if (countResult.count >= MAX_CHANNELS_PER_COMPANY) {
        throw unprocessable(`Maximum of ${MAX_CHANNELS_PER_COMPANY} notification channels per company`);
      }

      // Check name uniqueness (DB has constraint, but give a better error)
      const [existing] = await db
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(
          and(
            eq(notificationChannels.companyId, companyId),
            eq(notificationChannels.name, input.name),
          ),
        );
      if (existing) throw conflict(`A notification channel named "${input.name}" already exists`);

      try {
        const row = await db
          .insert(notificationChannels)
          .values({
            companyId,
            channelType: input.channelType,
            name: input.name,
            config: input.config,
            eventFilter: input.eventFilter ?? [],
            enabled: input.enabled ?? true,
          })
          .returning()
          .then((rows) => rows[0]);

        return toApiShape(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`A notification channel named "${input.name}" already exists`);
        throw err;
      }
    },

    update: async (
      id: string,
      patch: {
        name?: string;
        config?: Record<string, unknown>;
        eventFilter?: string[];
        enabled?: boolean;
      },
    ) => {
      const existing = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Notification channel not found");

      // Check name uniqueness if name is being changed
      if (patch.name && patch.name !== existing.name) {
        const [dup] = await db
          .select({ id: notificationChannels.id })
          .from(notificationChannels)
          .where(
            and(
              eq(notificationChannels.companyId, existing.companyId),
              eq(notificationChannels.name, patch.name),
            ),
          );
        if (dup) throw conflict(`A notification channel named "${patch.name}" already exists`);
      }

      const resolvedConfig = patch.config !== undefined
        ? mergeConfigUpdate(existing.channelType, patch.config, existing.config)
        : undefined;

      try {
        const row = await db
          .update(notificationChannels)
          .set({
            ...(patch.name !== undefined && { name: patch.name }),
            ...(resolvedConfig !== undefined && { config: resolvedConfig }),
            ...(patch.eventFilter !== undefined && { eventFilter: patch.eventFilter }),
            ...(patch.enabled !== undefined && { enabled: patch.enabled }),
            updatedAt: new Date(),
          })
          .where(eq(notificationChannels.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Notification channel not found");

        return toApiShape(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`A notification channel named "${patch.name}" already exists`);
        throw err;
      }
    },

    remove: async (id: string) => {
      const existing = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Notification channel not found");
      await db.delete(notificationChannels).where(eq(notificationChannels.id, id));
      return toApiShape(existing);
    },

    testChannel: async (channelType: string, config: Record<string, unknown>) => {
      const backend = getBackend(channelType);
      if (!backend) throw unprocessable(`Unknown channel type: ${channelType}`);
      return backend.testConnection(config);
    },

    dispatchNotification: async (event: LiveEvent) => {
      const mapped = mapLiveEvent(event);
      if (!mapped) return;

      const notifEvent: NotificationEvent = {
        id: randomUUID(),
        type: mapped.type,
        companyId: event.companyId,
        occurredAt: event.createdAt,
        actor: mapped.actor,
        entity: mapped.entity,
        payload: event.payload,
      };

      // Query enabled channels for this company
      const channels = await db
        .select()
        .from(notificationChannels)
        .where(
          and(
            eq(notificationChannels.companyId, event.companyId),
            eq(notificationChannels.enabled, true),
          ),
        );

      if (channels.length === 0) return;

      // Filter by eventFilter: empty = all events
      const matching = channels.filter((ch) => {
        if (ch.eventFilter.length === 0) return true;
        return ch.eventFilter.includes(mapped.type);
      });

      if (matching.length === 0) return;

      // Fire-and-forget: dispatch in parallel, log errors
      await Promise.allSettled(
        matching.map(async (ch) => {
          const backend = getBackend(ch.channelType);
          if (!backend) {
            logger.warn({ channelId: ch.id, channelType: ch.channelType }, "unknown notification backend");
            return;
          }
          try {
            await backend.send(notifEvent, ch.config);
          } catch (err) {
            logger.error(
              {
                err,
                channelId: ch.id,
                channelType: ch.channelType,
                companyId: event.companyId,
                eventType: mapped.type,
              },
              "notification send failed",
            );
          }
        }),
      );
    },
  };
}
