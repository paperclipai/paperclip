import type {
  FeedbackDataSharingPreference,
  FeedbackVoteValue,
} from "@paperclipai/shared";
import {
  BubbleCopyButton,
  IssueChatFeedbackButtons,
} from "@/components/AgentBubbleActionRow";

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
 * {@link BubbleCopyButton} and {@link IssueChatFeedbackButtons} so the
 * redesigned task thread speaks the same footer language as the conference
 * room's {@link AgentBubbleActionRow} without re-declaring their markup; the
 * timestamp stays owned by the summary/bubble, so it is not duplicated here.
 */
export function TaskChatBubbleActions({
  copyText,
  feedback,
}: {
  copyText: string;
  feedback?: TaskChatBubbleFeedback | null;
}) {
  return (
    <div className="flex items-center gap-0.5" data-testid="task-chat-bubble-actions">
      <BubbleCopyButton copyText={copyText} />
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
