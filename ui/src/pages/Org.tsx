import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ChevronRight, GitBranch } from "lucide-react";
import { cn } from "../lib/utils";

function countOrgNodes(nodes: OrgNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countOrgNodes(node.reports), 0);
}

function OrgTree({
  nodes,
  depth = 0,
  hrefFn,
}: {
  nodes: OrgNode[];
  depth?: number;
  hrefFn: (id: string) => string;
}) {
  return (
    <div>
      {nodes.map((node) => (
        <OrgTreeNode key={node.id} node={node} depth={depth} hrefFn={hrefFn} />
      ))}
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  hrefFn,
}: {
  node: OrgNode;
  depth: number;
  hrefFn: (id: string) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.reports.length > 0;

  return (
    <div>
      <Link
        to={hrefFn(node.id)}
        className="paperclip-gov-tree-link flex cursor-pointer items-center gap-2 px-3 py-2 text-sm no-underline text-inherit"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {hasChildren ? (
          <button
            className="p-0.5"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-4" />
        )}
        <span
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            node.status === "active"
              ? "bg-green-400"
              : node.status === "paused"
                ? "bg-yellow-400"
                : node.status === "pending_approval"
                  ? "bg-amber-400"
                : node.status === "error"
                  ? "bg-red-400"
                  : "bg-neutral-400"
          )}
        />
        <span className="font-medium flex-1">{node.name}</span>
        <span className="text-xs text-muted-foreground">{node.role}</span>
        <StatusBadge status={node.status} />
      </Link>
      {hasChildren && expanded && (
        <OrgTree nodes={node.reports} depth={depth + 1} hrefFn={hrefFn} />
      )}
    </div>
  );
}

export function Org() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={GitBranch} message="Select a company to view org chart." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const rootCount = data?.length ?? 0;
  const totalCount = countOrgNodes(data ?? []);

  return (
    <div className="space-y-5">
      <section className="paperclip-gov-hero px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="space-y-3">
            <p className="paperclip-gov-kicker">Reporting Graph</p>
            <div className="space-y-2">
              <h1 className="paperclip-gov-title">Org Chart</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Inspect command hierarchy, management span, and status posture across the full operating tree.
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="paperclip-gov-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-gov-label">Roots</p>
              <p className="mt-2 text-2xl font-semibold">{rootCount}</p>
            </div>
            <div className="paperclip-gov-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-gov-label">Agents</p>
              <p className="mt-2 text-2xl font-semibold">{totalCount}</p>
            </div>
            <div className="paperclip-gov-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-gov-label">Depth</p>
              <p className="mt-2 text-2xl font-semibold">{rootCount > 0 ? "Live" : "Idle"}</p>
            </div>
          </div>
        </div>
      </section>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon={GitBranch}
          message="No agents in the organization. Create agents to build your org chart."
        />
      )}

      {data && data.length > 0 && (
        <div className="paperclip-gov-card p-2 sm:p-3">
          <OrgTree nodes={data} hrefFn={(id) => `/agents/${id}`} />
        </div>
      )}
    </div>
  );
}
