/**
 * Phase E3 notifier — build the `agent.routing.escalated` domain event.
 *
 * Emitted by the heartbeat dispatcher (services/heartbeat.ts) at the
 * exact moment the Phase E2 escalation backstop fires: i.e. immediately
 * after the `routing.escalation` run event is appended, and immediately
 * before the second `adapter.execute` call at the escalated tier.
 *
 * The payload mirrors the `routing.escalation` run-event payload and
 * adds the run/agent/company/issue identifiers that observability +
 * cost-tracking subscribers need to correlate the escalation back to
 * the run record without inspecting adapter state.
 *
 * Pure functional. Defaults (`eventId`, `occurredAt`) can be injected
 * by tests to assert exact equality.
 */
import { randomUUID } from "node:crypto";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

import type { RoutingTier } from "@paperclipai/shared";

export interface RoutingEscalatedEventInput {
  runId: string;
  agentId: string;
  companyId: string;
  issueId: string | null;
  fromTier: RoutingTier;
  fromModel: string;
  toTier: RoutingTier;
  toModel: string;
  toProvider: string;
  reason: string;
  errorCode: string | null;
  errorFamily: string | null;
  /** Override for deterministic tests. Defaults to a fresh randomUUID. */
  eventId?: string;
  /** Override for deterministic tests. Defaults to `new Date().toISOString()`. */
  occurredAt?: string;
}

export interface RoutingEscalatedEventPayload {
  runId: string;
  agentId: string;
  companyId: string;
  issueId: string | null;
  fromTier: RoutingTier;
  fromModel: string;
  toTier: RoutingTier;
  toModel: string;
  toProvider: string;
  reason: string;
  errorCode: string | null;
  errorFamily: string | null;
}

export function buildRoutingEscalatedDomainEvent(
  input: RoutingEscalatedEventInput,
): PluginEvent<RoutingEscalatedEventPayload> {
  return {
    eventId: input.eventId ?? randomUUID(),
    eventType: "agent.routing.escalated",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    actorId: input.agentId,
    actorType: "agent",
    entityId: input.runId,
    entityType: "heartbeat_run",
    companyId: input.companyId,
    payload: {
      runId: input.runId,
      agentId: input.agentId,
      companyId: input.companyId,
      issueId: input.issueId,
      fromTier: input.fromTier,
      fromModel: input.fromModel,
      toTier: input.toTier,
      toModel: input.toModel,
      toProvider: input.toProvider,
      reason: input.reason,
      errorCode: input.errorCode,
      errorFamily: input.errorFamily,
    },
  };
}
