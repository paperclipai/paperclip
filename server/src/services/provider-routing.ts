/**
 * Provider Routing Service — Deterministic routing decisions with
 * circuit breaker and budget cap support.
 *
 * Stage 0: decision logic only. Always returns `useOriginalAdapter: true`.
 * No live fallback, no provider switching, no production behavior change.
 */

import type {
  FallbackProviderConfig,
  ProviderConfidence,
  ProviderRoutingPolicy,
  TaskClassificationContext,
  TaskRiskClass,
} from "./provider-routing-policy.js";
import { evaluateProviderFallbackEligibility } from "./provider-routing-policy.js";

// ---------------------------------------------------------------------------
// Circuit breaker state (in-memory, resets on restart)
// ---------------------------------------------------------------------------

export interface CircuitBreakerState {
  tripped: boolean;
  trippedAt: string | null;
  cooldownUntil: string | null;
  tripReason: string | null;
  recentFailures: number;
  recentMalformed: number;
  recentHallucinations: number;
}

function createCircuitBreakerState(): CircuitBreakerState {
  return {
    tripped: false,
    trippedAt: null,
    cooldownUntil: null,
    tripReason: null,
    recentFailures: 0,
    recentMalformed: 0,
    recentHallucinations: 0,
  };
}

const circuitBreakersByProvider = new Map<string, CircuitBreakerState>();

export function getCircuitBreakerState(providerId: string): CircuitBreakerState {
  let state = circuitBreakersByProvider.get(providerId);
  if (!state) {
    state = createCircuitBreakerState();
    circuitBreakersByProvider.set(providerId, state);
  }
  return state;
}

export function isCircuitBreakerTripped(providerId: string, now = new Date()): boolean {
  const state = circuitBreakersByProvider.get(providerId);
  if (!state?.tripped) return false;
  if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() <= now.getTime()) {
    // Cooldown expired — reset
    circuitBreakersByProvider.set(providerId, createCircuitBreakerState());
    return false;
  }
  return true;
}

export function tripCircuitBreaker(
  providerId: string,
  reason: string,
  cooldownMinutes: number,
  now = new Date(),
): void {
  const cooldownUntil = new Date(now.getTime() + cooldownMinutes * 60_000);
  circuitBreakersByProvider.set(providerId, {
    tripped: true,
    trippedAt: now.toISOString(),
    cooldownUntil: cooldownUntil.toISOString(),
    tripReason: reason,
    recentFailures: 0,
    recentMalformed: 0,
    recentHallucinations: 0,
  });
}

export function resetCircuitBreaker(providerId: string): void {
  circuitBreakersByProvider.set(providerId, createCircuitBreakerState());
}

// ---------------------------------------------------------------------------
// Routing decision types
// ---------------------------------------------------------------------------

export interface RoutingDecision {
  useOriginalAdapter: boolean;
  fallbackAdapterType: string | null;
  fallbackAdapterConfig: Record<string, unknown> | null;
  fallbackProvider: FallbackProviderConfig | null;
  providerConfidence: ProviderConfidence;
  taskRiskClass: TaskRiskClass;
  decision: {
    trigger: string;
    eligible: boolean;
    reason: string;
    stage: number;
    dryRun: boolean;
    precedenceLevel: number;
    precedenceLabel: string;
  };
}

function buildUseOriginal(
  taskRiskClass: TaskRiskClass,
  reason: string,
  stage: number,
  precedenceLevel: number,
  precedenceLabel: string,
  providerConfidence: ProviderConfidence = "full",
): RoutingDecision {
  return {
    useOriginalAdapter: true,
    fallbackAdapterType: null,
    fallbackAdapterConfig: null,
    fallbackProvider: null,
    providerConfidence,
    taskRiskClass,
    decision: {
      trigger: "none",
      eligible: false,
      reason,
      stage,
      dryRun: true,
      precedenceLevel,
      precedenceLabel,
    },
  };
}

// ---------------------------------------------------------------------------
// Budget check stub (Stage 0: always passes)
// ---------------------------------------------------------------------------

export interface BudgetCheckResult {
  exceeded: boolean;
  reason: string | null;
  currentSpendUsd?: number;
  currentRunsHour?: number;
  currentRunsDay?: number;
}

export function checkFallbackBudget(
  _companyId: string,
  _policy: ProviderRoutingPolicy,
): BudgetCheckResult {
  // Stage 0: no budget enforcement — always returns not exceeded
  return { exceeded: false, reason: null };
}

// ---------------------------------------------------------------------------
// Routing precedence chain
// ---------------------------------------------------------------------------

/**
 * Deterministic routing precedence:
 *
 * 1. Human override (per-agent providerRoutingOverride)
 * 2. Kill switch (env var or settings flag)
 * 3. Budget cap
 * 4. Circuit breaker
 * 5. "Never fallback" context (hard block)
 * 6. Eligibility policy (agent allowlist + role denylist + task-risk)
 * 7. Provider availability (is primary quota-exhausted?)
 * 8. Fallback credentials check
 * 9. Fallback route
 *
 * Stage 0: always returns useOriginalAdapter = true (no live routing).
 * The full precedence chain is evaluated for logging/observability.
 */
export function resolveProviderForRun(
  agent: {
    name?: string | null;
    role?: string | null;
    adapterConfig?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  },
  context: TaskClassificationContext & {
    companyId?: string;
    errorCode?: string | null;
  },
  wakeReason: string | null | undefined,
  policy: ProviderRoutingPolicy,
): RoutingDecision {
  const stage = policy.stage;
  const eligibility = evaluateProviderFallbackEligibility(agent, context, wakeReason, policy);
  const { taskRiskClass } = eligibility;

  // Priority 1: Human override
  const override = (agent.metadata?.providerRoutingOverride as string | undefined) ?? "auto";
  if (override === "force_primary") {
    return buildUseOriginal(taskRiskClass, "human_override:force_primary", stage, 1, "human_override");
  }

  // Priority 2: Kill switch
  if (!policy.enabled || process.env.PAPERCLIP_DISABLE_PROVIDER_ROUTING === "1") {
    return buildUseOriginal(taskRiskClass, "kill_switch", stage, 2, "kill_switch");
  }

  // Priority 3: Budget cap
  const budget = checkFallbackBudget(context.companyId ?? "", policy);
  if (budget.exceeded) {
    return buildUseOriginal(taskRiskClass, `fallback_budget_exceeded:${budget.reason}`, stage, 3, "budget_cap", "degraded");
  }

  // Priority 4: Circuit breaker
  if (isCircuitBreakerTripped(policy.fallbackProvider.id)) {
    return buildUseOriginal(taskRiskClass, "circuit_breaker_tripped", stage, 4, "circuit_breaker", "degraded");
  }

  // Priority 5-6: Eligibility (includes hard blocks, role checks, task-risk)
  if (!eligibility.eligible) {
    return buildUseOriginal(taskRiskClass, eligibility.reason, stage, eligibility.reason.startsWith("context_hard_blocked") ? 5 : 6, eligibility.reason.startsWith("context_hard_blocked") ? "hard_block" : "eligibility_policy");
  }

  // Priority 7: Provider availability — is primary quota-exhausted?
  const quotaExhausted = context.errorCode === "claude_quota_exhausted";
  if (!quotaExhausted && override !== "force_fallback") {
    return buildUseOriginal(taskRiskClass, "primary_available", stage, 7, "provider_availability");
  }

  // Priority 8: Fallback credentials check
  const credentialKey = policy.fallbackProvider.credentialEnvKey;
  const hasCredentials = Boolean(process.env[credentialKey]?.trim());
  if (!hasCredentials) {
    return buildUseOriginal(taskRiskClass, "no_fallback_credentials", stage, 8, "credentials_check", "degraded");
  }

  // Priority 9: Fallback route — all gates passed
  // Stage 0: still return useOriginalAdapter = true (dry-run always)
  const isDryRun = stage < 3;

  return {
    useOriginalAdapter: isDryRun,
    fallbackAdapterType: policy.fallbackProvider.adapterType,
    fallbackAdapterConfig: {
      env: {
        [credentialKey]: process.env[credentialKey],
        ...policy.fallbackProvider.envOverrides,
      },
      model: policy.fallbackProvider.modelId,
    },
    fallbackProvider: policy.fallbackProvider,
    providerConfidence: "emergency_fallback",
    taskRiskClass,
    decision: {
      trigger: "claude_quota_exhausted",
      eligible: true,
      reason: isDryRun ? "fallback_route_dry_run" : "fallback_route_active",
      stage,
      dryRun: isDryRun,
      precedenceLevel: 9,
      precedenceLabel: "fallback_route",
    },
  };
}

// ---------------------------------------------------------------------------
// Routing decision log structure (for NDJSON / activity log)
// ---------------------------------------------------------------------------

export interface ProviderRoutingLogEntry {
  eventType: "provider_routing.decision";
  ts: string;
  agentName: string | null;
  agentRole: string | null;
  taskRiskClass: TaskRiskClass;
  providerConfidence: ProviderConfidence;
  trigger: string;
  eligible: boolean;
  reason: string;
  stage: number;
  dryRun: boolean;
  precedenceLevel: number;
  precedenceLabel: string;
  fallbackProviderId: string | null;
}

export function buildRoutingLogEntry(
  decision: RoutingDecision,
  agent: { name?: string | null; role?: string | null },
): ProviderRoutingLogEntry {
  return {
    eventType: "provider_routing.decision",
    ts: new Date().toISOString(),
    agentName: agent.name ?? null,
    agentRole: agent.role ?? null,
    taskRiskClass: decision.taskRiskClass,
    providerConfidence: decision.providerConfidence,
    trigger: decision.decision.trigger,
    eligible: decision.decision.eligible,
    reason: decision.decision.reason,
    stage: decision.decision.stage,
    dryRun: decision.decision.dryRun,
    precedenceLevel: decision.decision.precedenceLevel,
    precedenceLabel: decision.decision.precedenceLabel,
    fallbackProviderId: decision.fallbackProvider?.id ?? null,
  };
}
