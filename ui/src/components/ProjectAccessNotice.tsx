import { t, useTranslation } from "@/i18n";
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

export function ProjectAccessNotice({ agentName, projectName, ready, canManage, canRetry, onManage, onRetry, error, className }: ProjectAccessNoticeProps) {
  useTranslation();
  return <section role={ready ? "status" : "alert"} aria-label={t("oct26Ui.access.heading")} className={cn("space-y-4 rounded-lg border border-border p-4", className)}>
    <div className="flex items-start gap-3">
      {ready ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden /> : <ShieldX className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />}
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{ready ? t("oct26Ui.access.ready") : t("oct26Ui.access.denied", { agent: agentName ?? t("oct26Ui.access.thisAgent") })}</h3>
        <p className="text-sm text-muted-foreground">{ready
          ? t("oct26Ui.access.readyHelp")
          : t(projectName != null ? "oct26Ui.access.deniedNamed" : "oct26Ui.access.deniedUnnamed", { project: projectName })}</p>
        {!ready && !canManage && <p className="text-sm text-muted-foreground">{t("oct26Ui.access.managerHelp")}</p>}
      </div>
    </div>
    <div className="flex flex-wrap gap-2 pl-8">
      {ready ? canRetry && <Button size="sm" onClick={onRetry}>{t("oct26Ui.access.retry")}<ArrowRight className="size-4" aria-hidden /></Button>
        : <Button size="sm" variant="outline" onClick={onManage}>{canManage ? t("oct26Ui.access.manage") : t("oct26Ui.access.view")}<ArrowRight className="size-4" aria-hidden /></Button>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
    {!ready && <details className="pl-8 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("oct26Ui.access.details")}</summary>
      <dl className="mt-3 grid grid-cols-2 gap-2"><dt>{t("oct26Ui.access.stoppedDuring")}</dt><dd>{t("oct26Ui.access.workspaceSetup")}</dd><dt>{t("oct26Ui.access.reason")}</dt><dd>{t("oct26Ui.access.outsideScope")}</dd><dt>{t("oct26Ui.access.providerStarted")}</dt><dd>{t("oct26Ui.access.no")}</dd></dl>
    </details>}
  </section>;
}
