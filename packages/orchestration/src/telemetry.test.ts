import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_POLICY,
  InMemoryTelemetrySink,
  decisionToTelemetry,
  route,
  type TelemetryEvent,
} from './index.js';

const deps = { policy: EXAMPLE_POLICY };

describe('orchestration.telemetry — per-call contract', () => {
  it('lifts a routing decision into a TelemetryEvent with required fields', () => {
    const descriptor = {
      task_type: 'strategy_positioning_board',
      sensitivity: 'outbound' as const,
      expected_complexity: 'complex' as const,
      estimated_input_tokens: 5_000,
      agent_id: 'agent-cto',
      call_id: 'call-fixture-1',
    };
    const decision = route(descriptor, deps);
    const event: TelemetryEvent = decisionToTelemetry(decision, descriptor, {
      ts: '2026-05-06T00:00:00.000Z',
    });
    expect(event.call_id).toBe('call-fixture-1');
    expect(event.ts).toBe('2026-05-06T00:00:00.000Z');
    expect(event.agent_id).toBe('agent-cto');
    expect(event.task_type).toBe('strategy_positioning_board');
    expect(event.engine).toBe(decision.engine);
    expect(event.model).toBe(decision.model);
    expect(event.role).toBe(decision.role);
    expect(event.complexity_class).toBe('complex');
    expect(event.expected_cost_eur_cents).toBe(decision.estimated_cost_eur_cents);
    expect(event.confidence).toBe(decision.confidence);
    expect(event.fallback_engine).toBe(decision.fallback?.engine);
    expect(event.fallback_model).toBe(decision.fallback?.model);
    // Outcome fields stay undefined until caller populates them post-call.
    expect(event.actual_cost_eur_cents).toBeUndefined();
    expect(event.outcome_signal).toBeUndefined();
    expect(event.failure_class).toBeUndefined();
  });

  it('InMemoryTelemetrySink retains emitted events in order', () => {
    const sink = new InMemoryTelemetrySink();
    const descriptor = {
      task_type: 'web_research_sourcing',
      sensitivity: 'internal' as const,
    };
    const decision = route(descriptor, deps);
    sink.emit(decisionToTelemetry(decision, descriptor, { call_id: 'a', ts: 't' }));
    sink.emit(decisionToTelemetry(decision, descriptor, { call_id: 'b', ts: 't' }));
    expect(sink.events.map((e) => e.call_id)).toEqual(['a', 'b']);
  });
});
