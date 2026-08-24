import type { BillingPeriod } from "@paperclipai/shared";
import { api } from "./client";

export interface SubscriptionTier {
  id: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  stripePriceMonthlyId: string | null;
  stripePriceYearlyId: string | null;
  stripeProductId: string | null;
  includedSeats: number;
  extraSeatPriceCents: number;
  includedAgentRuns: number;
  extraAgentRunPriceCents: number;
  includedStorageGb: number;
  extraStorageGbPriceCents: number;
  features: string[];
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionUsageRow {
  id: string;
  companyId: string;
  subscriptionId: string;
  metric: "seats" | "agent_runs" | "storage_gb";
  usage: number;
  included: number;
  overage: number;
  overageCents: number;
  periodStart: string;
  periodEnd: string;
  stripeUsageRecordId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanySubscription {
  id: string;
  companyId: string;
  tierId: string;
  stripeCustomerId: string;
  status: "active" | "trialing" | "incomplete" | "past_due" | "canceled" | "unpaid" | (string & {});
  billingPeriod: BillingPeriod;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  stripeSubscriptionId: string | null;
  stripeSubscriptionItemId: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  trialEnd: string | null;
  metadataJson: string | null;
  createdAt: string;
  updatedAt: string;
  tier: SubscriptionTier | null;
  usage: SubscriptionUsageRow[];
}

export interface CheckoutSessionResult {
  url: string | null;
  sessionId: string;
}

export interface BillingOverview {
  companyId: string;
  subscription: CompanySubscription | null;
  invoices: unknown[];
  usage: SubscriptionUsageRow[];
  totalSpentCents: number;
}

export interface SubscriptionInvoice {
  id: string;
  companyId: string;
  subscriptionId: string;
  stripeInvoiceId: string;
  invoiceNumber: string | null;
  status: string;
  amountCents: number;
  amountPaidCents: number;
  amountRemainingCents: number;
  currency: string;
  invoicePdfUrl: string | null;
  hostedInvoiceUrl: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentVariantResponse {
  variant: string | null;
  enabled: boolean;
}

export const billingApi = {
  tiers: (companyId: string) =>
    api.get<SubscriptionTier[]>(`/companies/${companyId}/billing/tiers`),
  subscription: (companyId: string) =>
    api.get<CompanySubscription | null>(`/companies/${companyId}/billing/subscription`),
  createCheckoutSession: (
    companyId: string,
    body: { tierId: string; billingPeriod?: BillingPeriod; successUrl?: string; cancelUrl?: string },
  ) =>
    api.post<CheckoutSessionResult>(`/companies/${companyId}/billing/create-checkout-session`, body),
  cancelSubscription: (companyId: string) =>
    api.post<CompanySubscription>(`/companies/${companyId}/billing/subscription/cancel`),
  reactivateSubscription: (companyId: string) =>
    api.post<CompanySubscription>(`/companies/${companyId}/billing/subscription/reactivate`),
  invoices: (companyId: string) =>
    api.get<SubscriptionInvoice[]>(`/companies/${companyId}/billing/invoices`),
  overview: (companyId: string) =>
    api.get<BillingOverview>(`/companies/${companyId}/billing/overview`),
  experimentVariant: (companyId: string) =>
    api.get<ExperimentVariantResponse>(`/companies/${companyId}/billing/experiment-variant`),
};
