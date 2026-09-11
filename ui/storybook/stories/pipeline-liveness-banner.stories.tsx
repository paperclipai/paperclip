import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PipelineCaseLiveness } from "@paperclipai/shared";
import { PipelineLivenessBanner } from "@/components/PipelineLivenessBanner";

/**
 * Visual coverage for the PAP-11246 pipeline item liveness banner. Each story
 * renders the banner from a Phase 2 `liveness` payload so screenshots reflect
 * the real markup operators see at the top of an item detail page.
 *
 * The banner replaces the green `ActivePipelineWorkBanner` 1:1 whenever the item
 * is not actively running, per the PAP-11245 design. Manual "Move to stage…" is
 * never promoted here — it stays in the ⋯ menu.
 */
const meta = {
  title: "Pipelines/Liveness Banner",
  component: PipelineLivenessBanner,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PipelineLivenessBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

function liveness(overrides: Partial<PipelineCaseLiveness>): PipelineCaseLiveness {
  return { state: "attention", reason: "no_action_path", message: "stub", ...overrides } as PipelineCaseLiveness;
}

export const AutomationPaused: Story = {
  args: {
    onRetry: () => {},
    liveness: liveness({
      state: "blocked",
      reason: "linked_issue_blocked",
      message: "The automation issue for this stage is blocked and can't continue on its own.",
      issue: { id: "auto-1", identifier: "PAP-9201", title: "Draft the release notes", status: "blocked" },
      blocker: { issueId: "blk-1", title: "Legal sign-off on the changelog", status: "in_progress" },
    }),
  },
};

export const BlockedByAnotherItem: Story = {
  args: {
    onRetry: () => {},
    liveness: liveness({
      state: "blocked",
      reason: "case_blocked",
      message: 'Pipeline item is blocked by "Upstream data export".',
      blocker: { caseId: "case-99", title: "Upstream data export", terminalKind: null },
    }),
  },
};

export const PermissionNeeded: Story = {
  args: {
    onRetry: () => {},
    liveness: liveness({
      state: "blocked",
      reason: "permission_preflight_failed",
      message:
        "Pipeline automation is blocked until the configured assignee can write to the target pipeline.",
      automation: {
        automationId: "auto-2",
        fingerprint: "case-1:stage-1:auto-2:target-pipe:agent-codex:pipelines:write",
        error: "permission_preflight_failed",
      },
    }),
  },
};

export const ReadyToRetry: Story = {
  args: {
    onRetry: () => {},
    liveness: liveness({
      state: "attention",
      reason: "automation_failed",
      message: "Pipeline automation permission has been restored; retry the failed automation ledger.",
      automation: { automationId: "auto-3", routineId: "routine-7" },
    }),
  },
};

export const AutomationFailed: Story = {
  args: {
    onRetry: () => {},
    liveness: liveness({
      state: "attention",
      reason: "automation_failed",
      message: "Pipeline automation failed and needs retry or recovery.",
      automation: { automationId: "auto-4", error: "adapter_timeout" },
    }),
  },
};

export const RetryError: Story = {
  args: {
    onRetry: () => {},
    retryError: "Forbidden: the assignee still lacks pipelines:write on the target pipeline.",
    liveness: liveness({
      state: "attention",
      reason: "automation_failed",
      message: "Pipeline automation failed and needs retry or recovery.",
      automation: { automationId: "auto-4" },
    }),
  },
};

export const BreakdownIncomplete: Story = {
  args: {
    onRetry: () => {},
    liveness: liveness({
      state: "blocked",
      reason: "breakdown_incomplete",
      message: "Breakdown evidence does not match created child cases.",
      breakdown: { expectedRequestKeys: ["a", "b", "c"], createdRequestKeys: ["a"], missingRequestKeys: ["b", "c"] },
    }),
  },
};

// The server still sends the implementation-flavored `message` here, but the
// banner translates `no_action_path` into prosumer copy (PAP-11259), so the
// rendered body is the friendly version regardless of this raw message.
export const StuckNoActionPath: Story = {
  args: {
    onRetry: () => {},
    liveness: liveness({
      state: "attention",
      reason: "no_action_path",
      message: "No lease, linked work, blocker, automation retry, review, or breakdown action path is visible.",
    }),
  },
};
