import type { ComponentProps } from "react";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { TaskChatMarker } from "./TaskChatMarker";
import type { TaskChatInteractionItem } from "./task-chat-model";

type InteractionCardProps = Omit<ComponentProps<typeof IssueThreadInteractionCard>, "interaction">;

export interface TaskChatInteractionCardProps extends InteractionCardProps {
  item: TaskChatInteractionItem;
}

/**
 * v7-grammar wrapper for issue-thread interactions (plan confirmation,
 * question card, suggested tasks…) inside the redesigned thread: cards are the
 * only rows that get bubble-level emphasis, so the shared
 * IssueThreadInteractionCard renders full-width with the standard bubble
 * entrance. Expired confirmations demote to a marker row — superseded asks are
 * history, not calls to action (legacy-thread parity).
 */
export function TaskChatInteractionCard({ item, ...cardProps }: TaskChatInteractionCardProps) {
  const interaction = item.interaction;
  if (interaction.kind === "request_confirmation" && interaction.status === "expired") {
    return (
      <TaskChatMarker
        item={{
          id: item.id,
          kind: "marker",
          variant: "turn_boundary",
          label: interaction.title ?? "Confirmation",
          detail: "expired",
        }}
      />
    );
  }
  return (
    <div
      id={`interaction-${interaction.id}`}
      className="tc-enter-bubble w-full"
      data-testid="task-chat-interaction"
    >
      <IssueThreadInteractionCard interaction={interaction} primaryActionOnRight {...cardProps} />
    </div>
  );
}
