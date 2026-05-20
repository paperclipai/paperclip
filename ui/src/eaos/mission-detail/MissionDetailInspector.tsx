// LET-467 — right inspector rail for the EAOS Mission detail page.
//
// Read-only properties, blocker count, gate/approval status, runtime, safety
// posture, and a single demoted Kernel/Admin link. No mutating controls.

import { Link } from "@/lib/router";
import type { Approval, Issue, IssuePriority, IssueStatus, IssueWorkMode } from "@paperclipai/shared";
import { EaosStateChip } from "../EaosStateChip";
import type { ActiveRunForIssue, LiveRunForIssue } from "@/api/heartbeats";
import { useEaosViewerRole } from "../useEaosViewerRole";

// LET-503 round-6: customer-facing inspector never surfaces raw enum tokens.
// Status / Priority / Work mode are normalized to product copy so the right
// rail reads like enterprise product UI, not an issue-tracker dump.
const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Queued",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

const PRIORITY_LABEL: Record<IssuePriority, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const WORK_MODE_LABEL: Record<IssueWorkMode, string> = {
  standard: "Standard",
  planning: "Planning",
};

interface MissionDetailInspectorProps {
  issue: Issue;
  owner: string;
  approvals: ReadonlyArray<Approval>;
  activeRun: ActiveRunForIssue | null;
  liveRuns: ReadonlyArray<LiveRunForIssue>;
}

function approvalSummary(approvals: ReadonlyArray<Approval>): string {
  if (approvals.length === 0) return "No approvals linked";
  const counts: Record<string, number> = {};
  for (const a of approvals) {
    counts[a.status] = (counts[a.status] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(" · ");
}

function runtimeSummary(active: ActiveRunForIssue | null, live: ReadonlyArray<LiveRunForIssue>): string {
  if (active) {
    return `${active.agentName} · ${active.adapterType} · ${active.status}`;
  }
  if (live.length > 0) {
    return `${live.length} live run${live.length === 1 ? "" : "s"}`;
  }
  return "No active run";
}

export function MissionDetailInspector({
  issue,
  owner,
  approvals,
  activeRun,
  liveRuns,
}: MissionDetailInspectorProps) {
  const kernelHref = `/issues/${issue.identifier ?? issue.id}`;
  // LET-503 round-5: operator-gate the Safety posture chips, the
  // "No approval, deploy..." paragraph, and the Related/Kernel link.
  const { isOperator } = useEaosViewerRole();
  return (
    <aside
      aria-label="Mission properties"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
      data-testid="eaos-mission-detail-inspector"
    >
      <section aria-labelledby="eaos-mission-inspector-properties-title" className="flex flex-col gap-2">
        <h2
          id="eaos-mission-inspector-properties-title"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Properties
        </h2>
        <dl className="grid grid-cols-1 gap-y-1 text-xs">
          <PropRow label="Status" value={STATUS_LABEL[issue.status] ?? issue.status} />
          <PropRow label="Priority" value={PRIORITY_LABEL[issue.priority] ?? issue.priority} />
          <PropRow label="Work mode" value={WORK_MODE_LABEL[issue.workMode] ?? issue.workMode} />
          <PropRow label="Owner" value={owner} />
          <PropRow label="Project" value={issue.project?.name ?? "—"} />
          <PropRow label="Parent" value={issue.parentId ? "Linked" : "—"} />
        </dl>
      </section>

      <section aria-labelledby="eaos-mission-inspector-blockers-title" className="flex flex-col gap-2">
        <h2
          id="eaos-mission-inspector-blockers-title"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Blockers
        </h2>
        <p className="text-xs text-foreground" data-testid="eaos-mission-inspector-blockers">
          {!issue.blockerAttention || issue.blockerAttention.state === "none"
            ? "No unresolved blockers."
            : `${issue.blockerAttention.unresolvedBlockerCount} unresolved · state ${issue.blockerAttention.state}`}
        </p>
      </section>

      <section aria-labelledby="eaos-mission-inspector-approvals-title" className="flex flex-col gap-2">
        <h2
          id="eaos-mission-inspector-approvals-title"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Approvals
        </h2>
        <p className="text-xs text-foreground" data-testid="eaos-mission-inspector-approvals">
          {approvalSummary(approvals)}
        </p>
      </section>

      <section aria-labelledby="eaos-mission-inspector-runtime-title" className="flex flex-col gap-2">
        <h2
          id="eaos-mission-inspector-runtime-title"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Runtime
        </h2>
        <p className="text-xs text-foreground" data-testid="eaos-mission-inspector-runtime">
          {runtimeSummary(activeRun, liveRuns)}
        </p>
      </section>

      {isOperator ? (
        <section aria-labelledby="eaos-mission-inspector-safety-title" className="flex flex-col gap-2">
          <h2
            id="eaos-mission-inspector-safety-title"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Safety posture
          </h2>
          <div className="flex flex-wrap gap-1.5" data-testid="eaos-mission-inspector-safety">
            <EaosStateChip
              label="PREVIEW"
              prefix="Slice"
              title="Read-only EAOS slice; sensitive text is masked before display."
            />
            <EaosStateChip
              label="DRY-RUN"
              prefix="Actions"
              title="No mutating actions available in this slice."
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            No approval, deploy, release, runtime, spend, secret, external write, or live campaign
            controls in the EAOS detail view. Use Kernel/Admin if you need a mutation surface.
          </p>
        </section>
      ) : null}

      {isOperator ? (
        <section aria-labelledby="eaos-mission-inspector-links-title" className="flex flex-col gap-2">
          <h2
            id="eaos-mission-inspector-links-title"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Related
          </h2>
          <Link
            to={kernelHref}
            data-testid="eaos-mission-inspector-kernel-link"
            aria-label={`Open Kernel/Admin view for ${issue.identifier ?? issue.title}`}
            className="inline-flex w-fit items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span aria-hidden="true">⎈</span>
            <span>Kernel / Admin view</span>
          </Link>
        </section>
      ) : null}
    </aside>
  );
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-xs text-foreground">{value}</dd>
    </div>
  );
}
