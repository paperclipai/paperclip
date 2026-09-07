import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

export type ColorTier = "green" | "yellow" | "orange" | "red";

export interface PersonalScoreComponents {
  aqi: number | null;
  uv: number | null;
  heatStress: number | null;
  greenspace: number | null;
}

export interface PersonalScoreToday {
  score: number;
  colorTier: ColorTier;
  scoredAt: string;
  confidenceFlag: string | null;
  partialSignals: string[];
  components: PersonalScoreComponents;
}

export interface PersonalScoreHistoryEntry {
  score: number;
  colorTier: ColorTier;
  scoredAt: string;
  confidenceFlag: string | null;
}

export interface PersonalEnvironmentalScoreResult {
  disclaimer: string;
  today: PersonalScoreToday | null;
  history: PersonalScoreHistoryEntry[];
}

async function fetchPersonalEnvironmentalScore(companyId: string): Promise<PersonalEnvironmentalScoreResult> {
  const url = new URL("/api/health/environmental-score", window.location.origin);
  url.searchParams.set("companyId", companyId);
  const res = await fetch(url.toString(), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to load environmental score (${res.status})`);
  }
  return res.json() as Promise<PersonalEnvironmentalScoreResult>;
}

export function usePersonalEnvironmentalScore(companyId: string | null) {
  return useQuery({
    queryKey: ["personal-environmental-score", companyId],
    queryFn: () => fetchPersonalEnvironmentalScore(companyId!),
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export type BBox = [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]

export interface HealthScoreBreakdown {
  aqi: number;
  uv: number;
  heatStress: number;
  greenspace: number;
}

export interface HealthScoreEntry {
  lat: number;
  lng: number;
  score: number; // 0–100
  band: "green" | "yellow" | "orange" | "red";
  breakdown: HealthScoreBreakdown;
}

export interface HealthScoreMapResult {
  entries: HealthScoreEntry[];
  generatedAt: string;
}

async function fetchHealthScoreMap(bbox: BBox | null): Promise<HealthScoreMapResult> {
  const url = new URL("/api/health/environmental-score/map", window.location.origin);
  if (bbox) url.searchParams.set("bbox", bbox.join(","));
  const res = await fetch(url.toString(), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to load health score map (${res.status})`);
  }
  return res.json();
}

/**
 * Fetches the environmental health score grid for optional bbox bounds.
 *
 * Bbox stabilization: callers may pass an inline array literal without wrapping in
 * useMemo — this hook serializes bbox to a string for the query key so a new array
 * reference on every render does NOT cause an infinite refetch loop.
 */
export function useHealthScoreMap(bbox?: BBox | null) {
  // Serialize bbox so the query key is stable regardless of array reference identity.
  // JSON.stringify([1,2,3,4]) is referentially stable if the VALUES are unchanged.
  const bboxKey = bbox ? JSON.stringify(bbox) : null;

  // Stable resolved bbox passed to the fetch function — avoids creating a new array
  // inside the queryFn closure on every render.
  const bboxRef = useRef<BBox | null>(bbox ?? null);
  const resolvedBbox = useMemo<BBox | null>(() => {
    // Re-parse from the serialized key so the fetch function always gets the same
    // array reference for equal values.
    if (bboxKey === null) {
      bboxRef.current = null;
      return null;
    }
    const parsed = JSON.parse(bboxKey) as BBox;
    bboxRef.current = parsed;
    return parsed;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bboxKey]);

  return useQuery({
    queryKey: ["environmental-score-map", bboxKey],
    queryFn: () => fetchHealthScoreMap(resolvedBbox),
    staleTime: 5 * 60 * 1000, // scores are valid for 5 minutes
  });
}

/** Convenience: today's aggregate environmental health score (no bbox). */
export function useEnvironmentalHealthScore() {
  return useHealthScoreMap(null);
}
