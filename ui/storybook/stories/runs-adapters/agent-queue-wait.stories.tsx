import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ExecutionAgentQueue, ExecutionProjection, Issue } from "@paperclipai/shared";
import { expect, within } from "storybook/test";
import { AgentQueueWait } from "@/components/AgentQueueWait";
import { InboxIssueMetaLeading } from "@/components/IssueColumns";
import { TaskChatLiveRunPill } from "@/components/task-chat/TaskChatLiveRunPill";
import { TaskChatRunnerHeader, TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";

const codieQueue: ExecutionAgentQueue = {
  agentId: "8f14e45f-ceea-467a-9575-6f1d0b2c9a01",
  agentName: "Codie",
  maxConcurrentRuns: 20,
  runningCount: 20,
  position: 41,
  queuedCount: 295,
};

const waitingExecution: ExecutionProjection = {
  canStop: true,
  phase: "queued",
  label: "Waiting for Codie",
  cause: "agent_at_capacity",
  lastConfirmedActivityAt: null,
  retryAt: null,
  attempt: 1,
  maxAttempts: 3,
  recoveryOwner: null,
  nextAction: "Codie is running 20 of 20 tasks at once. This task is 41 of 295 in line and starts automatically when a slot frees.",
  permittedActions: ["inspect_run"],
  predecessorRunId: null,
  successorRunId: null,
  agentQueue: codieQueue,
};

const issue = {
  id: "b6d1a4c2-6a43-4c55-9d0a-2f0d6f2b1c11",
  identifier: "PAP-4281",
  title: "Migrate billing exports",
  status: "in_progress",
  priority: "medium",
} as Issue;

const meta = {
  id: "runs-agent-queue-wait",
  title: "Agents and reusable capabilities/Runs, harnesses, and model accounts/Waiting for an agent slot",
  component: AgentQueueWait,
  parameters: { paperclip: {
    capabilities: ["runs-adapters/runs", "tasks/discussion"],
    status: "current",
    implementation: "production",
    boundary: "fixtures",
    notes: "A queued run that never started because its agent's concurrency limit is full. The server's execution projection supplies the agent, limit and place in the dispatch line; these fixtures do not prove dispatch order.",
  } },
  decorators: [(Story) => <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4"><Story /></div>],
  args: { queue: codieQueue },
} satisfies Meta<typeof AgentQueueWait>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The full sentence: who it waits for, the limit, its place in line, and where to change the limit. */
export const WaitingInLine: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Waiting for Codie")).toBeVisible();
    await expect(canvas.getByText("20 slots max")).toBeVisible();
    await expect(canvas.getByText("41 of 295 in line")).toBeVisible();
    await expect(canvas.getByRole("link", { name: /Configure Codie/ })).toHaveAttribute("href", expect.stringMatching(/\/agents\/codie\/advanced$/));
  },
};

/** The task chat's live turn: the waiting line replaces "Working" and its timer. */
export const InTaskChat: Story = {
  render: () => <>
    <TaskChatRunnerHeader agentName="Codie" status="queued" execution={waitingExecution} startedAtMs={Date.now() - 4 * 60 * 60_000}
      statusContent={<TaskChatLiveRunPill status="queued" execution={waitingExecution} startedAtMs={Date.now() - 4 * 60 * 60_000} toolSummary={null} />} />
    <TaskChatRunnerHeader agentName="Codie" status="queued" execution={waitingExecution} startedAtMs={Date.now() - 4 * 60 * 60_000} />
  </>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Waiting for Codie")).toHaveLength(2);
    await expect(canvas.queryByText("Working")).not.toBeInTheDocument();
  },
};

/** Task lists and the inbox: a quiet "Waiting" instead of a pulsing "Live". */
export const InTaskList: Story = {
  render: () => <div className="flex items-center gap-2">
    <InboxIssueMetaLeading issue={issue} isLive waiting={{ queue: codieQueue }} />
    <span className="truncate text-sm">{issue.title}</span>
  </div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Waiting for Codie · 20 slots max · 41 of 295 in line")).toBeVisible();
    await expect(canvas.queryByText("Live")).not.toBeInTheDocument();
  },
};

export const SingleSlot: Story = {
  args: { queue: { ...codieQueue, maxConcurrentRuns: 1, runningCount: 1, position: 2, queuedCount: 3 } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("1 slot max")).toBeVisible();
  },
};

export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };

/** A queued turn with no named hold, past the 30-second startup feedback. */
export const WaitingToStart: Story = {
  render: () => <TaskChatLiveRunPill status="queued" execution={{ ...waitingExecution, cause: null, label: "Queued", agentQueue: null }}
    startedAtMs={Date.now() - 15 * 60_000} toolSummary={null} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Waiting to start")).toBeVisible();
    await expect(canvas.queryByText("Working")).not.toBeInTheDocument();
  },
};

/** A routine task that waits for the routine's open execution. */
export const WaitingForRoutine: Story = {
  render: () => <TaskChatRunnerTurn agentName="Test Gardener" status="queued" startedAtMs={Date.now() - 8 * 60_000} runId="run-1" items={[]}
    execution={{ ...waitingExecution, cause: "routine_execution_in_progress", label: "Waiting for PAP-3093 to finish", agentQueue: null }} />,
  play: async ({ canvasElement }) => {
    const holds = within(canvasElement).getAllByText(/Waiting for PAP-3093 to finish/);
    await expect(holds).toHaveLength(1);
    await expect(holds[0]).toBeVisible();
  },
};
