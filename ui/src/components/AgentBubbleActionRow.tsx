import { useEffect, useState, type ReactNode } from "react";
import type {
  FeedbackDataSharingPreference,
  FeedbackVoteValue,
} from "@paperclipai/shared";
import { cn, formatShortDate } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { useCopyAction, useCopyToast } from "../lib/use-copy-action";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, Copy, MoreHorizontal, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { useTranslation } from "@/i18n";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Short relative timestamp for an agent bubble — "2h ago" within a week, then
 * an absolute short date. Mirrors the task thread's `commentDateLabel` so both
 * surfaces read identically.
 */
export function agentBubbleDateLabel(date: Date | string | undefined): string {
  if (!date) return "";
  const then = new Date(date).getTime();
  if (Date.now() - then < WEEK_MS) return timeAgo(date);
  return formatShortDate(date);
}

/**
 * Copy-to-clipboard icon button shared by every agent-bubble footer — the
 * conference-room {@link AgentBubbleActionRow} and the redesigned task thread's
 * {@link TaskChatBubbleActions} (PAP-413). Single-sourced so both footers keep
 * identical sizing, radius, and the "copied ✓" feedback affordance rather than
 * re-declaring the same button markup on each surface.
 */
export function BubbleCopyButton({ copyText }: { copyText: string }) {
  const { t } = useTranslation();
  const { copied, failed, copy } = useCopyAction(2000);
  const label = failed ? t("agents.BubbleCopyButton.couldntCopy") : t("agents.BubbleCopyButton.copyMessage");

  return (
    <button
      type="button"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={label}
      aria-label={label}
      onClick={() => {
        void copy(copyText);
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : failed ? (
        <X className="h-3.5 w-3.5 text-destructive" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/**
 * Shared agent-bubble action row — copy · 👍 · 👎 · timestamp · ⋯ menu.
 *
 * Rendered below every agent bubble so the task thread (`IssueChatThread`) and
 * the conference room (`BoardChat`) speak the same bubble language (PAP-95 /
 * PAP-105). Each surface supplies its own copy text, timestamp label, optional
 * feedback-vote wiring, and any extra overflow-menu items (e.g. stop-run /
 * view-run on the task side).
 */
export function AgentBubbleActionRow({
  copyText,
  dateLabel,
  dateTitle,
  anchorHref,
  feedback,
  menuItems,
  className,
}: {
  copyText: string;
  /** Short relative label shown inline (e.g. "2h ago"). */
  dateLabel?: string;
  /** Full datetime shown in the hover tooltip. */
  dateTitle?: string;
  /** Anchor href for the timestamp link (deep-link to the comment). */
  anchorHref?: string;
  /** When provided, renders the 👍/👎 feedback buttons wired to this vote API. */
  feedback?: {
    activeVote: FeedbackVoteValue | null;
    sharingPreference: FeedbackDataSharingPreference;
    termsUrl: string | null;
    onVote: (
      vote: FeedbackVoteValue,
      options?: { allowSharing?: boolean; reason?: string },
    ) => Promise<void>;
  } | null;
  /** Extra DropdownMenuItem nodes appended after the default "Copy message". */
  menuItems?: ReactNode;
  className?: string;
}) {
  // The menu closes on click, so its copy confirmation has to outlive it.
  const { t } = useTranslation();
  const copyWithToast = useCopyToast();
  return (
    <div className={cn("mt-2 flex items-center gap-1", className)}>
      <BubbleCopyButton copyText={copyText} />
      {feedback ? (
        <IssueChatFeedbackButtons
          activeVote={feedback.activeVote}
          sharingPreference={feedback.sharingPreference}
          termsUrl={feedback.termsUrl}
          onVote={feedback.onVote}
        />
      ) : null}
      {dateLabel ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={anchorHref}
              className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
            >
              {dateLabel}
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {dateTitle}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            title={t("agents.AgentBubbleActionRow.moreActions")}
            aria-label={t("agents.AgentBubbleActionRow.moreActions")}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              void copyWithToast(copyText, t("agents.AgentBubbleActionRow.messageCopied"));
            }}
          >
            <Copy className="mr-2 h-3.5 w-3.5" />
            {t("agents.AgentBubbleActionRow.copyMessage")}
          </DropdownMenuItem>
          {menuItems}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * 👍/👎 feedback buttons with downvote-reason popover and a sharing-preference
 * prompt. Self-contained (no IssueChatCtx) so it is reused by both the task
 * thread and the conference room via {@link AgentBubbleActionRow}.
 */
export function IssueChatFeedbackButtons({
  activeVote,
  sharingPreference = "prompt",
  termsUrl,
  onVote,
}: {
  activeVote: FeedbackVoteValue | null;
  sharingPreference: FeedbackDataSharingPreference;
  termsUrl: string | null;
  onVote: (vote: FeedbackVoteValue, options?: { allowSharing?: boolean; reason?: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [isSaving, setIsSaving] = useState(false);
  const [optimisticVote, setOptimisticVote] = useState<FeedbackVoteValue | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [downvoteReason, setDownvoteReason] = useState("");
  const [pendingSharingDialog, setPendingSharingDialog] = useState<{
    vote: FeedbackVoteValue;
    reason?: string;
  } | null>(null);
  const visibleVote = optimisticVote ?? activeVote ?? null;

  useEffect(() => {
    if (optimisticVote && activeVote === optimisticVote) setOptimisticVote(null);
  }, [activeVote, optimisticVote]);

  async function doVote(
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) {
    setIsSaving(true);
    try {
      await onVote(vote, options);
    } catch {
      setOptimisticVote(null);
    } finally {
      setIsSaving(false);
    }
  }

  function handleVote(vote: FeedbackVoteValue, reason?: string) {
    setOptimisticVote(vote);
    if (sharingPreference === "prompt") {
      setPendingSharingDialog({ vote, ...(reason ? { reason } : {}) });
      return;
    }
    const allowSharing = sharingPreference === "allowed";
    void doVote(vote, {
      ...(allowSharing ? { allowSharing: true } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  function handleThumbsUp() {
    handleVote("up");
  }

  function handleThumbsDown() {
    setOptimisticVote("down");
    setReasonOpen(true);
    // Submit the initial down vote right away
    handleVote("down");
  }

  function handleSubmitReason() {
    if (!downvoteReason.trim()) return;
    // Re-submit with reason attached
    if (sharingPreference === "prompt") {
      setPendingSharingDialog({ vote: "down", reason: downvoteReason });
    } else {
      const allowSharing = sharingPreference === "allowed";
      void doVote("down", {
        ...(allowSharing ? { allowSharing: true } : {}),
        reason: downvoteReason,
      });
    }
    setReasonOpen(false);
    setDownvoteReason("");
  }

  return (
    <>
      <button
        type="button"
        disabled={isSaving}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
          visibleVote === "up"
            ? "text-green-600 dark:text-green-400"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        title={t("agents.IssueChatFeedbackButtons.helpful")}
        aria-label={t("agents.IssueChatFeedbackButtons.helpful")}
        onClick={handleThumbsUp}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <Popover open={reasonOpen} onOpenChange={setReasonOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isSaving}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              visibleVote === "down"
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            title={t("agents.IssueChatFeedbackButtons.needsWork")}
            aria-label={t("agents.IssueChatFeedbackButtons.needsWork")}
            onClick={handleThumbsDown}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 p-3">
          <div className="mb-2 text-sm font-medium">{t("agents.IssueChatFeedbackButtons.whatCouldBeBetter")}</div>
          <Textarea
            value={downvoteReason}
            onChange={(event) => setDownvoteReason(event.target.value)}
            placeholder={t("agents.IssueChatFeedbackButtons.addNote")}
            className="min-h-20 resize-y bg-background text-sm"
            disabled={isSaving}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isSaving}
              onClick={() => {
                setReasonOpen(false);
                setDownvoteReason("");
              }}
            >
              {t("agents.IssueChatFeedbackButtons.dismiss")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isSaving || !downvoteReason.trim()}
              onClick={handleSubmitReason}
            >
              {isSaving ? t("agents.IssueChatFeedbackButtons.saving") : t("agents.IssueChatFeedbackButtons.saveNote")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog
        open={Boolean(pendingSharingDialog)}
        onOpenChange={(open) => {
          if (!open && !isSaving) {
            setPendingSharingDialog(null);
            setOptimisticVote(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("agents.IssueChatFeedbackButtons.sharingTitle")}</DialogTitle>
            <DialogDescription>
              {t("agents.IssueChatFeedbackButtons.sharingDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>{t("agents.IssueChatFeedbackButtons.alwaysSaved")}</p>
            <p>
              {t("agents.IssueChatFeedbackButtons.chooseAlways")} <span className="font-medium text-foreground">{t("agents.IssueChatFeedbackButtons.alwaysAllow")}</span> {t("agents.IssueChatFeedbackButtons.shareThisVote")}{" "}
              <span className="font-medium text-foreground">{t("agents.IssueChatFeedbackButtons.dontAllow")}</span> {t("agents.IssueChatFeedbackButtons.keepLocal")}
            </p>
            <p>{t("agents.IssueChatFeedbackButtons.changeLater")}</p>
            {termsUrl ? (
              <a
                href={termsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-foreground underline underline-offset-4"
              >
                {t("agents.IssueChatFeedbackButtons.readTerms")}
              </a>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={!pendingSharingDialog || isSaving}
              onClick={() => {
                if (!pendingSharingDialog) return;
                void doVote(
                  pendingSharingDialog.vote,
                  pendingSharingDialog.reason ? { reason: pendingSharingDialog.reason } : undefined,
                ).then(() => setPendingSharingDialog(null));
              }}
            >
              {isSaving ? t("agents.IssueChatFeedbackButtons.saving") : t("agents.IssueChatFeedbackButtons.dontAllow")}
            </Button>
            <Button
              type="button"
              disabled={!pendingSharingDialog || isSaving}
              onClick={() => {
                if (!pendingSharingDialog) return;
                void doVote(pendingSharingDialog.vote, {
                  allowSharing: true,
                  ...(pendingSharingDialog.reason ? { reason: pendingSharingDialog.reason } : {}),
                }).then(() => setPendingSharingDialog(null));
              }}
            >
              {isSaving ? t("agents.IssueChatFeedbackButtons.saving") : t("agents.IssueChatFeedbackButtons.alwaysAllow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
