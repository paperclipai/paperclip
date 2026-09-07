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
};
