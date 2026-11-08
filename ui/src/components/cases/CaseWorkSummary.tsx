import { t, useTranslation, Trans } from "@/i18n";
import { Clock3 } from "lucide-react";
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
  useTranslation("task-components");
  const task = caseData.workIssue;
  const pending = pendingHandoff === undefined ? caseData.pendingHandoff : pendingHandoff;
  const assignee = task?.assigneeAgentId ? agents?.get(task.assigneeAgentId) ?? {
    id: task.assigneeAgentId,
    name: task.assigneeAgentName ?? "Agent",
  } : null;
  const from = pending?.fromAgentId ? agents?.get(pending.fromAgentId)?.name ?? pending.fromAgentName ?? t("final-components-b:cases.CaseWorkSummary.the_previous_agent_4b8c85") : t("final-components-b:cases.CaseWorkSummary.the_previous_agent_4b8c85");
  const to = pending ? (pending.toAgentId ? agents?.get(pending.toAgentId)?.name : null) ?? pending.toAgentName ?? t("final-components-b:cases.CaseWorkSummary.the_receiving_agent_533128") : null;
  const destination = pending?.toAgentId ? agents?.get(pending.toAgentId) : null;
  const waiting = pending?.destinationKind === "done" ? t("final-components-b:cases.CaseWorkSummary.Case_will_close_when_the_task_is_complete_5b2090") : pending?.lastError
    ?? (pending?.state === "awaiting_release" ? t("final-components-b:Waiting_for_agentName_to_finish_8d1b6d", { agentName: from })
      : destination?.status === "paused" ? t("final-components-b:agentName_is_paused_44ddce", { agentName: to ?? "" }) : t("final-components-b:Waiting_for_agentName_to_start_99fe10", { agentName: to ?? "" }));

  return <section className="space-y-3" aria-label={t("task-components:caseWork_a81fc1d5")}>
    <h2 className="text-sm font-semibold">{t("task-components:work_104ab921")}</h2>
    {caseData.workIssueId ? <div className="space-y-3">
      {task ? <div>
        <PropertyRow label={t("task-components:task_4bc74b21")}><IssueReferencePill issue={task} className="min-h-11 md:min-h-0" /></PropertyRow>
        <PropertyRow label={t("task-components:workflow_2e2d5c56")}><span className="text-sm">{caseData.workflow?.name ?? t("final-components-b:cases.CaseWorkSummary.Case_instructions_b4833c")}</span></PropertyRow>
        {caseData.phase && <PropertyRow label={t("task-components:phase_46342ec1")}><span className="text-sm">{caseData.phase}</span></PropertyRow>}
        <PropertyRow label={t("task-components:agent_11b39c93")}>{assignee ? <AgentIdentity agent={assignee} size="xs" /> : <span className="text-sm text-muted-foreground">{t("task-components:unassigned_14d33bd0")}</span>}</PropertyRow>
        <PropertyRow label={t("task-components:taskStatus_3fd71308")}><IssueStatusBadge {...taskStatusIconProps(task)} /></PropertyRow>
      </div> : <p className="text-sm text-muted-foreground">{t("task-components:thePrimaryTaskIsUnavailable_f9b44128")}</p>}
      {pending && pending.state !== "delivered" && pending.state !== "completed" && pending.state !== "cancelled" && <div className="flex items-start gap-2 text-sm">
        <Clock3 aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          {pending.state === "awaiting_release" && <p><Trans ns="task-components" i18nKey="sentence_a50ee594b45a" components={{ part1: <>{pending.workflowTransition?.to.name ?? t("final-components-b:cases.CaseWorkSummary.Case_instructions_b4833c")}</>, part2: <>{pending.phase}</> }} /></p>}
          <p className="text-xs leading-relaxed text-muted-foreground">{waiting}</p>
        </div>
      </div>}
    </div> : <p className="text-sm text-muted-foreground">{t("task-components:noTaskLinked_9ab7ec8d")}</p>}
  </section>;
}
