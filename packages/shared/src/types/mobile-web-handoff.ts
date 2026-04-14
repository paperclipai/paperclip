export type MobileWebHandoffTarget = "onboarding" | "agent_configuration";

export interface CreateMobileWebHandoffRequest {
  target: MobileWebHandoffTarget;
  companyId?: string;
  agentId?: string;
  returnUrl?: string;
}

export interface MobileWebHandoffResponse {
  url: string;
  expiresAt: string;
}
