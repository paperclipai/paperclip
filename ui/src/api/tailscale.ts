import type { ToolOAuthStartResult } from "@paperclipai/shared";
import { api } from "./client";

export type TailscaleConnection = { id: string; companyId: string; name: string; status: string };
export type TailscaleDevice = { id: string; name: string; hostname: string; address: string; os: string; online: boolean };
export const tailscaleApi = {
  list: (companyId: string) => api.get<TailscaleConnection[]>(`/companies/${companyId}/tailscale-connections`),
  connect: (companyId: string, connectionId?: string) => api.post<ToolOAuthStartResult>(`/companies/${companyId}/tailscale-connections`, { name: "My tailnet", ...(connectionId ? { connectionId } : {}) }),
  devices: (companyId: string, id: string) => api.get<TailscaleDevice[]>(`/companies/${companyId}/tailscale-connections/${id}/devices`),
  disconnect: (companyId: string, id: string) => api.delete<TailscaleConnection>(`/companies/${companyId}/tailscale-connections/${id}`),
  pairing: (companyId: string, id: string, deviceId: string, port: number) => api.post<{ privateKeySecretId: string; publicKey: string; command: string }>(`/companies/${companyId}/tailscale-connections/${id}/pairing`, { deviceId, port }),
};
