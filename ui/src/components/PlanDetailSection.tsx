import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PlanMetadata, PlanMilestone, IssueDocument } from "@paperclipai/shared";
import { CheckCircle2, Circle, Clock, FileText, XCircle, Milestone, ListChecks, Layers } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { parsePlanMetadata } from "../lib/plan-metadata";
import { cn } from "../lib/utils";
import { PlanStatusBadge } from "./PlanStatusBadge";
import { MarkdownBody } from "./MarkdownBody";
import { FoldCurtain } from "./FoldCurtain";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getMilestoneIcon(status: PlanMilestone["status"]) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
    case "in_progress":
      return <Clock className="h-3.5 w-3.5 text-sky-400" />;
    case "cancelled":
      return <XCircle className="h-3.5 w-3.5 text-muted-foreground/60" />;
    case "pending":
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />;
  }
}

function getMilestoneLabel(status: PlanMilestone["status"]): string {
  switch (status) {
    case "completed": return "Completed";
    case "in_progress": return "In Progress";
    case "cancelled": return "Cancelled";
    case "pending": return "Pending";
    default: return status;
  }
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface PlanDetailSectionProps {
  issueId: string;
  issueIdentifier: string | null;
  /** Pass in the plan document from a parent query to avoid double-fetching. */
  planDocument?: IssueDocument | null;
  onPlanUpdated?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PlanDetailSection({
  issueId,
  issueIdentifier,
  planDocument: externalPlanDocument,
  onPlanUpdated,
}: PlanDetailSectionProps) {
  // Fetch plan document if not provided externally
  const { data: fetchedPlanDoc, isLoading } = useQuery({
    queryKey: queryKeys.issues.planDocument(issueId),
    queryFn: () => issuesApi.getPlanDocument(issueId),
    enabled: !externalPlanDocument,
  });

  const planDocument = externalPlanDocument ?? fetchedPlanDoc ?? null;

  const planMetadata = useMemo<PlanMetadata | null>(() => {
    return parsePlanMetadata(planDocument?.planMetadata ?? null);
  }, [planDocument]);

  if (isLoading && !planDocument) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Plan</h3>
        <div className="flex items-center gap-3 rounded-lg border border-border p-4 text-sm text-muted-foreground">
          <Clock className="h-4 w-4 animate-spin" />
          Loading plan...
        </div>
      </div>
    );
  }

  if (!planDocument) {
    return null;
  }

  if (!planMetadata) {
    // Plan document exists but has no structured metadata — show body as markdown
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">Plan</h3>
          <span className="text-[11px] text-muted-foreground/70">No structured metadata</span>
        </div>
        <div className="rounded-lg border border-border bg-card/50 p-4">
          <FoldCurtain>
            <MarkdownBody className="prose prose-sm dark:prose-invert max-w-none">
              {planDocument.body}
            </MarkdownBody>
          </FoldCurtain>
        </div>
      </div>
    );
  }

  const sections = planMetadata.sections ?? [];
  const milestones = planMetadata.milestones ?? [];
  const status = planMetadata.status ?? "draft";
  const version = planMetadata.version ?? 1;

  // Milestone progress
  const totalMilestones = milestones.length;
  const completedMilestones = milestones.filter((m) => m.status === "completed").length;
  const inProgressMilestones = milestones.filter((m) => m.status === "in_progress").length;
  const progressPct = totalMilestones > 0 ? Math.round((completedMilestones / totalMilestones) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* ─── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          Plan
          {issueIdentifier ? (
            <span className="ml-1.5 text-xs text-muted-foreground/60">
              for {issueIdentifier}
            </span>
          ) : null}
        </h3>
        <PlanStatusBadge status={status} />
      </div>

      {/* ─── Metadata row ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <FileText className="h-3 w-3" />
          v{version}
        </span>
        <span className="inline-flex items-center gap-1">
          <Layers className="h-3 w-3" />
          {sections.length} {sections.length === 1 ? "section" : "sections"}
        </span>
        <span className="inline-flex items-center gap-1">
          <ListChecks className="h-3 w-3" />
          {completedMilestones}/{totalMilestones} milestones
        </span>
      </div>

      {/* ─── Milestone progress bar ──────────────────────────────── */}
      {totalMilestones > 0 && (
        <div className="space-y-1.5">
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/50">
            <div
              className="h-full rounded-full bg-emerald-500/70 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
            {inProgressMilestones > 0 && (
              <div
                className="h-full rounded-full bg-sky-500/50 transition-all duration-300"
                style={{ width: `${(inProgressMilestones / totalMilestones) * 100}%` }}
              />
            )}
          </div>
          <div className="flex gap-3 text-[10px] text-muted-foreground/70">
            {completedMilestones > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-emerald-500/70" />
                {completedMilestones} done
              </span>
            )}
            {inProgressMilestones > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-sky-500/50" />
                {inProgressMilestones} in progress
              </span>
            )}
            {totalMilestones - completedMilestones - inProgressMilestones > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                {totalMilestones - completedMilestones - inProgressMilestones} pending
              </span>
            )}
          </div>
        </div>
      )}

      {/* ─── Sections ────────────────────────────────────────────── */}
      {sections.length > 0 && (
        <div className="space-y-3">
          {sections.map((section) => (
            <div
              key={section.id}
              className="rounded-lg border border-border bg-card/50 p-4"
            >
              <h4 className="mb-2 text-sm font-semibold text-foreground">
                {section.title}
              </h4>
              <FoldCurtain>
                <MarkdownBody
                  className="prose prose-sm dark:prose-invert max-w-none"
                  softBreaks={false}
                >
                  {section.body}
                </MarkdownBody>
              </FoldCurtain>
            </div>
          ))}
        </div>
      )}

      {/* ─── Milestones list ─────────────────────────────────────── */}
      {milestones.length > 0 && (
        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground/80">
            <Milestone className="h-3.5 w-3.5" />
            Milestones
          </h4>
          <ul className="space-y-1.5">
            {milestones.map((ms) => (
              <li
                key={ms.id}
                className={cn(
                  "flex items-start gap-2.5 rounded-md border border-border/60 bg-card/30 p-2.5 text-sm",
                  ms.status === "cancelled" && "opacity-50",
                )}
              >
                <span className="mt-0.5 shrink-0">
                  {getMilestoneIcon(ms.status)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{ms.title}</span>
                    <span className="rounded-sm bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {getMilestoneLabel(ms.status)}
                    </span>
                  </div>
                  {ms.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground/80 line-clamp-2">
                      {ms.description}
                    </p>
                  )}
                  {ms.acceptanceCriteria && ms.acceptanceCriteria.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {ms.acceptanceCriteria.map((ac, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-1.5 text-[11px] text-muted-foreground/70"
                        >
                          <span className="mt-1 shrink-0 text-muted-foreground/40">-</span>
                          <span>{ac}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ─── No sections or milestones ───────────────────────────── */}
      {sections.length === 0 && milestones.length === 0 && (
        <div className="rounded-lg border border-border bg-card/50 p-4">
          <FoldCurtain>
            <MarkdownBody
              className="prose prose-sm dark:prose-invert max-w-none"
              softBreaks={false}
            >
              {planDocument.body}
            </MarkdownBody>
          </FoldCurtain>
        </div>
      )}
    </div>
  );
}