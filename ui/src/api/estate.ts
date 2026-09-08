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
};
