import { api } from "./client";

export interface ServiceStatus {
  name: string;
  status: "healthy" | "unhealthy";
  responseTimeMs: number;
}

export const systemStatusApi = {
  getAll: () => api.get<ServiceStatus[]>("/system-status"),
};
