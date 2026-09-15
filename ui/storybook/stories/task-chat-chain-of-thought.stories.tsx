import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { TaskChatStatusPill } from "@/components/task-chat/TaskChatStatusPill";
import { commentsToTaskChatItems } from "@/components/task-chat/task-chat-adapter";
import type { TaskChatItem, TaskChatMessageItem } from "@/components/task-chat/task-chat-model";
import type { IssueChatComment } from "@/lib/issue-chat-messages";

const runningItemSteps: TaskChatItem[][] = [
  [
    {
      id: "reasoning-current",
      kind: "thinking",
      lines: ["Inspecting the task chat layout."],
      streaming: true,
      channel: "summary",
      transcriptIndex: 1,
    },
  ],
  [
    {
      id: "reasoning-current",
      kind: "thinking",
      lines: ["Inspecting the task chat layout."],
      streaming: false,
      channel: "summary",
      transcriptIndex: 1,
    },
    {
      id: "tool-read",
      kind: "tool",
      name: "Read",
      rawName: "read_file",
      target: "ui/src/components/task-chat/TaskChatRunnerTurn.tsx",
      status: "completed",
    },
  ],
  [
    {
      id: "reasoning-current",
      kind: "thinking",
      lines: ["Inspecting the task chat layout."],
      streaming: false,
      channel: "summary",
      transcriptIndex: 1,
    },
    {
      id: "tool-read",
      kind: "tool",
      name: "Read",
      rawName: "read_file",
      target: "ui/src/components/task-chat/TaskChatRunnerTurn.tsx",
      status: "completed",
    },
    {
      id: "tool-test",
      kind: "tool",
      name: "Bash",
      rawName: "bash",
      target: "pnpm exec vitest run ui/src/components/task-chat/TaskChatRunnerTurn.test.tsx --runInBand",
      status: "in_progress",
    },
  ],
];

function ChainOfThoughtReview() {
  const [step, setStep] = useState(0);
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <div className="rounded-lg border border-border bg-background p-4">
        <TaskChatRunnerTurn
          runId="storybook-live-run"
          agentName="CodexRunner"
          items={runningItemSteps[step] ?? runningItemSteps[0]}
          status="running"
          startedAtMs={Date.now() - 12_000}
        />
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button
          type="button"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-foreground hover:bg-muted"
          onClick={() =>
            setStep((value) => (value + 1) % runningItemSteps.length)
          }
          data-testid="advance-running-activity"
        >
          Show next activity
        </button>
        <span aria-live="polite">
          Update {step + 1} of {runningItemSteps.length}
        </span>
      </div>
    </div>
  );
}

const steeredComment: IssueChatComment = {
  id: "steered-comment",
  companyId: "storybook-company",
  issueId: "storybook-issue",
  authorAgentId: null,
  authorUserId: "storybook-user",
  authorType: "user",
  body: "Keep the regular timestamp after steering this follow-up.",
  presentation: null,
  metadata: null,
  createdAt: new Date("2026-09-10T21:09:33.000Z"),
  updatedAt: new Date("2026-09-10T21:09:33.000Z"),
  conversationAnchorAt: "2026-09-10T21:10:14.000Z",
  consumedByRunId: "run-live",
  followUpRequested: true,
  steeredIntoRunId: "run-live",
};

function TimestampReview() {
  const [item] = commentsToTaskChatItems([steeredComment]);
  return (
    <div className="max-w-xl rounded-lg border border-border bg-background p-4">
      <TaskChatBubble item={item as TaskChatMessageItem} animateEntry={false} />
    </div>
  );
}

function ReconnectingAlignmentReview() {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-xl rounded-lg border border-border bg-background p-4">
      <TaskChatStatusPill
        item={{
          id: "reconnecting-status",
          kind: "status",
          status: "running",
          label: "Reconnecting",
          startedAtMs: Date.now() - 12_000,
        }}
        chevronOpen={open}
        onToggle={() => setOpen((value) => !value)}
      />
    </div>
  );
}

const meta = {
  title: "Tasks/Task chat review fixes",
  component: ChainOfThoughtReview,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ChainOfThoughtReview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CollapsedRunningChainOfThought: Story = {};

export const RegularTimestampAfterSteering: Story = {
  render: () => <TimestampReview />,
};

export const ReconnectingCaretAndDotAlignment: Story = {
  render: () => <ReconnectingAlignmentReview />,
};
