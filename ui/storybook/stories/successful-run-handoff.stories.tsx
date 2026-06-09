import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { IssueBlockedNotice } from "@/components/IssueBlockedNotice";
import { KanbanBoard } from "@/components/KanbanBoard";
import { SuccessfulRunHandoffCommentCallout } from "@/components/IssueChatThread";
import { Identity } from "@/components/Identity";
import { cn, relativeTime } from "@/lib/utils";
import { formatIssueActivityAction } from "@/lib/activity-format";
import {
  SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION,
  SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION,
  successfulRunHandoffActivityTone,
} from "@/lib/successful-run-handoff";
import { createIssue, storybookAgents } from "../fixtures/paperclipData";

function ActivityExample({ action }: { action: string }) {
  const tone = successfulRunHandoffActivityTone(action);
  const isWarning = action !== SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION;
  return (
    <div className={cn("space-y-1.5 rounded-lg border px-3 py-2 text-xs", tone.className)}>
      <div className="flex items-center gap-1.5">
        {isWarning ? <AlertTriangle className={cn("h-3.5 w-3.5 shrink-0", tone.iconClassName)} /> : null}
        <Identity name="System" size="sm" />
        <span>{formatIssueActivityAction(action)}</span>
        <span className="ml-auto shrink-0">{relativeTime(new Date(Date.now() - 3 * 60_000))}</span>
      </div>
    </div>
  );
}

function SuccessfulRunHandoffStates() {
  return (
    <StoryFrame>
      <section className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <PinnedNoticePanel />
        <ActivityEventsPanel />
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <IssueCardPanel />
        <EscalationCommentPanel />
      </section>
    </StoryFrame>
  );
}

function handoffIssue() {
  return createIssue({
    id: "issue-handoff",
    identifier: "PAP-3053",
    issueNumber: 3053,
    title: "Add board-visible handoff affordances and activity copy",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: "agent-codex",
    successfulRunHandoff: {
      state: "required",
      required: true,
      sourceRunId: "9cdba892-c7ca-4d93-8604-4843873b127c",
      correctiveRunId: "61fdb79b-8012-4676-ac71-2971830e126a",
      assigneeAgentId: "agent-codex",
      detectedProgressSummary: "Updated the plan and created the first implementation notes.",
      createdAt: new Date(),
    },
  });
}

function StoryFrame({ children, title = "Board-visible handoff states" }: { children: ReactNode; title?: string }) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">Successful-run next-step review</div>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

function PinnedNoticePanel() {
  const issue = handoffIssue();
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">A. Pinned needs-next-step notice</div>
      <IssueBlockedNotice
        issueStatus="in_progress"
        blockers={[]}
        successfulRunHandoff={issue.successfulRunHandoff}
        agentName="CodexCoder"
      />
    </div>
  );
}

function ActivityEventsPanel() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">B. Activity stream events</div>
      <div className="space-y-2">
        <ActivityExample action={SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION} />
        <ActivityExample action="issue.successful_run_handoff_resolved" />
        <ActivityExample action={SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION} />
      </div>
    </div>
  );
}

function IssueCardPanel() {
  const issue = handoffIssue();
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">C. Issue card indicator</div>
      <KanbanBoard
        issues={[
          issue,
          createIssue({
            id: "issue-review",
            identifier: "PAP-3054",
            issueNumber: 3054,
            title: "Review completed next-step recovery",
            status: "in_review",
            priority: "high",
            assigneeAgentId: "agent-cto",
          }),
        ]}
        agents={storybookAgents}
        onUpdateIssue={() => {}}
      />
    </div>
  );
}

function EscalationCommentPanel() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">D. Escalation comment callout</div>
      <SuccessfulRunHandoffCommentCallout
        text={[
          "Paperclip exhausted the bounded successful-run handoff correction for this issue, but it still has no valid issue disposition.",
          "",
          "This is not a runtime/adapter crash report. The source run succeeded; the remaining problem is the missing `done`, `in_review`, `blocked`, delegated follow-up, or explicit continuation path.",
          "",
          "- Source issue: [PAP-3053](/PAP/issues/PAP-3053)",
          "- Source run: [`9cdba892-c7ca-4d93-8604-4843873b127c`](/PAP/agents/agent-codex/runs/9cdba892-c7ca-4d93-8604-4843873b127c)",
          "- Corrective handoff run: [`61fdb79b-8012-4676-ac71-2971830e126a`](/PAP/agents/agent-codex/runs/61fdb79b-8012-4676-ac71-2971830e126a)",
          "- Source assignee: [CodexCoder](/PAP/agents/codexcoder)",
          "- Latest issue status: `in_progress`",
          "- Latest handoff run status: `succeeded`",
          "- Normalized cause: `successful_run_missing_state`",
          "- Missing disposition: `no_clear_next_step`",
          "- Suggested manager action: choose and record a valid issue disposition without copying transcript content.",
          "",
          "Moving it to `blocked` with an explicit recovery owner so the missing disposition is visible and owned.",
        ].join("\n")}
      />
    </div>
  );
}

function SuccessfulRunHandoffPinnedNotice() {
  return <StoryFrame title="Pinned needs-next-step notice"><PinnedNoticePanel /></StoryFrame>;
}

function SuccessfulRunHandoffActivityEvents() {
  return <StoryFrame title="Activity stream events"><ActivityEventsPanel /></StoryFrame>;
}

function SuccessfulRunHandoffIssueCard() {
  return <StoryFrame title="Issue card indicator"><IssueCardPanel /></StoryFrame>;
}

function SuccessfulRunHandoffEscalationComment() {
  return <StoryFrame title="Escalation comment callout"><EscalationCommentPanel /></StoryFrame>;
}

const meta = {
  title: "Paperclip/Successful Run Handoff",
  component: SuccessfulRunHandoffStates,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof SuccessfulRunHandoffStates>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllStates: Story = {};
export const PinnedNotice: Story = { render: () => <SuccessfulRunHandoffPinnedNotice /> };
export const ActivityEvents: Story = { render: () => <SuccessfulRunHandoffActivityEvents /> };
export const IssueCardIndicator: Story = { render: () => <SuccessfulRunHandoffIssueCard /> };
export const EscalationComment: Story = { render: () => <SuccessfulRunHandoffEscalationComment /> };
