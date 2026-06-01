import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, GitBranch, ShieldCheck, Activity } from "lucide-react";
import { agentsApi, type HermesOrgAgentSummary } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { relativeTime } from "../lib/utils";

function MetricCard({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Bot }) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function AgentCard({ agent }: { agent: HermesOrgAgentSummary }) {
  const latestRun = agent.recentRuns[0] ?? null;
  return (
    <div className="border border-border bg-background p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">{agent.name}</div>
          <div className="text-xs text-muted-foreground font-mono">{agent.profile}</div>
        </div>
        <StatusBadge status={agent.status} />
      </div>
      {agent.charter ? <p className="text-xs text-muted-foreground leading-relaxed">{agent.charter}</p> : null}
      <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="border border-border px-1.5 py-0.5">{agent.cadence ?? "cadence unset"}</span>
        <span className="border border-border px-1.5 py-0.5">{agent.bridgeConnected ? "bridge connected" : "bridge not connected"}</span>
        {latestRun ? (
          <span className="border border-border px-1.5 py-0.5">
            last run: {latestRun.status} · {relativeTime(latestRun.createdAt)}
          </span>
        ) : (
          <span className="border border-border px-1.5 py-0.5">no recent runs</span>
        )}
      </div>
      {agent.review.length > 0 ? (
        <div className="text-xs text-muted-foreground">Review: {agent.review.join(", ")}</div>
      ) : null}
    </div>
  );
}

export function HermesOrg() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Hermes Org" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.hermesOrg(selectedCompanyId!),
    queryFn: () => agentsApi.hermesOrg(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view the Hermes operating org." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (error || !data) {
    return <EmptyState icon={Bot} message="Unable to load the Hermes operating org." />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Hermes Operating Org</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Private Paperclip visibility for Hermes department leads, bridge health, pod membership, reviews, and recent runs.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard label="Lead agents" value={`${data.totalAgents} lead agents`} icon={Bot} />
        <MetricCard label="Active" value={`${data.activeAgents} active`} icon={ShieldCheck} />
        <MetricCard label="Bridge" value={`${data.bridgeAgents} bridge-connected`} icon={GitBranch} />
        <MetricCard label="Live work" value={`${data.runningRuns} running`} icon={Activity} />
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">First activation pod</h2>
          <p className="text-sm text-muted-foreground">Command pod verified for Research → SEO → Content → Visual → QA → Security → COO workflows.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.firstActivationPod.map((agent) => <AgentCard key={agent.id} agent={agent} />)}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Divisions</h2>
        <div className="space-y-3">
          {data.divisions.map((division) => (
            <details key={division.name} className="border border-border bg-card" open={division.runningRunCount > 0}>
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                {division.name} · {division.agentCount} agents · {division.activeCount} active · {division.runningRunCount} running
              </summary>
              <div className="grid gap-3 border-t border-border p-3 md:grid-cols-2 xl:grid-cols-3">
                {division.agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)}
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
