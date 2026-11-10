import { useQuery } from "@tanstack/react-query";
import { EyeOff, ExternalLink, X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { describeError } from "@/api/errors";
import { heartbeatsApi } from "@/api/heartbeats";
import { useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { agentUrl, formatCents } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentStatusBadge, StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { roleLabel } from "./AgentGraphNodes";

const RECENT_RUN_LIMIT = 5;

export function AgentGraphSidePanel({
  agent,
  companyId,
  managerName,
  reportCount,
  onClose,
  onHide,
}: {
  agent: Agent;
  companyId: string;
  managerName: string | null;
  reportCount: number;
  onClose: () => void;
  onHide: () => void;
}) {
  const runsQuery = useQuery({
    queryKey: [...queryKeys.heartbeats(companyId, agent.id), "agent-graph", RECENT_RUN_LIMIT] as const,
    queryFn: () => heartbeatsApi.list(companyId, agent.id, RECENT_RUN_LIMIT, { summary: true }),
  });
  const runsView = useQueryView(runsQuery);
  const runs = runsQuery.data ?? [];
  const href = agentUrl(agent);

  return (
    <aside
      aria-label={`${agent.name} details`}
      data-testid="agent-graph-side-panel"
      className="nowheel flex max-h-full w-80 max-w-full flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg"
    >
      <header className="flex items-start gap-3">
        <AgentAvatar agent={agent} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{agent.name}</h2>
          <p className="truncate text-xs text-muted-foreground">{agent.title ?? roleLabel(agent.role)}</p>
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Close details" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </header>

      <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd className="col-span-2"><AgentStatusBadge status={agent.status} /></dd>
        <dt className="text-muted-foreground">Adapter</dt>
        <dd className="col-span-2 truncate">{getAdapterLabel(agent.adapterType)}</dd>
        <dt className="text-muted-foreground">Reports to</dt>
        <dd className="col-span-2 truncate">{managerName ?? "No manager"}</dd>
        <dt className="text-muted-foreground">Reports</dt>
        <dd className="col-span-2">{reportCount}</dd>
        <dt className="text-muted-foreground">Budget</dt>
        <dd className="col-span-2 font-mono text-xs leading-5">
          {formatCents(agent.spentMonthlyCents)}
          {agent.budgetMonthlyCents > 0 ? ` of ${formatCents(agent.budgetMonthlyCents)}` : " · no limit"}
        </dd>
      </dl>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent runs</h3>
        {runsQuery.data === undefined ? (
          runsView.kind === "error" ? (
            <p role="alert" className="text-sm text-destructive">{describeError(runsView.error, { action: "load recent runs" }).body}</p>
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  to={`${href}/runs/${run.id}`}
                  className="flex items-center justify-between gap-2 py-1.5 text-sm text-inherit no-underline hover:bg-accent/50"
                >
                  <StatusBadge status={run.status} />
                  <span className="text-xs text-muted-foreground">{timeAgo(run.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="flex flex-col gap-2">
        <Button asChild size="sm">
          <Link to={href}>
            <ExternalLink aria-hidden />
            Open agent
          </Link>
        </Button>
        <Button variant="outline" size="sm" onClick={onHide}>
          <EyeOff aria-hidden />
          Hide from graph
        </Button>
        <p className="text-xs text-muted-foreground">
          Pause, resume and terminate stay on the agent page. Hiding only changes your view.
        </p>
      </footer>
    </aside>
  );
}
