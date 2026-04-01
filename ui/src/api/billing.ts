import { api } from "./client";

export type PlanTier = "trial" | "starter" | "growth" | "business";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "incomplete";

export interface PlanDefinition {
  productId: string | undefined;
  projects: number; // -1 = unlimited
  storageGB: number;
  companies: number;
  playbookRuns: number; // -1 = unlimited
  kbPages: number; // -1 = unlimited
  priceMonthly: number; // cents
  label: string;
}

export interface SubscriptionRecord {
  id: string;
  companyId: string;
  polarCustomerId: string | null;
  polarSubscriptionId: string | null;
  planTier: PlanTier;
  status: SubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionResponse {
  subscription: SubscriptionRecord;
  plan: PlanDefinition;
  usage: {
    projects: number;
    storageBytes: number;
  };
}

export const billingApi = {
  getSubscription: (companyId: string) =>
    api.get<SubscriptionResponse>(`/companies/${companyId}/billing/subscription`),

  createCheckoutSession: (
    companyId: string,
    planTier: string,
    successUrl: string,
    cancelUrl: string,
  ) =>
    api.post<{ url: string }>(`/companies/${companyId}/billing/checkout`, {
      planTier,
      successUrl,
      cancelUrl,
    }),

  createPortalSession: (companyId: string, returnUrl: string) =>
    api.post<{ url: string }>(`/companies/${companyId}/billing/portal`, {
      returnUrl,
    }),
};
