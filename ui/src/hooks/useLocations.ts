import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface EnvironmentalReading {
  id: string;
  readingAt: string;
  aqi: number | null;
  pm25: number | null;
  pm10: number | null;
  no2: number | null;
  uvIndex: number | null;
  landSurfaceTemp: number | null;
  ndvi: number | null;
  dataSource: string;
}

export interface LocationReadingsResponse {
  locationId: string;
  from: string;
  to: string;
  readings: EnvironmentalReading[];
}

export interface UserLocation {
  id: string;
  companyId: string;
  userId: string;
  lat: number;
  lng: number;
  label: string | null;
  isDefault: boolean;
  geohash: string | null;
  createdAt: string;
  updatedAt: string;
}

export function buildLocationsUrl(companyId: string): string {
  return `/api/health/locations?companyId=${encodeURIComponent(companyId)}`;
}

export function buildLocationUrl(id: string): string {
  return `/api/health/locations/${encodeURIComponent(id)}`;
}

export function buildLocationReadingsUrl(
  id: string,
  companyId: string,
  opts?: { from?: string; to?: string; limit?: number },
): string {
  const params = new URLSearchParams({ companyId });
  if (opts?.from) params.set("from", opts.from);
  if (opts?.to) params.set("to", opts.to);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  return `/api/health/locations/${encodeURIComponent(id)}/readings?${params}`;
}

export function useLocationReadings(
  id: string | undefined,
  companyId: string | undefined,
) {
  return useQuery<LocationReadingsResponse>({
    queryKey: ["health-location-readings", id, companyId],
    queryFn: async () => {
      const res = await fetch(buildLocationReadingsUrl(id!, companyId!), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load readings (${res.status})`);
      }
      return res.json() as Promise<LocationReadingsResponse>;
    },
    enabled: !!id && !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useLocationsList(companyId: string | undefined) {
  return useQuery<UserLocation[]>({
    queryKey: ["health-locations", companyId],
    queryFn: async () => {
      if (!companyId) return [];
      const res = await fetch(buildLocationsUrl(companyId), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load locations (${res.status})`);
      }
      const data = await res.json() as { locations: UserLocation[] };
      return data.locations;
    },
    enabled: !!companyId,
    staleTime: 2 * 60 * 1000,
  });
}

export interface AddLocationInput {
  companyId: string;
  lat: number;
  lng: number;
  label?: string;
  isDefault?: boolean;
}

export function useAddLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddLocationInput): Promise<UserLocation> => {
      const res = await fetch("/api/health/locations", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to create location (${res.status})`);
      }
      return res.json() as Promise<UserLocation>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["health-locations", input.companyId] });
    },
  });
}

export interface EditLocationInput {
  id: string;
  companyId: string;
  lat?: number;
  lng?: number;
  label?: string | null;
  isDefault?: boolean;
}

export function useEditLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: EditLocationInput): Promise<UserLocation> => {
      const { id, companyId: _cid, ...patch } = input;
      const res = await fetch(buildLocationUrl(id), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to update location (${res.status})`);
      }
      return res.json() as Promise<UserLocation>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["health-locations", input.companyId] });
    },
  });
}

export function useDeleteLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(buildLocationUrl(id), {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete location (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["health-locations", companyId] });
    },
  });
}
