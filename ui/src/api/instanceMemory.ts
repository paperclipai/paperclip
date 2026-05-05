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

export const instanceMemoryApi = {
  health: () => api.get<MemoryHealthResponse>("/instance/memory/health"),
};
