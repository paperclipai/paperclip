/**
 * Memory Plane Observer Service
 *
 * Publishes Routine/Goal lifecycle events to all 4 memory planes:
 *   1. OB1 (OpenBrain) — writeback via REST API
 *   2. Hindsight — retain via REST API
 *   3. Honcho — conclude via REST API (Goal completions only)
 *   4. Holographic — fact_store via REST API
 *
 * Features:
 *   - Idempotency via event ID (UUID v4) — each event is delivered at most once per plane
 *   - Retry with exponential backoff (3 attempts: 1s, 2s, 4s)
 *   - Dead-letter handling for events that exhaust retries
 *   - Non-blocking: failures in one plane do not affect others
 */

import { randomUUID } from "node:crypto";
import type {
  MemoryPlaneLifecycleEvent,
  MemoryPlaneDeliveryResult,
  MemoryPlaneName,
  MemoryPlaneFanoutResult,
  Ob1InstanceConfig,
  DeadLetterEntry,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MemoryPlaneObserverConfig {
  /** OB1 instances to write back to (up to 4). */
  ob1Instances: Ob1InstanceConfig[];
  /** Hindsight API URL. */
  hindsightUrl: string | null;
  /** Hindsight bank name. */
  hindsightBank: string;
  /** Honcho API URL. */
  honchoUrl: string | null;
  /** Honcho API key (JWT). */
  honchoApiKey: string | null;
  /** Honcho workspace ID for conclusions. */
  honchoWorkspaceId: string | null;
  /** Holographic API URL (fact_store endpoint). */
  holographicUrl: string | null;
  /** Holographic API key. */
  holographicApiKey: string | null;
  /** Max retry attempts per plane. */
  maxRetries: number;
  /** Base delay in ms for exponential backoff. */
  baseRetryDelayMs: number;
  /** Whether the observer is enabled. */
  enabled: boolean;
}

const DEFAULT_CONFIG: MemoryPlaneObserverConfig = {
  ob1Instances: [],
  hindsightUrl: null,
  hindsightBank: "hermes",
  honchoUrl: null,
  honchoApiKey: null,
  honchoWorkspaceId: null,
  holographicUrl: null,
  holographicApiKey: null,
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  enabled: true,
};

// ---------------------------------------------------------------------------
// Dead-letter store (in-memory, lost on restart — acceptable for V1)
// ---------------------------------------------------------------------------

const deadLetterStore: Map<string, DeadLetterEntry> = new Map();

export function getDeadLetterEntries(): DeadLetterEntry[] {
  return Array.from(deadLetterStore.values());
}

export function clearDeadLetterEntries(): void {
  deadLetterStore.clear();
}

// ---------------------------------------------------------------------------
// Idempotency tracking (in-memory, per process)
// ---------------------------------------------------------------------------

const deliveredEventIds: Map<string, Set<MemoryPlaneName>> = new Map();

function isAlreadyDelivered(eventId: string, plane: MemoryPlaneName): boolean {
  const planes = deliveredEventIds.get(eventId);
  return planes ? planes.has(plane) : false;
}

function markDelivered(eventId: string, plane: MemoryPlaneName): void {
  let planes = deliveredEventIds.get(eventId);
  if (!planes) {
    planes = new Set();
    deliveredEventIds.set(eventId, planes);
  }
  planes.add(plane);
}

// Cleanup old entries to prevent unbounded growth (keep last 10k events)
const MAX_TRACKED_EVENTS = 10_000;
function pruneIdempotencyCache(): void {
  if (deliveredEventIds.size > MAX_TRACKED_EVENTS) {
    const keysToDelete = Array.from(deliveredEventIds.keys()).slice(0, deliveredEventIds.size - MAX_TRACKED_EVENTS);
    for (const key of keysToDelete) {
      deliveredEventIds.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
): Promise<{ result: T; attempts: number } | { error: string; attempts: number }> {
  let lastError: string = "";
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }
  return { error: lastError, attempts: maxRetries };
}

// ---------------------------------------------------------------------------
// Plane adapters
// ---------------------------------------------------------------------------

async function deliverToOb1(
  event: MemoryPlaneLifecycleEvent,
  instance: Ob1InstanceConfig,
  maxRetries: number,
  baseDelayMs: number,
): Promise<MemoryPlaneDeliveryResult> {
  const start = Date.now();
  const planeName: MemoryPlaneName = "ob1";

  if (isAlreadyDelivered(event.id, planeName)) {
    return { plane: planeName, success: true, error: null, attempts: 0, durationMs: 0 };
  }

  const outcome = await withRetry(async () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (instance.apiKey) {
      headers["Authorization"] = `Bearer ${instance.apiKey}`;
    }
    const response = await fetch(`${instance.url}/api/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        summary: `[${event.entityType}:${event.newStatus}] ${event.metadata.title ?? event.entityId}`,
        content: JSON.stringify(event),
        memory_type: "fact",
        metadata: {
          source: "paperclip-lifecycle-observer",
          entity_type: event.entityType,
          entity_id: event.entityId,
          event_id: event.id,
          plane: "ob1",
          instance: instance.name,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`OB1 ${instance.name} returned ${response.status}: ${await response.text()}`);
    }
  }, maxRetries, baseDelayMs);

  const durationMs = Date.now() - start;

  if ("error" in outcome) {
    logger.warn(
      { eventId: event.id, instance: instance.name, error: outcome.error, attempts: outcome.attempts },
      "OB1 delivery failed after retries",
    );
    recordDeadLetter(event, planeName, outcome.error, outcome.attempts);
    return { plane: planeName, success: false, error: outcome.error, attempts: outcome.attempts, durationMs };
  }

  markDelivered(event.id, planeName);
  pruneIdempotencyCache();
  return { plane: planeName, success: true, error: null, attempts: outcome.attempts, durationMs };
}

async function deliverToHindsight(
  event: MemoryPlaneLifecycleEvent,
  config: MemoryPlaneObserverConfig,
): Promise<MemoryPlaneDeliveryResult> {
  const start = Date.now();
  const planeName: MemoryPlaneName = "hindsight";

  if (!config.hindsightUrl) {
    return { plane: planeName, success: false, error: "Hindsight URL not configured", attempts: 0, durationMs: 0 };
  }

  if (isAlreadyDelivered(event.id, planeName)) {
    return { plane: planeName, success: true, error: null, attempts: 0, durationMs: 0 };
  }

  const outcome = await withRetry(async () => {
    const response = await fetch(`${config.hindsightUrl}/retain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: JSON.stringify(event),
        context: `paperclip-${event.entityType}-lifecycle`,
        tags: ["paperclip", event.entityType, event.newStatus, event.id],
      }),
    });
    if (!response.ok) {
      throw new Error(`Hindsight returned ${response.status}: ${await response.text()}`);
    }
  }, config.maxRetries, config.baseRetryDelayMs);

  const durationMs = Date.now() - start;

  if ("error" in outcome) {
    logger.warn({ eventId: event.id, error: outcome.error, attempts: outcome.attempts }, "Hindsight delivery failed");
    recordDeadLetter(event, planeName, outcome.error, outcome.attempts);
    return { plane: planeName, success: false, error: outcome.error, attempts: outcome.attempts, durationMs };
  }

  markDelivered(event.id, planeName);
  pruneIdempotencyCache();
  return { plane: planeName, success: true, error: null, attempts: outcome.attempts, durationMs };
}

async function deliverToHoncho(
  event: MemoryPlaneLifecycleEvent,
  config: MemoryPlaneObserverConfig,
): Promise<MemoryPlaneDeliveryResult> {
  const start = Date.now();
  const planeName: MemoryPlaneName = "honcho";

  // Honcho only stores Goal completions as conclusions
  if (event.entityType !== "goal" || event.newStatus !== "achieved") {
    return { plane: planeName, success: true, error: null, attempts: 0, durationMs: 0 };
  }

  if (!config.honchoUrl || !config.honchoApiKey || !config.honchoWorkspaceId) {
    return {
      plane: planeName,
      success: false,
      error: "Honcho URL, API key, or workspace ID not configured",
      attempts: 0,
      durationMs: 0,
    };
  }

  if (isAlreadyDelivered(event.id, planeName)) {
    return { plane: planeName, success: true, error: null, attempts: 0, durationMs: 0 };
  }

  const outcome = await withRetry(async () => {
    const response = await fetch(
      `${config.honchoUrl}/v3/workspaces/${config.honchoWorkspaceId}/conclusions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.honchoApiKey}`,
        },
        body: JSON.stringify({
          conclusion: `Goal "${event.metadata.title ?? event.entityId}" achieved (Paperclip goal ${event.entityId})`,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Honcho returned ${response.status}: ${await response.text()}`);
    }
  }, config.maxRetries, config.baseRetryDelayMs);

  const durationMs = Date.now() - start;

  if ("error" in outcome) {
    logger.warn({ eventId: event.id, error: outcome.error, attempts: outcome.attempts }, "Honcho delivery failed");
    recordDeadLetter(event, planeName, outcome.error, outcome.attempts);
    return { plane: planeName, success: false, error: outcome.error, attempts: outcome.attempts, durationMs };
  }

  markDelivered(event.id, planeName);
  pruneIdempotencyCache();
  return { plane: planeName, success: true, error: null, attempts: outcome.attempts, durationMs };
}

async function deliverToHolographic(
  event: MemoryPlaneLifecycleEvent,
  config: MemoryPlaneObserverConfig,
): Promise<MemoryPlaneDeliveryResult> {
  const start = Date.now();
  const planeName: MemoryPlaneName = "holographic";

  if (!config.holographicUrl) {
    return { plane: planeName, success: false, error: "Holographic URL not configured", attempts: 0, durationMs: 0 };
  }

  if (isAlreadyDelivered(event.id, planeName)) {
    return { plane: planeName, success: true, error: null, attempts: 0, durationMs: 0 };
  }

  const outcome = await withRetry(async () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.holographicApiKey) {
      headers["Authorization"] = `Bearer ${config.holographicApiKey}`;
    }
    const response = await fetch(`${config.holographicUrl}/api/facts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "add",
        content: `Paperclip ${event.entityType} ${event.entityId} status changed from ${event.oldStatus ?? "null"} to ${event.newStatus}${event.metadata.title ? ` (title: ${event.metadata.title})` : ""}`,
        category: "project",
        tags: `paperclip,${event.entityType},${event.newStatus}`,
      }),
    });
    if (!response.ok) {
      throw new Error(`Holographic returned ${response.status}: ${await response.text()}`);
    }
  }, config.maxRetries, config.baseRetryDelayMs);

  const durationMs = Date.now() - start;

  if ("error" in outcome) {
    logger.warn(
      { eventId: event.id, error: outcome.error, attempts: outcome.attempts },
      "Holographic delivery failed",
    );
    recordDeadLetter(event, planeName, outcome.error, outcome.attempts);
    return { plane: planeName, success: false, error: outcome.error, attempts: outcome.attempts, durationMs };
  }

  markDelivered(event.id, planeName);
  pruneIdempotencyCache();
  return { plane: planeName, success: true, error: null, attempts: outcome.attempts, durationMs };
}

// ---------------------------------------------------------------------------
// Dead-letter helper
// ---------------------------------------------------------------------------

function recordDeadLetter(
  event: MemoryPlaneLifecycleEvent,
  plane: MemoryPlaneName,
  error: string,
  attempts: number,
): void {
  const key = `${event.id}:${plane}`;
  deadLetterStore.set(key, {
    event,
    plane,
    error,
    finalAttemptAt: new Date().toISOString(),
    attempts,
  });
  logger.error({ eventId: event.id, plane, error, attempts }, "Event dead-lettered");
}

// ---------------------------------------------------------------------------
// Honcho reachability probe
// ---------------------------------------------------------------------------

export interface HonchoReachabilityResult {
  /** True when Honcho answered the probe with a 2xx status. */
  reachable: boolean;
  /** Human-readable detail when reachable is false; null on success. */
  error: string | null;
  /** HTTP status code returned by Honcho, or null if the request never completed. */
  status: number | null;
}

/**
 * Probe Honcho v3 reachability by POSTing to `/v3/workspaces/list`.
 *
 * Honcho v3 rejects a request body with 422 — the endpoint expects no body
 * (use `null`, not `JSON.stringify({})`). The probe is fail-safe: when Honcho
 * is not configured it reports `reachable=false` with a clear reason rather
 * than throwing.
 *
 * @param config Optional override config; defaults to the active observer config.
 */
export async function checkHonchoReachability(
  config: MemoryPlaneObserverConfig = observerConfig,
): Promise<HonchoReachabilityResult> {
  if (!config.honchoUrl) {
    return { reachable: false, error: "Honcho URL not configured", status: null };
  }
  if (!config.honchoApiKey) {
    return { reachable: false, error: "Honcho API key not configured", status: null };
  }

  const url = `${config.honchoUrl}/v3/workspaces/list`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.honchoApiKey) {
    headers["Authorization"] = `Bearer ${config.honchoApiKey}`;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      // Honcho v3 rejects `JSON.stringify({})` with 422. Send no body.
      headers,
      body: null,
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return {
        reachable: false,
        error: `Honcho returned ${response.status}: ${bodyText.slice(0, 200)}`,
        status: response.status,
      };
    }
    return { reachable: true, error: null, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { reachable: false, error: `Honcho request failed: ${message}`, status: null };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let observerConfig: MemoryPlaneObserverConfig = DEFAULT_CONFIG;

export function configureMemoryPlaneObserver(config: Partial<MemoryPlaneObserverConfig>): void {
  observerConfig = { ...observerConfig, ...config };
  logger.info(
    {
      enabled: observerConfig.enabled,
      ob1Count: observerConfig.ob1Instances.length,
      hindsight: !!observerConfig.hindsightUrl,
      honcho: !!observerConfig.honchoUrl,
      holographic: !!observerConfig.holographicUrl,
    },
    "Memory plane observer configured",
  );
}

export function getObserverConfig(): MemoryPlaneObserverConfig {
  return observerConfig;
}

/**
 * Create a lifecycle event from a state change.
 * Call this before fanout to get a properly structured event with a unique id.
 */
export function createLifecycleEvent(params: {
  entityType: "routine" | "goal" | "routine_run";
  entityId: string;
  companyId: string;
  oldStatus: string | null;
  newStatus: string;
  agentId: string | null;
  actorType: string;
  actorId: string | null;
  runId: string | null;
  metadata?: Record<string, unknown>;
}): MemoryPlaneLifecycleEvent {
  return {
    id: randomUUID(),
    entityType: params.entityType,
    entityId: params.entityId,
    companyId: params.companyId,
    oldStatus: params.oldStatus,
    newStatus: params.newStatus,
    timestamp: new Date().toISOString(),
    agentId: params.agentId,
    actorType: params.actorType,
    actorId: params.actorId,
    runId: params.runId,
    metadata: params.metadata ?? {},
  };
}

/**
 * Fan out a lifecycle event to all configured memory planes.
 * Non-blocking: each plane is attempted independently; one failure doesn't block others.
 * Returns aggregate result with per-plane outcomes.
 */
export async function publishLifecycleEvent(
  event: MemoryPlaneLifecycleEvent,
): Promise<MemoryPlaneFanoutResult> {
  if (!observerConfig.enabled) {
    logger.debug({ eventId: event.id }, "Memory plane observer disabled, skipping fanout");
    return { eventId: event.id, results: [], allSucceeded: true };
  }

  const results: MemoryPlaneDeliveryResult[] = [];

  // OB1 — deliver to all configured instances
  for (const instance of observerConfig.ob1Instances) {
    results.push(await deliverToOb1(event, instance, observerConfig.maxRetries, observerConfig.baseRetryDelayMs));
  }

  // Hindsight
  results.push(await deliverToHindsight(event, observerConfig));

  // Honcho
  results.push(await deliverToHoncho(event, observerConfig));

  // Holographic
  results.push(await deliverToHolographic(event, observerConfig));

  const allSucceeded = results.every((r) => r.success);

  logger.info(
    { eventId: event.id, allSucceeded, planeCount: results.length },
    "Memory plane fanout complete",
  );

  return { eventId: event.id, results, allSucceeded };
}