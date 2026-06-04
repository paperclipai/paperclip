import type {
  AccountPoolListResponse,
  AddPoolAccountRequest,
  OauthCompleteRequest,
  OauthStartResponse,
  PoolAccount,
  PoolState,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Account Pool & Rotation API client (Slice 4).
 * Endpoints are company-scoped via a ?companyId= query param.
 */
export const accountPoolApi = {
  list: (companyId: string) =>
    api.get<AccountPoolListResponse>(`/account-pool?companyId=${encodeURIComponent(companyId)}`),
  refresh: (companyId: string) =>
    api.post<AccountPoolListResponse>(
      `/account-pool/refresh?companyId=${encodeURIComponent(companyId)}`,
      {},
    ),
  state: (companyId: string) =>
    api.get<PoolState | null>(`/account-pool/state?companyId=${encodeURIComponent(companyId)}`),
  add: (companyId: string, input: AddPoolAccountRequest) =>
    api.post<PoolAccount>(`/account-pool?companyId=${encodeURIComponent(companyId)}`, input),
  oauthStart: (companyId: string) =>
    api.post<OauthStartResponse>(`/account-pool/oauth/start?companyId=${encodeURIComponent(companyId)}`, {}),
  oauthComplete: (companyId: string, input: OauthCompleteRequest) =>
    api.post<PoolAccount>(`/account-pool/oauth/complete?companyId=${encodeURIComponent(companyId)}`, input),
  remove: (companyId: string, id: string) =>
    api.delete<{ ok: true }>(
      `/account-pool/${encodeURIComponent(id)}?companyId=${encodeURIComponent(companyId)}`,
    ),
  engageStop: (companyId: string, reason?: string) =>
    api.post<PoolState | null>(
      `/account-pool/stop?companyId=${encodeURIComponent(companyId)}`,
      reason ? { reason } : {},
    ),
  releaseStop: (companyId: string) =>
    api.delete<PoolState | null>(`/account-pool/stop?companyId=${encodeURIComponent(companyId)}`),
};
