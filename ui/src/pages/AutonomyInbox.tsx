import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AutonomyInboxItem } from "@paperclipai/shared";
import { AlertTriangle, Bot, CheckCircle2, FileCheck2, ShieldAlert } from "lucide-react";
import { autonomyApi } from "../api/autonomy";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Link } from "@/lib/router";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "approval_gate", label: "Approvals" },
  { value: "incident", label: "Incidents" },
  { value: "evidence_validation", label: "Evidence" },
  { value: "lane_block", label: "Lane blocks" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];

function kindLabel(kind: AutonomyInboxItem["kind"]) {
  return kind.replace(/_/g, " ");
}

function itemIcon(kind: AutonomyInboxItem["kind"]) {
  if (kind === "approval_gate") return <ShieldAlert className="h-4 w-4" />;
  if (kind === "evidence_validation") return <FileCheck2 className="h-4 w-4" />;
  if (kind === "incident") return <AlertTriangle className="h-4 w-4" />;
  return <Bot className="h-4 w-4" />;
}

function statusTone(status: string) {
  if (["open", "pending", "pending_approval", "blocked", "quarantined"].includes(status)) return "destructive" as const;
  if (["accepted", "approved", "resolved", "active", "running"].includes(status)) return "secondary" as const;
  return "outline" as const;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function itemHref(item: AutonomyInboxItem) {
  if (item.approvalGate?.approvalId) return `/approvals/${item.approvalGate.approvalId}`;
  if (item.issueId) return `/issues/${item.issueId}`;
  if (item.runId) return `/activity?runId=${encodeURIComponent(item.runId)}`;
  return null;
}

function AutonomyInboxRow({ item }: { item: AutonomyInboxItem }) {
  const href = itemHref(item);
  const content = (
    <div className="flex items-start gap-3 p-4 transition-colors hover:bg-accent/40">
      <div className="mt-0.5 rounded-md border border-border bg-background p-2 text-muted-foreground">
        {itemIcon(item.kind)}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate text-sm font-semibold">{item.title}</h2>
          <Badge variant="outline" className="capitalize">{kindLabel(item.kind)}</Badge>
          <Badge variant={statusTone(item.status)} className="capitalize">
            {String(item.status).replace(/_/g, " ")}
          </Badge>
        </div>
        {item.summary ? <p className="text-sm text-muted-foreground">{item.summary}</p> : null}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {item.laneKey ? <span>Lane: {item.laneKey}</span> : null}
          {item.issueId ? <span>Issue: {item.issueId}</span> : null}
          {item.runId ? <span>Run: {item.runId}</span> : null}
          {item.agentId ? <span>Agent: {item.agentId}</span> : null}
          <span>Updated: {formatDate(item.updatedAt)}</span>
        </div>
      </div>
    </div>
  );

  if (!href) return <div>{content}</div>;
  return (
    <Link to={href} className="block" disableIssueQuicklook>
      {content}
    </Link>
  );
}

export function AutonomyInbox() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState<FilterValue>("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Autonomy" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.autonomyInbox(selectedCompanyId!),
    queryFn: () => autonomyApi.inbox(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const counts = useMemo(() => {
    const next: Record<string, number> = { all: data?.length ?? 0 };
    for (const item of data ?? []) next[item.kind] = (next[item.kind] ?? 0) + 1;
    return next;
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data;
    return data.filter((item) => item.kind === filter);
  }, [data, filter]);

  if (!selectedCompanyId) {
    return <EmptyState icon={ShieldAlert} message="Select a company to view autonomy operations." />;
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Autonomy inbox</h1>
          <p className="text-sm text-muted-foreground">
            Operator queue for autonomy gates, incidents, evidence validation, and lane blocks.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={filter === option.value ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(option.value)}
            >
              {option.label}
              <span className="ml-1 text-xs opacity-70">{counts[option.value] ?? 0}</span>
            </Button>
          ))}
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}

      {filtered.length === 0 ? (
        <EmptyState icon={CheckCircle2} message="No autonomy items need operator attention." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
          {filtered.map((item) => <AutonomyInboxRow key={`${item.kind}:${item.id}`} item={item} />)}
        </div>
      )}
    </div>
  );
}
