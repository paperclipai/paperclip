import { api } from "./client";

export interface SystemActionResponse {
  ok: boolean;
  action: "shutdown" | "restart";
  message?: string;
  usedLauncher?: boolean;
  error?: string;
}

export const systemApi = {
  shutdown: () => api.post<SystemActionResponse>("/system/shutdown", {}),
  restart: () => api.post<SystemActionResponse>("/system/restart", {}),
};
