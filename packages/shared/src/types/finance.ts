import type { AgentAdapterType, FinanceDirection, FinanceEventKind, FinanceUnit } from "../constants.js";

export interface FinanceEvent {
  id: string;
  companyId: string;
  agentId: string | null;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  costEventId: string | null;
  billingCode: string | null;
  description: string | null;
  eventKind: FinanceEventKind;
  direction: FinanceDirection;
  biller: string;
  provider: string | null;
  executionAdapterType: AgentAdapterType | null;
  pricingTier: string | null;
  region: string | null;
  model: string | null;
  quantity: number | null;
  unit: FinanceUnit | null;
  amountCents: number;
  amountCentsExact?: string;
  currency: string;
  estimated: boolean;
  externalInvoiceId: string | null;
  idempotencyKey: string | null;
  metadataJson: Record<string, unknown> | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface FinanceCurrencySummary {
  currency: string;
  providerReportedCentsExact?: string;
  debitCents: number;
  debitCentsExact?: string;
  creditCents: number;
  creditCentsExact?: string;
  netCents: number;
  netCentsExact?: string;
  estimatedDebitCents: number;
  estimatedDebitCentsExact?: string;
  eventCount: number;
}

export interface FinanceSummary {
  /** Provider cost reports overlap invoices and run estimates; never add these totals. */
  providerReportedCents?: number;
  providerReportedCentsExact?: string;
  /** Compatibility totals below are USD only; no implicit currency conversion. */
  currency: "USD";
  currencies: FinanceCurrencySummary[];
  companyId: string;
  debitCents: number;
  debitCentsExact?: string;
  creditCents: number;
  creditCentsExact?: string;
  netCents: number;
  netCentsExact?: string;
  estimatedDebitCents: number;
  estimatedDebitCentsExact?: string;
  eventCount: number;
}

export interface FinanceByBiller {
  currency: string;
  biller: string;
  debitCents: number;
  debitCentsExact?: string;
  creditCents: number;
  creditCentsExact?: string;
  netCents: number;
  netCentsExact?: string;
  estimatedDebitCents: number;
  estimatedDebitCentsExact?: string;
  eventCount: number;
  kindCount: number;
}

export interface FinanceByKind {
  currency: string;
  eventKind: FinanceEventKind;
  debitCents: number;
  debitCentsExact?: string;
  creditCents: number;
  creditCentsExact?: string;
  netCents: number;
  netCentsExact?: string;
  estimatedDebitCents: number;
  estimatedDebitCentsExact?: string;
  eventCount: number;
  billerCount: number;
}
