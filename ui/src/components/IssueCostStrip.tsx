import { useQuery } from "@tanstack/react-query";
import type { IssueCostSummary } from "@paperclipai/shared";
import { DollarSign } from "lucide-react";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";

function formatUsd(cents: number): string {
  const usd = cents / 100;
  if (usd < 0.01) return "$0.00";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

interface IssueCostStripProps {
  companyId: string;
  issueId: string;
  /** Identifier (e.g. SHA-1897) when available; fallback to raw UUID. */
  issueIdentifier?: string | null;
}

export function IssueCostStrip({ companyId, issueId, issueIdentifier }: IssueCostStripProps) {
  const key = issueIdentifier ?? issueId;
  const { data, isLoading, isError } = useQuery<IssueCostSummary>({
    queryKey: queryKeys.issues.costSummary(companyId, key),
    queryFn: () => costsApi.issueSummary(companyId, key),
    staleTime: 30_000,
  });

  if (isError) return null;
  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <DollarSign className="h-3.5 w-3.5" />
        <Skeleton className="h-3 w-40" />
      </div>
    );
  }
  if (!data || data.totalCostCents === 0) return null;

  const agentCount = data.topContributors.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors rounded-md px-1.5 py-0.5 -mx-1.5 hover:bg-muted/60"
          title="Click for per-agent breakdown"
        >
          <DollarSign className="h-3.5 w-3.5" />
          <span className="font-medium text-foreground">{formatUsd(data.totalCostCents)}</span>
          <span>·</span>
          <span>{data.runs} {data.runs === 1 ? "run" : "runs"}</span>
          <span>·</span>
          <span>{agentCount} {agentCount === 1 ? "agent" : "agents"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="px-3 py-2 border-b">
          <div className="text-xs font-medium">Cost breakdown</div>
          <div className="text-[11px] text-muted-foreground">
            {formatUsd(data.totalCostCents)} across {data.runs} {data.runs === 1 ? "run" : "runs"}
          </div>
        </div>
        <ul className="max-h-80 overflow-auto divide-y">
          {data.topContributors.map((c) => (
            <li key={c.agentId} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="truncate flex-1">{c.agentName ?? "(unknown agent)"}</span>
              <span className="tabular-nums text-muted-foreground">{c.runs}×</span>
              <span className="tabular-nums font-medium w-14 text-right">
                {formatUsd(c.costCents)}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
