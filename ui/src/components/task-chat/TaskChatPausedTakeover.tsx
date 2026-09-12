import { useId } from "react";
import { useTranslation } from "@/i18n";
import { Loader2, Pause, Play } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";

export interface TaskComposerPause {
  scope: "leaf" | "subtree";
  onResume?: () => void;
  resumeHref?: string;
  pending?: boolean;
  error?: string | null;
}

/** Replaces all input controls until the effective pause hold is released. */
export function TaskChatPausedTakeover({
  scope,
  resumeHref,
  hasDraft = false,
  pending = false,
  error,
  onResume,
}: {
  hasDraft?: boolean;
} & TaskComposerPause) {
  const { t } = useTranslation();
  const headingId = useId();
  const subtree = scope === "subtree";
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={pending}
      data-testid="paused-composer-takeover"
      className="flex flex-col gap-4 rounded-(--radius-task-composer) border border-(--status-agent-paused)/40 bg-(--status-agent-paused)/10 p-(--sz-18px)"
    >
      <div className="flex items-start gap-3">
        <Pause aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-(--status-task-icon-todo)" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-sm font-medium text-foreground">
            {t(subtree ? "sep12Chat.pause.subtreeHeading" : "sep12Chat.pause.taskHeading")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {subtree
              ? t("sep12Chat.pause.subtreeDescription")
              : t("sep12Chat.pause.taskDescription")}
          </p>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {hasDraft ? (
          <p className="mr-auto text-xs text-muted-foreground">{t("sep12Chat.pause.draftSaved")}</p>
        ) : null}
        {resumeHref ? (
          <Button asChild size="sm" className="h-auto min-h-9 max-w-full whitespace-normal text-center bg-(--status-agent-paused) text-foreground hover:bg-(--status-agent-paused)/80 dark:text-background">
            <Link to={resumeHref}><Play aria-hidden="true" />{t("sep12Chat.pause.resumeSubtree")}</Link>
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={pending || !onResume}
            onClick={onResume}
            className="h-auto min-h-9 max-w-full whitespace-normal text-center bg-(--status-agent-paused) text-foreground hover:bg-(--status-agent-paused)/80 dark:text-background"
          >
            {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
            {t(pending ? "sep12Chat.pause.resuming" : subtree ? "sep12Chat.pause.resumeSubtree" : "sep12Chat.pause.resumeTask")}
          </Button>
        )}
      </div>
    </section>
  );
}
