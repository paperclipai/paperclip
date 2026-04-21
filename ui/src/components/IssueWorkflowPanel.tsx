import type { Issue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";

const ROLE_LABELS: Record<string, string> = {
  pm: "PM",
  designer: "Design",
  engineer: "Build",
  security: "Security",
  qa: "QA",
};

function artifactTone(satisfied: boolean, blocking: boolean, stale: boolean) {
  if (satisfied) return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (stale) return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  if (blocking) return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border bg-muted/30 text-muted-foreground";
}

function statusTone(status: string) {
  if (status === "done") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "in_progress" || status === "in_review") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (status === "blocked" || status === "missing") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border bg-muted/30 text-muted-foreground";
}

function phaseTone(phase: string) {
  if (phase === "done") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (phase === "active") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (phase === "ready") return "border-border bg-muted/30 text-foreground";
  if (phase === "waiting") return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
  if (phase === "missing") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border bg-muted/30 text-muted-foreground";
}

function formatRole(role: string | null | undefined) {
  return role ? (ROLE_LABELS[role] ?? role) : "Workflow";
}

function formatWorkspaceMode(mode: string | null | undefined) {
  if (!mode) return "Inherited";
  return mode.replace(/_/g, " ");
}

function formatRoleList(roles: string[] | null | undefined) {
  return (roles ?? []).map((role) => formatRole(role)).join(", ");
}

function formatLanePhase(phase: string | null | undefined) {
  if (!phase) return "Unknown";
  return phase.replace(/_/g, " ");
}

export function IssueWorkflowPanel({
  issue,
  agentNamesById,
  issueLinkState,
  onApplyEngineeringDeliveryWorkflow,
  isApplyingTemplate = false,
}: {
  issue: Issue;
  agentNamesById?: Map<string, string | { name?: string | null }>;
  issueLinkState?: unknown;
  onApplyEngineeringDeliveryWorkflow?: (() => void) | null;
  isApplyingTemplate?: boolean;
}) {
  const canApplyTemplate = !issue.parentId && !issue.workflowTemplateKey && !issue.workflowLaneRole;
  const isRootWorkflowIssue = !issue.workflowLaneRole && Boolean(issue.workflowSummary);
  const isLaneIssue = Boolean(issue.workflowLaneRole);

  if (!canApplyTemplate && !isRootWorkflowIssue && !isLaneIssue) {
    return null;
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Workflow</h3>
          <p className="text-xs text-muted-foreground">
            {isLaneIssue
              ? `${formatRole(issue.workflowLaneRole)} lane requirements`
              : issue.workflowSummary
                ? "Specialist delivery lanes"
                : "Create PM, design, build, security, and QA child lanes"}
          </p>
        </div>
        {canApplyTemplate && onApplyEngineeringDeliveryWorkflow ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shadow-none"
            onClick={onApplyEngineeringDeliveryWorkflow}
            disabled={isApplyingTemplate}
          >
            {isApplyingTemplate ? "Starting..." : "Start engineering delivery"}
          </Button>
        ) : null}
      </div>

      {issue.workflowSummary ? (
        <div className="space-y-2">
          {issue.workflowSummary.blockingReasons.length > 0 ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-2 text-xs text-amber-700 dark:text-amber-300">
              {issue.workflowSummary.blockingReasons[0]}
            </div>
          ) : null}
          {issue.workflowSummary.activeRoles.length > 0 ? (
            <div className="text-[11px] text-muted-foreground">
              Actionable now: {formatRoleList(issue.workflowSummary.activeRoles)}
            </div>
          ) : null}
          {issue.workflowSummary.waitingRoles.length > 0 ? (
            <div className="text-[11px] text-muted-foreground">
              Waiting on dependencies: {formatRoleList(issue.workflowSummary.waitingRoles)}
            </div>
          ) : null}
          {issue.workflowSummary.ownerNeededRoles.length > 0 ? (
            <div className="text-[11px] text-muted-foreground">
              Needs owner: {formatRoleList(issue.workflowSummary.ownerNeededRoles)}
            </div>
          ) : null}
          <div className="space-y-2">
            {issue.workflowSummary.lanes.map((lane) => {
              const completedArtifacts = lane.artifactStatuses.filter((artifact) => artifact.satisfied).length;
              const totalArtifacts = lane.artifactStatuses.length;
              const agentEntry = lane.assigneeAgentId ? agentNamesById?.get(lane.assigneeAgentId) : null;
              const assigneeName = lane.assigneeAgentId
                ? (typeof agentEntry === "string" ? agentEntry : agentEntry?.name) ?? lane.assigneeAgentId.slice(0, 8)
                : lane.assigneeUserId ?? "Unassigned";
              const rowContent = (
                <>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                        {formatRole(lane.role)}
                      </span>
                      <span className="truncate text-sm font-medium">{lane.title}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{assigneeName}</span>
                      <span>•</span>
                      <span>{formatWorkspaceMode(lane.workspaceMode)}</span>
                      {lane.blockedByRoles.length > 0 ? (
                        <>
                          <span>•</span>
                          <span>Waiting on {formatRoleList(lane.blockedByRoles)}</span>
                        </>
                      ) : lane.phase === "ready" ? (
                        <>
                          <span>•</span>
                          <span>Ready</span>
                        </>
                      ) : lane.phase === "active" ? (
                        <>
                          <span>•</span>
                          <span>Active</span>
                        </>
                      ) : null}
                      {totalArtifacts > 0 ? (
                        <>
                          <span>•</span>
                          <span>{completedArtifacts}/{totalArtifacts} artifacts</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]", phaseTone(lane.phase))}>
                      {formatLanePhase(lane.phase)}
                    </span>
                    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]", statusTone(lane.status))}>
                      {lane.status.replace(/_/g, " ")}
                    </span>
                  </div>
                </>
              );

              return lane.issueId ? (
                <Link
                  key={lane.role}
                  to={createIssueDetailPath(lane.issueId)}
                  state={issueLinkState}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 transition-colors hover:bg-accent/20"
                >
                  {rowContent}
                </Link>
              ) : (
                <div key={lane.role} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                  {rowContent}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {issue.workflowLaneRole ? (
        <div className="space-y-2">
          {(issue.workflowArtifactStatus ?? []).map((artifact) => (
            <div key={artifact.key} className={cn("rounded-md border px-2 py-2 text-xs", artifactTone(artifact.satisfied, artifact.blocking, artifact.stale))}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{artifact.label}</span>
                <span>{artifact.satisfied ? "Ready" : artifact.stale ? "Stale" : "Missing"}</span>
              </div>
              {artifact.detail ? <p className="mt-1">{artifact.detail}</p> : null}
            </div>
          ))}
          {(issue.workflowArtifactStatus?.length ?? 0) === 0 ? (
            <div className="rounded-md border border-border px-2 py-2 text-xs text-muted-foreground">
              This lane has no explicit artifact contract.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
