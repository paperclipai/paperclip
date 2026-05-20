// LET-503 (LET-502 contract §5 + CEO comment 420a4229) — first-class
// `/eaos/org` route. The page now renders a real graph canvas backed by
// `agentsApi.org`, with a right details sidebar on selection and pan /
// zoom / fit controls on the canvas itself. When the org backend returns
// no reporting relationships we synthesise a truthful flat fallback tree
// from `agentsApi.list` (CEO-like roles as roots, the rest under an
// implicit root) so the surface is always populated when agents exist —
// and the gap note still explains that the reporting-graph endpoint is
// not wired.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { agentsApi, type OrgNode } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { AGENT_ROLE_LABELS, type AgentRole, type Agent } from "@paperclipai/shared";
import { redactSecretLikeText } from "../secret-redact";
import { EaosOrgGraph, type EaosOrgGraphNodeDecoration } from "./EaosOrgGraph";

const LEADERSHIP_ROLES: ReadonlySet<AgentRole> = new Set(["ceo", "cto", "cmo", "cfo"]);

export function OrgPage() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.agents.list(selectedCompanyId), "eaos-org"]
      : ["agents", "__no-company__", "eaos-org"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const orgQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.org(selectedCompanyId), "eaos-org-graph"]
      : ["org", "__no-company__", "eaos-org-graph"],
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const agents = agentsQuery.data ?? [];
  const orgTree = orgQuery.data ?? [];

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const tree = useMemo<OrgNode[]>(() => {
    if (orgTree.length > 0 && hasReports(orgTree)) return orgTree;
    return synthesizeTree(agents);
  }, [orgTree, agents]);

  const treeBackendSource = useMemo<"backend" | "derived" | "empty">(() => {
    if (orgTree.length > 0 && hasReports(orgTree)) return "backend";
    if (agents.length > 0) return "derived";
    return "empty";
  }, [orgTree, agents]);

  const decorate = useMemo(() => {
    return (node: OrgNode): EaosOrgGraphNodeDecoration => {
      const agent = agentMap.get(node.id);
      const role = (agent?.role ?? (node.role as AgentRole)) as AgentRole;
      const roleLabel = AGENT_ROLE_LABELS[role] ?? node.role ?? "—";
      const reportsCount = node.reports.length;
      const workloadLabel =
        reportsCount > 0
          ? `${reportsCount} ${reportsCount === 1 ? "report" : "reports"}`
          : null;
      return { roleLabel, workloadLabel };
    };
  }, [agentMap]);

  const selectedAgent = selectedId ? agentMap.get(selectedId) ?? null : null;

  const isLoading =
    Boolean(selectedCompanyId) && (agentsQuery.isLoading || orgQuery.isLoading);
  const isError = Boolean(selectedCompanyId) && (agentsQuery.isError || orgQuery.isError);
  const dataConnected =
    !isLoading &&
    !isError &&
    agentsQuery.isSuccess &&
    orgQuery.isSuccess &&
    treeBackendSource !== "empty";

  return (
    <section
      aria-labelledby="eaos-org-title"
      data-testid="eaos-org-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
      data-eaos-org-source={treeBackendSource}
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
        <h1
          id="eaos-org-title"
          className="text-xl font-semibold tracking-tight text-foreground"
          data-testid="eaos-org-title"
        >
          Org
        </h1>
        {selectedCompany ? (
          <span className="text-xs text-muted-foreground">
            {redactSecretLikeText(selectedCompany.name)}
          </span>
        ) : null}
      </header>

      {!selectedCompanyId ? (
        <ContextNote
          testId="eaos-org-no-company"
          body="Select a company scope in the top bar to load the org."
        />
      ) : isLoading ? (
        <ContextNote testId="eaos-org-loading" body="Loading org structure…" />
      ) : isError ? (
        <ContextNote
          testId="eaos-org-error"
          tone="error"
          body="Could not load the org. Try refreshing."
        />
      ) : tree.length === 0 ? (
        <ContextNote
          testId="eaos-org-empty"
          body="No agents in this scope yet. The org graph will appear here once agents are onboarded."
        />
      ) : (
        <div
          data-testid="eaos-org-layout"
          className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]"
        >
          <div className="relative flex min-h-[420px] min-w-0 flex-col lg:min-h-0">
            <EaosOrgGraph
              tree={tree}
              decorate={decorate}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId(id)}
              ariaLabel="Org graph canvas"
            />
          </div>
          <OrgDetailsPanel
            selectedId={selectedId}
            selectedAgent={selectedAgent}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}

      <GapNote source={treeBackendSource} />
    </section>
  );
}

function OrgDetailsPanel({
  selectedId,
  selectedAgent,
  onClose,
}: {
  selectedId: string | null;
  selectedAgent: Agent | null;
  onClose: () => void;
}) {
  if (!selectedId) {
    return (
      <aside
        aria-label="Org details"
        data-testid="eaos-org-details-empty"
        className="hidden min-h-0 flex-col rounded-md border border-dashed border-border bg-card p-3 text-xs text-muted-foreground lg:flex"
      >
        Select a node in the graph to view details.
      </aside>
    );
  }

  const name = selectedAgent?.name ?? "Unknown agent";
  const role = (selectedAgent?.role ?? null) as AgentRole | null;
  const roleLabel = role ? AGENT_ROLE_LABELS[role] ?? role : "—";
  const status = selectedAgent?.status ?? "unknown";
  const adapterType = selectedAgent?.adapterType ?? "—";
  const title = selectedAgent?.title ?? null;
  const capabilities = selectedAgent?.capabilities ?? null;
  const detailHref = selectedAgent
    ? `/agents/${encodeURIComponent(selectedAgent.urlKey || selectedAgent.id)}`
    : `/agents/${encodeURIComponent(selectedId)}`;

  return (
    <aside
      aria-label="Org details"
      data-testid="eaos-org-details"
      className="flex min-h-0 flex-col rounded-md border border-border bg-card"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-foreground">
            {redactSecretLikeText(name)}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{roleLabel}</div>
        </div>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-org-details-close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <dl className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3 py-2 text-[12px]">
        {title ? (
          <DetailRow label="Title" value={redactSecretLikeText(title)} />
        ) : null}
        <DetailRow label="Status" value={status} />
        <DetailRow label="Adapter" value={adapterType} mono />
        {capabilities ? (
          <DetailRow label="Capabilities" value={redactSecretLikeText(capabilities)} />
        ) : null}
        {!selectedAgent ? (
          <p className="rounded-md border border-dashed border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">
            Agent record not found in this scope. The graph node references an
            agent ID that the agents API did not return.
          </p>
        ) : null}
      </dl>
      <footer className="border-t border-border px-3 py-2">
        <Link
          to={detailHref}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-org-details-link"
        >
          Open agent profile <ExternalLink className="h-3 w-3" />
        </Link>
      </footer>
    </aside>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={
          "text-[12px] text-foreground " + (mono ? "font-mono uppercase tracking-wide" : "")
        }
      >
        {value}
      </dd>
    </div>
  );
}

function GapNote({ source }: { source: "backend" | "derived" | "empty" }) {
  let body: string;
  if (source === "backend") {
    body =
      "Reporting lines come from the company org. Workload-based connections are coming soon.";
  } else if (source === "derived") {
    body =
      "Reporting lines are inferred from agent roles. A dedicated team graph is coming soon.";
  } else {
    body = "This view will populate as agents are onboarded.";
  }
  return (
    <p
      data-testid="eaos-org-gap-note"
      className="text-[11px] text-muted-foreground"
    >
      {body}
    </p>
  );
}

function ContextNote({
  body,
  tone = "muted",
  testId,
}: {
  body: string;
  tone?: "muted" | "error";
  testId?: string;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className={
        "rounded-md border px-3 py-2 text-xs " +
        (tone === "error"
          ? "border-red-200 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
          : "border-dashed border-border bg-card text-muted-foreground")
      }
    >
      {body}
    </p>
  );
}

function hasReports(tree: readonly OrgNode[]): boolean {
  for (const node of tree) {
    if (node.reports.length > 0) return true;
    if (hasReports(node.reports)) return true;
  }
  return false;
}

function synthesizeTree(agents: readonly Agent[]): OrgNode[] {
  if (agents.length === 0) return [];

  const liveAgents = agents.filter((agent) => agent.status !== "terminated");
  const source = liveAgents.length > 0 ? liveAgents : agents;

  const leaders = source.filter((agent) => LEADERSHIP_ROLES.has(agent.role));
  const followers = source.filter((agent) => !LEADERSHIP_ROLES.has(agent.role));

  const compareByName = (a: Agent, b: Agent) => a.name.localeCompare(b.name);
  leaders.sort(compareByName);
  followers.sort(compareByName);

  const followerNodes: OrgNode[] = followers.map((agent) => agentToNode(agent));

  if (leaders.length === 0) {
    return followerNodes;
  }

  const [primaryLeader, ...otherLeaders] = leaders;
  const primaryNode = agentToNode(primaryLeader, followerNodes);
  return [primaryNode, ...otherLeaders.map((agent) => agentToNode(agent))];
}

function agentToNode(agent: Agent, reports: OrgNode[] = []): OrgNode {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    reports,
  };
}
