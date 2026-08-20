/**
 * Memory plane lifecycle event types.
 *
 * Published when a Paperclip Routine or Goal undergoes a state change.
 * The event is fanned out to all 4 memory planes (OB1, Hindsight, Honcho, Holographic)
 * via the MemoryPlaneObserver service in the server layer.
 */

export type MemoryPlaneEventEntityType = "routine" | "goal" | "routine_run";

export interface MemoryPlaneLifecycleEvent {
  /** Globally unique idempotency key — prevents duplicate writebacks. */
  id: string;
  /** Which entity changed. */
  entityType: MemoryPlaneEventEntityType;
  /** UUID of the changed entity. */
  entityId: string;
  /** Company that owns the entity. */
  companyId: string;
  /** Previous status (null on create). */
  oldStatus: string | null;
  /** New status after the change. */
  newStatus: string;
  /** ISO 8601 timestamp of the event. */
  timestamp: string;
  /** Agent that triggered the change (null for board/user actions). */
  agentId: string | null;
  /** Actor type: "agent" | "user" | "board" | "system". */
  actorType: string;
  /** Actor ID (user id, agent id, or "system"). */
  actorId: string | null;
  /** Run ID if the change originated from a run. */
  runId: string | null;
  /** Free-form metadata (title, description, priority, etc.). */
  metadata: Record<string, unknown>;
}

/** Result of a single-plane delivery attempt. */
export interface MemoryPlaneDeliveryResult {
  plane: MemoryPlaneName;
  success: boolean;
  error: string | null;
  attempts: number;
  /** Duration in milliseconds. */
  durationMs: number;
}

export type MemoryPlaneName = "ob1" | "hindsight" | "honcho" | "holographic";

/** Aggregate result of fanning an event to all 4 planes. */
export interface MemoryPlaneFanoutResult {
  eventId: string;
  results: MemoryPlaneDeliveryResult[];
  /** True if every plane succeeded. */
  allSucceeded: boolean;
}

/** Configuration for a single OB1 instance. */
export interface Ob1InstanceConfig {
  name: string;
  url: string;
  apiKey: string | null;
}

/** Dead-letter entry for events that exhausted retries. */
export interface DeadLetterEntry {
  event: MemoryPlaneLifecycleEvent;
  plane: MemoryPlaneName;
  error: string;
  finalAttemptAt: string;
  attempts: number;
}