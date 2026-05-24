import { useState, useEffect, useCallback } from "react";
import type { FeedbackTrends } from "@paperclipai/shared";

interface UseFeedbackTrendsOptions {
  apiUrl: string;
}

interface UseFeedbackTrendsReturn {
  trends: FeedbackTrends | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useFeedbackTrends(
  options: UseFeedbackTrendsOptions,
): UseFeedbackTrendsReturn {
  const [trends, setTrends] = useState<FeedbackTrends | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTrends = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${options.apiUrl}/api/feedback/briefing/trends`);
      if (!res.ok) {
        throw new Error(`Failed to load trends (${res.status})`);
      }
      const data = (await res.json()) as FeedbackTrends;
      setTrends(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [options.apiUrl]);

  useEffect(() => {
    fetchTrends();
  }, [fetchTrends]);

  return { trends, loading, error, refetch: fetchTrends };
}
