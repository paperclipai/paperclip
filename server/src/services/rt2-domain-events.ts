import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  rt2V33DomainEvents,
  rt2V33ProjectorEvents,
  rt2V33ProjectorState,
} from "@paperclipai/db";
import type { AppendRt2DomainEvent, Rt2DomainEvent } from "@paperclipai/shared";
import { appendRt2DomainEventSchema } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";

type DomainEventRow = typeof rt2V33DomainEvents.$inferSelect;

function toDomainEvent(row: DomainEventRow): Rt2DomainEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    eventType: row.eventType as Rt2DomainEvent["eventType"],
    eventVersion: row.eventVersion,
    actorType: row.actorType as Rt2DomainEvent["actorType"],
    actorId: row.actorId,
    entityType: row.entityType as Rt2DomainEvent["entityType"],
    entityId: row.entityId,
    commandId: row.commandId ?? null,
    correlationId: row.correlationId ?? null,
    causationId: row.causationId ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    payload: row.payload ?? {},
    metadata: row.metadata ?? {},
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function liveEventFor(event: Rt2DomainEvent) {
  const payload = event.payload;
  if (event.eventType.startsWith("rt2.execution.")) {
    return {
      type: "rt2.task.updated" as const,
      payload: {
        ...payload,
        mutation: event.eventType.replace("rt2.", "").replace(".", "_"),
        domainEventId: event.id,
      },
    };
  }
  if (event.eventType.startsWith("rt2.participant.")) {
    return {
      type: "rt2.participant.updated" as const,
      payload: {
        ...payload,
        mutation: event.eventType.replace("rt2.participant.", ""),
        domainEventId: event.id,
      },
    };
  }
  if (event.eventType.startsWith("rt2.todo.")) {
    return {
      type: "rt2.todo.updated" as const,
      payload: {
        ...payload,
        mutation: event.eventType.replace("rt2.todo.", ""),
        domainEventId: event.id,
      },
    };
  }
  if (event.eventType.startsWith("rt2.deliverable.")) {
    return {
      type: "rt2.deliverable.updated" as const,
      payload: {
        ...payload,
        mutation: event.eventType.replace("rt2.deliverable.", ""),
        domainEventId: event.id,
      },
    };
  }
  return {
    type: "rt2.task.updated" as const,
    payload: {
      ...payload,
      mutation: event.eventType.replace("rt2.task.", ""),
      domainEventId: event.id,
    },
  };
}

export function rt2DomainEventService(db: Db) {
  async function append(input: AppendRt2DomainEvent) {
    const parsed = appendRt2DomainEventSchema.parse(input);

    if (parsed.idempotencyKey) {
      const existing = await db
        .select()
        .from(rt2V33DomainEvents)
        .where(
          and(
            eq(rt2V33DomainEvents.companyId, parsed.companyId),
            eq(rt2V33DomainEvents.idempotencyKey, parsed.idempotencyKey),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return toDomainEvent(existing);
      }
    }

    const [created] = await db
      .insert(rt2V33DomainEvents)
      .values({
        companyId: parsed.companyId,
        eventType: parsed.eventType,
        eventVersion: parsed.eventVersion,
        actorType: parsed.actorType,
        actorId: parsed.actorId,
        entityType: parsed.entityType,
        entityId: parsed.entityId,
        commandId: parsed.commandId ?? null,
        correlationId: parsed.correlationId ?? null,
        causationId: parsed.causationId ?? null,
        idempotencyKey: parsed.idempotencyKey ?? null,
        payload: parsed.payload,
        metadata: parsed.metadata,
      })
      .returning();

    return toDomainEvent(created);
  }

  async function getEvent(eventId: string) {
    const row = await db
      .select()
      .from(rt2V33DomainEvents)
      .where(eq(rt2V33DomainEvents.id, eventId))
      .then((rows) => rows[0] ?? null);
    return row ? toDomainEvent(row) : null;
  }

  async function processEvent(
    projectorName: string,
    eventId: string,
    handler: (event: Rt2DomainEvent) => Promise<void>,
  ) {
    const existing = await db
      .select()
      .from(rt2V33ProjectorEvents)
      .where(
        and(
          eq(rt2V33ProjectorEvents.projectorName, projectorName),
          eq(rt2V33ProjectorEvents.eventId, eventId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing?.status === "processed") {
      return { status: "skipped" as const };
    }

    const event = await getEvent(eventId);
    if (!event) {
      throw new Error("RT2 domain event not found");
    }

    try {
      await db
        .insert(rt2V33ProjectorState)
        .values({
          projectorName,
          status: "running",
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: rt2V33ProjectorState.projectorName,
          set: { status: "running", updatedAt: new Date() },
        });

      await handler(event);

      await db
        .insert(rt2V33ProjectorEvents)
        .values({
          projectorName,
          eventId,
          status: "processed",
        })
        .onConflictDoUpdate({
          target: [rt2V33ProjectorEvents.projectorName, rt2V33ProjectorEvents.eventId],
          set: { status: "processed", error: null, processedAt: new Date() },
        });

      await db
        .insert(rt2V33ProjectorState)
        .values({
          projectorName,
          status: "idle",
          lastEventId: eventId,
          lastProcessedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: rt2V33ProjectorState.projectorName,
          set: {
            status: "idle",
            lastEventId: eventId,
            lastProcessedAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          },
        });

      return { status: "processed" as const };
    } catch (error) {
      const message = errorText(error);
      await db
        .insert(rt2V33ProjectorEvents)
        .values({
          projectorName,
          eventId,
          status: "failed",
          error: message,
        })
        .onConflictDoUpdate({
          target: [rt2V33ProjectorEvents.projectorName, rt2V33ProjectorEvents.eventId],
          set: { status: "failed", error: message, processedAt: new Date() },
        });
      await db
        .insert(rt2V33ProjectorState)
        .values({
          projectorName,
          status: "failed",
          lastEventId: eventId,
          lastError: message,
          failureCount: 1,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: rt2V33ProjectorState.projectorName,
          set: {
            status: "failed",
            lastEventId: eventId,
            lastError: message,
            failureCount: 1,
            updatedAt: new Date(),
          },
        });
      throw error;
    }
  }

  async function projectActivityAndLive(event: Rt2DomainEvent) {
    const liveEvent = liveEventFor(event);
    const actorType = event.actorType === "runtime" ? "system" : event.actorType;
    await logActivity(db, {
      companyId: event.companyId,
      actorType,
      actorId: event.actorId,
      action: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      details: {
        ...event.payload,
        domainEventId: event.id,
        commandId: event.commandId,
        correlationId: event.correlationId,
      },
    });
    publishLiveEvent({
      companyId: event.companyId,
      type: liveEvent.type,
      payload: liveEvent.payload,
    });
  }

  async function appendAndProject(input: AppendRt2DomainEvent) {
    const event = await append(input);
    await processEvent("rt2.activity_live_bridge", event.id, projectActivityAndLive);
    const { rt2KnowledgeProjectorService } = await import("./rt2-knowledge-projector.js");
    await rt2KnowledgeProjectorService(db).projectEvent(event.id);
    return event;
  }

  return {
    append,
    appendAndProject,
    getEvent,
    processEvent,
    projectActivityAndLive,
    toDomainEvent,
  };
}
