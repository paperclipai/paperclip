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
import { useLocalizedCopy } from "../i18n/ui-copy";

function OrgTree({
  nodes,
  depth = 0,
  hrefFn,
  copy,
}: {
  nodes: OrgNode[];
  depth?: number;
  hrefFn: (id: string) => string;
  copy: ReturnType<typeof useLocalizedCopy>;
}) {
  return (
    <div>
      {nodes.map((node) => (
        <OrgTreeNode key={node.id} node={node} depth={depth} hrefFn={hrefFn} copy={copy} />
      ))}
    </div>
  );
}

function orgRoleLabel(role: string, copy: ReturnType<typeof useLocalizedCopy>) {
  const normalized = role.trim().toLowerCase();
  if (normalized === "ceo") return copy("org.role.ceo", "CEO", "대표");
  if (normalized === "engineer") return copy("org.role.engineer", "Engineer", "개발자");
  if (normalized === "researcher") return copy("org.role.researcher", "Researcher", "조사원");
  if (normalized === "manager") return copy("org.role.manager", "Manager", "관리자");
  if (normalized === "designer") return copy("org.role.designer", "Designer", "디자이너");
  if (normalized === "operator") return copy("org.role.operator", "Operator", "운영자");
  return role;
}

function OrgTreeNode({
  node,
  depth,
  hrefFn,
  copy,
}: {
  node: OrgNode;
  depth: number;
  hrefFn: (id: string) => string;
  copy: ReturnType<typeof useLocalizedCopy>;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.reports.length > 0;

  return (
    <div>
      <Link
        to={hrefFn(node.id)}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer hover:bg-accent/50 no-underline text-inherit"
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
        <span className="text-xs text-muted-foreground">{orgRoleLabel(node.role, copy)}</span>
        <StatusBadge status={node.status} />
      </Link>
      {hasChildren && expanded && (
        <OrgTree nodes={node.reports} depth={depth + 1} hrefFn={hrefFn} copy={copy} />
      )}
    </div>
  );
}

export function Org() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const copy = useLocalizedCopy();

  useEffect(() => {
    setBreadcrumbs([{ label: copy("org.breadcrumb", "Org Chart", "조직도") }]);
  }, [copy, setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={GitBranch}
        message={copy("org.noCompany", "Select a company to view org chart.", "조직도를 보려면 회사를 선택하세요.")}
      />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon={GitBranch}
          message={copy(
            "org.empty",
            "No agents in the organization. Create agents to build your org chart.",
            "조직에 직원이 없습니다. 직원을 만들어 조직도를 구성하세요.",
          )}
        />
      )}

      {data && data.length > 0 && (
        <div className="border border-border py-1">
          <OrgTree nodes={data} hrefFn={(id) => `/agents/${id}`} copy={copy} />
        </div>
      )}
    </div>
  );
}
