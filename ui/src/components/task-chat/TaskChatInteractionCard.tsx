import type { ComponentProps } from "react";
import type { IssueDocument } from "@paperclipai/shared";
import type { MentionOption } from "@/components/MarkdownEditor";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { AppLogo } from "@/pages/apps/AppLogo";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { shouldHideInteractionCard } from "@/lib/issue-thread-interactions";
import { TaskChatCompactInteractionCard } from "./TaskChatCompactInteractionCard";
import { TaskChatPlanPreviewCard } from "./TaskChatPlanPreviewCard";
import type { TaskChatInteractionItem } from "./task-chat-model";

type InteractionCardProps = Omit<
  ComponentProps<typeof IssueThreadInteractionCard>,
  "interaction"
>;

export interface TaskChatInteractionCardProps extends InteractionCardProps {
  item: TaskChatInteractionItem;
  onReviewRequest?: (interactionId: string) => void;
  planDocument?: IssueDocument | null;
  showPlanPreview?: boolean;
  presentation?: "timeline" | "takeover";
  draftKey?: string;
  mentions?: MentionOption[];
}

/**
 * Task-page presentation for durable issue interactions. The new task view uses
 * a compact, protocol-card-aligned renderer with paginated questions and
 * verdicts; the classic issue thread keeps its existing card. Resolved inputs
 * collapse to one receipt row, with security and audit details preserved in the
 * disclosure.
 */
export function TaskChatInteractionCard({
  item,
  onReviewRequest,
  planDocument,
  showPlanPreview = true,
  presentation = "timeline",
  draftKey,
  ...cardProps
}: TaskChatInteractionCardProps) {
  const interaction = item.interaction;
  if (interaction.kind === "request_confirmation" && interaction.payload.toolAction) {
    const action = interaction.payload.toolAction;
    if (presentation === "takeover") {
      return <IssueThreadInteractionCard interaction={interaction} {...cardProps} />;
    }
    return (
      <div id={`interaction-${interaction.id}`} data-testid="task-chat-tool-review" className="w-full space-y-2">
        {interaction.status === "pending" ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <AppLogo name={action.appDisplayName || action.toolDisplayName} size={36} />
            <div className="min-w-0 flex-1"><MarkdownBody>{action.previewMarkdown.split(/\n\s*\n/)[0] || action.toolDisplayName}</MarkdownBody></div>
            <Button className="ml-auto" size="sm" variant="outline" disabled={!onReviewRequest} onClick={() => onReviewRequest?.(interaction.id)}>Review request</Button>
          </div>
        ) : (
          <IssueThreadInteractionCard interaction={interaction} {...cardProps} />
        )}
      </div>
    );
  }
  const isSupersededQuestionReceipt =
    interaction.kind === "ask_user_questions" &&
    interaction.status !== "pending" &&
    interaction.result?.expirationReason === "superseded_by_newer_interaction";
  if (shouldHideInteractionCard(interaction) && !isSupersededQuestionReceipt)
    return null;
  if (presentation === "timeline" && interaction.status === "pending" && interaction.kind !== "connection_intent") {
    const isPlanReview =
      interaction.kind === "request_confirmation" &&
      Boolean(interaction.sourceRunId) &&
      interaction.payload.target?.type === "issue_document" &&
      interaction.payload.target.key === "plan" &&
      Boolean(planDocument) &&
      (planDocument?.latestRevisionId
        ? interaction.payload.target.revisionId ===
          planDocument.latestRevisionId
        : interaction.payload.target.revisionNumber ===
          planDocument?.latestRevisionNumber);
    if (!isPlanReview || !showPlanPreview) return null;
    return (
      <div
        id={`interaction-${interaction.id}`}
        data-testid="task-chat-interaction"
      >
        <TaskChatPlanPreviewCard
          source={{ kind: "saved", document: planDocument }}
          testId="plan-review-preview"
        />
      </div>
    );
  }
  const isResolvedPlanReview =
    presentation === "timeline" &&
    interaction.kind === "request_confirmation" &&
    (interaction.status === "accepted" || interaction.status === "rejected") &&
    interaction.payload.target?.type === "issue_document" &&
    interaction.payload.target.key === "plan";
  const resolvedPlanMatchesDocument =
    isResolvedPlanReview &&
    planDocument != null &&
    (planDocument.latestRevisionId
      ? interaction.payload.target?.revisionId === planDocument.latestRevisionId
      : interaction.payload.target?.revisionNumber ===
        planDocument.latestRevisionNumber);
  if (isResolvedPlanReview) {
    if (resolvedPlanMatchesDocument && showPlanPreview && planDocument) {
      return (
        <div
          id={`interaction-${interaction.id}`}
          data-testid="task-chat-interaction"
        >
          <TaskChatPlanPreviewCard
            source={{ kind: "saved", document: planDocument }}
            testId="plan-review-preview"
          />
        </div>
      );
    }
    return null;
  }
  if (presentation === "timeline" && interaction.status !== "pending") {
    return (
      <div
        id={`interaction-${interaction.id}`}
        className="tc-enter-bubble w-full"
        data-testid="task-chat-interaction"
      >
        <TaskChatCompactInteractionCard
          interaction={interaction}
          planDocument={planDocument}
          showPlanPreview={showPlanPreview}
          presentation="timeline"
          draftKey={draftKey}
          {...cardProps}
        />
      </div>
    );
  }
  return (
    <div
      id={`interaction-${interaction.id}`}
      className="tc-enter-bubble w-full"
      data-testid="task-chat-interaction"
    >
      <TaskChatCompactInteractionCard
        interaction={interaction}
        planDocument={planDocument}
        showPlanPreview={showPlanPreview}
        presentation={presentation}
        draftKey={draftKey}
        {...cardProps}
      />
    </div>
  );
}
