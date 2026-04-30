import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { estimateApiEquivalentCents, formatCents } from "../lib/utils";

interface SubscriptionEstimateProps {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  model?: string | null;
  className?: string;
}

export function SubscriptionEstimate({
  inputTokens,
  cachedInputTokens,
  outputTokens,
  model,
  className,
}: SubscriptionEstimateProps) {
  const estimatedCents = estimateApiEquivalentCents(inputTokens, cachedInputTokens, outputTokens, model);
  if (estimatedCents === 0) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground ${className ?? ""}`}
          >
            {formatCents(estimatedCents)} est.
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs">
          API-equivalent estimate based on token usage and published pricing. Subscription runs have $0 actual cost — this shows what the same usage would cost via direct API.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
