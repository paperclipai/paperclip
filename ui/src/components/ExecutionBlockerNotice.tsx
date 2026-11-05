import { t, useTranslation, Trans } from "@/i18n";
import { describeError } from "../api/errors";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import { AlertCircle } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { useSecondTick } from "../hooks/useSecondTick";
import { TaskProjectAccessNotice } from "./TaskProjectAccessNotice";
import { ProviderFailureNotice } from "./ProviderFailureNotice";

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
  useTranslation("task-components");
  useSecondTick(presentation?.state === "retry_scheduled");
  if (presentation?.projectAccess && !optimistic && !takingLonger) return <TaskProjectAccessNotice
    access={presentation.projectAccess} issueId={issueId} agentName={agentName} projectName={projectName}
    canRetry={canRetry && presentation.canRetry} onRetry={onRetry} error={error} className={className} />;
  if (error && !optimistic && !takingLonger) return <div role="alert" className={cn("flex items-center justify-between gap-2 text-sm text-destructive", className)}><span>{describeError(error).body}</span>{canRetry && <Button variant="outline" size="sm" onClick={onRetry}>{t("task-components:retry_942087cc")}</Button>}</div>;
  if (takingLonger) return <div role="status" className={cn("flex items-center justify-between gap-2 text-sm text-muted-foreground", className)}><span>{t("task-components:takingLongerThanUsual_4d04a295")}</span>{canRetry && <Button variant="outline" size="sm" onClick={onRetry}>{t("task-components:retry_942087cc")}</Button>}</div>;
  if (!optimistic && !presentation?.retryWait && presentation?.providerFailure && ["failed", "retry_scheduled", "waiting_for_user"].includes(presentation.state)) {
    return <ProviderFailureNotice failure={presentation.providerFailure} className={className}
      actions={canRetry && presentation.canRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t("task-components:retry_942087cc")}</Button> : undefined}>
      {presentation.state === "retry_scheduled" && <p>{t("task-components:paperclipWillRetryAutomatically_ec298deb")}</p>}
    </ProviderFailureNotice>;
  }
  if (optimistic || !presentation || presentation.responsibility !== "system" ||
      !["failed", "retry_scheduled"].includes(presentation.state)) return null;
  const seconds = Math.max(0, Math.ceil((Date.parse(presentation.nextRetryAt ?? "") - Date.now()) / 1000));
  return (
    <div className={cn(presentation.state === "failed" && "pt-4", className)}>
      <div role="status" aria-label={t("task-components:taskStatus_3fd71308")} className={cn(
        "flex items-center justify-between gap-3 text-sm",
        presentation.state === "failed" ? "rounded-lg bg-destructive/10 p-4 text-foreground" : "text-muted-foreground",
      )}>
        {presentation.state === "failed" && <AlertCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />}
        <span className="min-w-0 flex-1">{presentation.state === "retry_scheduled"
          ? t("task-components:tryingAgainIn_2c95f21b", { value1: seconds > 60 ? `${Math.ceil(seconds / 60)}m` : `${seconds}s` })
          : presentation.retryWait ? presentation.retryWait.message
          : presentation.workspaceFailure
            ? <><Trans ns="task-components" i18nKey="sentence_d6338d9fc582" components={{ part1: <>{presentation.workspaceFailure.message}</> }} /></>
            : t("task-components:couldnTFinishThisAttemptYourMessage_c41c671a")}</span>
        {canRetry && presentation.canRetry && <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry}>{t("task-components:retry_942087cc")}</Button>}
      </div>
    </div>
  );
}
