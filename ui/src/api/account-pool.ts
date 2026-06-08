import type {
  AccountPoolListResponse,
  AddPoolAccountRequest,
  AutoRotationPreview,
  OauthCompleteRequest,
  OauthStartResponse,
  PoolAccount,
  PoolProvider,
  PoolState,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Account Pool & Rotation API client.
 * Endpoints are company-scoped via a ?companyId= query param and provider-scoped
 * via an optional ?provider= (claude | codex; defaults to claude server-side).
 */
function qs(companyId: string, provider?: PoolProvider): string {
  const params = new URLSearchParams({ companyId });
  if (provider) params.set("provider", provider);
  return params.toString();
}

export const accountPoolApi = {
  list: (companyId: string, provider?: PoolProvider) =>
    api.get<AccountPoolListResponse>(`/account-pool?${qs(companyId, provider)}`),
  refresh: (companyId: string, provider?: PoolProvider) =>
    api.post<AccountPoolListResponse>(`/account-pool/refresh?${qs(companyId, provider)}`, {}),
  state: (companyId: string, provider?: PoolProvider) =>
    api.get<PoolState | null>(`/account-pool/state?${qs(companyId, provider)}`),
  // which pool/account the shared auto_rotation adapter currently rides (provider-agnostic)
  autoRotationPreview: (companyId: string) =>
    api.get<AutoRotationPreview | null>(`/account-pool/auto-rotation-state?${qs(companyId)}`),
  add: (companyId: string, input: AddPoolAccountRequest) =>
    api.post<PoolAccount>(`/account-pool?${qs(companyId)}`, input),
  oauthStart: (companyId: string) =>
    api.post<OauthStartResponse>(`/account-pool/oauth/start?${qs(companyId)}`, {}),
  oauthComplete: (companyId: string, input: OauthCompleteRequest) =>
    api.post<PoolAccount>(`/account-pool/oauth/complete?${qs(companyId)}`, input),
  remove: (companyId: string, id: string) =>
    api.delete<{ ok: true }>(`/account-pool/${encodeURIComponent(id)}?${qs(companyId)}`),
  engageStop: (companyId: string, provider: PoolProvider, reason?: string) =>
    api.post<PoolState | null>(
      `/account-pool/stop?${qs(companyId, provider)}`,
      reason ? { reason } : {},
    ),
  releaseStop: (companyId: string, provider: PoolProvider) =>
    api.delete<PoolState | null>(`/account-pool/stop?${qs(companyId, provider)}`),
  // provider is REQUIRED for the synthetic default account (`__default__`), which
  // has no secret row for the server to derive the provider from; for pooled
  // accounts the server derives it from the row and the param is harmless.
  setRotationEnabled: (companyId: string, id: string, enabled: boolean, provider: PoolProvider) =>
    api.patch<AccountPoolListResponse>(
      `/account-pool/${encodeURIComponent(id)}/rotation?${qs(companyId, provider)}`,
      { enabled },
    ),
};
