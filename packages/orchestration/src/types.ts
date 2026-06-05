/** LLM orchestration core — public types.
 *
 *  Source of truth for the routing layer. The router is tenant-agnostic: the
 *  routing grid itself (which task types map to which engines) is supplied by
 *  the caller via `RouterDependencies.policy`. This module only defines the
 *  shared vocabulary (engines, complexity, sensitivity) and the decision /
 *  telemetry shapes.
 */

import type { AgentPolicy } from './policy.js';

/** Vendor + product tier combination. Tier 1 = subscription, Tier 2 = API automation. */
export type Engine = 'claude' | 'chatgpt' | 'gemini' | 'perplexity' | 'api';

/** Coarse role label attached to a routing decision for telemetry / dashboards. */
export type EngineRole =
  | 'reasoning' // senior strategic reasoning
  | 'orchestration' // operational + creative + multimodal + agent coordination
  | 'document' // long-context, knowledge base, multi-doc compare
  | 'research' // web research, monitoring, sourcing
  | 'automation'; // Tier 2 — autonomous machine-to-machine

/** Complexity classes, cheapest → most capable. */
export type ComplexityClass = 'simple' | 'medium' | 'complex' | 'critical';

export const COMPLEXITY_RANK: Record<ComplexityClass, number> = {
  simple: 0,
  medium: 1,
  complex: 2,
  critical: 3,
};

/** Sensitivity = blast radius of the output; drives second-pass / sign-off gates. */
export type Sensitivity = 'internal' | 'outbound' | 'regulatory' | 'critical';

export type TierLevel = 1 | 2 | 3;

/** Task taxonomy is tenant-defined. The core treats task types as opaque ids;
 *  the supplied `policy` table is the authority on which ids are valid and how
 *  they route. See `example-policy.ts` for a reference table. */
export type TaskType = string;

/** Caller-supplied descriptor. Only `task_type` + `sensitivity` are required;
 *  other fields tighten the routing decision. */
export interface TaskDescriptor {
  task_type: TaskType;
  sensitivity: Sensitivity;
  /** Override / hint for complexity. If absent, router infers from the policy rule default + sensitivity floor. */
  expected_complexity?: ComplexityClass;
  /** Set to `true` ONLY for cron / webhook / M2M automation. Required to unlock Tier 2. */
  automation?: boolean;
  /** Best estimate of input tokens. Drives long-context promotion (>200k). */
  estimated_input_tokens?: number;
  /** True if input mixes images / audio / video. Biases towards ChatGPT/Gemini. */
  requires_multimodal?: boolean;
  /** Free-form context for telemetry only — never used by router logic. */
  agent_id?: string;
  call_id?: string;
  /** Soft routing preferences attached by the calling agent's config layer.
   *  Router uses these as tie-breakers — hard constraints (Tier, sensitivity,
   *  long-context, multimodal) always win. See `AgentPolicy` in policy.ts. */
  agent_policy?: AgentPolicy;
}

/** Selected model within an engine, with cost/capability metadata. */
export interface ModelSelection {
  engine: Engine;
  model: string;
  /** Tier 1 = subscription, Tier 2 = API. */
  tier: TierLevel;
  /** Maximum input tokens this model accepts (effective context window). */
  max_input_tokens: number;
  /** Whether this model accepts non-text inputs. */
  multimodal: boolean;
}

/** Outcome of `route(taskDescriptor)`. */
export interface RoutingDecision {
  engine: Engine;
  model: string;
  role: EngineRole;
  complexity_class: ComplexityClass;
  /** 0..1; how well the engine role matches the task. 1.0 = primary engine for that policy row. */
  role_match_score: number;
  /** Estimated cost in EUR cents for the planned call (input tokens × price). 0 if unknown. */
  estimated_cost_eur_cents: number;
  /** 0..1; aggregate confidence in this routing. Penalised by missing fields, fallbacks, sensitivity. */
  confidence: number;
  /** Human-readable reasons. First entry is the primary justification. */
  justification: string[];
  /** Required for `outbound|regulatory|critical` — the cross-vendor second-pass model. */
  fallback?: ModelSelection;
  /** Tier this routing landed in. */
  tier: TierLevel;
  /** True when sign-off is required (e.g. complexity=critical OR sensitivity=critical/regulatory). */
  human_sign_off_required: boolean;
}

/** Per-call telemetry contract. Dashboard and self-learning consumers read this schema.
 *
 *  Schema versioning: bump TELEMETRY_SCHEMA_VERSION when fields are added or
 *  semantics change so downstream consumers can detect drift. New fields land
 *  as optional to preserve back-compat with already-emitted events. */
export interface TelemetryEvent {
  call_id: string;
  /** ISO-8601 timestamp. */
  ts: string;
  agent_id?: string;
  task_type: TaskType;
  /** Sensitivity tier of the input — drives dashboard filter + second-pass gate. */
  sensitivity?: Sensitivity;
  engine: Engine;
  model: string;
  role: EngineRole;
  /** Tier 1 = subscription, Tier 2 = API. Dashboard filter / Tier escalation audit. */
  tier?: TierLevel;
  complexity_class: ComplexityClass;
  /** Caller's best estimate of input tokens — drives context-window utilization analytics. */
  estimated_input_tokens?: number;
  /** EUR cents — copied from RoutingDecision at decision time. */
  expected_cost_eur_cents: number;
  /** EUR cents — populated by caller after the LLM call resolves. */
  actual_cost_eur_cents?: number;
  latency_ms?: number;
  confidence: number;
  /** 0..1; how well the engine role matches the task. From RoutingDecision.role_match_score. */
  role_match_score?: number;
  /** Human-readable router justification (first entry is primary reason). Drill-down. */
  justification?: string[];
  /** True iff sensitivity/complexity required a human sign-off marker. */
  human_sign_off_required?: boolean;
  /** Primary call vs cross-vendor second pass (red-team) marker. */
  pass_role?: 'primary' | 'redteam';
  /** Links second-pass / sign-off telemetry back to the primary call. */
  parent_call_id?: string;
  /** Count of findings produced by the second pass. */
  red_team_finding_count?: number;
  /** True when at least one second-pass finding has `severity=block`. */
  has_blocking_findings?: boolean;
  /** Why the second pass was skipped in degraded mode. */
  critical_pass_skipped_reason?: 'tier1_latency_cap';
  /** Sign-off gate outcome (phase 1 telemetry-only stamp). */
  sign_off_outcome?: 'requested' | 'skipped';
  outcome_signal?: 'success' | 'retry' | 'failure';
  failure_class?: 'model' | 'infra' | 'orchestration';
  /** Process exit code captured by the runner — `143` = SIGTERM/OOM. */
  exit_code?: number;
  /** Free-form sub-class (e.g. `adapter_timeout`, `oom`, `retry_storm`). */
  failure_subtype?: string;
  /** Document type for document-engine analytics breakdown. */
  document_type?:
    | 'pdf'
    | 'sheets'
    | 'docs'
    | 'workspace'
    | 'transcript'
    | 'multi_doc'
    | 'other';
  /** Set when sensitivity required a second-pass gate. */
  fallback_engine?: Engine;
  fallback_model?: string;
  /** Schema version stamp — see TELEMETRY_SCHEMA_VERSION. */
  schema_version?: string;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void | Promise<void>;
}

/** Inputs to the router beyond the descriptor — injected for testability and
 *  tenant configuration. */
export interface RouterDependencies {
  /** Tenant-injected routing grid. Core ships an empty default (see
   *  `DEFAULT_POLICY`); the tenant supplies its own rules at runtime. A
   *  reference table lives in `example-policy.ts`. */
  policy?: ReadonlyArray<import('./policy.js').RoutingRule>;
  /** Signals whether Gemini Advanced subscription is reachable for the current run. */
  geminiAvailable?: boolean;
}

/** Telemetry schema stamp — bump on any non-additive change to TelemetryEvent. */
export const TELEMETRY_SCHEMA_VERSION = '1.1.0' as const;

/** Long-context cutover (>200k tokens biases toward a document/long-context engine). */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000 as const;
