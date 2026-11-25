import type { PullRequestDetails } from "@/lib/pull-request-display";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { cn } from "@/lib/utils";

export function PullRequestDetailsLine({ details, className }: {
  details: PullRequestDetails | null | undefined;
  className?: string;
}) {
  if (!details) return null;
  const { headSha, mergeLabel } = details;
  return (
    <span className={cn("block text-xs text-muted-foreground", ANALYTICS_MASK_CLASS, className)}>
      {headSha ? <>head <span className="font-mono">{headSha}</span></> : null}
      {headSha && mergeLabel ? " · " : null}
      {mergeLabel}
    </span>
  );
}
