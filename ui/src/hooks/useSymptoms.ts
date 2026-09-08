import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const VALID_SYMPTOMS = [
  "headache", "fatigue", "nausea", "sore_throat", "runny_nose",
  "cough", "chest_pain", "shortness_of_breath", "dizziness", "body_aches",
  "fever", "chills", "stomach_pain", "back_pain", "anxiety", "insomnia", "other",
] as const;

export type SymptomType = typeof VALID_SYMPTOMS[number];

export interface SymptomLog {
  id: string;
  companyId: string;
  userId: string;
  symptomDate: string;
  symptom: SymptomType;
  severity: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SymptomHistoryResponse {
  from: string;
  to: string;
  logs: SymptomLog[];
}

export function buildSymptomHistoryUrl(companyId: string, from: string, to: string): string {
  return `/api/symptoms?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useSymptomHistory(companyId: string | undefined, from: string, to: string) {
  return useQuery<SymptomHistoryResponse>({
    queryKey: ["symptom-history", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(buildSymptomHistoryUrl(companyId!, from, to), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load symptom history (${res.status})`);
      }
      return res.json() as Promise<SymptomHistoryResponse>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface LogSymptomInput {
  companyId: string;
  symptomDate: string;
  symptom: SymptomType;
  severity?: number | null;
  notes?: string | null;
}

export function useLogSymptom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogSymptomInput): Promise<SymptomLog> => {
      const res = await fetch("/api/symptoms", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to log symptom (${res.status})`);
      }
      return res.json() as Promise<SymptomLog>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["symptom-history", input.companyId] });
    },
  });
}

export function useDeleteSymptomLog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/symptoms/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete symptom log (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["symptom-history", companyId] });
    },
  });
}
