import { describeError } from "@/api/errors";
import { ShieldCheck, ShieldX, ArrowRight } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { useTranslation } from "@/i18n";

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

export function ProjectAccessNotice({ agentName, projectName, ready, canManage, canRetry, onManage, onRetry, error, className }: ProjectAccessNoticeProps) {
  const { t } = useTranslation();
  const agent = agentName ?? t("projects.projectAccessNotice.defaultAgentName");
  const project = projectName ?? t("projects.projectAccessNotice.defaultProjectName");
  return <section role={ready ? "status" : "alert"} aria-label={t("projects.projectAccessNotice.sectionLabel")} className={cn("space-y-4 rounded-lg border border-border p-4", className)}>
    <div className="flex items-start gap-3">
      {ready ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden /> : <ShieldX className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />}
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{ready ? t("projects.projectAccessNotice.readyTitle") : t("projects.projectAccessNotice.blockedTitle", { agentName: agent })}</h3>
        <p className="text-sm text-muted-foreground">{ready
          ? t("projects.projectAccessNotice.readyBody")
          : t("projects.projectAccessNotice.blockedBody", { projectName: project })}</p>
        {!ready && !canManage && <p className="text-sm text-muted-foreground">{t("projects.projectAccessNotice.noManageHint")}</p>}
      </div>
    </div>
    <div className="flex flex-wrap gap-2 pl-8">
      {ready ? canRetry && <Button size="sm" onClick={onRetry}>{t("projects.projectAccessNotice.retryTask")}<ArrowRight className="size-4" aria-hidden /></Button>
        : <Button size="sm" variant="outline" onClick={onManage}>{canManage ? t("projects.projectAccessNotice.manageAccess") : t("projects.projectAccessNotice.viewAgentAccess")}<ArrowRight className="size-4" aria-hidden /></Button>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{describeError(error).body}</p>}
    {!ready && <details className="pl-8 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("projects.projectAccessNotice.runDetails")}</summary>
      <dl className="mt-3 grid grid-cols-2 gap-2"><dt>{t("projects.projectAccessNotice.stoppedDuring")}</dt><dd>{t("projects.projectAccessNotice.workspaceSetup")}</dd><dt>{t("projects.projectAccessNotice.reason")}</dt><dd>{t("projects.projectAccessNotice.outsideScope")}</dd><dt>{t("projects.projectAccessNotice.providerStarted")}</dt><dd>{t("projects.projectAccessNotice.no")}</dd></dl>
    </details>}
  </section>;
}
