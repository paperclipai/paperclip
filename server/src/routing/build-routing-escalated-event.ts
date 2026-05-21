/**
 * Phase E3 + I notifier — typed payload shape for the
 * `agent.routing.escalated` domain event.
 *
 * Phase E3 (PR-G) introduced this builder and called
 * `publishPluginDomainEvent(buildRoutingEscalatedDomainEvent({...}))`
 * directly at the dispatch site. Phase I (this file's current shape)
 * promotes the escalation event into `activity_log` as a persistent
 * row by routing it through `logActivity()` — which writes the row
 * AND publishes the same plugin event via `eventTypeForActivityAction`
 * (the new event type is in `PLUGIN_EVENT_SET`, so the lookup picks
 * it up automatically).
 *
 * The builder is now scoped to producing the `details` payload that
 * `logActivity()` consumes — and that subscribers receive in
 * `PluginEvent.payload` (logActivity merges the details with
 * {agentId, runId}, see services/activity-log.ts).
 *
 * `buildRoutingEscalatedDomainEvent` (full envelope) is retained as
 * a thin wrapper for non-logActivity callers (e.g. plugins or
 * adapter overlays that want to publish directly without writing to
 * activity_log).
 *
 * Pure functional. Defaults (`eventId`, `occurredAt`) can be
 * overridden by tests to assert exact equality.
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

/**
 * Build the payload sent to `logActivity()`'s `details` field. This
 * is what subscribers will see in `PluginEvent.payload` (with
 * `agentId` + `runId` merged in by `logActivity`).
 */
export function buildRoutingEscalatedPayload(
  input: RoutingEscalatedEventInput,
): RoutingEscalatedEventPayload {
  return {
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
  };
}

/**
 * Build the full `PluginEvent` envelope for callers that want to
 * publish directly to the plugin bus without going through
 * `logActivity` (e.g. an adapter overlay or test harness). The
 * dispatch site uses `logActivity` + `buildRoutingEscalatedPayload`
 * instead; this function is retained for completeness and may be
 * unused in the main code path.
 */
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
    payload: buildRoutingEscalatedPayload(input),
  };
}
