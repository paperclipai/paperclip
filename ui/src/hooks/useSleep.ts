import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type SleepQuality = "poor" | "fair" | "good" | "excellent";

export interface SleepRecord {
  id: string;
  companyId: string;
  userId: string;
  sleepDate: string;
  durationMinutes: number;
  quality: SleepQuality | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SleepHistoryResponse {
  from: string;
  to: string;
  records: SleepRecord[];
}

export function buildSleepHistoryUrl(
  companyId: string,
  from: string,
  to: string,
): string {
  return `/api/sleep?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useSleepHistory(
  companyId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery<SleepHistoryResponse>({
    queryKey: ["sleep-history", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(`/api/sleep?companyId=${encodeURIComponent(companyId!)}&from=${from}&to=${to}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load sleep history (${res.status})`);
      }
      return res.json() as Promise<SleepHistoryResponse>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface LogSleepInput {
  companyId: string;
  sleepDate: string;
  durationMinutes: number;
  quality?: SleepQuality | null;
  notes?: string | null;
}

export function useLogSleep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogSleepInput): Promise<SleepRecord> => {
      const res = await fetch("/api/sleep", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to log sleep (${res.status})`);
      }
      return res.json() as Promise<SleepRecord>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["sleep-history", input.companyId] });
    },
  });
}

export function useDeleteSleepRecord() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/sleep/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete sleep record (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["sleep-history", companyId] });
    },
  });
}
