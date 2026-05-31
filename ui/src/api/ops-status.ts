import { api } from "./client";

export type OpsCheckStatus = "ok" | "warning" | "error" | "unknown";

export interface OpsStatusCheck {
  id: string;
  label: string;
  status: OpsCheckStatus;
  summary: string;
  detail?: string;
  updatedAt: string;
}

export interface OpsStatusResponse {
  status: OpsCheckStatus;
  checks: OpsStatusCheck[];
}

export const opsStatusApi = {
  get: () => api.get<OpsStatusResponse>("/ops-status"),
};
