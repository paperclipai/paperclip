import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue, IssueExecutionState } from "@paperclipai/shared";
import { IssueExecutionDecisionCard } from "@/components/IssueExecutionDecisionCard";

const VIEWER = "user-viewer";

function stateWith(overrides: Partial<IssueExecutionState>): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "user", userId: VIEWER },
    returnAssignee: { type: "agent", agentId: "agent-eng" },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

function issueWith(state: IssueExecutionState, id = "issue-1"): Issue {
  return { id, executionState: state } as unknown as Issue;
}

function StoryFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-2xl space-y-5">
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">Execution-policy decisions</div>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

/** Interactive so screenshots can show the disabled-until-typed state honestly. */
function InteractiveCard(props: { issue: Issue; working?: boolean }) {
  return (
    <IssueExecutionDecisionCard
      issue={props.issue}
      currentUserId={VIEWER}
      onApprove={() => (props.working ? new Promise<void>(() => undefined) : undefined)}
      onRequestChanges={() => (props.working ? new Promise<void>(() => undefined) : undefined)}
    />
  );
}

function ReviewStatePanel() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">A. Review stage, no instructions</div>
      <InteractiveCard issue={issueWith(stateWith({ currentStageType: "review" }))} />
    </div>
  );
}

function ApprovalWithInstructionsPanel() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">B. Approval stage with reviewer instructions</div>
      <InteractiveCard
        issue={issueWith(
          stateWith({
            currentStageType: "approval",
            reviewRequest: { instructions: "Confirm the migration ran cleanly against staging before approving." },
          }),
        )}
      />
    </div>
  );
}

function LoadingStatePanel() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">C. Approve in flight (buttons locked)</div>
      <IssueExecutionDecisionCard
        issue={issueWith(stateWith({ currentStageType: "approval" }))}
        currentUserId={VIEWER}
        onApprove={() => new Promise(() => undefined)}
        onRequestChanges={() => new Promise(() => undefined)}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Rendered pre-clicked in a separate story variant for the loading screenshot — see “Approving (loading)”.
      </p>
    </div>
  );
}

function AllStates() {
  return (
    <StoryFrame title="Board decision card — all states">
      <ReviewStatePanel />
      <ApprovalWithInstructionsPanel />
      <LoadingStatePanel />
    </StoryFrame>
  );
}

const meta = {
  title: "Paperclip/Issue Execution Decision Card",
  component: AllStates,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AllStates>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Overview: Story = {};

export const ReviewStage: Story = {
  render: () => (
    <StoryFrame title="Review stage, no instructions">
      <ReviewStatePanel />
    </StoryFrame>
  ),
};

export const ApprovalWithInstructions: Story = {
  render: () => (
    <StoryFrame title="Approval stage with reviewer instructions">
      <ApprovalWithInstructionsPanel />
    </StoryFrame>
  ),
};

export const ApprovingLoading: Story = {
  render: () => (
    <StoryFrame title="Approving in flight">
      <div className="rounded-lg border border-border bg-card p-4">
        <InteractiveCard issue={issueWith(stateWith({ currentStageType: "approval" }))} working />
      </div>
    </StoryFrame>
  ),
};
