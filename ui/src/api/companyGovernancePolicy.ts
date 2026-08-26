import { api } from "./client";

export type CompanyGovernancePolicyReadback = {
  active: {
    id: string;
    revision: number;
    sha256: string;
    body: string;
    bindings: Array<Record<string, unknown>>;
    createdAt: string;
  } | null;
  history: Array<{
    id: string;
    revision: number;
    sha256: string;
    body: string;
    bindings: Array<Record<string, unknown>>;
    createdAt: string;
  }>;
  targets: Array<{
    agentId: string;
    name: string;
    role: string | null;
    adapterType: string | null;
    bindingId: string | null;
    delivery: "required" | "best_effort" | null;
    included: boolean;
  }>;
  drift: { detected: boolean; reason: "sha256_mismatch" | null } | null;
};

export const companyGovernancePolicyApi = {
  get: (companyId: string) =>
    api.get<CompanyGovernancePolicyReadback>(
      `/companies/${encodeURIComponent(companyId)}/governance-policy`,
    ),
  restore: (companyId: string, revisionId: string, expectedRevision: number) =>
    api.post<CompanyGovernancePolicyReadback["active"]>(
      `/companies/${encodeURIComponent(companyId)}/governance-policy/revisions/${encodeURIComponent(revisionId)}/restore`,
      { expectedRevision },
    ),
};
