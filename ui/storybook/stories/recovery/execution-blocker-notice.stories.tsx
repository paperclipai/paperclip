import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { ExecutionBlockerNotice } from "@/components/ExecutionBlockerNotice";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatLiveRunPill } from "@/components/task-chat/TaskChatLiveRunPill";

const failed: TaskInterruptionPresentation = {
  intentId: "saved-request", responsibility: "system", state: "failed", nextRetryAt: null,
  canRetry: true, userAction: null, sourceRunIds: ["stopped-run"], observedRunId: "stopped-run",
};
const meta = {
  id: "task-chat-recovery-notice",
  title: "Projects and execution/Recovery/Task chat/Recovery notice",
  component: ExecutionBlockerNotice,
  parameters: { paperclip: {
    capabilities: ["recovery/diagnosis", "recovery/exhaustion"], implementation: "production", boundary: "fixtures",
    notes: "Production task status driven by the shared presentation contract. Former inspection and certification examples now exercise ordinary Retry, quiet preparation, and permission gating. Fixture transitions do not prove provider recovery or durable admission.",
  } },
  decorators: [(Story) => <div className="mx-auto flex w-full max-w-2xl flex-col gap-4"><Story /></div>],
  args: { presentation: failed, canRetry: true, onRetry: () => {} },
} satisfies Meta<typeof ExecutionBlockerNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
const ordinaryRetry: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("button", { name: /^Retry$/ })).toBeVisible();
  await expect(canvas.queryByRole("link", { name: "Inspect run" })).not.toBeInTheDocument();
  await expect(canvas.queryByRole("checkbox")).not.toBeInTheDocument();
};
export const Stopped: Story = { play: ordinaryRetry };
export const FileRecovery: Story = { play: ordinaryRetry };
export const RecoveringSavedWork: Story = {
  args: { presentation: { ...failed, state: "working" } },
  play: async ({ canvasElement }) => { await expect(within(canvasElement).queryByRole("status")).not.toBeInTheDocument(); },
};
export const RetrySavedWork: Story = {
  render: function RetryJourney(args) {
    const [pending, setPending] = useState(false);
    return <>
      <TaskChatBubble item={{ id: "saved-request", kind: "message", author: "human", authorName: "Alex",
        text: "Confirm the existing review and finish the task. Do not publish another review." }} />
      {pending && <TaskChatLiveRunPill status="running" startedAtMs={null} toolSummary={null} />}
      <ExecutionBlockerNotice {...args} optimistic={pending} onRetry={() => setPending(true)} />
    </>;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /^Retry$/ }));
    await expect(canvas.getByText("Working")).toBeVisible();
    await expect(canvas.queryByRole("status")).not.toBeInTheDocument();
  },
};
// Stable IDs retained: each historical failure now shares the ordinary Retry contract.
export const PreviousSessionUnverified: Story = { play: ordinaryRetry };
export const FileRecoveryReadOnly: Story = { args: { canRetry: false }, play: async ({ canvasElement }) => {
  await expect(within(canvasElement).queryByRole("button")).not.toBeInTheDocument();
} };
export const FileRecoveryRecorded: Story = { play: ordinaryRetry };
export const FileRecoveryRejected: Story = { play: ordinaryRetry };
export const AutomaticRecovery: Story = { ...RecoveringSavedWork };
export const MissedRecovery: Story = { play: ordinaryRetry };
export const RecoveryReadUnavailable: Story = { args: { takingLonger: true }, play: async ({ canvasElement }) => {
  await expect(within(canvasElement).getByText("Taking longer than usual…")).toBeVisible();
} };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } }, play: ordinaryRetry };
export const SourceReconstruction: Story = { play: ordinaryRetry };
export const ReconstructionQueued: Story = { ...RecoveringSavedWork };
export const RetryScheduled: Story = { args: { presentation: { ...failed, state: "retry_scheduled", nextRetryAt: new Date(Date.now() + 60_000).toISOString() } }, play: ordinaryRetry };
