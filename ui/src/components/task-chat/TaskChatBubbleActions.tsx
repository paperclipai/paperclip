import { useState } from "react";
import type {
  FeedbackDataSharingPreference,
  FeedbackVoteValue,
} from "@paperclipai/shared";
import { copyTextToClipboard } from "@/lib/clipboard";
import { IssueChatFeedbackButtons } from "@/components/AgentBubbleActionRow";
import { Check, Copy } from "lucide-react";

/** Feedback-vote wiring for an agent bubble, resolved per comment by the host. */
export interface TaskChatBubbleFeedback {
  activeVote: FeedbackVoteValue | null;
  sharingPreference: FeedbackDataSharingPreference;
  termsUrl: string | null;
  onVote: (
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
}

/**
 * Compact copy · 👍 · 👎 cluster prepended to an agent bubble's footer line
 * (PAP-413), leading the "✓ Worked · …" turn summary (or the bare timestamp
 * when the reply had no run activity). It reuses the shared
 * {@link IssueChatFeedbackButtons} so the redesigned task thread speaks the
 * same feedback language as the conference room's {@link AgentBubbleActionRow};
 * the timestamp stays owned by the summary/bubble, so it is not duplicated here.
 */
export function TaskChatBubbleActions({
  copyText,
  feedback,
}: {
  copyText: string;
  feedback?: TaskChatBubbleFeedback | null;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-0.5" data-testid="task-chat-bubble-actions">
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Copy message"
        aria-label="Copy message"
        onClick={() => {
          void copyTextToClipboard(copyText)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => {});
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {feedback ? (
        <IssueChatFeedbackButtons
          activeVote={feedback.activeVote}
          sharingPreference={feedback.sharingPreference}
          termsUrl={feedback.termsUrl}
          onVote={feedback.onVote}
        />
      ) : null}
    </div>
  );
}
