import { useState, useCallback } from "react";
import type {
  BriefingFeedbackRating,
  BriefingFeedbackCategory,
  BriefingFeedback,
} from "@paperclipai/shared";

interface UseBriefingFeedbackOptions {
  apiUrl: string;
}

interface UseBriefingFeedbackReturn {
  submit: (
    briefingId: string,
    rating: BriefingFeedbackRating,
    category?: BriefingFeedbackCategory | null,
    freeText?: string | null,
    userId?: string | null,
  ) => Promise<BriefingFeedback>;
  loading: boolean;
  error: string | null;
}

export function useBriefingFeedback(
  options: UseBriefingFeedbackOptions,
): UseBriefingFeedbackReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (
      briefingId: string,
      rating: BriefingFeedbackRating,
      category?: BriefingFeedbackCategory | null,
      freeText?: string | null,
      userId?: string | null,
    ): Promise<BriefingFeedback> => {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`${options.apiUrl}/api/feedback/briefing`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            briefingId,
            rating,
            category: category ?? null,
            freeText: freeText ?? null,
            userId: userId ?? "anonymous",
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Feedback submission failed (${res.status}): ${body}`);
        }

        return (await res.json()) as BriefingFeedback;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [options.apiUrl],
  );

  return { submit, loading, error };
}
