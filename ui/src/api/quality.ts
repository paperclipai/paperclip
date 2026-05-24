import type { QualityScorecard, QualityEscalation, QualityMetricsResponse, CrewMemberScore, GatePassRate } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import { queryKeys } from "../lib/queryKeys";

export const qualityApi = {
  scorecard: () => api.get<QualityScorecard>("/quality/scorecards"),
  escalations: (limit?: number) => {
    const params = limit ? `?limit=${limit}` : "";
    return api.get<QualityEscalation[]>(`/quality/escalations${params}`);
  },
  metrics: (days?: number) => {
    const params = days ? `?days=${days}` : "";
    return api.get<QualityMetricsResponse>(`/quality/metrics${params}`);
  },
  crewScores: () => api.get<CrewMemberScore[]>("/quality/crew-scores"),
  gatePassRates: () => api.get<GatePassRate[]>("/quality/gate-pass-rates"),
};

export function useQualityScorecard() {
  return useQuery({
    queryKey: queryKeys.quality.scorecard,
    queryFn: () => qualityApi.scorecard(),
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useQualityEscalations(limit?: number) {
  return useQuery({
    queryKey: queryKeys.quality.escalations(limit),
    queryFn: () => qualityApi.escalations(limit),
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useQualityMetrics(days?: number) {
  return useQuery({
    queryKey: queryKeys.quality.metrics(days),
    queryFn: () => qualityApi.metrics(days),
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useQualityCrewScores() {
  return useQuery({
    queryKey: queryKeys.quality.crewScores,
    queryFn: () => qualityApi.crewScores(),
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useQualityGatePassRates() {
  return useQuery({
    queryKey: queryKeys.quality.gatePassRates,
    queryFn: () => qualityApi.gatePassRates(),
    refetchInterval: 5 * 60 * 1000,
  });
}
