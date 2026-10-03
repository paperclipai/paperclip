import type { ImportProviderCosts, AccountingHealth, AccountingInspection, AdjustCost, BillingInvoice, BillingReconciliation, CostAdjustment, ImportBillingInvoice } from "@paperclipai/shared";
import { api } from "./client";
export const accountingApi = {
  importProviderCosts: (company: string, input: ImportProviderCosts) => api.post<{ daysRead: number; eventsCreated: number }>(`/companies/${company}/accounting/provider-costs/import`, input),
  health: (company: string) => api.get<AccountingHealth>(`/companies/${company}/accounting/health`),
  inspect: (company: string) => api.get<AccountingInspection>(`/companies/${company}/accounting/inspect`),
  repair: (company: string, fingerprint: string, reason: string) => api.post<AccountingInspection>(`/companies/${company}/accounting/repair`, { fingerprint, reason }),
  retry: (company: string, runId: string) => api.post<{ accounted: boolean }>(`/companies/${company}/accounting/retry`, { runId }),
  invoices: (company: string) => api.get<BillingInvoice[]>(`/companies/${company}/accounting/invoices`),
  importInvoice: (company: string, invoice: ImportBillingInvoice) => api.post<BillingInvoice>(`/companies/${company}/accounting/invoices`, invoice),
  reconcile: (company: string, invoiceId: string) => api.get<BillingReconciliation>(`/companies/${company}/accounting/invoices/${invoiceId}`),
  adjustments: (company: string, eventId: string) => api.get<CostAdjustment[]>(`/companies/${company}/accounting/events/${eventId}/adjustments`),
  adjust: (company: string, eventId: string, adjustment: AdjustCost) => api.post<CostAdjustment>(`/companies/${company}/accounting/events/${eventId}/adjustments`, adjustment),
};
