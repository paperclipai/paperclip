import type { ModelProfileKey } from "@paperclipai/shared";
import { api } from "./client";

/** Mirrors server/src/services/model-policy.ts `ModelPolicyMatch`. An omitted
 *  key imposes no constraint; an empty `when` (no keys) matches every task. */
export interface ModelPolicyMatch {
  agentRole?: string[];
  wakeReason?: string[];
  issuePriority?: string[];
  workMode?: string[];
}

/** Mirrors server/src/services/model-policy.ts `ModelPolicyRule`. */
export interface ModelPolicyRule {
  when: ModelPolicyMatch;
  modelProfile: ModelProfileKey;
  reason?: string;
}

export interface CompanyModelPolicyResponse {
  rules: ModelPolicyRule[];
}

export const modelPoliciesApi = {
  get: (companyId: string) =>
    api.get<CompanyModelPolicyResponse>(
      `/companies/${encodeURIComponent(companyId)}/model-policies`,
    ),
  save: (companyId: string, rules: ModelPolicyRule[]) =>
    api.put<CompanyModelPolicyResponse>(
      `/companies/${encodeURIComponent(companyId)}/model-policies`,
      { rules },
    ),
};
