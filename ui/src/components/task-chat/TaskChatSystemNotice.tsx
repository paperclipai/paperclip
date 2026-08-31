import { useId, useState } from "react";
import {
  ChevronDown,
  CircleCheck,
  Info,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import {
  SystemNoticeMetadataSections,
  type SystemNoticeTone,
} from "@/components/SystemNotice";
import { humanizeSystemNotice } from "@/lib/system-notice-humanizer";
import { mapCommentMetadataToSystemNoticeSections } from "@/lib/system-notice-comment";
import { timeAgo } from "@/lib/timeAgo";
import type { TaskChatMessageItem } from "./task-chat-model";

const TONE_ICON: Record<SystemNoticeTone, LucideIcon> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: OctagonAlert,
};

const TONE_ICON_CLASS: Record<SystemNoticeTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-(--status-task-icon-in_progress)",
  success: "text-(--status-task-icon-done)",
  warning: "text-(--status-task-icon-todo)",
  danger: "text-(--status-task-icon-blocked)",
};

/**
 * System comment row in the chat shell (PAP-443 / PAP-442 Phase 1): collapsed,
 * it reads as a quiet centered one-liner in TaskChatMarker's register — tone
 * icon + humanized plain-English title + relative time + chevron — instead of
 * a large gray paragraph of raw text. Expanding reveals the full
 * markdown-rendered body plus any structured metadata sections; nothing is
 * suppressed, only folded.
 */
export function TaskChatSystemNotice({
  item,
  onTryAgainNoLiveExecutionPath,
  tryAgainNoLiveExecutionPathPending = false,
}: {
  item: TaskChatMessageItem;
  onTryAgainNoLiveExecutionPath?: () => Promise<void> | void;
  tryAgainNoLiveExecutionPathPending?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(item.presentation?.detailsDefaultOpen));
  const detailsId = useId();
  const { title, tone, detail } = humanizeSystemNotice({
    body: item.text,
    presentation: item.presentation,
  });
  const sections = mapCommentMetadataToSystemNoticeSections(item.metadata, {
    runAgentId: item.runAgentId,
  });
  const ToneIcon = TONE_ICON[tone];
  const relative = item.createdAtIso ? timeAgo(item.createdAtIso) : undefined;
  const showTryAgain =
    Boolean(onTryAgainNoLiveExecutionPath) &&
    (item.presentation?.title?.trim() === "No live execution path" ||
      item.text.toLowerCase().includes("no live execution path"));
  const handleTryAgain = () => {
    void Promise.resolve()
      .then(() => onTryAgainNoLiveExecutionPath?.())
      // The parent mutation owns visible error feedback.
      .catch(() => undefined);
  };

  return (
    <div className="tc-enter-bubble flex flex-col items-center py-1" data-testid="task-chat-system-notice">
      <div className="flex max-w-(--pct-85) items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={detailsId}
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted-foreground",
            "hover:bg-muted/50 hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          )}
        >
          <ToneIcon className={cn("h-3.5 w-3.5 shrink-0", TONE_ICON_CLASS[tone])} aria-hidden />
          <span className="truncate font-medium">{title}</span>
          {detail ? <span className="hidden truncate sm:inline">· {detail}</span> : null}
          {relative ? <span className="shrink-0 text-muted-foreground/70">· {relative}</span> : null}
          <ChevronDown
            className={cn("tc-notice-chevron h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
        {showTryAgain && !open ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleTryAgain}
            disabled={tryAgainNoLiveExecutionPathPending}
            data-testid="task-chat-no-live-path-try-again"
          >
            {tryAgainNoLiveExecutionPathPending ? "Trying again..." : "Try again"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div
          id={detailsId}
          data-testid="task-chat-system-notice-details"
          className="mt-1 w-full max-w-(--pct-85) overflow-hidden rounded-lg border border-border bg-muted/25 text-left text-sm dark:bg-muted/15"
        >
          <div className="px-3 py-2.5 text-foreground/90">
            <MarkdownBody softBreaks linkIssueReferences>
              {item.text}
            </MarkdownBody>
          </div>
          {sections.length > 0 ? (
            <div className="border-t border-border/70 bg-background/50 dark:bg-background/30">
              <SystemNoticeMetadataSections sections={sections} tone={tone} />
            </div>
          ) : null}
          {showTryAgain ? (
            <div className="flex justify-end border-t border-border/70 bg-background/50 px-3 py-2 dark:bg-background/30">
              <Button
                type="button"
                size="xs"
                onClick={handleTryAgain}
                disabled={tryAgainNoLiveExecutionPathPending}
                data-testid="task-chat-no-live-path-try-again"
              >
                {tryAgainNoLiveExecutionPathPending ? "Trying again..." : "Try again"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
