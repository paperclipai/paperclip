export interface ProviderRateLimitBlock {
  id: string;
  companyId: string;
  adapterType: string;
  limitKind: string;
  modelFamily: string | null;
  message: string | null;
  resetsAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}
