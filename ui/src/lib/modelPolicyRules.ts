import type { ModelProfileKey } from "@paperclipai/shared";
import type { ModelPolicyMatch, ModelPolicyRule } from "../api/modelPolicies";

export const SIGNAL_KEYS = ["agentRole", "wakeReason", "issuePriority", "workMode"] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

export function emptyRule(defaultProfile: ModelProfileKey): ModelPolicyRule {
  return { when: {}, modelProfile: defaultProfile };
}

export function addRule(rules: ModelPolicyRule[], rule: ModelPolicyRule): ModelPolicyRule[] {
  return [...rules, rule];
}

export function removeRule(rules: ModelPolicyRule[], index: number): ModelPolicyRule[] {
  return rules.filter((_, i) => i !== index);
}

export function updateRule(
  rules: ModelPolicyRule[],
  index: number,
  next: ModelPolicyRule,
): ModelPolicyRule[] {
  return rules.map((rule, i) => (i === index ? next : rule));
}

export function moveRule(
  rules: ModelPolicyRule[],
  index: number,
  dir: "up" | "down",
): ModelPolicyRule[] {
  const target = index + (dir === "up" ? -1 : 1);
  if (target < 0 || target >= rules.length) return rules;
  const copy = rules.slice();
  const tmp = copy[index];
  copy[index] = copy[target];
  copy[target] = tmp;
  return copy;
}

export function setSignal(
  rule: ModelPolicyRule,
  key: SignalKey,
  values: string[],
): ModelPolicyRule {
  const when: ModelPolicyMatch = { ...rule.when };
  if (values.length === 0) {
    delete when[key];
  } else {
    when[key] = values;
  }
  return { ...rule, when };
}

/** Rebuild each rule's `when` with keys in SIGNAL_KEYS order, dropping empty
 *  arrays, and omit an undefined `reason`. Produces a canonical form for
 *  equality checks and for the save payload. */
export function normalizeRules(rules: ModelPolicyRule[]): ModelPolicyRule[] {
  return rules.map((rule) => {
    const when: ModelPolicyMatch = {};
    for (const key of SIGNAL_KEYS) {
      const value = rule.when[key];
      if (value && value.length > 0) {
        when[key] = [...value];
      }
    }
    const normalized: ModelPolicyRule = { when, modelProfile: rule.modelProfile };
    if (rule.reason && rule.reason.trim().length > 0) {
      normalized.reason = rule.reason;
    }
    return normalized;
  });
}

export function isDirty(a: ModelPolicyRule[], b: ModelPolicyRule[]): boolean {
  return JSON.stringify(normalizeRules(a)) !== JSON.stringify(normalizeRules(b));
}
