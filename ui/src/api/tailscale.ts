import type { TailscaleConnection, TailscaleDeviceLogin } from "@paperclipai/shared";
import { api } from "./client";

export type { TailscaleConnection } from "@paperclipai/shared";
export type TailscaleDevice = { id: string; name: string; hostname: string; address: string; os: string; online: boolean };
export const tailscaleApi = {
  list: (companyId: string) => api.get<TailscaleConnection[]>(`/companies/${companyId}/tailscale-connections`),
  connect: (companyId: string, connectionId?: string) => api.post<TailscaleDeviceLogin>(`/companies/${companyId}/tailscale-connections`, { name: "My tailnet", ...(connectionId ? { connectionId } : {}) }),
  deviceLogin: (companyId: string, connectionId: string) => api.post<TailscaleDeviceLogin>(`/companies/${companyId}/tailscale-connections/${connectionId}/device-login`, {}),
  devices: (companyId: string, id: string) => api.get<TailscaleDevice[]>(`/companies/${companyId}/tailscale-connections/${id}/devices`),
  disconnect: (companyId: string, id: string) => api.delete<TailscaleConnection>(`/companies/${companyId}/tailscale-connections/${id}`),
  pairing: (companyId: string, id: string, deviceId: string, port: number) => api.post<{ privateKeySecretId: string; publicKey: string; command: string }>(`/companies/${companyId}/tailscale-connections/${id}/pairing`, { deviceId, port }),
};
