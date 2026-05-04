export type Rt2DomainEventActorType = "user" | "agent" | "system" | "runtime";

export type Rt2DomainEventType =
  | "rt2.task.created"
  | "rt2.task.capacity_changed"
  | "rt2.participant.joined"
  | "rt2.participant.assigned"
  | "rt2.participant.ended"
  | "rt2.todo.created"
  | "rt2.todo.started"
  | "rt2.deliverable.defined"
  | "rt2.execution.enqueued"
  | "rt2.execution.dispatched"
  | "rt2.execution.claimed"
  | "rt2.execution.started"
  | "rt2.execution.completed"
  | "rt2.execution.failed"
  | "rt2.execution.cancelled"
  | "rt2.execution.stale_cleaned"
  | "rt2.execution.retried"
  | "rt2.work.created"
  | "rt2.work.state_changed"
  | "rt2.work.archived";

export type Rt2DomainEventEntityType =
  | "task"
  | "todo"
  | "participant"
  | "deliverable"
  | "execution"
  | "work";

export interface Rt2DomainEventPayload {
  taskIssueId?: string;
  todoIssueId?: string | null;
  projectId?: string;
  goalId?: string | null;
  deliverableWorkProductId?: string | null;
  executionAttemptId?: string;
  mutation?: string;
  previousState?: string;
  newState?: string;
  [key: string]: unknown;
}

export interface Rt2DomainEvent {
  id: string;
  companyId: string;
  eventType: Rt2DomainEventType;
  eventVersion: number;
  actorType: Rt2DomainEventActorType;
  actorId: string;
  entityType: Rt2DomainEventEntityType;
  entityId: string;
  commandId: string | null;
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
  payload: Rt2DomainEventPayload;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
}
