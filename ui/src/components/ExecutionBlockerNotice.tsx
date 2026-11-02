import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { useSecondTick } from "../hooks/useSecondTick";
import { TaskProjectAccessNotice } from "./TaskProjectAccessNotice";

/** One ordinary interruption surface. Technical records remain in diagnostics. */
export function ExecutionBlockerNotice({ presentation, canRetry, onRetry, optimistic, takingLonger, error, className, issueId, agentName, projectName }: {
  presentation: TaskInterruptionPresentation | null | undefined;
  canRetry: boolean;
  onRetry: () => void;
  optimistic?: boolean;
  takingLonger?: boolean;
  error?: Error | null;
  className?: string;
  issueId?: string;
  agentName?: string;
  projectName?: string;
}) {
  const { t } = useTranslation();
  useSecondTick(presentation?.state === "retry_scheduled");
  if (presentation?.projectAccess && !optimistic && !takingLonger) return <TaskProjectAccessNotice
    access={presentation.projectAccess} issueId={issueId} agentName={agentName} projectName={projectName}
    canRetry={canRetry && presentation.canRetry} onRetry={onRetry} error={error} className={className} />;
  if (error && !optimistic && !takingLonger) return <div role="alert" className={cn("flex items-center justify-between gap-2 text-sm text-destructive", className)}><span>{error.message}</span>{canRetry && <Button variant="outline" size="sm" onClick={onRetry}>{t("sep12Screens.retry")}</Button>}</div>;
  if (takingLonger) return <div role="status" className={cn("flex items-center justify-between gap-2 text-sm text-muted-foreground", className)}><span>{t("oct26Onboarding.blocker.takingLonger")}</span>{canRetry && <Button variant="outline" size="sm" onClick={onRetry}>{t("sep12Screens.retry")}</Button>}</div>;
  if (optimistic || !presentation || presentation.responsibility !== "system" ||
      !["failed", "retry_scheduled"].includes(presentation.state)) return null;
  const seconds = Math.max(0, Math.ceil((Date.parse(presentation.nextRetryAt ?? "") - Date.now()) / 1000));
  return (
    <div role="status" aria-label={t("oct26Onboarding.blocker.status")} className={cn("flex items-center justify-between gap-2 text-sm text-muted-foreground", className)}>
      <span>{presentation.state === "retry_scheduled"
        ? t(seconds > 60 ? "oct26Onboarding.blocker.retryMinutes" : "oct26Onboarding.blocker.retrySeconds", { count: seconds > 60 ? Math.ceil(seconds / 60) : seconds })
        : t("oct26Onboarding.blocker.savedMessage")}</span>
      {canRetry && presentation.canRetry && <Button variant="outline" size="sm" onClick={onRetry}>{t("sep12Screens.retry")}</Button>}
    </div>
  );
}
