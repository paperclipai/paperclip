/** Routing policy contracts.
 *
 *  The routing grid (which task types map to which engines) is *tenant-injected*:
 *  the core ships an empty `DEFAULT_POLICY` and the caller supplies a
 *  `RoutingRule[]` via `RouterDependencies.policy`. This keeps the core
 *  tenant-agnostic — no organisation-specific routing rows live here.
 *
 *  The safety edges below (sensitivity → complexity floor, second-pass gate,
 *  sign-off gate) are domain-neutral and ship as defaults, since they encode
 *  blast-radius semantics rather than any specific routing preference.
 */

import { COMPLEXITY_RANK } from './types.js';
import type {
  ComplexityClass,
  Engine,
  EngineRole,
  Sensitivity,
  TaskType,
  TierLevel,
} from './types.js';

/** Agent-level routing preferences attached to a `TaskDescriptor`.
 *
 *  Soft signals only — the router treats these as tie-breakers. Hard
 *  constraints (Tier 2 unlock, sensitivity floor, long-context promotion,
 *  multimodal pivot) always win. See `route()` for the resolution order. */
export interface AgentPolicy {
  /** Caller-attached complexity hint. Folded into complexity resolution after
   *  `descriptor.expected_complexity` if the descriptor itself didn't pin a
   *  value. Mapped into `ComplexityClass` via `agentPolicyComplexityToClass`. */
  expectedComplexity?: AgentPolicyComplexityHint;
  /** Caller-preferred engine. Honored only when it equals the routing rule's
   *  declared `secondary` for this task type — otherwise silently ignored to
   *  preserve the routing-grid contract. `null` is treated identically to
   *  omitting the field; explicit nulling is allowed so config layers can
   *  unset a previously-configured preference without dropping the key. */
  preferredEngine?: Engine | null;
}

/** Coarser complexity vocabulary used in agent config UIs. We translate to
 *  `ComplexityClass` (the policy-grid-native union) inside the router. */
export type AgentPolicyComplexityHint = 'low' | 'medium' | 'high';

const AGENT_POLICY_COMPLEXITY_TO_CLASS: Record<AgentPolicyComplexityHint, ComplexityClass> = {
  low: 'simple',
  medium: 'medium',
  high: 'complex',
};

/** Lift the agent-config complexity hint into the native `ComplexityClass`.
 *  `critical` cannot be requested from agent config — it is reserved for the
 *  sensitivity floor in `SENSITIVITY_COMPLEXITY_FLOOR`. */
export function agentPolicyComplexityToClass(
  hint: AgentPolicyComplexityHint,
): ComplexityClass {
  return AGENT_POLICY_COMPLEXITY_TO_CLASS[hint];
}

/** A single row of the tenant routing grid. */
export interface RoutingRule {
  task_type: TaskType;
  /** Primary engine choice when this rule matches. */
  primary: Engine;
  /** Optional cross-vendor second-pass / red-team for Complex+/outbound flows. */
  secondary?: Engine;
  /** Engine role label attached to telemetry. */
  role: EngineRole;
  /** Default complexity inferred for this row when caller omits expected_complexity. */
  default_complexity: ComplexityClass;
  /** Tier this rule lives in. Tier 2 (API) requires automation=true to unlock. */
  tier: TierLevel;
  /** Free-form annotation surfaced as the primary justification line. */
  rationale: string;
}

/** Core default policy: empty. Tenants inject their routing grid at runtime via
 *  `RouterDependencies.policy`. See `example-policy.ts` for a reference table. */
export const DEFAULT_POLICY: ReadonlyArray<RoutingRule> = [];

const POLICY_INDEX_CACHE = new WeakMap<
  ReadonlyArray<RoutingRule>,
  ReadonlyMap<TaskType, RoutingRule>
>();

/** Build a task_type → rule lookup from a policy table. Later rows win on
 *  duplicate task_type so tenants can layer overrides. */
export function buildRuleIndex(
  policy: ReadonlyArray<RoutingRule>,
): ReadonlyMap<TaskType, RoutingRule> {
  const index = new Map<TaskType, RoutingRule>();
  for (const rule of policy) {
    index.set(rule.task_type, rule);
  }
  return index;
}

/** Resolve a single routing rule from a policy table. Throws when the task type
 *  is not present — an empty/missing policy is a configuration error, not a
 *  caller-input error. */
export function getRoutingRule(
  taskType: TaskType,
  policy: ReadonlyArray<RoutingRule>,
): RoutingRule {
  let index = POLICY_INDEX_CACHE.get(policy);
  if (!index) {
    index = buildRuleIndex(policy);
    POLICY_INDEX_CACHE.set(policy, index);
  }
  const rule = index.get(taskType);
  if (!rule) {
    throw new Error(
      `No routing rule for task_type=${String(taskType)} in the active policy ` +
        `(${policy.length} rule(s)). Inject a policy via RouterDependencies.policy.`,
    );
  }
  return rule;
}

/** Sensitivity → minimum complexity floor.
 *
 *  Blast-radius bias: anything leaving the firm or touching regulated/critical
 *  surfaces defaults to a higher complexity tier + second-pass. */
export const SENSITIVITY_COMPLEXITY_FLOOR: Record<Sensitivity, ComplexityClass> = {
  internal: 'simple',
  outbound: 'complex',
  regulatory: 'critical',
  critical: 'critical',
};

export function maxComplexity(a: ComplexityClass, b: ComplexityClass): ComplexityClass {
  return COMPLEXITY_RANK[a] >= COMPLEXITY_RANK[b] ? a : b;
}

/** True when the sensitivity gate fires (outbound/regulatory/critical, or any
 *  complex/critical task). */
export function requiresSecondPass(
  sensitivity: Sensitivity,
  complexity: ComplexityClass,
): boolean {
  if (sensitivity === 'outbound' || sensitivity === 'regulatory' || sensitivity === 'critical') {
    return true;
  }
  return complexity === 'complex' || complexity === 'critical';
}

/** True when human sign-off is mandatory (regulatory/critical sensitivity, or a
 *  critical-complexity task). */
export function requiresHumanSignOff(
  sensitivity: Sensitivity,
  complexity: ComplexityClass,
): boolean {
  if (sensitivity === 'regulatory' || sensitivity === 'critical') return true;
  return complexity === 'critical';
}
