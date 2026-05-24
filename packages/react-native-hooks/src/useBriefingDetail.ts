import { useState, useEffect, useCallback } from "react";
import type { FlightCrewBriefing } from "@paperclipai/shared";

interface UseBriefingDetailOptions {
  apiUrl: string;
  tripId: string;
  dutyDayId: string;
}

interface UseBriefingDetailReturn {
  briefing: FlightCrewBriefing | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useBriefingDetail(
  options: UseBriefingDetailOptions,
): UseBriefingDetailReturn {
  const { apiUrl, tripId, dutyDayId } = options;
  const [briefing, setBriefing] = useState<FlightCrewBriefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `${apiUrl}/api/briefings/${encodeURIComponent(tripId)}/${encodeURIComponent(dutyDayId)}`,
        { method: "GET" },
      );

      if (res.status === 404) {
        setBriefing(null);
        setError("Briefing not found");
        return;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Failed to load briefing (${res.status}): ${body}`);
      }

      const data = (await res.json()) as FlightCrewBriefing;
      setBriefing(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, tripId, dutyDayId]);

  useEffect(() => {
    fetchBriefing();
  }, [fetchBriefing]);

  return { briefing, loading, error, refetch: fetchBriefing };
}
