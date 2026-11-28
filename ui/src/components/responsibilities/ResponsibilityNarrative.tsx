import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import type { ResponsibilitySummary as Narrative } from "@paperclipai/shared";
import { responsibilitiesApi } from "@/api/responsibilities";
import { queryKeys } from "@/lib/queryKeys";
import { summaryAttribution, summaryRefetchDelay } from "@/lib/responsibility-summary";
import { useResolvedViewerId } from "@/hooks/useResolvedViewerId";
import { cn } from "@/lib/utils";

/**
 * The paragraph's read: shown as soon as it arrives, read again on a short
 * backoff while a model-written version is on its way, kept on screen while
 * it is read again (no flicker), and quietly absent on failure.
 */
function useNarrative(queryKey: readonly unknown[], queryFn: () => Promise<Narrative>, enabled: boolean) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchInterval: (current) => summaryRefetchDelay(current.state.data, current.state.dataUpdateCount),
  });
  const reads = client.getQueryState(queryKey)?.dataUpdateCount ?? 0;
  const stillWaiting = summaryRefetchDelay(query.data, reads) !== false;
  return { summary: query.data ?? null, stillWaiting };
}

/** The Dashboard's paragraph of where everything stands. */
export function useDashboardNarrative(companyId: string | null | undefined) {
  const { userId } = useResolvedViewerId();
  return useNarrative(
    queryKeys.responsibilities.summary(companyId ?? "__none__", userId),
    () => responsibilitiesApi.companySummary(companyId!),
    !!companyId && !!userId,
  );
}

/** One responsibility's paragraph of what in the work affects its number. */
export function useResponsibilitySummary(responsibilityId: string) {
  return useNarrative(
    queryKeys.responsibilities.detailSummary(responsibilityId),
    () => responsibilitiesApi.summary(responsibilityId),
    !!responsibilityId,
  );
}

/**
 * A written paragraph with a quiet line saying who wrote it (AI, or composed
 * from the numbers) and when. Renders nothing until there is text.
 */
export function NarrativeParagraph({
  summary,
  stillWaiting,
  className,
}: {
  summary: Narrative | null;
  stillWaiting: boolean;
  className?: string;
}) {
  const text = summary?.text.trim();
  if (!summary || !text) return null;
  const attribution = summaryAttribution(summary, stillWaiting);
  const at = new Date(summary.generatedAt);
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-narrative-source={summary.source}>
      <p className="text-sm leading-relaxed text-foreground">{text}</p>
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground" aria-live="polite">
        {summary.source === "model" ? <Sparkles aria-hidden="true" className="size-3 shrink-0" /> : null}
        <span>{attribution.source}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={summary.generatedAt} title={Number.isNaN(at.getTime()) ? undefined : at.toLocaleString()}>
          {attribution.when}
        </time>
        {attribution.pending ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{attribution.pending}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}
