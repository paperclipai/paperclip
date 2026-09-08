import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface MedicationLog {
  id: string;
  companyId: string;
  userId: string;
  medicationDate: string;
  medicationName: string;
  dosage: string | null;
  taken: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MedicationHistoryResponse {
  from: string;
  to: string;
  logs: MedicationLog[];
}

export function buildMedicationHistoryUrl(companyId: string, from: string, to: string): string {
  return `/api/medications?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useMedicationHistory(companyId: string | undefined, from: string, to: string) {
  return useQuery<MedicationHistoryResponse>({
    queryKey: ["medication-history", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(buildMedicationHistoryUrl(companyId!, from, to), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load medication history (${res.status})`);
      }
      return res.json() as Promise<MedicationHistoryResponse>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface LogMedicationInput {
  companyId: string;
  medicationDate: string;
  medicationName: string;
  dosage?: string | null;
  taken?: boolean;
  notes?: string | null;
}

export function useLogMedication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogMedicationInput): Promise<MedicationLog> => {
      const res = await fetch("/api/medications", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to log medication (${res.status})`);
      }
      return res.json() as Promise<MedicationLog>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["medication-history", input.companyId] });
    },
  });
}

export function useDeleteMedicationLog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/medications/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete medication log (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["medication-history", companyId] });
    },
  });
}
