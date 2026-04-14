export type CompanyReadinessReason = "missing_secrets" | "no_agents_configured";

export interface CompanyReadiness {
  companyId: string;
  status: "ready" | "not_ready";
  reasons: CompanyReadinessReason[];
  webSetupUrl: string;
}
