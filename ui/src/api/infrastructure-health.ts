export type InfraServiceStatus = {
  status: "ok" | "degraded" | "error";
  service: string;
  label?: string;
  version: string | null;
  uptime_seconds: number | null;
  checks: Record<string, unknown>;
  error?: string;
};

export type InfraHealthSummary = {
  total: number;
  ok: number;
  degraded: number;
  error: number;
};

export type InfraHealthResponse = {
  status: "ok" | "degraded" | "error";
  timestamp: string;
  services: Record<string, InfraServiceStatus>;
  summary: InfraHealthSummary;
};

export const infrastructureHealthApi = {
  getAll: async (): Promise<InfraHealthResponse> => {
    const res = await fetch("/api/infrastructure/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Infrastructure health check failed (${res.status})`);
    }
    return res.json();
  },
};
