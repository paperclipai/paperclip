import { t, useTranslation, Trans } from "@/i18n";
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
  useTranslation("task-components");
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
          <ThumbsUp className="mr-1.5 h-3.5 w-3.5" />{t("task-components:helpful_63c432db")}</Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || isSaving}
          className={cn(visibleVote === "down" && "border-amber-600/50 bg-amber-500/10 text-amber-800")}
          onClick={() => handleVote("down")}
        >
          <ThumbsDown className="mr-1.5 h-3.5 w-3.5" />{t("task-components:needsWork_738a3278")}</Button>
        {rightSlot ? <div className="ml-auto">{rightSlot}</div> : null}
      </div>
      {collectingDownvoteReason ? (
        <div className="mt-2 rounded-md border border-border/60 bg-accent/20 p-3">
          <div className="mb-2 text-sm font-medium">{t("task-components:whatCouldHaveBeenBetter_829e701d")}</div>
          <Textarea
            value={downvoteReason}
            onChange={(event) => setDownvoteReason(event.target.value)}
            placeholder={t("task-components:addAShortNote_1adb884a")}
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
            >{t("task-components:dismiss_48845bff")}</Button>
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
              {isSaving ? t("task-components:saving_dc85af8f") : t("task-components:saveNote_6501e1ce")}
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
            <DialogTitle>{t("task-components:saveYourFeedbackSharingPreference_1c562b5e")}</DialogTitle>
            <DialogDescription>{t("task-components:chooseWhetherVotedAiOutputsCanBe_1e435dd1")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>{t("task-components:thisVoteIsAlwaysSavedLocally_a7cd6ce4")}</p>
            <p><Trans ns="task-components" i18nKey="sentence_e49067638ca1" components={{ part1: <>{<span className="font-medium text-foreground">{t("task-components:alwaysAllow_977618bd")}</span>}</>, part2: <>{<span className="font-medium text-foreground">{t("task-components:donTAllow_9803bdd2")}</span>}</> }} /></p>
            <p>{t("task-components:youCanChangeThisLaterInSettings_46238be6")}</p>
            {termsUrl ? (
              <a
                href={termsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-foreground underline underline-offset-4"
              >{t("task-components:readOurTermsOfService_50aceeb5")}</a>
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
              {isSaving ? t("task-components:saving_dc85af8f") : t("task-components:donTAllow_9803bdd2")}
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
              {isSaving ? t("task-components:saving_dc85af8f") : t("task-components:alwaysAllow_977618bd")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
