import { z } from "zod";

export const rt2DomainEventActorTypeSchema = z.enum(["user", "agent", "system", "runtime"]);

export const rt2DomainEventTypeSchema = z.enum([
  "rt2.task.created",
  "rt2.task.capacity_changed",
  "rt2.participant.joined",
  "rt2.participant.assigned",
  "rt2.participant.ended",
  "rt2.todo.created",
  "rt2.todo.started",
  "rt2.deliverable.defined",
  "rt2.execution.enqueued",
  "rt2.execution.dispatched",
  "rt2.execution.claimed",
  "rt2.execution.started",
  "rt2.execution.completed",
  "rt2.execution.failed",
  "rt2.execution.cancelled",
  "rt2.execution.stale_cleaned",
  "rt2.execution.retried",
]);

export const rt2DomainEventEntityTypeSchema = z.enum([
  "task",
  "todo",
  "participant",
  "deliverable",
  "execution",
]);

export const rt2DomainEventPayloadSchema = z.record(z.string(), z.unknown());

export const appendRt2DomainEventSchema = z.object({
  companyId: z.string().uuid(),
  eventType: rt2DomainEventTypeSchema,
  eventVersion: z.number().int().min(1).default(1),
  actorType: rt2DomainEventActorTypeSchema,
  actorId: z.string().trim().min(1),
  entityType: rt2DomainEventEntityTypeSchema,
  entityId: z.string().trim().min(1),
  commandId: z.string().trim().min(1).nullable().optional(),
  correlationId: z.string().trim().min(1).nullable().optional(),
  causationId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().trim().min(1).nullable().optional(),
  payload: rt2DomainEventPayloadSchema.default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type AppendRt2DomainEvent = z.input<typeof appendRt2DomainEventSchema>;

export const processRt2ProjectorEventSchema = z.object({
  projectorName: z.string().trim().min(1),
  eventId: z.string().uuid(),
});

export type ProcessRt2ProjectorEvent = z.infer<typeof processRt2ProjectorEventSchema>;
