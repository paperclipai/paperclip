import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface Supplement {
  id: string;
  companyId: string;
  userId: string;
  name: string;
  dose: string;
  unit: string;
  scheduledTime: string;
  notes: string | null;
  active: boolean;
}

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

export function buildSupplementsUrl(apiUrl: string, companyId: string): string {
  return `${apiUrl}/supplements?companyId=${companyId}`;
}

export function buildSupplementUrl(apiUrl: string, id: string): string {
  return `${apiUrl}/supplements/${id}`;
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

export function useSupplementsList(companyId: string | undefined) {
  return useQuery<Supplement[]>({
    queryKey: ["supplements-list", companyId],
    queryFn: async () => {
      if (!apiUrl || !companyId) return [];
      const res = await fetch(buildSupplementsUrl(apiUrl, companyId), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load supplements (${res.status})`);
      }
      const data = await res.json() as { supplements: Supplement[] };
      return data.supplements;
    },
    enabled: !!companyId,
    staleTime: 2 * 60 * 1000,
  });
}

export interface AddSupplementInput {
  companyId: string;
  name: string;
  dose: string;
  unit?: string;
  scheduledTime?: string;
  notes?: string;
}

export function useAddSupplement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddSupplementInput): Promise<Supplement> => {
      if (!apiUrl) throw new Error("VITE_API_URL not configured");
      const res = await fetch(`${apiUrl}/supplements`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to create supplement (${res.status})`);
      }
      return res.json() as Promise<Supplement>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["supplements-list", input.companyId] });
    },
  });
}

export interface EditSupplementInput {
  id: string;
  companyId: string;
  name?: string;
  dose?: string;
  unit?: string;
  scheduledTime?: string;
  notes?: string;
  active?: boolean;
}

export function useEditSupplement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: EditSupplementInput): Promise<Supplement> => {
      if (!apiUrl) throw new Error("VITE_API_URL not configured");
      const { id, companyId: _cid, ...patch } = input;
      const res = await fetch(buildSupplementUrl(apiUrl, id), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to update supplement (${res.status})`);
      }
      return res.json() as Promise<Supplement>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["supplements-list", input.companyId] });
    },
  });
}

export interface SupplementHistoryDay {
  date: string;
  takenAt: string | null;
  skippedAt: string | null;
}

export interface SupplementHistoryEntry {
  id: string;
  name: string;
  dose: string;
  unit: string;
  days: SupplementHistoryDay[];
}

export interface SupplementHistoryResult {
  from: string;
  to: string;
  supplements: SupplementHistoryEntry[];
}

export function buildSupplementHistoryUrl(
  apiUrl: string,
  companyId: string,
  from: string,
  to: string,
): string {
  return `${apiUrl}/supplements/intake/history?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useSupplementHistory(
  companyId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery<SupplementHistoryResult>({
    queryKey: ["supplement-history", companyId, from, to],
    queryFn: async () => {
      if (!apiUrl || !companyId) return { from, to, supplements: [] };
      const res = await fetch(buildSupplementHistoryUrl(apiUrl, companyId, from, to), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load supplement history (${res.status})`);
      }
      return res.json() as Promise<SupplementHistoryResult>;
    },
    enabled: !!companyId && !!from && !!to,
    staleTime: 5 * 60 * 1000,
  });
}

export function useDeleteSupplement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, companyId }: { id: string; companyId: string }): Promise<void> => {
      if (!apiUrl) throw new Error("VITE_API_URL not configured");
      const res = await fetch(buildSupplementUrl(apiUrl, id), {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete supplement (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["supplements-list", companyId] });
    },
  });
}
