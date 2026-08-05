import type { IssueReviewAttention, IssueReviewAttentionPath, IssueStatus } from "@paperclipai/shared";
import {
  Activity,
  AlertTriangle,
  Bell,
  Clock,
  HelpCircle,
  LifeBuoy,
  ShieldCheck,
  UserCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn, relativeTime } from "../lib/utils";
import { StatusGlyph } from "./StatusGlyph";
import { StalledReviewActions } from "./StalledReviewActions";

/** Minimal shape the panel needs — the full `Issue` satisfies it. */
export interface ReviewPanelIssue {
  id: string;
  companyId: string;
  status: IssueStatus;
  reviewAttention?: IssueReviewAttention;
}

const PATH_ICON: Record<IssueReviewAttentionPath["kind"], LucideIcon> = {
  execution_participant: Users,
  interaction: HelpCircle,
  approval: ShieldCheck,
  monitor: Clock,
  human_reviewer: UserCheck,
  active_run: Activity,
  queued_wake: Bell,
  recovery: LifeBuoy,
};

/**
 * Persistent review panel pinned above the thread whenever an issue is
 * `in_review` (PAP-16080 §4.4). Driven by `issue.reviewAttention` (P2):
 *
 *  - **covered** — names WHAT is being reviewed (each maintained path), WHO
 *    decides it, and since when, plus what each outcome does. Keeps a stalled
 *    review from ever being the *only* thing an operator sees, and surfaces the
 *    responder so a covered review reads as "someone has this".
 *  - **stalled** — the amber "nobody is reviewing this" notice with the three
 *    escape actions (approve / request changes / send back), so an agent-owned
 *    review can never become an invisible zombie (the PAP-14994 failure).
 *
 * Renders nothing when the issue is not in review, or when `reviewAttention` is
 * absent (older payloads) — the thread simply shows as it does today.
 */
export function IssueReviewPanel({ issue }: { issue: ReviewPanelIssue }) {
  const reviewAttention = issue.reviewAttention;
  if (issue.status !== "in_review" || !reviewAttention) return null;

  if (reviewAttention.state === "stalled") {
    return <StalledReviewPanel issue={issue} reason={reviewAttention.reason} />;
  }
  if (reviewAttention.state === "covered") {
    return <CoveredReviewPanel reviewAttention={reviewAttention} />;
  }
  return null;
}

function CoveredReviewPanel({ reviewAttention }: { reviewAttention: IssueReviewAttention }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-3"
      data-testid="issue-review-panel"
      data-review-state="covered"
    >
      <div className="flex items-start gap-2">
        <StatusGlyph status="in_review" size="md" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-violet-950 dark:text-violet-100">In review</p>
          <p className="text-xs text-muted-foreground">
            {reviewAttention.reason ?? "This issue has a maintained review path."}
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-1.5" data-testid="issue-review-paths">
        {reviewAttention.paths.map((path, index) => (
          <ReviewPathRow key={`${path.kind}-${path.ref ?? index}`} path={path} />
        ))}
      </ul>

      <p className="text-(length:--text-nano) text-muted-foreground">
        Approving marks this issue done. Requesting changes or sending it back returns it to the
        assignee.
      </p>
    </div>
  );
}

function ReviewPathRow({ path }: { path: IssueReviewAttentionPath }) {
  const Icon = PATH_ICON[path.kind] ?? Activity;
  return (
    <li className="flex items-center gap-2 text-xs" data-review-path-kind={path.kind}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
      <span className="font-medium text-foreground">{path.label}</span>
      {path.responder && (
        <>
          <PathDot />
          <span className="text-muted-foreground">{path.responder}</span>
        </>
      )}
      {path.since && (
        <>
          <PathDot />
          <span className="text-muted-foreground" title={new Date(path.since).toLocaleString()}>
            {relativeTime(path.since)}
          </span>
        </>
      )}
    </li>
  );
}

function PathDot() {
  return (
    <span className="text-muted-foreground/60" aria-hidden>
      ·
    </span>
  );
}

function StalledReviewPanel({
  issue,
  reason,
}: {
  issue: ReviewPanelIssue;
  reason: string | null;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-amber-400/60 bg-amber-50/70 px-4 py-3",
        "dark:border-amber-500/40 dark:bg-amber-500/10",
      )}
      data-testid="issue-review-panel"
      data-review-state="stalled"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-amber-950 dark:text-amber-100">
            Nobody is reviewing this
          </p>
          <p className="text-xs text-amber-900/80 dark:text-amber-100/80">
            {reason
              ?? "No reviewer, interaction, approval, or monitor exists — the review has no owner."}
          </p>
        </div>
      </div>

      <StalledReviewActions issueId={issue.id} companyId={issue.companyId} />
    </div>
  );
}
