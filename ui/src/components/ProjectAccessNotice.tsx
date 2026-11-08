import { t, useTranslation } from "@/i18n";
import { describeError } from "@/api/errors";
import { ShieldCheck, ShieldX, ArrowRight } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export interface ProjectAccessNoticeProps {
  agentName?: string;
  projectName?: string;
  ready: boolean;
  canManage: boolean;
  canRetry: boolean;
  onManage: () => void;
  onRetry: () => void;
  error?: Error | null;
  className?: string;
}

export function ProjectAccessNotice({ agentName = "This agent", projectName, ready, canManage, canRetry, onManage, onRetry, error, className }: ProjectAccessNoticeProps) {
  useTranslation("task-components");
  return <section role={ready ? "status" : "alert"} aria-label={t("final-components-b:Project_access_379e09")} className={cn("space-y-4 rounded-lg border border-border p-4", className)}>
    <div className="flex items-start gap-3">
      {ready ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden /> : <ShieldX className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />}
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{ready ? t("final-components-b:Project_access_is_ready_f50658") : t("final-components-b:agentName_can_t_access_this_project_7b5629", { agentName })}</h3>
        <p className="text-sm text-muted-foreground">{ready
          ? t("final-components-b:The_agent_can_now_access_the_required_project_Retry_to_continue_with_y_72cac5")
          : projectName ? t("final-components-b:This_task_needs_projectName_outside_the_agent_s_allowed_projects_The_a_707e05", { projectName }) : t("final-components-b:This_task_needs_a_project_outside_the_agent_s_allowed_projects_The_age_8ac6c6")}</p>
        {!ready && !canManage && <p className="text-sm text-muted-foreground">{t("task-components:aPersonWithAgentManagementPermissionCan_63e49d38")}</p>}
      </div>
    </div>
    <div className="flex flex-wrap gap-2 pl-8">
      {ready ? canRetry && <Button size="sm" onClick={onRetry}>{t("final-components-b:Retry_task_f53510")}<ArrowRight className="size-4" aria-hidden /></Button>
        : <Button size="sm" variant="outline" onClick={onManage}>{canManage ? t("final-components-b:Manage_project_access_e74b94") : t("final-components-b:View_agent_access_8b46dc")}<ArrowRight className="size-4" aria-hidden /></Button>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{describeError(error).body}</p>}
    {!ready && <details className="pl-8 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("task-components:runDetails_7bbc3690")}</summary>
      <dl className="mt-3 grid grid-cols-2 gap-2"><dt>{t("task-components:stoppedDuring_f60d25c5")}</dt><dd>{t("task-components:workspaceSetup_80cbc79c")}</dd><dt>{t("task-components:reason_f81ab834")}</dt><dd>{t("task-components:projectOutsideAllowedScope_45f7104b")}</dd><dt>{t("task-components:providerStarted_74320f2d")}</dt><dd>{t("task-components:no_1ea442a1")}</dd></dl>
    </details>}
  </section>;
}
