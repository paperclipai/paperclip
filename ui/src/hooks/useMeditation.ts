import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface MeditationLog {
  id: string;
  companyId: string;
  userId: string;
  sessionDate: string;
  durationMinutes: number;
  technique: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeditationHistoryResponse {
  from: string;
  to: string;
  logs: MeditationLog[];
}

export const MEDITATION_TECHNIQUES = [
  { value: "mindfulness", label: "Mindfulness" },
  { value: "breath_focus", label: "Breath Focus" },
  { value: "body_scan", label: "Body Scan" },
  { value: "loving_kindness", label: "Loving Kindness" },
  { value: "visualization", label: "Visualization" },
  { value: "mantra", label: "Mantra" },
  { value: "transcendental", label: "Transcendental" },
  { value: "movement", label: "Movement" },
  { value: "other", label: "Other" },
];

export function buildMeditationHistoryUrl(companyId: string, from: string, to: string): string {
  return `/api/meditation?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useMeditationHistory(companyId: string | undefined, from: string, to: string) {
  return useQuery<MeditationHistoryResponse>({
    queryKey: ["meditation", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(buildMeditationHistoryUrl(companyId!, from, to), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load meditation history (${res.status})`);
      }
      return res.json() as Promise<MeditationHistoryResponse>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface LogMeditationInput {
  companyId: string;
  sessionDate: string;
  durationMinutes: number;
  technique?: string | null;
  notes?: string | null;
}

export function useLogMeditation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogMeditationInput): Promise<MeditationLog> => {
      const res = await fetch("/api/meditation", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to log meditation (${res.status})`);
      }
      return res.json() as Promise<MeditationLog>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["meditation", input.companyId] });
    },
  });
}

export function useDeleteMeditationLog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/meditation/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete meditation log (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["meditation", companyId] });
    },
  });
}
