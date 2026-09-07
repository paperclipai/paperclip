import { useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useEffect, useState } from "react";
import type { FeedbackDataSharingPreference, FeedbackVoteValue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "../lib/utils";

export function OutputFeedbackButtons({
  activeVote,
  disabled = false,
  sharingPreference = "prompt",
  termsUrl = null,
  onVote,
  rightSlot,
  inline = false,
}: {
  activeVote?: FeedbackVoteValue | null;
  disabled?: boolean;
  sharingPreference?: FeedbackDataSharingPreference;
  termsUrl?: string | null;
  onVote: (vote: FeedbackVoteValue, options?: { allowSharing?: boolean; reason?: string }) => Promise<void>;
  rightSlot?: React.ReactNode;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const [pendingVote, setPendingVote] = useState<{
    vote: FeedbackVoteValue;
    reason?: string;
    keepReasonPromptOpen?: boolean;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [downvoteReason, setDownvoteReason] = useState("");
  const [collectingDownvoteReason, setCollectingDownvoteReason] = useState(false);
  const [downvoteAllowSharing, setDownvoteAllowSharing] = useState<boolean | undefined>(undefined);
  const [optimisticVote, setOptimisticVote] = useState<FeedbackVoteValue | null>(null);
  const visibleVote = optimisticVote ?? activeVote ?? null;

  useEffect(() => {
    if (optimisticVote && activeVote === optimisticVote) {
      setOptimisticVote(null);
    }
  }, [activeVote, optimisticVote]);

  async function submitVote(
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
    behavior?: { keepReasonPromptOpen?: boolean },
  ) {
    setIsSaving(true);
    try {
      await onVote(vote, options);
      setPendingVote(null);
      if (!behavior?.keepReasonPromptOpen) {
        setCollectingDownvoteReason(false);
        setDownvoteReason("");
        setDownvoteAllowSharing(undefined);
      }
    } catch (error) {
      setOptimisticVote(null);
      throw error;
    } finally {
      setIsSaving(false);
    }
  }

  function beginVote(
    vote: FeedbackVoteValue,
    reason?: string,
    behavior?: { keepReasonPromptOpen?: boolean },
  ) {
    if (sharingPreference === "prompt") {
      setPendingVote({
        vote,
        ...(reason ? { reason } : {}),
        ...(behavior?.keepReasonPromptOpen ? { keepReasonPromptOpen: true } : {}),
      });
      return;
    }
    const allowSharing = sharingPreference === "allowed";
    if (vote === "down") {
      setDownvoteAllowSharing(allowSharing);
    }
    void submitVote(
      vote,
      {
        ...(allowSharing ? { allowSharing: true } : {}),
        ...(reason ? { reason } : {}),
      },
      behavior,
    );
  }

  function handleVote(vote: FeedbackVoteValue) {
    setOptimisticVote(vote);
    if (vote === "down") {
      setCollectingDownvoteReason(true);
      setDownvoteReason("");
      setDownvoteAllowSharing(undefined);
      void beginVote("down", undefined, { keepReasonPromptOpen: true });
      return;
    }
    void beginVote(vote);
  }

  return (
    <>
      <div className={cn(
        "flex items-center gap-2",
        inline ? "justify-end" : "mt-3 border-t border-border/60 pt-3",
      )}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || isSaving}
          className={cn(visibleVote === "up" && "border-green-600/50 bg-green-500/10 text-green-700")}
          onClick={() => handleVote("up")}
        >
          <ThumbsUp className="mr-1.5 h-3.5 w-3.5" />
          {t("localizationIssueAux.ui_Helpful_x076el")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || isSaving}
          className={cn(visibleVote === "down" && "border-amber-600/50 bg-amber-500/10 text-amber-800")}
          onClick={() => handleVote("down")}
        >
          <ThumbsDown className="mr-1.5 h-3.5 w-3.5" />
          {t("localizationIssueAux.ui_Needs_work_v7b92r")}
        </Button>
        {rightSlot ? <div className="ml-auto">{rightSlot}</div> : null}
      </div>
      {collectingDownvoteReason ? (
        <div className="mt-2 rounded-md border border-border/60 bg-accent/20 p-3">
          <div className="mb-2 text-sm font-medium">{t("localizationIssueAux.ui_What_could_have_been_better_1natcm5")}</div>
          <Textarea
            value={downvoteReason}
            onChange={(event) => setDownvoteReason(event.target.value)}
            placeholder={t("localizationIssueAux.ui_Add_a_short_note_1ige8pr")}
            aria-label={t("localizationIssueAux.ui_What_could_have_been_better_1natcm5")}
            className="min-h-20 resize-y bg-background"
            disabled={disabled || isSaving}
          />
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || isSaving}
              onClick={() => {
                setCollectingDownvoteReason(false);
                setDownvoteReason("");
                setDownvoteAllowSharing(undefined);
              }}
            >
              {t("localizationIssueAux.ui_Dismiss_an1pf7")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={disabled || isSaving || !downvoteReason.trim()}
              onClick={() => {
                void submitVote("down", {
                  ...(downvoteAllowSharing ? { allowSharing: true } : {}),
                  reason: downvoteReason,
                });
              }}
            >
              {isSaving ? t("localizationIssueAux.ui_Saving_8kfkb3") : t("localizationIssueAux.ui_Save_note_1f8pchg")}
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={Boolean(pendingVote)}
        onOpenChange={(open) => {
          if (!open && !isSaving) {
            setPendingVote(null);
            setOptimisticVote(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("localizationIssueAux.ui_Save_your_feedback_sharing_preference_1ebw6en")}</DialogTitle>
            <DialogDescription>
              {t("localizationIssueAux.ui_Choose_whether_voted_AI_outputs_can_be_shared_with_Paperclip_Labs_crke3y")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              {t("localizationIssueAux.ui_This_vote_is_always_saved_locally_kj9hq1")}
            </p>
            <p>
              <Trans i18nKey="localizationIssueAux.sharingChoice" components={{ allow: <span className="font-medium text-foreground" />, deny: <span className="font-medium text-foreground" /> }} />
            </p>
            <p>
              {t("localizationIssueAux.ui_You_can_change_this_later_in_Settings_General_1veml1c")}
            </p>
            {termsUrl ? (
              <a
                href={termsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-foreground underline underline-offset-4"
              >
                {t("localizationIssueAux.ui_Read_our_terms_of_service_10h7tky")}
              </a>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={!pendingVote || isSaving}
              onClick={() => {
                if (!pendingVote) return;
                if (pendingVote.vote === "down") {
                  setDownvoteAllowSharing(false);
                }
                void submitVote(
                  pendingVote.vote,
                  pendingVote.reason ? { reason: pendingVote.reason } : undefined,
                  { keepReasonPromptOpen: pendingVote.keepReasonPromptOpen },
                );
              }}
            >
              {isSaving ? t("localizationIssueAux.ui_Saving_8kfkb3") : t("localizationIssueAux.ui_Don_t_allow_1u4gj3k")}
            </Button>
            <Button
              type="button"
              disabled={!pendingVote || isSaving}
              onClick={() => {
                if (!pendingVote) return;
                if (pendingVote.vote === "down") {
                  setDownvoteAllowSharing(true);
                }
                void submitVote(
                  pendingVote.vote,
                  {
                    allowSharing: true,
                    ...(pendingVote.reason ? { reason: pendingVote.reason } : {}),
                  },
                  { keepReasonPromptOpen: pendingVote.keepReasonPromptOpen },
                );
              }}
            >
              {isSaving ? t("localizationIssueAux.ui_Saving_8kfkb3") : t("localizationIssueAux.ui_Always_allow_1vl0a6l")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
