import type {
  BrowserUseControl,
  BrowserUseSettings,
  BrowserUseViewportPreset,
  BrowserUseViewportState,
  BrowserUseViewportRequest,
  TaskBrowser,
} from "@paperclipai/shared";
import { api } from "./client";
export const browserUseApi = {
  list: (issueId: string) =>
    api.get<TaskBrowser[]>(`/issues/${issueId}/browsers`, {
      cache: "no-store",
    }),
  viewer: (
    issueId: string,
    browserId: string,
    signal?: AbortSignal,
    viewerId?: string,
  ) =>
    api.get<{
      url: string;
      viewport: BrowserUseViewportPreset;
      viewportState?: BrowserUseViewportState;
    }>(
      `/issues/${issueId}/browsers/${browserId}/viewer${viewerId ? `?viewerId=${encodeURIComponent(viewerId)}` : ""}`,
      { cache: "no-store", signal },
    ),
  presence: (issueId: string, browserId: string) =>
    api.post<{ accepted: boolean }>(
      `/issues/${issueId}/browsers/${browserId}/presence`,
      {},
    ),
  control: (issueId: string, browserId: string, action: BrowserUseControl) =>
    api.post(`/issues/${issueId}/browsers/${browserId}/control`, { action }),
  resize: (
    issueId: string,
    browserId: string,
    viewport: BrowserUseViewportRequest,
  ) =>
    api.post<BrowserUseViewportState>(
      `/issues/${issueId}/browsers/${browserId}/viewport`,
      viewport,
    ),
  releaseViewport: (issueId: string, browserId: string, viewerId: string) =>
    api.post(`/issues/${issueId}/browsers/${browserId}/viewport/release`, {
      viewerId,
    }),
  profiles: (companyId: string, grantId: string) =>
    api.get<Array<{ id: string; name: string | null }>>(
      `/companies/${companyId}/browser-use-cloud/grants/${grantId}/profiles`,
      { cache: "no-store" },
    ),
  settings: (companyId: string, grantId: string) =>
    api.get<BrowserUseSettings>(
      `/companies/${companyId}/browser-use-cloud/grants/${grantId}/settings`,
    ),
  saveSettings: (
    companyId: string,
    grantId: string,
    value: BrowserUseSettings,
  ) =>
    api.put<BrowserUseSettings>(
      `/companies/${companyId}/browser-use-cloud/grants/${grantId}/settings`,
      value,
    ),
};
