import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { IssueChatThread } from "@/components/IssueChatThread";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  acceptedManyRequestCheckboxConfirmationInteraction,
  acceptedRequestCheckboxConfirmationInteraction,
  acceptedSuggestedTasksInteraction,
  answeredAskUserQuestionsInteraction,
  acceptedRequestConfirmationInteraction,
  boundedRequestCheckboxConfirmationInteraction,
  cancelledAskUserQuestionsInteraction,
  cancelledRequestCheckboxConfirmationInteraction,
  cancelledRequestConfirmationInteraction,
  cancelledSuggestedTasksInteraction,
  commentExpiredAskUserQuestionsInteraction,
  commentExpiredRequestCheckboxConfirmationInteraction,
  commentExpiredRequestConfirmationInteraction,
  everyQuestionTypeAnsweredAskUserQuestionsInteraction,
  everyQuestionTypeAskUserQuestionsInteraction,
  expiredSuggestedTasksInteraction,
  failedAskUserQuestionsInteraction,
  failedRequestCheckboxConfirmationInteraction,
  failedRequestConfirmationInteraction,
  failedSuggestedTasksInteraction,
  genericPendingRequestConfirmationInteraction,
  issueThreadInteractionComments,
  issueThreadInteractionEvents,
  issueThreadInteractionFixtureMeta,
  issueThreadInteractionLiveRuns,
  issueThreadInteractionTranscriptsByRunId,
  manyOptionsRequestCheckboxConfirmationInteraction,
  mixedIssueThreadInteractions,
  optionalDeclineRequestConfirmationInteraction,
  partialAcceptedSuggestedTasksInteraction,
  pendingAskUserQuestionsInteraction,
  pendingRequestCheckboxConfirmationInteraction,
  pendingRequestConfirmationInteraction,
  pendingSuggestedTasksInteraction,
  planApprovalAcceptedRequestConfirmationInteraction,
  rejectedNoReasonRequestConfirmationInteraction,
  rejectedRequestCheckboxConfirmationInteraction,
  rejectedRequestConfirmationInteraction,
  rejectedSuggestedTasksInteraction,
  staleTargetRequestCheckboxConfirmationInteraction,
  staleTargetRequestConfirmationInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  RequestCheckboxConfirmationInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
  IssueThreadInteraction,
} from "@/lib/issue-thread-interactions";
import { storybookAgentMap } from "../fixtures/paperclipData";

const boardUserLabels = new Map<string, string>([
  [issueThreadInteractionFixtureMeta.currentUserId, "Riley Board"],
  ["user-product", "Mara Product"],
]);

function StoryFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">{children}</main>
    </div>
  );
}

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="paperclip-story__label">{eyebrow}</div>
          <h2 className="mt-1 text-xl font-semibold">{title}</h2>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function ScenarioCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function StaticInteractionCard({
  interaction,
}: {
  interaction: IssueThreadInteraction;
}) {
  return (
    <IssueThreadInteractionCard
      interaction={interaction}
      agentMap={storybookAgentMap}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
      userLabelMap={boardUserLabels}
    />
  );
}

function MobileScenario({
  title,
  interaction,
}: {
  title: string;
  interaction: IssueThreadInteraction;
}) {
  return (
    <StoryFrame>
      <div className="mx-auto w-[390px] max-w-full">
        <ScenarioCard title={title} description="390px-wide mobile render.">
          <StaticInteractionCard interaction={interaction} />
        </ScenarioCard>
      </div>
    </StoryFrame>
  );
}

function InteractiveSuggestedTasksCard() {
  const [interaction, setInteraction] = useState<SuggestTasksInteraction>(
    pendingSuggestedTasksInteraction,
  );

  return (
    <IssueThreadInteractionCard
      interaction={interaction}
      agentMap={storybookAgentMap}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
      userLabelMap={boardUserLabels}
      onAcceptInteraction={(_interaction, selectedClientKeys) =>
        setInteraction({
          ...acceptedSuggestedTasksInteraction,
          result: {
            version: 1,
            createdTasks: (acceptedSuggestedTasksInteraction.result?.createdTasks ?? []).filter((task) =>
              selectedClientKeys?.includes(task.clientKey) ?? true),
            skippedClientKeys: pendingSuggestedTasksInteraction.payload.tasks
              .map((task) => task.clientKey)
              .filter((clientKey) => !(selectedClientKeys?.includes(clientKey) ?? true)),
          },
        })}
      onRejectInteraction={(_interaction, reason) =>
        setInteraction({
          ...rejectedSuggestedTasksInteraction,
          result: {
            version: 1,
            ...(rejectedSuggestedTasksInteraction.result ?? {}),
            rejectionReason:
              reason
              || rejectedSuggestedTasksInteraction.result?.rejectionReason
              || null,
          },
        })}
    />
  );
}

function AutoClickInteractionCard({
  buttonText,
  children,
}: {
  buttonText: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const button = Array.from(ref.current?.querySelectorAll("button") ?? [])
      .find((candidate) => candidate.textContent?.includes(buttonText));
    button?.click();
  }, [buttonText]);

  return <div ref={ref}>{children}</div>;
}

function InFlightSuggestedTasksCard() {
  return (
    <AutoClickInteractionCard buttonText="Accept drafts">
      <IssueThreadInteractionCard
        interaction={pendingSuggestedTasksInteraction}
        agentMap={storybookAgentMap}
        currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
        userLabelMap={boardUserLabels}
        onAcceptInteraction={() => new Promise(() => {})}
        onRejectInteraction={() => undefined}
      />
    </AutoClickInteractionCard>
  );
}

function InFlightAskUserQuestionsCard() {
  const readyInteraction: AskUserQuestionsInteraction = {
    ...pendingAskUserQuestionsInteraction,
    result: {
      version: 1,
      answers: [
        {
          questionId: "collapse-depth",
          optionIds: ["visible-root"],
        },
        {
          questionId: "post-submit-summary",
          optionIds: ["answers-inline"],
        },
      ],
    },
  };

  return (
    <AutoClickInteractionCard buttonText="Send answers">
      <IssueThreadInteractionCard
        interaction={readyInteraction}
        agentMap={storybookAgentMap}
        currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
        userLabelMap={boardUserLabels}
        onSubmitInteractionAnswers={() => new Promise(() => {})}
      />
    </AutoClickInteractionCard>
  );
}

function InFlightRequestConfirmationCard() {
  return (
    <AutoClickInteractionCard buttonText="Approve plan">
      <IssueThreadInteractionCard
        interaction={pendingRequestConfirmationInteraction}
        agentMap={storybookAgentMap}
        currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
        userLabelMap={boardUserLabels}
        onAcceptInteraction={() => new Promise(() => {})}
        onRejectInteraction={() => undefined}
      />
    </AutoClickInteractionCard>
  );
}

function InFlightCheckboxConfirmationCard() {
  return (
    <AutoClickInteractionCard buttonText="Delete selected">
      <IssueThreadInteractionCard
        interaction={pendingRequestCheckboxConfirmationInteraction}
        agentMap={storybookAgentMap}
        currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
        userLabelMap={boardUserLabels}
        onAcceptInteraction={() => new Promise(() => {})}
        onRejectInteraction={() => undefined}
      />
    </AutoClickInteractionCard>
  );
}

function buildAnsweredInteraction(
  answers: AskUserQuestionsAnswer[],
): AskUserQuestionsInteraction {
  const labels = pendingAskUserQuestionsInteraction.payload.questions.flatMap((question) => {
    const answer = answers.find((entry) => entry.questionId === question.id);
    if (!answer) return [];
    return question.options
      .filter((option) => answer.optionIds.includes(option.id))
      .map((option) => option.label);
  });

  return {
    ...answeredAskUserQuestionsInteraction,
    result: {
      version: 1,
      answers,
      summaryMarkdown: labels.map((label) => `- ${label}`).join("\n"),
    },
  };
}

function InteractiveAskUserQuestionsCard() {
  const [interaction, setInteraction] = useState<AskUserQuestionsInteraction>(
    pendingAskUserQuestionsInteraction,
  );

  return (
    <IssueThreadInteractionCard
      interaction={interaction}
      agentMap={storybookAgentMap}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
      userLabelMap={boardUserLabels}
      onSubmitInteractionAnswers={(_interaction, answers) =>
        setInteraction(buildAnsweredInteraction(answers))}
    />
  );
}

function InteractiveRequestConfirmationCard() {
  const [interaction, setInteraction] = useState<RequestConfirmationInteraction>(
    pendingRequestConfirmationInteraction,
  );

  return (
    <IssueThreadInteractionCard
      interaction={interaction}
      agentMap={storybookAgentMap}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
      userLabelMap={boardUserLabels}
      onAcceptInteraction={() => setInteraction(acceptedRequestConfirmationInteraction)}
      onRejectInteraction={(_interaction, reason) =>
        setInteraction({
          ...rejectedRequestConfirmationInteraction,
          result: {
            version: 1,
            outcome: "rejected",
            reason: reason || rejectedRequestConfirmationInteraction.result?.reason || null,
          },
        })}
    />
  );
}

function InteractiveRequestCheckboxConfirmationCard({
  pending,
  accepted,
  rejected,
}: {
  pending: RequestCheckboxConfirmationInteraction;
  accepted: RequestCheckboxConfirmationInteraction;
  rejected: RequestCheckboxConfirmationInteraction;
}) {
  const [interaction, setInteraction] = useState<RequestCheckboxConfirmationInteraction>(pending);

  return (
    <IssueThreadInteractionCard
      interaction={interaction}
      agentMap={storybookAgentMap}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
      userLabelMap={boardUserLabels}
      onAcceptInteraction={(_interaction, _selectedClientKeys, selectedOptionIds) =>
        setInteraction({
          ...accepted,
          payload: pending.payload,
          result: {
            version: 1,
            outcome: "accepted",
            selectedOptionIds: selectedOptionIds ?? [],
          },
        })}
      onRejectInteraction={(_interaction, reason) =>
        setInteraction({
          ...rejected,
          payload: pending.payload,
          result: {
            version: 1,
            outcome: "rejected",
            reason: reason || rejected.result?.reason || null,
          },
        })}
    />
  );
}

function AutoOpenDeclineRequestConfirmationCard({
  interaction,
}: {
  interaction: RequestConfirmationInteraction;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const declineButton = Array.from(ref.current?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.includes(interaction.payload.rejectLabel ?? "Decline"));
    declineButton?.click();
  }, [interaction]);

  return (
    <div ref={ref}>
      <IssueThreadInteractionCard
        interaction={interaction}
        agentMap={storybookAgentMap}
        currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
        userLabelMap={boardUserLabels}
        onAcceptInteraction={() => undefined}
        onRejectInteraction={() => undefined}
      />
    </div>
  );
}

const meta = {
  title: "Chat & Comments/Issue Thread Interactions",
  parameters: {
    docs: {
      description: {
        component:
          "Interaction cards for `suggest_tasks`, `ask_user_questions`, `request_confirmation`, and `request_checkbox_confirmation`, shown both in isolation and inside the real `IssueChatThread` feed.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const SuggestedTasksPending: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Pending suggested tasks"
        description="Draft issues are selectable before they become real issues."
      >
        <InteractiveSuggestedTasksCard />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const SuggestedTasksAccepted: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Accepted suggested tasks"
        description="Created issues are linked back to their original draft rows."
      >
        <IssueThreadInteractionCard
          interaction={acceptedSuggestedTasksInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const SuggestedTasksPartiallyAccepted: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Partially accepted suggested tasks"
        description="Some suggested tasks became issues while the rest stayed marked as skipped."
      >
        <StaticInteractionCard interaction={partialAcceptedSuggestedTasksInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const SuggestedTasksRejected: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Rejected suggested tasks"
        description="The declined draft stays visible with its rejection note."
      >
        <IssueThreadInteractionCard
          interaction={rejectedSuggestedTasksInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const SuggestedTasksExpired: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Expired suggested tasks"
        description="The suggestion is no longer actionable, but the proposed task tree remains readable."
      >
        <StaticInteractionCard interaction={expiredSuggestedTasksInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const SuggestedTasksCancelled: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Cancelled suggested tasks"
        description="The cancelled state keeps the draft artifact visible without action controls."
      >
        <StaticInteractionCard interaction={cancelledSuggestedTasksInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const SuggestedTasksFailed: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Failed suggested tasks"
        description="Failed resolution removes controls while preserving the task tree for inspection."
      >
        <StaticInteractionCard interaction={failedSuggestedTasksInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const AskUserQuestionsPending: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Pending question form"
        description="Single- and multi-select questions remain local until submitted."
      >
        <InteractiveAskUserQuestionsCard />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const AskUserQuestionsEveryQuestionType: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Every question input shape"
        description="Single-select, multi-select, optional, long-copy, and Other free-text paths render together."
      >
        <IssueThreadInteractionCard
          interaction={everyQuestionTypeAskUserQuestionsInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
          onSubmitInteractionAnswers={() => undefined}
          onCancelInteraction={() => undefined}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const AskUserQuestionsAnswered: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Answered question form"
        description="Selected answers and the submitted summary remain attached to the thread."
      >
        <IssueThreadInteractionCard
          interaction={answeredAskUserQuestionsInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const AskUserQuestionsEveryQuestionTypeAnswered: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Answered every question input shape"
        description="Answered summaries include selected choices, empty optional answers, and Other free text."
      >
        <StaticInteractionCard interaction={everyQuestionTypeAnsweredAskUserQuestionsInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const AskUserQuestionsExpiredByComment: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Question form expired by comment"
        description="A later board comment superseded the unanswered question request."
      >
        <StaticInteractionCard interaction={commentExpiredAskUserQuestionsInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const AskUserQuestionsCancelled: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Cancelled question form"
        description="Cancellation records why no answer set was captured."
      >
        <StaticInteractionCard interaction={cancelledAskUserQuestionsInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const AskUserQuestionsFailed: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Failed question form"
        description="The failed state is read-only and keeps each unanswered prompt visible."
      >
        <StaticInteractionCard interaction={failedAskUserQuestionsInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationPending: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Pending request confirmation"
        description="A generic confirmation can render without a target or custom labels."
      >
        <IssueThreadInteractionCard
          interaction={genericPendingRequestConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
          onAcceptInteraction={() => undefined}
          onRejectInteraction={() => undefined}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationPendingWithTarget: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Pending request confirmation with target"
        description="The watched plan document renders as a compact target chip."
      >
        <IssueThreadInteractionCard
          interaction={pendingRequestConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
          onAcceptInteraction={() => undefined}
          onRejectInteraction={() => undefined}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationPendingDecliningOptional: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Pending optional decline"
        description="The decline textarea is visible, but a reason is optional."
      >
        <AutoOpenDeclineRequestConfirmationCard
          interaction={optionalDeclineRequestConfirmationInteraction}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationPendingRequireReason: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Pending required decline reason"
        description="A plan approval waits for an explicit board decision and requires a decline reason."
      >
        <InteractiveRequestConfirmationCard />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationConfirmed: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Confirmed request confirmation"
        description="The resolved state remains visible without active controls."
      >
        <IssueThreadInteractionCard
          interaction={acceptedRequestConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationDeclinedWithReason: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Declined request confirmation"
        description="The decline reason stays attached to the request in the thread."
      >
        <IssueThreadInteractionCard
          interaction={rejectedRequestConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationDeclinedNoReason: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Declined without a reason"
        description="The card stays compact when no decline reason was provided."
      >
        <IssueThreadInteractionCard
          interaction={rejectedNoReasonRequestConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationExpiredByComment: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Expired by comment"
        description="A board comment superseded the request before resolution."
      >
        <IssueThreadInteractionCard
          interaction={commentExpiredRequestConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationExpiredByTargetChange: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Expired by target change"
        description="The watched plan document moved to a newer revision before approval."
      >
        <IssueThreadInteractionCard
          interaction={staleTargetRequestConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationPlanApprovalPending: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Pending plan approval"
        description="The plan-approval variant keeps the approval labels and target chip visible."
      >
        <InteractiveRequestConfirmationCard />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationPlanApprovalConfirmed: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Confirmed plan approval"
        description="The resolved plan approval reads as a compact receipt."
      >
        <IssueThreadInteractionCard
          interaction={planApprovalAcceptedRequestConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationFailed: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Failed request confirmation"
        description="The failed state provides explicit recovery copy."
      >
        <IssueThreadInteractionCard
          interaction={failedRequestConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationCancelled: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Cancelled request confirmation"
        description="A cancelled confirmation has the same shell language as other inactive states."
      >
        <StaticInteractionCard interaction={cancelledRequestConfirmationInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const RequestConfirmationAccepted = RequestConfirmationConfirmed;
export const RequestConfirmationRejected = RequestConfirmationDeclinedWithReason;

export const CheckboxConfirmationPending: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Pending checkbox confirmation"
        description="Board users select any number of options, with frontend-owned select-all and clear controls."
      >
        <InteractiveRequestCheckboxConfirmationCard
          pending={pendingRequestCheckboxConfirmationInteraction}
          accepted={acceptedRequestCheckboxConfirmationInteraction}
          rejected={rejectedRequestCheckboxConfirmationInteraction}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const CheckboxConfirmationBounded: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Min/max constrained selection"
        description="The card enforces minimum and maximum selection counts and requires a decline reason."
      >
        <InteractiveRequestCheckboxConfirmationCard
          pending={boundedRequestCheckboxConfirmationInteraction}
          accepted={acceptedRequestCheckboxConfirmationInteraction}
          rejected={rejectedRequestCheckboxConfirmationInteraction}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const CheckboxConfirmationAccepted: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Accepted checkbox confirmation"
        description="The resolved state leads with a count and lists the selected labels."
      >
        <IssueThreadInteractionCard
          interaction={acceptedRequestCheckboxConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const CheckboxConfirmationAcceptedMany: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Accepted large selection"
        description="Large resolved selections summarize by count first and bound the inline chips."
      >
        <IssueThreadInteractionCard
          interaction={acceptedManyRequestCheckboxConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const CheckboxConfirmationRejected: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Declined checkbox confirmation"
        description="The decline reason stays attached to the request in the thread."
      >
        <IssueThreadInteractionCard
          interaction={rejectedRequestCheckboxConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const CheckboxConfirmationExpiredByComment: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Checkbox confirmation expired by comment"
        description="A later board comment superseded the selection before it was confirmed."
      >
        <StaticInteractionCard interaction={commentExpiredRequestCheckboxConfirmationInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const CheckboxConfirmationStaleTarget: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Expired by target change"
        description="The watched plan revision moved before the selection was confirmed."
      >
        <IssueThreadInteractionCard
          interaction={staleTargetRequestCheckboxConfirmationInteraction}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          userLabelMap={boardUserLabels}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const CheckboxConfirmationCancelled: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Cancelled checkbox confirmation"
        description="The cancelled state keeps the prompt and option context visible without controls."
      >
        <StaticInteractionCard interaction={cancelledRequestCheckboxConfirmationInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const CheckboxConfirmationFailed: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Failed checkbox confirmation"
        description="Failed resolution shows the recovery copy used by inactive checkbox confirmations."
      >
        <StaticInteractionCard interaction={failedRequestCheckboxConfirmationInteraction} />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const CheckboxConfirmationManyOptions: Story = {
  render: () => (
    <StoryFrame>
      <ScenarioCard
        title="Around 100 options"
        description="The list stays compact inside a bounded scroll region even with 100 options."
      >
        <InteractiveRequestCheckboxConfirmationCard
          pending={manyOptionsRequestCheckboxConfirmationInteraction}
          accepted={acceptedManyRequestCheckboxConfirmationInteraction}
          rejected={rejectedRequestCheckboxConfirmationInteraction}
        />
      </ScenarioCard>
    </StoryFrame>
  ),
};

export const InteractionInFlightStates: Story = {
  render: () => (
    <StoryFrame>
      <Section eyebrow="In-flight" title="Submitting states where the card can represent a pending action">
        <div className="grid gap-6 xl:grid-cols-2">
          <ScenarioCard
            title="Suggested tasks accepting"
            description="The primary action shows a loading state while acceptance is in flight."
          >
            <InFlightSuggestedTasksCard />
          </ScenarioCard>
          <ScenarioCard
            title="Questions submitting"
            description="The submit button shows a loading state while answers are being sent."
          >
            <InFlightAskUserQuestionsCard />
          </ScenarioCard>
          <ScenarioCard
            title="Confirmation accepting"
            description="The confirmation button stays disabled and shows progress."
          >
            <InFlightRequestConfirmationCard />
          </ScenarioCard>
          <ScenarioCard
            title="Checkbox confirmation accepting"
            description="Selection confirmation shows progress while the response is unresolved."
          >
            <InFlightCheckboxConfirmationCard />
          </ScenarioCard>
        </div>
      </Section>
    </StoryFrame>
  ),
};

export const SuggestedTasksMobile390: Story = {
  render: () => (
    <MobileScenario
      title="Suggested tasks mobile"
      interaction={pendingSuggestedTasksInteraction}
    />
  ),
};

export const AskUserQuestionsMobile390: Story = {
  render: () => (
    <MobileScenario
      title="Question form mobile"
      interaction={everyQuestionTypeAskUserQuestionsInteraction}
    />
  ),
};

export const RequestConfirmationMobile390: Story = {
  render: () => (
    <MobileScenario
      title="Confirmation mobile"
      interaction={pendingRequestConfirmationInteraction}
    />
  ),
};

export const CheckboxConfirmationMobile390: Story = {
  render: () => (
    <MobileScenario
      title="Checkbox confirmation mobile"
      interaction={pendingRequestCheckboxConfirmationInteraction}
    />
  ),
};

export const StateMatrix: Story = {
  render: () => (
    <StoryFrame>
      <Section eyebrow="State matrix" title="Issue-thread interaction status coverage">
        <div className="grid gap-6 xl:grid-cols-2">
          <ScenarioCard title="Suggested tasks" description="Pending, accepted, rejected, expired, cancelled, and failed.">
            <div className="space-y-4">
              <StaticInteractionCard interaction={pendingSuggestedTasksInteraction} />
              <StaticInteractionCard interaction={partialAcceptedSuggestedTasksInteraction} />
              <StaticInteractionCard interaction={rejectedSuggestedTasksInteraction} />
              <StaticInteractionCard interaction={expiredSuggestedTasksInteraction} />
              <StaticInteractionCard interaction={cancelledSuggestedTasksInteraction} />
              <StaticInteractionCard interaction={failedSuggestedTasksInteraction} />
            </div>
          </ScenarioCard>
          <ScenarioCard title="Ask user questions" description="Pending, answered, expired by comment, cancelled, and failed.">
            <div className="space-y-4">
              <StaticInteractionCard interaction={everyQuestionTypeAskUserQuestionsInteraction} />
              <StaticInteractionCard interaction={everyQuestionTypeAnsweredAskUserQuestionsInteraction} />
              <StaticInteractionCard interaction={commentExpiredAskUserQuestionsInteraction} />
              <StaticInteractionCard interaction={cancelledAskUserQuestionsInteraction} />
              <StaticInteractionCard interaction={failedAskUserQuestionsInteraction} />
            </div>
          </ScenarioCard>
          <ScenarioCard title="Request confirmation" description="Pending, accepted, rejected, both expiry reasons, cancelled, and failed.">
            <div className="space-y-4">
              <StaticInteractionCard interaction={pendingRequestConfirmationInteraction} />
              <StaticInteractionCard interaction={acceptedRequestConfirmationInteraction} />
              <StaticInteractionCard interaction={rejectedRequestConfirmationInteraction} />
              <StaticInteractionCard interaction={commentExpiredRequestConfirmationInteraction} />
              <StaticInteractionCard interaction={staleTargetRequestConfirmationInteraction} />
              <StaticInteractionCard interaction={cancelledRequestConfirmationInteraction} />
              <StaticInteractionCard interaction={failedRequestConfirmationInteraction} />
            </div>
          </ScenarioCard>
          <ScenarioCard title="Checkbox confirmation" description="Pending, accepted, rejected, both expiry reasons, cancelled, and failed.">
            <div className="space-y-4">
              <StaticInteractionCard interaction={pendingRequestCheckboxConfirmationInteraction} />
              <StaticInteractionCard interaction={acceptedRequestCheckboxConfirmationInteraction} />
              <StaticInteractionCard interaction={rejectedRequestCheckboxConfirmationInteraction} />
              <StaticInteractionCard interaction={commentExpiredRequestCheckboxConfirmationInteraction} />
              <StaticInteractionCard interaction={staleTargetRequestCheckboxConfirmationInteraction} />
              <StaticInteractionCard interaction={cancelledRequestCheckboxConfirmationInteraction} />
              <StaticInteractionCard interaction={failedRequestCheckboxConfirmationInteraction} />
            </div>
          </ScenarioCard>
        </div>
      </Section>
    </StoryFrame>
  ),
};

export const ReviewSurface: Story = {
  render: () => (
    <StoryFrame>
      <section className="paperclip-story__frame p-6">
        <div className="paperclip-story__label">Thread interactions</div>
        <div className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          This review surface pressure-tests the thread interaction kinds directly inside the issue
          chat surface. The card language leans closer to
          annotated review sheets than generic admin widgets so the objects feel like first-class work
          artifacts in the thread.
        </div>
      </section>

      <Section eyebrow="Suggested Tasks" title="Pending, accepted, and rejected task-tree cards">
        <div className="grid gap-6 xl:grid-cols-3">
          <ScenarioCard
            title="Pending"
            description="The draft tree stays editable and non-persistent until someone accepts or rejects it."
          >
            <InteractiveSuggestedTasksCard />
          </ScenarioCard>
          <ScenarioCard
            title="Accepted"
            description="Accepted state resolves to created issue links while keeping the original suggestion visible in-thread."
          >
            <IssueThreadInteractionCard
              interaction={acceptedSuggestedTasksInteraction}
              agentMap={storybookAgentMap}
              currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
              userLabelMap={boardUserLabels}
            />
          </ScenarioCard>
          <ScenarioCard
            title="Rejected"
            description="The rejection reason remains attached to the artifact so future reviewers can see why the draft was declined."
          >
            <IssueThreadInteractionCard
              interaction={rejectedSuggestedTasksInteraction}
              agentMap={storybookAgentMap}
              currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
              userLabelMap={boardUserLabels}
            />
          </ScenarioCard>
        </div>
      </Section>

      <Section eyebrow="Ask User Questions" title="Pending multi-question form and answered summary">
        <div className="grid gap-6 xl:grid-cols-2">
          <ScenarioCard
            title="Pending"
            description="Answers stay local across the whole form and only wake the assignee once after final submit."
          >
            <InteractiveAskUserQuestionsCard />
          </ScenarioCard>
          <ScenarioCard
            title="Answered"
            description="The answered state keeps the exact choices visible and adds a compact summary note for later review."
          >
            <IssueThreadInteractionCard
              interaction={answeredAskUserQuestionsInteraction}
              agentMap={storybookAgentMap}
              currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
              userLabelMap={boardUserLabels}
            />
          </ScenarioCard>
        </div>
      </Section>

      <Section eyebrow="Request Confirmation" title="Plan approval and compact resolution states">
        <div className="grid gap-6 xl:grid-cols-2">
          <ScenarioCard
            title="Plan approval"
            description="The pending card links to the watched plan revision and requires a reason when declined."
          >
            <InteractiveRequestConfirmationCard />
          </ScenarioCard>
          <ScenarioCard
            title="Accepted"
            description="Accepted confirmations stay visible as resolved work artifacts."
          >
            <IssueThreadInteractionCard
              interaction={acceptedRequestConfirmationInteraction}
              agentMap={storybookAgentMap}
              currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
              userLabelMap={boardUserLabels}
            />
          </ScenarioCard>
          <ScenarioCard
            title="Rejected"
            description="Rejected confirmations keep the board's decline reason attached."
          >
            <IssueThreadInteractionCard
              interaction={rejectedRequestConfirmationInteraction}
              agentMap={storybookAgentMap}
              currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
              userLabelMap={boardUserLabels}
            />
          </ScenarioCard>
          <ScenarioCard
            title="Expired states"
            description="Comment and target-change expiry states are compact and disabled."
          >
            <div className="space-y-4">
              <IssueThreadInteractionCard
                interaction={commentExpiredRequestConfirmationInteraction}
                agentMap={storybookAgentMap}
                currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
                userLabelMap={boardUserLabels}
              />
              <IssueThreadInteractionCard
                interaction={staleTargetRequestConfirmationInteraction}
                agentMap={storybookAgentMap}
                currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
                userLabelMap={boardUserLabels}
              />
            </div>
          </ScenarioCard>
        </div>
      </Section>

      <Section eyebrow="Mixed Feed" title="Interaction cards in the real issue thread">
        <ScenarioCard
          title="IssueChatThread composition"
          description="Comments, timeline events, accepted task suggestions, a pending confirmation, a pending question form, and an active run share the same feed."
        >
          <div className="overflow-hidden rounded-[32px] border border-border/70 bg-[linear-gradient(135deg,rgba(14,165,233,0.08),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.08),transparent_42%),var(--background)] p-5 shadow-[0_30px_80px_rgba(15,23,42,0.10)]">
            <IssueChatThread
              comments={issueThreadInteractionComments}
              interactions={mixedIssueThreadInteractions}
              timelineEvents={issueThreadInteractionEvents}
              liveRuns={issueThreadInteractionLiveRuns}
              transcriptsByRunId={issueThreadInteractionTranscriptsByRunId}
              hasOutputForRun={(runId) => runId === "run-thread-live"}
              companyId={issueThreadInteractionFixtureMeta.companyId}
              projectId={issueThreadInteractionFixtureMeta.projectId}
              currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
              userLabelMap={boardUserLabels}
              agentMap={storybookAgentMap}
              onAdd={async () => {}}
              showComposer={false}
            />
          </div>
        </ScenarioCard>
      </Section>
    </StoryFrame>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Covers the prototype states called out in [PAP-1709](/PAP/issues/PAP-1709): suggested-task previews, collapsed descendants, rejection reasons, request confirmations, multi-question answers, and a mixed issue thread.",
      },
    },
  },
};
