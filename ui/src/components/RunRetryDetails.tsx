import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { describeRunRetryState } from "@/lib/runRetryState";

/** Shared with the run page so Storybook exercises the production retry copy. */
export function RunRetryDetails({ run, agentRouteId }: {
  run: Parameters<typeof describeRunRetryState>[0];
  agentRouteId: string;
}) {
  const retry = describeRunRetryState(run);
  if (!retry) return null;
  return <div className="rounded-md border border-border/70 bg-accent/20 px-3 py-2 text-xs leading-5">
    <div className="flex flex-wrap items-center gap-2">
      <span className={cn("rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium", retry.tone)}>{retry.badgeLabel}</span>
      {retry.retryOfRunId && <Link to={`/agents/${agentRouteId}/runs/${retry.retryOfRunId}`} className="font-mono text-foreground hover:underline">{retry.retryOfRunId.slice(0, 8)}</Link>}
    </div>
    {retry.detail && <p className="mt-2 text-muted-foreground">{retry.detail}</p>}
    {retry.secondary && <p className="text-muted-foreground">{retry.secondary}</p>}
  </div>;
}
