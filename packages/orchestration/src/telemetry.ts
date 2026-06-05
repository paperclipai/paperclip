/** Per-call telemetry contract.
 *
 *  Single source of truth that dashboard and self-learning consumers both read.
 *  Schema is fixed in `types.ts::TelemetryEvent`; this module provides:
 *    - in-memory sink for tests and dev,
 *    - logger sink that emits structured events for production tap-in,
 *    - composite sink so callers can fan out to multiple sinks atomically,
 *    - a `decisionToTelemetry()` helper that lifts a RoutingDecision into a
 *      partially-populated TelemetryEvent (caller fills outcome fields after
 *      the LLM call resolves).
 */

import {
  TELEMETRY_SCHEMA_VERSION,
  type RoutingDecision,
  type TaskDescriptor,
  type TelemetryEvent,
  type TelemetrySink,
} from './types.js';

/** Minimal structural logger contract for {@link LoggerTelemetrySink}.
 *
 *  Kept dependency-free so this package stays vendor-agnostic. Concrete loggers
 *  (pino, console, custom) match structurally. */
export interface TelemetryLogger {
  info: (obj: object, msg?: string) => void;
}

export class InMemoryTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

export class LoggerTelemetrySink implements TelemetrySink {
  constructor(private readonly logger: TelemetryLogger) {}
  emit(event: TelemetryEvent): void {
    this.logger.info({ telemetry: event }, 'orchestration.telemetry');
  }
}

export class CompositeTelemetrySink implements TelemetrySink {
  constructor(private readonly sinks: readonly TelemetrySink[]) {}
  async emit(event: TelemetryEvent): Promise<void> {
    await Promise.all(this.sinks.map((s) => Promise.resolve(s.emit(event))));
  }
}

/** No-op sink used as the default when callers don't supply one. */
export const noopTelemetrySink: TelemetrySink = {
  emit() {
    /* intentional no-op */
  },
};

/** Build the immutable portion of a TelemetryEvent from a routing decision +
 *  the descriptor that produced it. Caller fills `actual_cost_eur_cents`,
 *  `latency_ms`, `outcome_signal`, `failure_class`, `exit_code`,
 *  `document_type` after the LLM call. */
export function decisionToTelemetry(
  decision: RoutingDecision,
  descriptor: TaskDescriptor,
  opts: { call_id?: string; ts?: string } = {},
): TelemetryEvent {
  return {
    call_id: opts.call_id ?? descriptor.call_id ?? generateCallId(),
    ts: opts.ts ?? new Date().toISOString(),
    agent_id: descriptor.agent_id,
    task_type: descriptor.task_type,
    sensitivity: descriptor.sensitivity,
    engine: decision.engine,
    model: decision.model,
    role: decision.role,
    tier: decision.tier,
    complexity_class: decision.complexity_class,
    estimated_input_tokens: descriptor.estimated_input_tokens,
    expected_cost_eur_cents: decision.estimated_cost_eur_cents,
    confidence: decision.confidence,
    role_match_score: decision.role_match_score,
    justification: decision.justification,
    human_sign_off_required: decision.human_sign_off_required,
    fallback_engine: decision.fallback?.engine,
    fallback_model: decision.fallback?.model,
    schema_version: TELEMETRY_SCHEMA_VERSION,
  };
}

function generateCallId(): string {
  // crypto.randomUUID is in Node 22 and the standard runtime. call_id only needs
  // to be unique within a sink, and most callers will have their own ids.
  return globalThis.crypto?.randomUUID?.() ?? `call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
