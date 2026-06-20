import type { AgentRole, ModelProfileKey } from "@paperclipai/shared";

/** Signals available at dispatch time. All optional except agentRole. */
export interface PolicySignals {
  agentRole: AgentRole;
  wakeReason?: string;
  issuePriority?: string;
  workMode?: string;
}

/** Constraints for a single rule. A constraint is satisfied when the
 * corresponding signal is present AND its value is in the constraint's list.
 * An omitted constraint imposes no requirement. An empty `when` matches all. */
export interface ModelPolicyMatch {
  agentRole?: AgentRole[];
  wakeReason?: string[];
  issuePriority?: string[];
  workMode?: string[];
}

export interface ModelPolicyRule {
  when: ModelPolicyMatch;
  modelProfile: ModelProfileKey;
  reason?: string;
}

export interface ModelPolicyDecision {
  modelProfile: ModelProfileKey | null;
  reason: string;
}

function constraintSatisfied(
  allowed: string[] | undefined,
  signal: string | undefined,
): boolean {
  if (allowed === undefined) return true; // no requirement
  if (signal === undefined) return false; // required but signal missing
  return allowed.includes(signal);
}

function matchesRule(when: ModelPolicyMatch, signals: PolicySignals): boolean {
  return (
    constraintSatisfied(when.agentRole, signals.agentRole) &&
    constraintSatisfied(when.wakeReason, signals.wakeReason) &&
    constraintSatisfied(when.issuePriority, signals.issuePriority) &&
    constraintSatisfied(when.workMode, signals.workMode)
  );
}

/** First-match wins. Returns a null decision when no rule matches. */
export function resolveModelPolicy(
  rules: ModelPolicyRule[],
  signals: PolicySignals,
): ModelPolicyDecision {
  for (const rule of rules) {
    if (matchesRule(rule.when, signals)) {
      return {
        modelProfile: rule.modelProfile,
        reason: rule.reason ?? `matched policy rule for profile ${rule.modelProfile}`,
      };
    }
  }
  return { modelProfile: null, reason: "no_policy_match" };
}
