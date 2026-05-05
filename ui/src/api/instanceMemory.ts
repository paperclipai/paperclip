import { api } from "./client";

export interface MemoryHealthResponse {
  shim: { up: boolean; error: string | null; url: string };
  stats: {
    total24h: number;
    distinctActors24h: number;
    lastWriteAt: string | null;
    topActors: { actorId: string; count: number }[];
  } | null;
  dbError: string | null;
  pill: "green" | "yellow" | "red";
  reason: string | null;
  generatedAt: string;
}

export interface MemoryDashboardResponse {
  generatedAt: string;
  source: { dbPath: string; healthUrl: string };
  writesPerAgentPerDay: {
    day: string;
    total: number;
    actors: { actorId: string; count: number }[];
  }[];
  recall: {
    windowHours: number;
    totalSearches: number;
    hitSearches: number;
    hitRate: number | null;
    latencyMs: { p50: number | null; p95: number | null };
  };
  topRecalledMemoryKeys: {
    available: boolean;
    reason: string | null;
    rows: { key: string; count: number }[];
  };
  health: {
    pill: "green" | "yellow" | "red";
    reason: string | null;
    last: {
      createdAt: string;
      latencyMs: number;
      status: string;
      components: Record<string, unknown>;
      error: string | null;
    } | null;
  };
}

export const instanceMemoryApi = {
  health: () => api.get<MemoryHealthResponse>("/instance/memory/health"),
  dashboard: () => api.get<MemoryDashboardResponse>("/memory/dashboard"),
};
