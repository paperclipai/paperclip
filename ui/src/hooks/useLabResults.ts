import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface LabResult {
  id: string;
  companyId: string;
  userId: string;
  markerName: string;
  loincCode: string | null;
  value: string;
  unit: string;
  optimalMin: string | null;
  optimalMax: string | null;
  measuredDate: string;
  source: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LabResultsResponse {
  from: string;
  to: string;
  results: LabResult[];
}

export interface MarkerPreset {
  name: string;
  loincCode: string;
  unit: string;
  optimalMin: number | null;
  optimalMax: number | null;
}

export const LAB_MARKER_PRESETS: MarkerPreset[] = [
  { name: "HbA1c", loincCode: "4548-4", unit: "%", optimalMin: 4.0, optimalMax: 5.6 },
  { name: "Vitamin D (25-OH)", loincCode: "1989-3", unit: "ng/mL", optimalMin: 40, optimalMax: 60 },
  { name: "hsCRP", loincCode: "30522-7", unit: "mg/L", optimalMin: 0, optimalMax: 1 },
  { name: "ApoB", loincCode: "1884-6", unit: "mg/dL", optimalMin: null, optimalMax: 80 },
  { name: "Testosterone", loincCode: "2986-8", unit: "ng/dL", optimalMin: 400, optimalMax: 700 },
  { name: "IGF-1", loincCode: "2484-4", unit: "ng/mL", optimalMin: null, optimalMax: null },
  { name: "Ferritin", loincCode: "2276-4", unit: "ng/mL", optimalMin: 50, optimalMax: 150 },
  { name: "Homocysteine", loincCode: "13965-9", unit: "μmol/L", optimalMin: 0, optimalMax: 9 },
  { name: "eGFR", loincCode: "98979-8", unit: "mL/min/1.73m²", optimalMin: 60, optimalMax: null },
];

export function buildLabResultsUrl(companyId: string, from: string, to: string): string {
  return `/api/lab-results?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useLabResults(companyId: string | undefined, from: string, to: string) {
  return useQuery<LabResultsResponse>({
    queryKey: ["lab-results", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(buildLabResultsUrl(companyId!, from, to), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load lab results (${res.status})`);
      }
      return res.json() as Promise<LabResultsResponse>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface LogLabResultInput {
  companyId: string;
  measuredDate: string;
  markerName: string;
  value: number;
  unit: string;
  loincCode?: string | null;
  optimalMin?: number | null;
  optimalMax?: number | null;
  source?: string | null;
  notes?: string | null;
}

export function useLogLabResult() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogLabResultInput): Promise<LabResult> => {
      const res = await fetch("/api/lab-results", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to log lab result (${res.status})`);
      }
      return res.json() as Promise<LabResult>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["lab-results", input.companyId] });
    },
  });
}

export function useDeleteLabResult() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/lab-results/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete lab result (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["lab-results", companyId] });
    },
  });
}
