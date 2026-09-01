import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  RunnerGoalCapability,
  RunnerGoalPendingAction,
  RunnerGoalProjection,
  RunnerGoalStatus,
} from "@paperclipai/shared";
import {
  RunnerGoalWidget,
  type RunnerGoalControl,
} from "@/components/task-chat/RunnerGoalWidget";

const codexCapability: RunnerGoalCapability = {
  availability: "available",
  verified: true,
  actions: ["set", "pause", "resume", "clear"],
  autonomousUpdates: true,
  persistentAcrossResume: true,
  maxObjectiveChars: 4_000,
  tokenBudgetControl: true,
  usageReporting: true,
};

function projection(input: {
  status?: RunnerGoalStatus;
  pendingAction?: RunnerGoalPendingAction | null;
  capability?: RunnerGoalCapability;
  workingNow?: boolean;
} = {}): RunnerGoalProjection {
  const status = input.status;
  return {
    issueId: "issue-story-goal",
    agentId: "agent-story-goal",
    adapterType: "paperclip_runner",
    sessionId: "session-story-goal",
    capability: input.capability ?? codexCapability,
    goal: status
      ? {
          objective: "Ship end-to-end session goals with durable recovery and capability-aware controls.",
          status,
          tokenBudget: 32_000,
          tokensUsed: 8_420,
          elapsedSeconds: 754,
          iterations: 4,
          lastReason: status === "blocked" ? "Waiting for a required user decision." : null,
          createdAt: "2026-08-28T12:00:00.000Z",
          updatedAt: "2026-08-28T12:12:34.000Z",
          completedAt: status === "complete" ? "2026-08-28T12:12:34.000Z" : null,
          workingNow: input.workingNow ?? status === "active",
        }
      : null,
    workingNow: input.workingNow ?? status === "active",
    activeRunId: input.workingNow ? "run-story-goal" : null,
    pendingAction: input.pendingAction ?? null,
    revision: 7,
    observedAt: "2026-08-28T12:12:34.000Z",
  };
}

function Preview({ value }: { value: RunnerGoalProjection }) {
  const control = {
    data: value,
    expanded: true,
    setExpanded: () => undefined,
    edit: async () => undefined,
    executeAction: async () => undefined,
  } as unknown as RunnerGoalControl;
  return <RunnerGoalWidget control={control} />;
}

function SessionGoalStates() {
  const statuses: RunnerGoalStatus[] = [
    "active",
    "paused",
    "blocked",
    "limited",
    "usage_limited",
    "budget_limited",
    "complete",
  ];
  const pending: RunnerGoalPendingAction[] = [
    "starting",
    "editing",
    "replacing",
    "pausing",
    "resuming",
    "clearing",
    "continuing",
  ];
  const claudeCapability: RunnerGoalCapability = {
    ...codexCapability,
    actions: ["set", "clear"],
    tokenBudgetControl: false,
    usageReporting: false,
  };
  const unsupportedCapability: RunnerGoalCapability = {
    ...codexCapability,
    availability: "unsupported",
    actions: [],
    autonomousUpdates: false,
    persistentAcrossResume: false,
    tokenBudgetControl: false,
    usageReporting: false,
    reason: "Unsupported by OpenCode.",
  };
  const policyCapability: RunnerGoalCapability = {
    ...unsupportedCapability,
    availability: "policy_disabled",
    reason: "Session goals are disabled by the provider policy.",
  };

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-6xl space-y-8">
        <section>
          <h1 className="mb-3 text-lg font-semibold">Goal statuses and negotiated actions</h1>
          <div className="grid gap-3 lg:grid-cols-2">
            {statuses.map((status) => (
              <Preview key={status} value={projection({ status, workingNow: status === "active" })} />
            ))}
            <Preview value={projection({ status: "active", capability: claudeCapability })} />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold">Pending controls</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {pending.map((pendingAction) => (
              <Preview
                key={pendingAction}
                value={projection({
                  status: pendingAction === "starting" ? undefined : "active",
                  pendingAction,
                  workingNow: pendingAction === "pausing",
                })}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold">Unavailable capabilities</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            <Preview value={projection({ capability: unsupportedCapability })} />
            <Preview value={projection({ capability: policyCapability })} />
          </div>
        </section>
      </div>
    </main>
  );
}

const meta = {
  title: "Product/Agent session goals",
  component: SessionGoalStates,
  parameters: {
    docs: {
      description: {
        component:
          "Capability, status, active-turn, and pending-control states for the issue composer session-goal widget.",
      },
    },
  },
} satisfies Meta<typeof SessionGoalStates>;

export default meta;
type Story = StoryObj<typeof meta>;
export const AllStates: Story = {};
