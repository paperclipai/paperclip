import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ExecutionReconciliationDialog } from "@/components/ExecutionReconciliationDialog";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ExecutionProjection } from "@paperclipai/shared";
import { expect, fn, userEvent, within } from "storybook/test";
import { ExecutionStatus } from "@/components/ExecutionStatus";

const base: ExecutionProjection = {
  phase: "working",
  label: "Working",
  cause: null,
  lastConfirmedActivityAt: "2026-09-08T16:00:00Z",
  retryAt: null,
  attempt: 1,
  maxAttempts: 3,
  recoveryOwner: null,
  nextAction: null,
  permittedActions: ["inspect_run"],
  predecessorRunId: null,
  successorRunId: null,
};
const meta = {
  title: "Tasks/Execution recovery",
  component: ExecutionStatus,
  args: { execution: base, onInspect: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExecutionStatus>;
export default meta;
type Story = StoryObj<typeof meta>;
const state = (overrides: Partial<ExecutionProjection>) => ({
  args: { execution: { ...base, ...overrides } },
});
export const Working: Story = state({});
export const Reconnecting: Story = state({
  phase: "reconnecting",
  label: "Reconnecting",
  attempt: 2,
  recoveryOwner: "agent",
  nextAction:
    "Resume the established provider session with the task's current request.",
});
export const RetryScheduled: Story = state({
  phase: "retry_scheduled",
  label: "Retry scheduled",
  attempt: 2,
  recoveryOwner: "agent",
  retryAt: "2026-09-08T16:00:30Z",
  nextAction: "The agent will continue automatically after the retry delay.",
});
export const WaitingForWorkspace: Story = state({
  phase: "retry_scheduled",
  label: "Waiting for workspace",
  retryAt: "2026-09-08T16:00:30Z",
  nextAction: "Waiting for the live workspace holder to finish; the scheduled check will revalidate ownership.",
});
export const Finalizing: Story = state({
  phase: "finishing",
  label: "Finishing",
  nextAction: "Saving the result and preserving workspace changes.",
});
export const SafelyReplaced: Story = state({
  phase: "completed",
  label: "Continued in another run",
  successorRunId: "successor-run",
  nextAction:
    "The original session stopped. A fresh session continues the Gmail request with the task's history and connection access.",
});
export const RecoveryExhausted: Story = state({
  phase: "recovery_needed",
  label: "Recovery needed",
  attempt: 3,
  recoveryOwner: "board",
  cause: "execution_recovery_budget_exhausted",
  nextAction:
    "Inspect the original failure and choose a recovery action; three execution attempts have been used.",
});
export const UncertainAction: Story = state({
  phase: "recovery_needed",
  label: "Recovery needed",
  recoveryOwner: "board",
  cause: "uncertain_external_action",
  nextAction:
    "Reconcile send_email (invocation email-1) and preserve its result before continuing. Do not repeat it automatically.",
});
export const UnavailableRecovery: Story = state({
  phase: "recovery_needed",
  label: "Recovery unavailable",
  recoveryOwner: "board",
  cause: "provider_ownership_unverified",
  nextAction:
    "Verify that the previous provider stopped before continuing this task.",
});
export const WaitingForAccess: Story = state({
  phase: "waiting_for_access",
  label: "Waiting for access",
  nextAction: "Connect Gmail using the task card to continue.",
});
export const WaitingForAnswer: Story = state({
  phase: "waiting_for_answer",
  label: "Waiting for answer",
  nextAction:
    "Answer the pending question. You can keep writing messages while the agent waits.",
});
export const NarrowLongError: Story = {
  ...UncertainAction,
  decorators: [
    (Story) => (
      <div className="max-w-xs">
        <Story />
      </div>
    ),
  ],
  args: {
    execution: {
      ...base,
      phase: "recovery_needed",
      label: "Recovery needed",
      recoveryOwner: "board",
      nextAction:
        "Reconcile the outcome of send_launch_decisions_to_the_external_company_mailing_list (invocation pending-provider-action-with-a-long-reference) before continuing. The provider stopped before recording an outcome, so the original write cannot be safely repeated.",
    },
  },
};
export const KeyboardInspection: Story = {
  ...RecoveryExhausted,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Inspect run" });
    button.focus();
    await expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onInspect).toHaveBeenCalledOnce();
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Recovery needed",
    );
  },
};

function ReconciliationExample({
  fail = false,
  saving = false,
}: {
  fail?: boolean;
  saving?: boolean;
}) {
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-3">
      <Button ref={returnFocusRef} onClick={() => setOpen(true)}>
        Reconcile and continue
      </Button>
      {saved ? (
        <p role="status">Decision recorded. Continuation is queued.</p>
      ) : null}
      <ExecutionReconciliationDialog
        returnFocusRef={returnFocusRef}
        open={open}
        onOpenChange={setOpen}
        runId="11111111-1111-4111-8111-111111111111"
        nextAction="Verify whether send_email completed. Preserve its observed result before continuing."
        onSubmit={async () => {
          if (fail)
            throw new Error(
              "The previous provider is still running. Stop it before continuing.",
            );
          if (saving) await new Promise(() => {});
          setSaved(true);
        }}
      />
    </div>
  );
}
const openReconciliation = async (canvasElement: HTMLElement) => {
  await userEvent.click(
    within(canvasElement).getByRole("button", {
      name: "Reconcile and continue",
    }),
  );
};
const completeReconciliationForm = async (canvasElement: HTMLElement) => {
  await openReconciliation(canvasElement);
  const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog", {
    name: "Reconcile execution",
  });
  await userEvent.click(
    within(dialog).getByRole("radio", { name: "The actions did not happen" }),
  );
  await userEvent.type(
    within(dialog).getByRole("textbox", {
      name: "Evidence and remaining work",
    }),
    "Verified the provider log and mailbox: the email was never sent. The remaining task is a read.",
  );
  await userEvent.click(within(dialog).getByRole("checkbox"));
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Record and continue" }),
  );
};
export const ReconciliationEntry: Story = {
  render: () => <ReconciliationExample />,
  play: async ({ canvasElement }) => {
    await openReconciliation(canvasElement);
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("button", {
        name: "Record and continue",
      }),
    ).toBeDisabled();
  },
};
export const ReconciliationError: Story = {
  render: () => <ReconciliationExample fail />,
  play: async ({ canvasElement }) => {
    await completeReconciliationForm(canvasElement);
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("alert"),
    ).toHaveTextContent("previous provider is still running");
  },
};
export const ReconciliationSaving: Story = {
  render: () => <ReconciliationExample saving />,
  play: async ({ canvasElement }) => {
    await completeReconciliationForm(canvasElement);
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("button", {
        name: "Recording decision…",
      }),
    ).toBeDisabled();
  },
};
export const ReconciliationCompleted: Story = {
  render: () => <ReconciliationExample />,
  play: async ({ canvasElement }) => {
    await completeReconciliationForm(canvasElement);
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "Continuation is queued",
    );
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Reconcile and continue",
      }),
    ).toHaveFocus();
  },
};
