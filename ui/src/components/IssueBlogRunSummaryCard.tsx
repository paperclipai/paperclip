import { useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileStack } from "lucide-react";
import { blogRunsApi, type BlogRunListItem } from "../api/blogRuns";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";

interface IssueBlogRunSummaryCardProps {
  companyId: string;
  issueId: string;
}

function summarizeState(run: BlogRunListItem) {
  if (run.status === "failed") return { label: "Failed", tone: "danger" as const };
  if (run.status === "review_required" || run.status === "human_review_backlog") {
    return { label: "Needs review", tone: "warning" as const };
  }
  if (run.status === "publish_approval_pending") {
    return { label: "Awaiting approval", tone: "warning" as const };
  }
  if (run.status === "public_verify_running" || run.currentStep === "public_verify") {
    return { label: "Public verify", tone: "active" as const };
  }
  if (run.status === "publish_running" || run.currentStep === "publish") {
    return { label: "Publishing", tone: "active" as const };
  }
  if (run.currentStep) {
    return { label: run.currentStep.replaceAll("_", " "), tone: "active" as const };
  }
  return { label: run.status.replaceAll("_", " "), tone: "neutral" as const };
}

function toneClass(tone: "active" | "warning" | "danger" | "neutral") {
  if (tone === "active") return "border-cyan-500/20 bg-cyan-500/[0.08] text-cyan-700 dark:text-cyan-300";
  if (tone === "warning") return "border-amber-500/20 bg-amber-500/[0.10] text-amber-700 dark:text-amber-300";
  if (tone === "danger") return "border-red-500/20 bg-red-500/[0.10] text-red-700 dark:text-red-300";
  return "border-border/70 bg-muted/30 text-muted-foreground";
}

function summaryChip(label: string, value: string) {
  return (
    <span className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
      {label}: {value.replaceAll("_", " ")}
    </span>
  );
}

function blockerText(run: BlogRunListItem) {
  if (run.latestVerify?.failureNames && run.latestVerify.failureNames.length > 0) {
    return `verify failures: ${run.latestVerify.failureNames.join(", ")}`;
  }
  if (run.latestVerify?.summary) return run.latestVerify.summary;
  if (run.failedReason) return run.failedReason;
  if (run.latestAttempt?.errorMessage) return run.latestAttempt.errorMessage;
  if (run.status === "publish_approval_pending" && run.latestApproval?.targetSlug) {
    return `approval target: ${run.latestApproval.targetSlug}`;
  }
  if (run.approval.state === "approved" && run.latestApproval?.targetSlug) {
    return `approved for ${run.latestApproval.targetSlug}`;
  }
  return null;
}

export function IssueBlogRunSummaryCard({ companyId, issueId }: IssueBlogRunSummaryCardProps) {
  const { data } = useQuery({
    queryKey: queryKeys.blogRuns.list(companyId, "active", 10),
    queryFn: () => blogRunsApi.listForCompany(companyId, { mode: "active", limit: 10 }),
    enabled: Boolean(companyId && issueId),
  });

  const run = useMemo(() => (data ?? []).find((entry) => entry.issueId === issueId) ?? null, [data, issueId]);

  if (!run) return null;

  const state = summarizeState(run);
  const blocker = blockerText(run);

  return (
    <div className="rounded-lg border border-border bg-background/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Linked blog run</p>
          <p className="mt-1 text-xs text-muted-foreground">Updated {relativeTime(run.updatedAt)}</p>
        </div>
        <div className="flex items-center gap-2">
          {run.publishedUrl ? (
            <a
              href={run.publishedUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ) : null}
          <Link
            to={`/blog-runs/${run.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <FileStack className="h-2.5 w-2.5" />
          </Link>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em]", toneClass(state.tone))}>
          {state.label}
        </span>
      </div>
      <p className="mt-3 line-clamp-2 text-sm font-medium text-foreground">
        {run.topic}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {summaryChip("approval", run.approval.state)}
        {summaryChip("publish", run.publish.state)}
        {summaryChip("verify", run.publicVerify.state)}
      </div>
      {blocker ? (
        <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">
          {blocker}
        </p>
      ) : null}
    </div>
  );
}
