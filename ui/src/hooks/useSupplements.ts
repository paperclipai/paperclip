import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface SupplementIntake {
  id: string;
  supplementId: string;
  name: string;
  dose: string;
  unit: string;
  scheduledAt: string;
  takenAt: string | null;
  skippedAt: string | null;
}

export interface SupplementsIntakeResult {
  date: string;
  intakes: SupplementIntake[];
}

export function formatIntakeDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function buildSupplementsIntakeUrl(apiUrl: string, date: string): string {
  return `${apiUrl}/supplements/intake/${date}`;
}

export function buildTakeUrl(apiUrl: string, date: string, supplementId: string): string {
  return `${apiUrl}/supplements/intake/${date}/${supplementId}/take`;
}

export function buildSkipUrl(apiUrl: string, date: string, supplementId: string): string {
  return `${apiUrl}/supplements/intake/${date}/${supplementId}/skip`;
}

export function buildUndoUrl(apiUrl: string, date: string, supplementId: string): string {
  return `${apiUrl}/supplements/intake/${date}/${supplementId}`;
}

const apiUrl = import.meta.env.VITE_API_URL as string | undefined;

async function fetchSupplementsIntake(date: string): Promise<SupplementsIntakeResult> {
  if (!apiUrl) {
    return { date, intakes: [] };
  }

  const res = await fetch(buildSupplementsIntakeUrl(apiUrl, date), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to load supplements intake (${res.status})`);
  }

  return res.json() as Promise<SupplementsIntakeResult>;
}

export function useSupplementsIntake(date?: string) {
  const targetDate = date ?? formatIntakeDate(new Date());
  return useQuery({
    queryKey: ["supplements-intake", targetDate],
    queryFn: () => fetchSupplementsIntake(targetDate),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSupplements() {
  return useSupplementsIntake();
}

export function useTakeSupplement(date?: string) {
  const queryClient = useQueryClient();
  const targetDate = date ?? formatIntakeDate(new Date());
  return useMutation({
    mutationFn: async (supplementId: string): Promise<SupplementIntake> => {
      if (!apiUrl) throw new Error("VITE_API_URL not configured");
      const res = await fetch(buildTakeUrl(apiUrl, targetDate, supplementId), {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to mark supplement taken (${res.status})`);
      }
      return res.json() as Promise<SupplementIntake>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["supplements-intake", targetDate] });
    },
  });
}

export function useSkipSupplement(date?: string) {
  const queryClient = useQueryClient();
  const targetDate = date ?? formatIntakeDate(new Date());
  return useMutation({
    mutationFn: async (supplementId: string): Promise<SupplementIntake> => {
      if (!apiUrl) throw new Error("VITE_API_URL not configured");
      const res = await fetch(buildSkipUrl(apiUrl, targetDate, supplementId), {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to mark supplement skipped (${res.status})`);
      }
      return res.json() as Promise<SupplementIntake>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["supplements-intake", targetDate] });
    },
  });
}

export function useUndoSupplement(date?: string) {
  const queryClient = useQueryClient();
  const targetDate = date ?? formatIntakeDate(new Date());
  return useMutation({
    mutationFn: async (supplementId: string): Promise<void> => {
      if (!apiUrl) throw new Error("VITE_API_URL not configured");
      const res = await fetch(buildUndoUrl(apiUrl, targetDate, supplementId), {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to undo supplement intake (${res.status})`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["supplements-intake", targetDate] });
    },
  });
}
