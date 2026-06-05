/** Pure router: TaskDescriptor → RoutingDecision.
 *
 *  Resolves a routing rule from the tenant-injected policy table, applies the
 *  complexity floor / second-pass / sign-off edges, and selects the cheapest
 *  model that satisfies complexity + context size + multimodal.
 *
 *  Design notes:
 *    - No I/O, no clock dependency beyond the optional `geminiAvailable`
 *      injection. Telemetry emit is the caller's choice — the router stays
 *      synchronous and side-effect-free for testability.
 *    - The routing grid lives in `deps.policy` (tenant-supplied). Core ships an
 *      empty `DEFAULT_POLICY`; an unknown task_type is a configuration error.
 *    - Tier 2 (API) selection requires `automation=true`. Otherwise the router
 *      fails fast to a policy-violation error.
 */

import { RouterConfigError, RouterPolicyViolationError } from './errors.js';
import {
  describeGeminiContextWindow,
  geminiRequiresClaudeReasoningPass,
  isGeminiAvailable,
  shouldPromoteToGeminiLongContext,
} from './gemini.js';
import { selectModel } from './models.js';
import {
  agentPolicyComplexityToClass,
  DEFAULT_POLICY,
  getRoutingRule,
  maxComplexity,
  requiresHumanSignOff,
  requiresSecondPass,
  SENSITIVITY_COMPLEXITY_FLOOR,
} from './policy.js';
import { estimateInputCost } from './pricing.js';
import type {
  ComplexityClass,
  Engine,
  ModelSelection,
  RouterDependencies,
  RoutingDecision,
  TaskDescriptor,
} from './types.js';

/** Engines that carry a Tier 1 reasoning role for second-pass purposes. */
const REASONING_FALLBACK_ORDER: Engine[] = ['claude', 'chatgpt', 'gemini'];

export function route(
  descriptor: TaskDescriptor,
  deps: RouterDependencies = {},
): RoutingDecision {
  const rule = getRoutingRule(descriptor.task_type, deps.policy ?? DEFAULT_POLICY);

  // 1. Resolve effective complexity (caller hint vs. sensitivity floor vs. rule default).
  const complexity = resolveComplexity(descriptor, rule.default_complexity);

  // 2. Tier escalation guard: Tier 2 only with automation=true.
  if (rule.tier === 2 && !descriptor.automation) {
    throw new RouterPolicyViolationError(
      `task_type=${descriptor.task_type} routes to Tier 2 (API) but automation flag is not set. ` +
        `Set automation=true for cron/webhook/M2M flows, otherwise pick a Tier 1 task_type.`,
    );
  }

  // 3. Engine selection.
  const justification: string[] = [rule.rationale];
  let engine: Engine = rule.primary;
  let role = rule.role;
  let roleMatchScore = 1.0;
  // After long-context promotion the rule's declared secondary may be wrong, so
  // track an override for the second-pass engine.
  let secondPassOverride: Engine | undefined;

  // 3a. Agent policy preferredEngine — soft tie-breaker.
  // Honored only when it equals the rule's declared secondary (swap
  // primary↔secondary). Anything else is silently ignored — keeps the policy
  // grid as the single source of truth for engine eligibility.
  const preferredEngine = descriptor.agent_policy?.preferredEngine ?? null;
  if (preferredEngine && preferredEngine !== engine) {
    if (rule.secondary && preferredEngine === rule.secondary) {
      justification.push(
        `Agent policy preferredEngine=${preferredEngine} matches rule secondary → swapping primary↔secondary as soft tie-breaker.`,
      );
      engine = preferredEngine;
      secondPassOverride = rule.primary;
      roleMatchScore = 0.9;
    } else {
      justification.push(
        `Agent policy preferredEngine=${preferredEngine} ignored — incompatible with task_type=${descriptor.task_type} (allowed engines: ${rule.primary}${rule.secondary ? `/${rule.secondary}` : ''}).`,
      );
    }
  }

  // Long-context promotion to a document engine.
  if (
    shouldPromoteToGeminiLongContext(descriptor.estimated_input_tokens) &&
    engine !== 'gemini' &&
    rule.tier === 1 &&
    engine !== 'perplexity' // research engine never gets promoted
  ) {
    const geminiOk = deps.geminiAvailable ?? isGeminiAvailable();
    if (geminiOk) {
      justification.push(
        `Long-context promotion: estimated ${descriptor.estimated_input_tokens} tokens > 200k threshold → document-engine ingestion + reasoning pass.`,
      );
      engine = 'gemini';
      role = 'document';
      roleMatchScore = 0.85; // demoted from 1.0 — promotion is a sensitivity override, not a perfect role match
      secondPassOverride = 'claude';
    } else {
      justification.push(
        'Long-context task detected but the long-context subscription is unavailable; staying on primary engine and warning caller.',
      );
      roleMatchScore = 0.7;
    }
  }

  // 4. Multimodal nudge.
  if (descriptor.requires_multimodal && engine === 'claude') {
    justification.push(
      'Multimodal input requested → biased away from Claude towards ChatGPT.',
    );
    engine = 'chatgpt';
    role = 'orchestration';
    roleMatchScore = 0.8;
  }

  // 5. Pick the cheapest model that satisfies complexity + context size + multimodal.
  const primaryModel = selectModel(engine, complexity, {
    estimated_input_tokens: descriptor.estimated_input_tokens,
    requires_multimodal: descriptor.requires_multimodal,
  });
  if (!primaryModel) {
    throw new RouterConfigError(
      `No model in catalog for engine=${engine} complexity=${complexity} ` +
        `tokens=${descriptor.estimated_input_tokens ?? '?'} multimodal=${Boolean(descriptor.requires_multimodal)}`,
    );
  }

  // 6. Second-pass / fallback.
  let fallback: ModelSelection | undefined;
  if (requiresSecondPass(descriptor.sensitivity, complexity)) {
    const secondary = secondPassOverride ?? rule.secondary;
    fallback = pickSecondPassModel(engine, secondary, complexity, descriptor);
    if (!fallback) {
      // For outbound/regulatory/critical we MUST have a configured cross-vendor pass.
      if (
        descriptor.sensitivity === 'outbound' ||
        descriptor.sensitivity === 'regulatory' ||
        descriptor.sensitivity === 'critical'
      ) {
        throw new RouterPolicyViolationError(
          `Sensitivity=${descriptor.sensitivity} requires a cross-vendor second-pass model but none could be resolved (primary engine=${engine}, secondary=${rule.secondary ?? 'none'}).`,
        );
      }
    } else {
      justification.push(
        `Second-pass gate (sensitivity=${descriptor.sensitivity}, complexity=${complexity}) → ${fallback.engine}/${fallback.model}.`,
      );
    }
  }

  // 7. Document-engine reinforcement: Gemini primary + outbound-class sensitivity → reasoning pass.
  if (engine === 'gemini' && geminiRequiresClaudeReasoningPass(descriptor.sensitivity) && !fallback) {
    // Reasoning pass operates on the document engine's summary/output, not raw input — no token cap.
    const claudePass = selectModel('claude', maxComplexity(complexity, 'complex'));
    if (claudePass) {
      fallback = claudePass;
      justification.push(
        `Document-engine primary + sensitivity=${descriptor.sensitivity} → mandatory reasoning-pass marker.`,
      );
    }
  }

  // 8. Sign-off marker.
  const humanSignOff = requiresHumanSignOff(descriptor.sensitivity, complexity);
  if (humanSignOff) {
    justification.push('Human sign-off required (critical complexity or regulatory/critical sensitivity).');
  }

  // 9. Confidence: 1.0 base, penalised for missing inputs / long-context fallback / multimodal pivot.
  const confidence = computeConfidence({
    descriptor,
    roleMatchScore,
    hasFallback: Boolean(fallback),
  });

  // 10. Estimated cost — primary call only (caller adds fallback cost when invoking second pass).
  const estimatedCost = estimateInputCost(primaryModel.model, descriptor.estimated_input_tokens);

  // 11. Document-engine context-window report appended to justification when relevant.
  if (engine === 'gemini' && descriptor.estimated_input_tokens) {
    const report = describeGeminiContextWindow(
      descriptor.estimated_input_tokens,
      primaryModel.max_input_tokens,
    );
    justification.push(
      `Document-engine context window: ${descriptor.estimated_input_tokens}/${report.max_input_tokens} tokens (${(report.utilization * 100).toFixed(1)}% utilization).`,
    );
    if (report.exceeds_window) {
      justification.push(
        'WARNING: estimated input exceeds the document-engine context window — caller must chunk or escalate.',
      );
    }
  }

  return {
    engine: primaryModel.engine,
    model: primaryModel.model,
    role,
    complexity_class: complexity,
    role_match_score: roleMatchScore,
    estimated_cost_eur_cents: estimatedCost,
    confidence,
    justification,
    fallback,
    tier: primaryModel.tier,
    human_sign_off_required: humanSignOff,
  };
}

function resolveComplexity(
  descriptor: TaskDescriptor,
  ruleDefault: ComplexityClass,
): ComplexityClass {
  const floor = SENSITIVITY_COMPLEXITY_FLOOR[descriptor.sensitivity];
  const agentHint = descriptor.agent_policy?.expectedComplexity;
  const requested =
    descriptor.expected_complexity ??
    (agentHint ? agentPolicyComplexityToClass(agentHint) : undefined) ??
    ruleDefault;
  return maxComplexity(requested, floor);
}

function pickSecondPassModel(
  primaryEngine: Engine,
  secondary: Engine | undefined,
  complexity: ComplexityClass,
  _descriptor: TaskDescriptor,
): ModelSelection | undefined {
  // Second-pass models read a summary / draft from the primary, not the raw
  // descriptor input — so we deliberately do NOT filter by
  // `estimated_input_tokens` here. Otherwise long-context promotion (>200k)
  // would have nowhere to land its cross-vendor pass.
  if (secondary && secondary !== primaryEngine) {
    const m = selectModel(secondary, maxComplexity(complexity, 'complex'));
    if (m) return m;
  }
  for (const candidate of REASONING_FALLBACK_ORDER) {
    if (candidate === primaryEngine) continue;
    const m = selectModel(candidate, maxComplexity(complexity, 'complex'));
    if (m) return m;
  }
  return undefined;
}

function computeConfidence(args: {
  descriptor: TaskDescriptor;
  roleMatchScore: number;
  hasFallback: boolean;
}): number {
  const { descriptor, roleMatchScore, hasFallback } = args;
  let conf = roleMatchScore;
  if (descriptor.estimated_input_tokens === undefined) conf -= 0.05;
  if (descriptor.expected_complexity === undefined) conf -= 0.05;
  if (
    (descriptor.sensitivity === 'outbound' ||
      descriptor.sensitivity === 'regulatory' ||
      descriptor.sensitivity === 'critical') &&
    !hasFallback
  ) {
    conf -= 0.2;
  }
  return Math.max(0, Math.min(1, Number(conf.toFixed(2))));
}
