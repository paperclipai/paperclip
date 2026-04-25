import { api } from "./client";

export interface ModelStats {
  model: string;
  evaluations: number;
  successRate: number;
  avgQuality: number | null;
  avgLatencyMs: number | null;
  avgTokenCost: number | null;
}

export interface RoleSummary {
  role: string;
  primaryModel: string | null;
  challengerModel: string | null;
  primaryStats: ModelStats | null;
  challengerStats: ModelStats | null;
  pairingStatus: string | null;
  recommendation: string | null;
  trialsStartedAt: string | null;
  trialsCompletedAt: string | null;
}

export interface PosteriorResult {
  role: string;
  modelA: string;
  modelB: string;
  pBA: number;
  alphaA: number;
  betaA: number;
  alphaB: number;
  betaB: number;
  evaluationsA: number;
  evaluationsB: number;
  recommendation: "swap_to_challenger" | "keep_primary" | null;
}

export const evaluationsApi = {
  summary: () =>
    api.get<{ success: true; data: RoleSummary[] }>("/evaluations/summary"),

  posterior: (role: string) =>
    api.get<{ success: true; data: PosteriorResult }>(`/evaluations/posterior/${encodeURIComponent(role)}`),
};