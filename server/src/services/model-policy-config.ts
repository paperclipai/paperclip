import type { ModelPolicyRule } from "./model-policy.ts";

export type CompanyModelPolicies = Record<string, ModelPolicyRule[]>;

/** Parse the PAPERCLIP_MODEL_POLICIES env var (a JSON object mapping
 * companyId -> ModelPolicyRule[]). Returns {} on undefined or malformed input;
 * never throws — a bad config must not break dispatch. */
export function parseModelPolicies(raw: string | undefined): CompanyModelPolicies {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: CompanyModelPolicies = {};
    for (const [companyId, rules] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(rules)) {
        result[companyId] = rules as ModelPolicyRule[];
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function selectCompanyModelPolicy(
  policies: CompanyModelPolicies,
  companyId: string,
): ModelPolicyRule[] {
  return policies[companyId] ?? [];
}

let cached: CompanyModelPolicies | null = null;

/** Process-lifetime lookup using the PAPERCLIP_MODEL_POLICIES env var.
 * Parsed once and cached. */
export function getCompanyModelPolicy(companyId: string): ModelPolicyRule[] {
  if (cached === null) {
    cached = parseModelPolicies(process.env.PAPERCLIP_MODEL_POLICIES);
  }
  return selectCompanyModelPolicy(cached, companyId);
}

/** Test-only: clear the process-lifetime cache. */
export function resetModelPolicyCacheForTests(): void {
  cached = null;
}
