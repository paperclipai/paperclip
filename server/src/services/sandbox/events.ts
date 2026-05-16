/**
 * Phase 4A-2 (LET-314): In-process sandbox event bus.
 *
 * Producers (the Docker provider scaffold, future runtime workers, the
 * reaper) call `publishSandboxEvent` to broadcast a lease/runtime status
 * change. Consumers (the `/api/companies/:companyId/sandbox/events` SSE
 * route, future Command Center widgets) subscribe per company and receive
 * already-redacted, allowlisted payloads — see `read-model.ts`.
 *
 * The bus is intentionally process-local and stateless: it does not
 * persist events. The REST list/get endpoints remain the source of truth
 * for current lease state; the event stream is a notification channel that
 * tells consumers when to re-read.
 */

import { EventEmitter } from "node:events";

export const SANDBOX_EVENT_TYPES = [
  "sandbox.lease.upserted",
  "sandbox.lease.state_changed",
  "sandbox.lease.released",
  "sandbox.provider.status",
] as const;

export type SandboxEventType = (typeof SANDBOX_EVENT_TYPES)[number];

export interface SandboxEvent {
  /** Monotonic id within this process. */
  id: number;
  companyId: string;
  type: SandboxEventType;
  createdAt: string;
  /**
   * Read-model payload. Producers MUST pass an already-redacted, allowlisted
   * payload — see `toSandboxLeaseReadModel` / `redactSandboxEventPayload`.
   */
  payload: Record<string, unknown>;
}

type Listener = (event: SandboxEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

export function publishSandboxEvent(input: {
  companyId: string;
  type: SandboxEventType;
  payload?: Record<string, unknown>;
}): SandboxEvent {
  nextEventId += 1;
  const event: SandboxEvent = {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
  emitter.emit(input.companyId, event);
  return event;
}

export function subscribeCompanySandboxEvents(companyId: string, listener: Listener): () => void {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

/** Test helper: count active subscribers for a company. */
export function __sandboxSubscriberCount(companyId: string): number {
  return emitter.listenerCount(companyId);
}
