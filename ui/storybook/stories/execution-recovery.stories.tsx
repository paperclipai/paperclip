import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IssueRow } from "@/components/IssueRow";
import { ActiveAgentsPanel } from "@/components/ActiveAgentsPanel";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { TaskChatLiveRunPill } from "@/components/task-chat/TaskChatLiveRunPill";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/queryKeys";
import { createIssue, storybookLiveRuns } from "../fixtures/paperclipData";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ExecutionProjection } from "@paperclipai/shared";
import { expect, userEvent, within } from "storybook/test";

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
function runStatus(execution: ExecutionProjection) {
  if (execution.phase === "recovery_needed") return "failed";
  if (
    ["completed", "waiting_for_access", "waiting_for_answer"].includes(
      execution.phase,
    )
  )
    return "succeeded";
  if (execution.phase === "retry_scheduled") return "scheduled_retry";
  return "running";
}
function QuietExecution({ execution }: { execution: ExecutionProjection }) {
  return (
    <div className="space-y-6" data-testid="quiet-execution-story">
      <IssueRow
        presentation="task"
        issue={createIssue({
          title: "Summarize the launch decisions",
          status:
            execution.phase === "recovery_needed" ? "blocked" : "in_progress",
          activeRun: { ...storybookLiveRuns[0]!, execution },
        })}
      />
      <TaskChatRunnerTurn
        agentName="Research agent"
        items={[]}
        status={runStatus(execution)}
        execution={execution}
        startedAtMs={null}
      />
      <Textarea aria-label="Message draft" placeholder="Write a follow-up…" />
    </div>
  );
}
const meta = {
  title: "Tasks/Execution recovery",
  component: QuietExecution,
  args: { execution: base },
  decorators: [
    (Story, context) => (
      <div
        className={
          context.parameters.recoveryWide ? "max-w-6xl p-4" : "max-w-xl p-4"
        }
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof QuietExecution>;
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
});
export const RetryScheduled: Story = state({
  phase: "retry_scheduled",
  label: "Retry scheduled",
  attempt: 2,
});
export const WaitingForWorkspace: Story = state({
  phase: "retry_scheduled",
  label: "Waiting for workspace",
});
export const Finalizing: Story = state({
  phase: "finishing",
  label: "Finishing",
});
export const SafelyReplaced: Story = state({
  phase: "completed",
  label: "Continued in another run",
  successorRunId: "successor-run",
});
export const RecoveryExhausted: Story = state({
  phase: "recovery_needed",
  label: "Stopped",
  attempt: 3,
  cause: "execution_recovery_budget_exhausted",
});
export const UncertainAction: Story = state({
  phase: "recovery_needed",
  label: "Stopped",
  cause: "uncertain_external_action",
});
export const UnavailableRecovery: Story = state({
  phase: "recovery_needed",
  label: "Stopped",
  cause: "provider_ownership_unverified",
});
export const WaitingForAccess: Story = state({
  phase: "waiting_for_access",
  label: "Waiting for access",
});
export const WaitingForAnswer: Story = state({
  phase: "waiting_for_answer",
  label: "Waiting for answer",
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
      label: "Stopped",
      nextAction:
        "A provider action has an unverified result. Recorded work is preserved. The system selected no replay; diagnostics remain in the run log.",
    },
  },
};
export const ComposerDuringRecovery: Story = {
  ...Reconnecting,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: "Inspect run" }),
    ).not.toBeInTheDocument();
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    const draft = canvas.getByRole("textbox", { name: "Message draft" });
    await userEvent.type(draft, "Continue with the launch notes.");
    await expect(draft).toHaveValue("Continue with the launch notes.");
    await expect(draft).toHaveFocus();
  },
};

const labelExamples: ExecutionProjection[] = [
  { ...base, phase: "working", label: "Working" },
  {
    ...base,
    phase: "reconnecting",
    label: "Reconnecting",
    recoveryOwner: "agent",
    attempt: 2,
  },
  {
    ...base,
    phase: "retry_scheduled",
    label: "Retry scheduled",
    nextAction: "The agent will continue automatically after the retry delay.",
  },
  { ...base, phase: "finishing", label: "Finishing" },
  { ...base, phase: "waiting_for_access", label: "Waiting for access" },
  { ...base, phase: "waiting_for_answer", label: "Waiting for answer" },
  {
    ...base,
    phase: "recovery_needed",
    label: "Recovery needed",
    recoveryOwner: "board",
    nextAction: "Review the stopped run before continuing.",
  },
];

function TaskListExamples({
  presentation = "legacy",
}: {
  presentation?: "legacy" | "task";
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">
          Task lists without execution badges
        </h2>
        <p className="text-sm text-muted-foreground">
          Execution phases add no badges to the task list. Routine recovery
          stays in the background.
        </p>
      </div>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">
          Baseline: no execution projection
        </h3>
        <IssueRow
          presentation={presentation}
          issue={createIssue({
            title: "Summarize the launch decisions",
            activeRun: null,
          })}
        />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">With execution status</h3>
        <div className="divide-y rounded-lg border">
          {labelExamples.map((execution, index) => (
            <IssueRow
              key={execution.phase}
              presentation={presentation}
              issue={createIssue({
                id: `execution-label-task-${index}`,
                identifier: `EXE-${index + 1}`,
                title: "Summarize the launch decisions",
                status:
                  execution.phase === "recovery_needed"
                    ? "blocked"
                    : "in_progress",
                activeRun: {
                  ...storybookLiveRuns[0]!,
                  id: `label-run-${index}`,
                  execution,
                },
              })}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

export const TaskListBadges: Story = {
  parameters: { recoveryWide: true },
  render: () => <TaskListExamples />,
};
export const TaskListBadgesCanonical: Story = {
  parameters: { recoveryWide: true },
  render: () => <TaskListExamples presentation="task" />,
};
export const NativeChatStatusLabels: Story = {
  parameters: { recoveryWide: true },
  render: () => (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">
        Native-runner chat status labels
      </h2>
      <p className="text-sm text-muted-foreground">
        The existing transcript header stays quiet. Only an intermediate
        reconnection briefly changes its text.
      </p>
      {labelExamples.map((execution) => (
        <section key={execution.phase} className="rounded-lg border p-3">
          <TaskChatRunnerTurn
            runId={`native-${execution.phase}`}
            agentName="Research agent"
            items={[]}
            status={runStatus(execution)}
            execution={execution}
            startedAtMs={null}
          />
        </section>
      ))}
    </div>
  ),
};
export const LegacyChatStatusLabels: Story = {
  parameters: { recoveryWide: true },
  render: () => (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Legacy chat status labels</h2>
      <p className="text-sm text-muted-foreground">
        Normal transcript presentation, with a brief neutral reconnection
        indicator and no recovery panel.
      </p>
      {labelExamples.map((execution) => (
        <section key={execution.phase} className="rounded-lg border p-3">
          <TaskChatLiveRunPill
            status={runStatus(execution)}
            execution={execution}
            startedAtMs={null}
            toolSummary={null}
          />
        </section>
      ))}
    </div>
  ),
};

function DashboardLabelExamples() {
  const [client] = useState(() => {
    const cache = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: Infinity,
          retry: false,
          refetchOnWindowFocus: false,
        },
      },
    });
    const runs = labelExamples.map((execution, index) => ({
      ...storybookLiveRuns[0]!,
      id: `dashboard-label-${index}`,
      issueId: `dashboard-task-${index}`,
      agentName: `Research agent ${index + 1}`,
      createdAt: "2026-09-08T16:00:00Z", startedAt: "2026-09-08T16:00:00Z",
      status: runStatus(execution),
      finishedAt: ["succeeded", "failed"].includes(runStatus(execution))
        ? "2026-09-08T16:00:30Z"
        : null,
      execution,
    }));
    cache.setQueryData(
      [
        ...queryKeys.liveRuns("company-storybook"),
        "execution-label-review",
        { minRunCount: 0, fetchLimit: undefined },
      ],
      runs,
    );
    runs.forEach((run) =>
      cache.setQueryData(
        queryKeys.issues.detail(run.issueId),
        createIssue({
          id: run.issueId,
          title: "Summarize the launch decisions",
        }),
      ),
    );
    return cache;
  });
  return (
    <QueryClientProvider client={client}>
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Dashboard agent-card labels</h2>
        <p className="text-sm text-muted-foreground">
          The existing dashboard layout stays unchanged. Reconnection is a brief
          update to the existing line, with no additional card or controls.
        </p>
        <ActiveAgentsPanel
          companyId="company-storybook"
          title="Agent execution"
          queryScope="execution-label-review"
          minRunCount={0}
          cardLimit={7}
          gridClassName="xl:grid-cols-3"
          showMoreLink={false}
        />
      </div>
    </QueryClientProvider>
  );
}
export const DashboardStatusLabels: Story = {
  parameters: { recoveryWide: true },
  render: () => <DashboardLabelExamples />,
};
