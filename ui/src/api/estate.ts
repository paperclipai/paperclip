import { api } from "./client";

export type AssetType =
  | "real_estate"
  | "investment"
  | "vehicle"
  | "personal_property"
  | "digital_asset"
  | "other";

export interface EstateAsset {
  id: string;
  companyId: string;
  userId: string;
  name: string;
  assetType: AssetType;
  category: string | null;
  currentValueCents: string | null;
  valuationDate: string | null;
  notes: string | null;
  estateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetBreakdownEntry {
  assetType: AssetType;
  totalDollars: string;
}

export interface FinancialAccount {
  id: string;
  name: string;
  accountType: string;
  balanceDollars: string;
  balanceUpdatedAt: string | null;
}

export interface NetWorthResult {
  netWorthDollars: string;
  netWorthCents: string;
  assetsTotalDollars: string;
  accountsTotalDollars: string;
  accounts: FinancialAccount[];
  assetBreakdown: AssetBreakdownEntry[];
}

export interface EstateItem {
  id: string;
  companyId: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export type PlanStatusCheckKey =
  | "hasWill"
  | "hasTrust"
  | "hasPOA"
  | "hasHealthcareDirective"
  | "hasInsurance"
  | "hasRetirementAccount"
  | "hasBeneficiaries"
  | "hasAnnualReview"
  | "hasDocumentVault";

export interface PlanStatusResult {
  estateId: string;
  estateName: string;
  score: number;
  completedCount: number;
  totalChecks: number;
  checks: Record<PlanStatusCheckKey, boolean>;
  completedItems: PlanStatusCheckKey[];
  missingItems: PlanStatusCheckKey[];
}

export interface ProjectionYear {
  year: number;
  projectedNetWorthDollars: number;
  projectedNetWorthCents: number;
  byClass: Record<string, number>;
}

export interface NetWorthProjectionResult {
  currentNetWorthDollars: number;
  currentNetWorthCents: number;
  horizonYears: number;
  growthRatesUsed: Record<string, number>;
  projections: ProjectionYear[];
}

export interface EstateTaxSummary {
  estateId: string;
  estateName: string;
  maritalStatus: string | null;
  grossEstateDollars: number;
  federalExemptionDollars: number;
  taxableEstateDollars: number;
  estimatedFederalTaxDollars: number;
  taxRate: number;
  exemptionYear: number;
  exemptionLaw: string;
  asOfDate: string;
}

export interface RmdAccount {
  id: string;
  assetId: string;
  assetName: string;
  accountType: string;
  isRoth: boolean;
  custodian: string | null;
  currentValueCents: number;
  rmdRequired: boolean;
  rmdDueYear: number | null;
  rmdAmountCents: number;
  rmdWithdrawnThisYearCents: number;
  rmdRemainingCents: number;
  isDueThisYear: boolean;
  isFullySatisfied: boolean | null;
}

export interface RmdSummary {
  year: number;
  accounts: RmdAccount[];
  summary: {
    totalAccountsWithRmd: number;
    accountsDueThisYear: number;
    totalRmdDueCents: number;
    totalWithdrawnCents: number;
    totalRemainingCents: number;
    allSatisfied: boolean;
  };
}

export type EstateReviewStatus = "pending" | "in_progress" | "complete";

export interface ReviewChecklistItem {
  id: string;
  label: string;
  completed: boolean;
  completedAt?: string;
}

export interface EstateReview {
  id: string;
  companyId: string;
  userId: string;
  reviewYear: number;
  status: EstateReviewStatus;
  checklist: ReviewChecklistItem[];
  notes: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TrustType = "revocable" | "irrevocable" | "testamentary" | "special_needs";
export type TrustFundingStatus = "unfunded" | "partially_funded" | "fully_funded";

export interface EstateTrust {
  id: string;
  estateId: string;
  companyId: string;
  trustName: string;
  trustType: TrustType;
  trusteeUserId: string | null;
  successorTrusteeName: string | null;
  fundingStatus: TrustFundingStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DesignationType = "primary" | "contingent" | "per_stirpes";

export interface EstateBeneficiary {
  id: string;
  estateId: string;
  companyId: string;
  name: string;
  relationship: string | null;
  email: string | null;
  phone: string | null;
  allocationPercentage: string | null;
  designationType: DesignationType;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PropertyTaxStatus = "upcoming" | "paid" | "overdue" | "exempt";

export interface PropertyTaxBill {
  id: string;
  assetId: string;
  companyId: string;
  userId: string;
  state: string;
  county: string | null;
  taxYear: number;
  installment: number;
  dueDate: string;
  amountCents: string | null;
  status: PropertyTaxStatus;
  paidAt: string | null;
  paidAmountCents: string | null;
  notes: string | null;
  isOverdue: boolean;
  daysUntilDue: number;
  createdAt: string;
  updatedAt: string;
}

function qs(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export const estateApi = {
  netWorth: (companyId: string, userId?: string) =>
    api.get<NetWorthResult>(`/estate/net-worth${qs({ companyId, userId })}`),

  listAssets: (companyId: string, userId?: string) =>
    api.get<{ assets: EstateAsset[] }>(`/estate/assets${qs({ companyId, userId })}`),

  createAsset: (data: {
    companyId: string;
    name: string;
    assetType: AssetType;
    currentValueCents?: number;
    notes?: string;
  }) => api.post<EstateAsset>("/estate/assets", data),

  deleteAsset: (assetId: string) => api.delete<void>(`/estate/assets/${assetId}`),

  listEstates: (companyId: string) =>
    api.get<{ estates: EstateItem[] }>(`/estates${qs({ companyId })}`),

  planStatus: (estateId: string) =>
    api.get<PlanStatusResult>(`/estates/${estateId}/plan-status`),

  netWorthProjection: (companyId: string, years?: number) =>
    api.get<NetWorthProjectionResult>(
      `/estate/projection${qs({ companyId, years: years?.toString() })}`,
    ),

  listBeneficiaries: (estateId: string) =>
    api.get<{ beneficiaries: EstateBeneficiary[] }>(`/estates/${estateId}/beneficiaries`),

  listTrusts: (estateId: string) =>
    api.get<{ trusts: EstateTrust[] }>(`/estates/${estateId}/trusts`),

  taxSummary: (estateId: string) =>
    api.get<EstateTaxSummary>(`/estates/${estateId}/tax-summary`),

  getReview: (companyId: string, year: number) =>
    api.get<EstateReview>(`/estate/reviews/${year}${qs({ companyId })}`),

  patchReview: (year: number, companyId: string, body: {
    checklistItemId?: string;
    checklistCompleted?: boolean;
    status?: EstateReviewStatus;
    notes?: string;
  }) => api.patch<EstateReview>(`/estate/reviews/${year}${qs({ companyId })}`, body),

  rmdSummary: (companyId: string, year?: number) =>
    api.get<RmdSummary>(`/estate/rmd-summary${qs({ companyId, year: year?.toString() })}`),

  listPropertyTax: (companyId: string, year?: number) =>
    api.get<{ bills: PropertyTaxBill[] }>(
      `/estate/property-tax${qs({ companyId, year: year?.toString() })}`,
    ),

  createPropertyTax: (data: {
    companyId: string;
    assetId: string;
    state: string;
    county?: string;
    taxYear: number;
    installment?: number;
    dueDate: string;
    amountCents?: number;
    notes?: string;
  }) => api.post<PropertyTaxBill>("/estate/property-tax", data),

  patchPropertyTax: (id: string, body: {
    status?: PropertyTaxStatus;
    paidAt?: string;
    paidAmountCents?: number;
    amountCents?: number;
    notes?: string;
    dueDate?: string;
  }) => api.patch<PropertyTaxBill>(`/estate/property-tax/${id}`, body),

  deletePropertyTax: (id: string) => api.delete<void>(`/estate/property-tax/${id}`),
};
