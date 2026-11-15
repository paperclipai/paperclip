import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { IssueRecoveryActionCard } from "@/components/IssueRecoveryActionCard";
import {
  DispositionRecoveryNotice,
  DispositionRecoveryProvider,
} from "@/components/DispositionRecoveryNotice";
import { storybookAgents } from "../../fixtures/paperclipData";
const agent = storybookAgents[0];
const action: IssueRecoveryAction = {
  id: "recovery-gap",
  companyId: agent.companyId,
  sourceIssueId: "task-gap",
  recoveryIssueId: null,
  kind: "deliberate_wait_without_target",
  status: "active",
  ownerType: "board",
  ownerAgentId: null,
  ownerUserId: null,
  previousOwnerAgentId: agent.id,
  returnOwnerAgentId: agent.id,
  cause: "unchanged_source_state_exhausted",
  fingerprint: "storybook-recovery-gap",
  evidence: {
    summary:
      "Automatic recovery exhausted two attempts without a durable next step.",
  },
  nextAction: "Inspect the outcome before deciding whether to retry.",
  wakePolicy: { type: "board_escalation" },
  monitorPolicy: null,
  attemptCount: 2,
  maxAttempts: 2,
  timeoutAt: null,
  lastAttemptAt: "2026-10-12T12:00:00Z",
  outcome: null,
  resolutionNote: null,
  resolvedAt: null,
  createdAt: "2026-10-12T12:00:00Z",
  updatedAt: "2026-10-12T12:00:00Z",
};
function Recovery({
  state = "ready",
}: {
  state?: "ready" | "blocked" | "failure" | "saving" | "historical";
}) {
  const [resolved, setResolved] = useState(false);
  return (
    <DispositionRecoveryProvider
      value={{
        issue: {
          status: resolved ? "todo" : "blocked",
          assigneeAgentId: agent.id,
          executionRunId: null,
          checkoutRunId: null,
          executionState: null,
          blockedBy: [],
          activeRecoveryAction: state === "historical" ? null : action,
        },
        agentMap: new Map([[agent.id, agent]]),
        unavailableReason:
          state === "blocked"
            ? "You do not have permission to retry this task."
            : null,
        onRetry: async () => {
          if (state === "saving") return new Promise<void>(() => {});
          if (state === "failure")
            throw new Error("The recovery decision could not be saved.");
          setResolved(true);
        },
      }}
    >
      <DispositionRecoveryNotice
        defaultExpanded
        snapshot={{
          kind: "disposition_repair_escalated",
          actionId: action.id,
          attemptCount: 2,
          maxAttempts: 2,
          reason: "unchanged_source_state_exhausted",
          assigneeAgentId: agent.id,
        }}
      />
    </DispositionRecoveryProvider>
  );
}
const meta = {
  id: "feature-recovery-gap-states",
  title: "Projects and execution/Recovery/Exhaustion and user decisions",
  component: Recovery,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Shipped recovery notice/card. Decisions alter local fixture state only. Bounded attempts, unknown-side-effect replay and real continuation require production tests.",
      },
    },
    paperclip: {
      "capabilities": [
        "recovery/exhaustion",
        "recovery/unknown-outcome"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Exhaustion notice, blocked authority, retry pending/failure/accepted and inactive notice; unknown-outcome action card is rendered separately. Retry callbacks and disposition context are simulated; no real continuation proof. The expanded native copyback recovery recipe requires harness stop proof; these generic exhaustion/queued-response fixtures do not establish that path. Retained legacy files use a separate recovery form with verified stop evidence; these exhaustion and response-queue examples do not establish file repair."
    },
  },
} satisfies Meta<typeof Recovery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Exhausted: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("button", { name: "Retry agent" });
  },
};
export const PermissionBlocked: Story = {
  args: { state: "blocked" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(
      await c.findByRole("button", { name: "Retry agent" }),
    ).toBeDisabled();
    await c.findByText("You do not have permission to retry this task.");
  },
};
export const RetryFailed: Story = {
  args: { state: "failure" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Retry agent" }),
    );
    await c.findByRole("alert");
  },
};
export const RetryPending: Story = {
  args: { state: "saving" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Retry agent" }),
    );
    const retry = await c.findByRole("button", { name: "Requesting retry…" });
    await waitFor(() => expect(retry).toBeDisabled());
  },
};
export const RetryAccepted: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Retry agent" }),
    );
    await c.findByRole("heading", { name: "Retry requested" });
  },
};
export const NoActiveRecovery: Story = {
  args: { state: "historical" },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("heading", {
      name: "Agent needed attention",
    });
  },
};
export const UnknownOutcome: Story = {
  render: () => (
    <IssueRecoveryActionCard
      action={{
        ...action,
        kind: "active_run_watchdog",
        cause: "external_execution_unknown",
        evidence: {
          summary:
            "The external request may have completed. Inspect the provider before replaying it.",
        },
        nextAction:
          "Inspect the external outcome; choose a recorded disposition.",
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(
      "The external request may have completed. Inspect the provider before replaying it.",
    );
  },
};
