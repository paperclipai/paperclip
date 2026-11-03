import { useTranslation } from "@/i18n";
import { Clock3 } from "lucide-react";
import type { CaseDetail, CaseHandoffView } from "@/api/cases";
import { AgentIdentity } from "@/components/AgentIdentity";
import type { AvatarAgent } from "@/components/AgentAvatar";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { PropertyRow } from "@/components/issue-properties/primitives";

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
    name: task.assigneeAgentName ?? t("oct26Cases.agent"),
  } : null;
  const from = pending?.fromAgentId ? agents?.get(pending.fromAgentId)?.name ?? pending.fromAgentName ?? t("oct26Cases.previousAgent") : t("oct26Cases.previousAgent");
  const to = pending ? (pending.toAgentId ? agents?.get(pending.toAgentId)?.name : null) ?? pending.toAgentName ?? t("oct26Cases.receivingAgent") : null;
  const destination = pending?.toAgentId ? agents?.get(pending.toAgentId) : null;
  const waiting = pending?.destinationKind === "done" ? t("oct26Cases.closesWhenTaskDone") : pending?.lastError
    ?? (pending?.state === "awaiting_release" ? t("oct26Cases.waitingForFinish", { name: from })
      : destination?.status === "paused" ? t("oct26Cases.agentPaused", { name: to }) : t("oct26Cases.waitingForStart", { name: to }));

  return <section className="space-y-3" aria-label={t("oct26Cases.caseWork")}>
    <h2 className="text-sm font-semibold">{t("oct26Cases.work")}</h2>
    {caseData.workIssueId ? <div className="space-y-3">
      {task ? <div>
        <PropertyRow label={t("oct26Cases.task")}><IssueReferencePill issue={task} className="min-h-11 md:min-h-0" /></PropertyRow>
        <PropertyRow label={t("oct26Cases.workflow")}><span className="text-sm">{caseData.workflow?.name ?? t("oct26Cases.caseInstructions")}</span></PropertyRow>
        {caseData.phase && <PropertyRow label={t("oct26Cases.phase")}><span className="text-sm">{caseData.phase}</span></PropertyRow>}
        <PropertyRow label={t("oct26Cases.agent")}>{assignee ? <AgentIdentity agent={assignee} size="xs" /> : <span className="text-sm text-muted-foreground">{t("oct26Cases.unassigned")}</span>}</PropertyRow>
        <PropertyRow label={t("oct26Cases.taskStatus")}><IssueStatusBadge status={task.status} /></PropertyRow>
      </div> : <p className="text-sm text-muted-foreground">{t("oct26Cases.primaryTaskUnavailable")}</p>}
      {pending && pending.state !== "delivered" && pending.state !== "completed" && pending.state !== "cancelled" && <div className="flex items-start gap-2 text-sm">
        <Clock3 aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          {pending.state === "awaiting_release" && <p>{t("oct26Cases.nextHandoff", { workflow: pending.workflowTransition?.to.name ?? t("oct26Cases.caseInstructions"), phase: pending.phase })}</p>}
          <p className="text-xs leading-relaxed text-muted-foreground">{waiting}</p>
        </div>
      </div>}
    </div> : <p className="text-sm text-muted-foreground">{t("oct26Cases.noTask")}</p>}
  </section>;
}
