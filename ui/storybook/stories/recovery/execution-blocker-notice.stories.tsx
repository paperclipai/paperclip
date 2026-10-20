import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { RecoveryNoticeFixture } from "../../support/workspace-file-recovery/fixture";
import { ExecutionBlockerNotice } from "@/components/ExecutionBlockerNotice";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatLiveRunPill } from "@/components/task-chat/TaskChatLiveRunPill";

const meta = {
  id: "task-chat-recovery-notice",
  title: "Projects and execution/Recovery/Task chat/Recovery notice",
  component: ExecutionBlockerNotice,
  parameters: { docs: { story: { inline: false } }, paperclip: {
    capabilities: ["recovery/diagnosis"], implementation: "production", boundary: "fixtures",
    notes: "Production task notice with source-bound recovery reads. Automatic recovery stays quiet; unresolved holds expose inspection without infrastructure certification. Fixture APIs do not prove live provider recovery.",
  } },
  decorators: [(Story, context) => <RecoveryNoticeFixture key={context.id} state={context.parameters.recoveryState ?? "blocked"}>
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4"><Story /></div>
  </RecoveryNoticeFixture>],
  args: {
    companyId: "storybook-company", issueId: "storybook-recovery", issueStatus: "blocked", canManage: true, onRetried: () => {},
    blocker: {
      recoveryActionId: "recovery", runId: "stopped-run", agentId: "agent",
      cause: "native_continuation_requires_reconciliation",
      nextAction: "The previous action's outcome needs inspection before work can continue.",
    },
  },
} satisfies Meta<typeof ExecutionBlockerNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Stopped: Story = {};

const fileHold = {
  ...meta.args.blocker,
  nextAction: "The original workspace is retained. An operator must verify that its previous execution stopped before recovering files.",
  runError: "runner_remote_provider_artifact_incompatible: provider pack verification failed ()",
  workspaceRepairRequired: true, canRecordWorkspaceRepair: true,
};
const noRepairForm: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText("Work paused.")).toBeVisible();
  await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument();
  await expect(canvas.queryByRole("checkbox")).not.toBeInTheDocument();
  await expect(canvas.getByRole("link", { name: "Inspect run" })).toBeVisible();
};
export const FileRecovery: Story = { args: { blocker: fileHold }, play: noRepairForm };
export const RecoveringSavedWork: Story = {
  args: { blocker: { ...fileHold, savedMessageCount: 1, workspaceRecovery: {
    status: "recovering", stage: "restoring_files", canRetry: false, message: "Recovering saved work…",
  } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Recovering saved work…")).toBeVisible();
    await expect(canvas.getByText("Your message is saved and will continue after recovery.")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Retry recovery" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Working")).not.toBeInTheDocument();
  },
};
export const RetrySavedWork: Story = {
  args: { blocker: { ...fileHold, savedMessageCount: 1, workspaceRecovery: {
    status: "blocked", stage: "restoring_files", canRetry: true, message: "Recovery couldn’t finish. Your message is saved.",
  } } },
  render: function RetryJourney(args) {
    const [queued, setQueued] = useState(false);
    return <>
      <TaskChatBubble item={{ id: "saved-request", kind: "message", author: "human", authorName: "Alex",
        text: "Confirm the existing review and finish the task. Do not publish another review." }} />
      <ExecutionBlockerNotice {...args} blocker={queued ? { ...args.blocker, workspaceRecovery: {
        status: "queued", stage: "verifying_stop", canRetry: false, message: "Recovering saved work…",
      } } : args.blocker} onRetried={() => setQueued(true)} />
    </>;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Retry recovery" }));
    await expect(canvas.getByText("Recovering saved work…")).toBeVisible();
    await expect(canvas.getByText("Your message is saved and will continue after recovery.")).toBeVisible();
    await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument();
  },
};
export const PreviousSessionUnverified: Story = {
  args: { blocker: { ...fileHold, savedMessageCount: 1, workspaceRecovery: {
    status: "blocked", stage: "verifying_stop", canRetry: false,
    message: "Paperclip couldn’t verify that the previous session stopped. This task needs service attention.",
  } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/couldn’t verify that the previous session stopped/)).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Retry recovery" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("checkbox")).not.toBeInTheDocument();
  },
};
export const FileRecoveryReadOnly: Story = { args: { blocker: fileHold, canManage: false }, play: noRepairForm };
// Preserve existing story IDs for saved inspection links.
export const FileRecoveryRecorded: Story = { args: { blocker: fileHold }, parameters: { recoveryState: "recorded" }, play: noRepairForm };
export const FileRecoveryRejected: Story = {
  args: { blocker: fileHold }, parameters: { recoveryState: "rejected" },
  play: async context => {
    await noRepairForm(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByText("Recovery details"));
    await expect(canvas.getByText(/previous execution could not be verified stopped/)).toBeVisible();
  },
};
export const AutomaticRecovery: Story = {
  args: { blocker: fileHold }, parameters: { recoveryState: "automatic" },
  render: args => <>
    <TaskChatBubble item={{ id: "request", kind: "message", author: "human", authorName: "Dotta", text: "Review the test suite and open a PR with the useful cleanup." }} />
    <TaskChatLiveRunPill status="running" startedAtMs={null} toolSummary={null} />
    <ExecutionBlockerNotice {...args} />
  </>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Working")).toBeVisible();
    await expect(canvas.queryByRole("status", { name: "Task recovery" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument();
  },
};
export const MissedRecovery: Story = { args: { blocker: fileHold }, parameters: { recoveryState: "expired" }, play: noRepairForm };
export const RecoveryReadUnavailable: Story = {
  args: { blocker: fileHold }, parameters: { recoveryState: "unavailable" },
  play: async context => {
    await expect(await within(context.canvasElement).findByRole("alert")).toHaveTextContent("Recovery service unavailable");
    await noRepairForm(context);
  },
};
export const Mobile: Story = { args: { blocker: fileHold }, globals: { viewport: { value: "mobile", isRotated: false } }, play: noRepairForm };
export const SourceReconstruction: Story = {
  args: { blocker: { ...fileHold, canReconstructWorkspace: true, workspaceRecoveryStatusVersion: 1,
    nextAction: "The original workspace was destroyed. Continue only from verified surviving source attachments." } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Continue from saved sources")).toBeVisible();
    for (const input of canvas.queryAllByRole("textbox")) {
      await expect(input).not.toBeVisible();
    }
    await userEvent.click(canvas.getByText("Continue from saved sources"));
    await expect(canvas.getByText("test-audit.patch (4096 bytes)")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Rebuild and continue" })).toBeDisabled();
  },
};
export const ReconstructionQueued: Story = {
  args: { blocker: { ...fileHold, workspaceReconstructionPending: true,
    nextAction: "Continuation from saved sources is queued and waiting for execution checks." } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Continuation queued.")).toBeVisible();
    await expect(canvas.queryByText("Work paused.")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument();
  },
};
