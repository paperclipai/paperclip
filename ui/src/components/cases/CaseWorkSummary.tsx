import { Clock3 } from "lucide-react";
import { useTranslation } from "@/i18n";
import type { CaseDetail, CaseHandoffView } from "@/api/cases";
import { AgentIdentity } from "@/components/AgentIdentity";
import type { AvatarAgent } from "@/components/AgentAvatar";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { PropertyRow } from "@/components/issue-properties/primitives";
import { taskStatusIconProps } from "@/lib/task-status-presentation";

export type CaseAgentMap = ReadonlyMap<string, AvatarAgent & { status?: string }>;

export function CaseWorkSummary({ caseData, pendingHandoff, agents }: {
  caseData: CaseDetail;
  pendingHandoff?: CaseHandoffView | null;
  agents?: CaseAgentMap;
}) {
  const { t } = useTranslation();
  const task = caseData.workIssue;
  const pending = pendingHandoff === undefined ? caseData.pendingHandoff : pendingHandoff;
  const assignee = task?.assigneeAgentId ? agents?.get(task.assigneeAgentId) ?? {
    id: task.assigneeAgentId,
    name: task.assigneeAgentName ?? t("cases.work.agent"),
  } : null;
  const from = pending?.fromAgentId ? agents?.get(pending.fromAgentId)?.name ?? pending.fromAgentName ?? t("cases.work.previousAgent") : t("cases.work.previousAgent");
  const to = pending ? (pending.toAgentId ? agents?.get(pending.toAgentId)?.name : null) ?? pending.toAgentName ?? t("cases.work.receivingAgent") : null;
  const destination = pending?.toAgentId ? agents?.get(pending.toAgentId) : null;
  const waiting = pending?.destinationKind === "done" ? t("cases.work.caseWillClose") : pending?.lastError
    ?? (pending?.state === "awaiting_release" ? t("cases.work.waitingForFinish", { agent: from })
      : destination?.status === "paused" ? t("cases.work.agentPaused", { agent: to }) : t("cases.work.waitingForStart", { agent: to }));

  return <section className="space-y-3" aria-label={t("cases.work.ariaLabel")}>
    <h2 className="text-sm font-semibold">{t("cases.work.title")}</h2>
    {caseData.workIssueId ? <div className="space-y-3">
      {task ? <div>
        <PropertyRow label={t("cases.work.task")}><IssueReferencePill issue={task} className="min-h-11 md:min-h-0" /></PropertyRow>
        <PropertyRow label={t("cases.work.workflow")}><span className="text-sm">{caseData.workflow?.name ?? t("cases.work.caseInstructions")}</span></PropertyRow>
        {caseData.phase && <PropertyRow label={t("cases.work.phase")}><span className="text-sm">{caseData.phase}</span></PropertyRow>}
        <PropertyRow label={t("cases.work.agent")}>{assignee ? <AgentIdentity agent={assignee} size="xs" /> : <span className="text-sm text-muted-foreground">{t("cases.work.unassigned")}</span>}</PropertyRow>
        <PropertyRow label={t("cases.work.taskStatus")}><IssueStatusBadge {...taskStatusIconProps(task)} /></PropertyRow>
      </div> : <p className="text-sm text-muted-foreground">{t("cases.work.primaryTaskUnavailable")}</p>}
      {pending && pending.state !== "delivered" && pending.state !== "completed" && pending.state !== "cancelled" && <div className="flex items-start gap-2 text-sm">
        <Clock3 aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          {pending.state === "awaiting_release" && <p>{t("cases.work.next", { workflow: pending.workflowTransition?.to.name ?? t("cases.work.caseInstructions"), phase: pending.phase })}</p>}
          <p className="text-xs leading-relaxed text-muted-foreground">{waiting}</p>
        </div>
      </div>}
    </div> : <p className="text-sm text-muted-foreground">{t("cases.work.noTaskLinked")}</p>}
  </section>;
}
