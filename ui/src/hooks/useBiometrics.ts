import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface BiometricReading {
  id: string;
  companyId: string;
  userId: string;
  measurementDate: string;
  weightKg: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;
  restingHeartRate: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BiometricsHistoryResponse {
  from: string;
  to: string;
  readings: BiometricReading[];
}

export function buildBiometricsHistoryUrl(
  companyId: string,
  from: string,
  to: string,
): string {
  return `/api/biometrics?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useBiometricsHistory(
  companyId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery<BiometricsHistoryResponse>({
    queryKey: ["biometrics-history", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(buildBiometricsHistoryUrl(companyId!, from, to), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load biometrics history (${res.status})`);
      }
      return res.json() as Promise<BiometricsHistoryResponse>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface LogBiometricsInput {
  companyId: string;
  measurementDate: string;
  weightKg?: number | null;
  systolicBp?: number | null;
  diastolicBp?: number | null;
  restingHeartRate?: number | null;
  notes?: string | null;
}

export function useLogBiometrics() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogBiometricsInput): Promise<BiometricReading> => {
      const res = await fetch("/api/biometrics", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to log biometrics (${res.status})`);
      }
      return res.json() as Promise<BiometricReading>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["biometrics-history", input.companyId] });
    },
  });
}

export function useDeleteBiometricReading() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/biometrics/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete biometric reading (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["biometrics-history", companyId] });
    },
  });
}
