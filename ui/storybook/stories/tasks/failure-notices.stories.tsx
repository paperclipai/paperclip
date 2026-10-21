import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { TaskChatPresentationProvider, type TaskChatPresentationMode } from "@/components/task-chat/presentation-mode";
import type { TaskChatItem, TaskChatMarkerItem, TaskChatMessageItem } from "@/components/task-chat/task-chat-model";

const failed: TaskChatMarkerItem = {
  id: "failed", kind: "marker", variant: "interrupted", label: "Run failed",
  detail: "The runner stopped before returning an answer (runner_exited).",
  collapsible: true, runId: "failed-run", runHref: "/agents/coder/runs/failed-run",
  createdAtIso: new Date(Date.now() - 3 * 60_000).toISOString(),
};
const recovery: TaskChatMessageItem = {
  id: "no-live-path", kind: "message", author: "system",
  text: "Paperclip retried continuation, but it still has no live execution path. The task is blocked. Your message is preserved.",
  presentation: { kind: "system_notice", title: "No live execution path", tone: "danger", detailsDefaultOpen: false },
  createdAtIso: new Date(Date.now() - 2 * 60_000).toISOString(),
};
const request: TaskChatMessageItem = {
  id: "request", kind: "message", author: "human", authorName: "Alex", isCurrentUser: true,
  text: "Please update the task summary.", timestamp: "12:00 PM",
};

function FailureNotices({ items, mode = "streamlined", recoveryRetryEnabled = true }: { items: TaskChatItem[]; mode?: TaskChatPresentationMode; recoveryRetryEnabled?: boolean }) {
  const [retry, setRetry] = useState<string | null>(null);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground md:p-8">
      <div className="mx-auto max-w-(--tc-shell-max-w)">
        <h1 className="text-xl font-semibold">Task summary</h1>
        <TaskChatPresentationProvider mode={mode}>
          <TaskChatThreadView items={[request, ...items]} scroll={false}
            onRetryFailedRun={(runId) => setRetry(`Retry requested for ${runId}`)}
            onTryAgainNoLiveExecutionPath={recoveryRetryEnabled ? () => setRetry("Recovery retry requested") : undefined} />
        </TaskChatPresentationProvider>
        {retry ? <p role="status" className="text-sm text-muted-foreground">{retry}</p> : null}
      </div>
    </main>
  );
}

const meta = {
  id: "tasks-failure-notices",
  title: "Tasks and conversations/Task creation and lifecycle/Task chat/Failure notices",
  component: FailureNotices,
  args: { items: [failed] },
  parameters: {
    layout: "fullscreen",
    throwPlayFunctionExceptions: true,
    paperclip: {
      capabilities: ["tasks/discussion", "runs-adapters/runs"],
      status: "current", implementation: "production", boundary: "fixtures",
      notes: "Uses the shared production thread and failure markers. Covers older and current markers, either order of adjacent run/recovery errors, intervening messages and unrelated system notices with quoted error text, saved Automatic recovery blocked metadata, both presentation modes, permitted legacy run retries, light and mobile. Retry callbacks record a local receipt; no agent runs or API changes occur.",
    },
  },
} satisfies Meta<typeof FailureNotices>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectNoRules(canvasElement: HTMLElement) {
  await expect(canvasElement.querySelector(".border-dashed, .h-px")).toBeNull();
}

export const FailedRun: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /Run failed/ })).toHaveAttribute("aria-expanded", "false");
    await expectNoRules(canvasElement);
  },
};
export const OlderMarker: Story = {
  args: { items: [{ ...failed, collapsible: false }] },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(within(canvasElement).getByText(failed.detail!, { exact: false })).toBeVisible());
    await expectNoRules(canvasElement);
  },
};
export const ProductionMode: Story = { args: { mode: "production" }, play: FailedRun.play };
export const RecoveryIsLatest: Story = {
  args: { items: [failed, recovery] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Run failed")).toBeNull();
    await expect(canvas.getByRole("button", { name: /No live execution path/ })).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    await expectNoRules(canvasElement);
  },
};
export const FailureIsLatest: Story = {
  args: { items: [recovery, { ...failed, createdAtIso: new Date(Date.now() - 60_000).toISOString() }] },
  play: async (context) => {
    await FailedRun.play?.(context);
    await expect(within(context.canvasElement).queryByText("No live execution path")).toBeNull();
  },
};
export const ExpandedRecoveryAndRetry: Story = {
  args: RecoveryIsLatest.args,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /No live execution path/ }));
    await waitFor(() => expect(canvas.getByText(/Your message is preserved/)).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Recovery retry requested");
  },
};
export const ExpandedFailureAndRetry: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Run failed/ }));
    await waitFor(() => expect(canvas.getByText(failed.detail!)).toBeVisible());
    await expect(canvas.getByRole("link", { name: "View run" }).getAttribute("href")).toMatch(/\/agents\/coder\/runs\/failed-run$/);
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Retry requested for failed-run");
  },
};
export const MessageBetweenErrors: Story = {
  args: { items: [failed, { ...request, id: "followup", text: "Please try again." }, recovery] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText("Run failed")).toBeVisible());
    await waitFor(() => expect(canvas.getByText("No live execution path")).toBeVisible());
  },
};
export const SystemNoticeBetweenErrors: Story = {
  args: { items: [failed, {
    id: "child-notice", kind: "message", author: "system",
    text: "Child task has no live execution path. Parent must review its result.",
    presentation: { kind: "system_notice", title: "Child task blocked", tone: "warning", detailsDefaultOpen: false },
  }, recovery] },
  play: async (context) => {
    await MessageBetweenErrors.play?.(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Child task blocked/ }));
    await waitFor(() => expect(canvas.getByText(/Parent must review its result/)).toBeVisible());
    await expect(context.canvasElement.querySelectorAll('[data-testid="task-chat-no-live-path-try-again"]')).toHaveLength(1);
    await expectNoRules(context.canvasElement);
  },
};
export const ProductionSystemNoticeBetweenErrors: Story = {
  ...SystemNoticeBetweenErrors,
  args: { ...SystemNoticeBetweenErrors.args, mode: "production" },
};
export const Light: Story = { ...RecoveryIsLatest, globals: { theme: "light" } };
export const Mobile: Story = { ...RecoveryIsLatest, globals: { viewport: { value: "mobile1", isRotated: false } } };

export const LegacyRunRetry: Story = {
  args: { items: [failed, recovery], recoveryRetryEnabled: false },
  play: async (context) => {
    await RecoveryIsLatest.play?.(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Retry requested for failed-run");
  },
};
export const LegacyProductionRetry: Story = { ...LegacyRunRetry, args: { ...LegacyRunRetry.args, mode: "production" } };

export const AutomaticRecoveryBlocked: Story = {
  args: { items: [failed, {
    ...recovery,
    text: "Paperclip automatically retried continuation for this assigned `in_progress` issue and the retry made progress, but it still has no live execution path. Moving it to `blocked` so it is visible for intervention.",
    presentation: { ...recovery.presentation!, title: "Automatic recovery blocked" },
    metadata: { version: 1, sourceRunId: "failed-run", sections: [{ title: "Recovery", rows: [
      { type: "key_value", label: "Recovery action", value: "recovery-action-1" },
      { type: "key_value", label: "Recovery owner", value: "Board decision required" },
    ] }] },
  }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Run failed")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: /Automatic recovery blocked/ }));
    await waitFor(() => expect(canvas.getByText("recovery-action-1")).toBeVisible());
    await expect(canvas.getByText(/retry made progress/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Recovery retry requested");
    await expectNoRules(canvasElement);
  },
};
export const ProductionAutomaticRecoveryBlocked: Story = { ...AutomaticRecoveryBlocked, args: { ...AutomaticRecoveryBlocked.args, mode: "production" } };
