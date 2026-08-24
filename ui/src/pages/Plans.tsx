import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue, IssueDocument, PlanMetadata } from "@paperclipai/shared";
import {
  FileText,
  Layers,
  ListChecks,
  Loader2,
  Milestone,
  Search,
  X,
  ArrowUpDown,
  ShieldCheck,
  FileDiff,
} from "lucide-react";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PlanStatusBadge } from "../components/PlanStatusBadge";
import { FreshnessDot } from "../components/ui/FreshnessCue";
import { FadeIn } from "../components/ui/FadeIn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { parsePlanMetadata } from "../lib/plan-metadata";
import { usePageMeta } from "../hooks/usePageMeta";

// ─── Constants ──────────────────────────────────────────────────────────────

const PLANS_PAGE_SIZE = 100;
const PLAN_STATUS_OPTIONS = ["all", "draft", "in_review", "approved", "superseded"] as const;
type PlanStatusFilter = (typeof PLAN_STATUS_OPTIONS)[number];

type SortField = "updated" | "title" | "milestoneProgress";

interface PlanListItem {
  issue: Issue;
  planDocument: IssueDocument;
  planMetadata: PlanMetadata | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function milestoneProgress(metadata: PlanMetadata | null): {
  completed: number;
  total: number;
  pct: number;
} {
  const total = metadata?.milestones?.length ?? 0;
  const completed = metadata?.milestones?.filter((m) => m.status === "completed").length ?? 0;
  return {
    completed,
    total,
    pct: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

// ─── Page ───────────────────────────────────────────────────────────────────

  usePageMeta("Plans", "View and manage plans and strategies.");
export function Plans() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<PlanStatusFilter>("all");
  const [sortField, setSortField] = useState<SortField>("updated");

  useEffect(() => {
    setBreadcrumbs([{ label: "Plans" }]);
  }, [setBreadcrumbs]);

  const issueLinkState = useMemo(
    () => createIssueDetailLocationState("Plans", "/plans"),
    [],
  );

  // Fetch issues that have a plan document
  const { data: planIssues, isLoading, error } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "has-plan-document",
      "plans-browser",
    ],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        hasPlanDocument: true,
        limit: PLANS_PAGE_SIZE,
        offset: 0,
        sortField: "updated",
        sortDir: "desc",
      }),
    enabled: !!selectedCompanyId,
  });

  // Plan documents are returned inline on each issue when hasPlanDocument=true
  const items = useMemo<PlanListItem[]>(() => {
    const issues = planIssues ?? [];
    const list: PlanListItem[] = [];
    for (const issue of issues) {
      const doc = issue.planDocument ?? null;
      if (!doc) continue;
      const planMetadata = parsePlanMetadata(doc.planMetadata);
      list.push({ issue, planDocument: doc, planMetadata });
    }
    return list;
  }, [planIssues]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    let result = items.filter((item) => {
      if (statusFilter !== "all" && (item.planMetadata?.status ?? "draft") !== statusFilter) {
        return false;
      }
      if (!q) return true;
      const haystack = [
        item.issue.identifier,
        item.issue.title,
        item.issue.description ?? "",
        item.planMetadata?.sections?.map((s) => s.title).join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });

    result = [...result].sort((a, b) => {
      switch (sortField) {
        case "title":
          return a.issue.title.localeCompare(b.issue.title);
        case "milestoneProgress":
          return milestoneProgress(b.planMetadata).pct - milestoneProgress(a.planMetadata).pct;
        case "updated":
        default:
          return new Date(b.issue.updatedAt).getTime() - new Date(a.issue.updatedAt).getTime();
      }
    });
    return result;
  }, [items, search, statusFilter, sortField]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const item of items) {
      const status = item.planMetadata?.status ?? "draft";
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  if (!selectedCompanyId) {
    return <EmptyState icon={FileText} message="Select a company to view plans." />;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Plans</h1>
          <p className="text-xs text-muted-foreground">
            Browse structured plans across issues — status, sections, milestone progress.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search plans..."
              className="h-8 w-56 pl-8 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as PlanStatusFilter)}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {PLAN_STATUS_OPTIONS.map((status) => (
                <SelectItem key={status} value={status} className="text-xs">
                  {status === "all" ? "All statuses" : status.replace("_", " ")}
                  {" "}
                  <span className="text-muted-foreground/60">
                    ({statusCounts[status] ?? 0})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sortField}
            onValueChange={(v) => setSortField(v as SortField)}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <ArrowUpDown className="mr-1 h-3 w-3" />
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated" className="text-xs">Recently updated</SelectItem>
              <SelectItem value="title" className="text-xs">Title</SelectItem>
              <SelectItem value="milestoneProgress" className="text-xs">Milestone progress</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Loading / Error */}
      {isLoading ? (
        <PageSkeleton />
      ) : error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">
          Failed to load plans: {(error as Error).message}
        </div>
      ) : null}

      {/* Empty state */}
      {!isLoading && items.length === 0 && (
        <div className="space-y-1">
          <EmptyState
            icon={FileText}
            message="No plans yet"
          />
          <p className="-mt-8 text-center text-xs text-muted-foreground">
            Issues with a plan document (key 'plan') will appear here with their status, sections, and milestone progress.
          </p>
        </div>
      )}

      {/* Plan cards — fade in after skeleton */}
      {!isLoading && items.length > 0 && (
        <FadeIn delayMs={50} durationMs={400}>
          <div className="space-y-2">
          {filteredItems.length === 0 && (
            <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
              No plans match the current filters.
            </div>
          )}
          {filteredItems.map((item) => {
            const metadata = item.planMetadata;
            const status = metadata?.status ?? "draft";
            const sectionCount = metadata?.sections?.length ?? 0;
            const progress = milestoneProgress(metadata);
            const revisionNumber = item.planDocument.latestRevisionNumber ?? 0;
            const gatesCount = item.planDocument.gatesCount ?? 0;

            return (
              <Link
                key={item.issue.id}
                to={`/issues/${item.issue.id}`}
                state={issueLinkState}
                className="block rounded-lg border border-border bg-card/50 p-4 transition-colors hover:border-primary/40 hover:bg-accent/50"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {item.issue.identifier}
                      </span>
                      <FreshnessDot updatedAt={item.issue.updatedAt} />
                      <PlanStatusBadge status={status} />
                    </div>
                    <h2 className="mt-1 text-sm font-semibold text-foreground line-clamp-2">
                      {item.issue.title}
                    </h2>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Layers className="h-3 w-3" />
                        {sectionCount} {sectionCount === 1 ? "section" : "sections"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <ListChecks className="h-3 w-3" />
                        {progress.completed}/{progress.total} milestones done
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <FileDiff className="h-3 w-3" />
                        rev {revisionNumber}
                      </span>
                      {metadata?.version != null && (
                        <span className="inline-flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          v{metadata.version}
                        </span>
                      )}
                      {gatesCount > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <ShieldCheck className="h-3 w-3" />
                          {gatesCount} gates
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="w-40 shrink-0">
                    <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground/70">
                      <span className="inline-flex items-center gap-1">
                        <Milestone className="h-3 w-3" />
                        Progress
                      </span>
                      <span>{progress.pct}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/50">
                      <div
                        className="h-full rounded-full bg-emerald-500/70"
                        style={{ width: `${progress.pct}%` }}
                      />
                    </div>
                    {metadata?.milestones && metadata.milestones.length > 0 && (
                      <div className="mt-1 flex gap-1">
                        {metadata.milestones.slice(0, 6).map((m) => (
                          <span
                            key={m.id}
                            title={m.title}
                            className={cn(
                              "h-1.5 flex-1 rounded-full",
                              m.status === "completed" && "bg-emerald-500/70",
                              m.status === "in_progress" && "bg-sky-500/50",
                              m.status === "cancelled" && "bg-muted-foreground/20",
                              m.status === "pending" && "bg-muted-foreground/30",
                            )}
                          />
                        ))}
                        {metadata.milestones.length > 6 && (
                          <span className="text-[9px] text-muted-foreground/50">
                            +{metadata.milestones.length - 6}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
          </div>
        </FadeIn>
      )}
    </div>
  );
}