/**
 * Shared types for the Circuit Breaker plugin.
 *
 * Defines the configuration schema, per-agent circuit state, and detection
 * strategy identifiers used by the worker and tests.
 */

// ---------------------------------------------------------------------------
// Circuit breaker domain types
// ---------------------------------------------------------------------------

/** Circuit states following the classic circuit breaker pattern. */
export type CircuitState = "closed" | "open" | "half-open";

/** Detection strategies that can trip the breaker. */
export type TripReason = "consecutive_failures" | "no_progress" | "token_velocity";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Merged config shape (instance defaults + per-agent overrides). */
export interface CircuitBreakerConfig {
  enabled: boolean;
  maxConsecutiveFailures: number;
  maxConsecutiveNoProgress: number;
  tokenVelocityMultiplier: number;
  tokenVelocityWindowSize: number;
  recovery: {
    mode: "manual" | "half-open";
    cooldownMinutes: number;
  };
}

/** Default instance config values. */
export const DEFAULT_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  maxConsecutiveFailures: 3,
  maxConsecutiveNoProgress: 5,
  tokenVelocityMultiplier: 3.0,
  tokenVelocityWindowSize: 20,
  recovery: { mode: "manual", cooldownMinutes: 30 },
};

// ---------------------------------------------------------------------------
// Per-agent state
// ---------------------------------------------------------------------------

/** Per-agent state persisted in ctx.state scoped to each agent. */
export interface AgentCircuitState {
  circuitState: CircuitState;
  consecutiveFailures: number;
  consecutiveNoProgress: number;
  tokenCostHistory: number[];
  tripReasons: TripReason[];
  trippedAt: string | null;
  lastEventAt: string | null;
}

/** Default state for an agent with no circuit breaker history. */
export const DEFAULT_AGENT_STATE: AgentCircuitState = {
  circuitState: "closed",
  consecutiveFailures: 0,
  consecutiveNoProgress: 0,
  tokenCostHistory: [],
  tripReasons: [],
  trippedAt: null,
  lastEventAt: null,
};
