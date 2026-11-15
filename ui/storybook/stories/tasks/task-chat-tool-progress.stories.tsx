import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ToolCallProgressSnapshot } from "@paperclipai/shared";
import { TaskChatToolCard } from "@/components/task-chat/TaskChatToolCard";
import type { TaskChatToolItem } from "@/components/task-chat/task-chat-model";

type Props = { state: "total" | "no-total" | "done" };

const TOOL: TaskChatToolItem = {
  id: "toolu_progress",
  kind: "tool",
  name: "slow_with_progress",
  rawName: "mcp__paperclip__kv_demo__slow_with_progress",
  target: "steps: 10",
  status: "in_progress",
};

function progressFor(state: Props["state"]): ToolCallProgressSnapshot {
  const now = Date.now();
  return {
    invocationId: "call-1",
    runId: "run-1",
    toolName: "kv_demo__slow_with_progress",
    startedAt: new Date(now - 65_000).toISOString(),
    updatedAt: new Date(now - 400).toISOString(),
    progress: 4,
    total: state === "total" ? 10 : null,
    message: state === "total" ? "Exporting rows 4,000 of 10,000" : "Indexing documents",
    done: false,
  };
}

function ToolProgressPreview({ state }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-1 p-6">
      <TaskChatToolCard item={{ ...TOOL, status: state === "done" ? "completed" : "in_progress" }} progress={progressFor(state)} />
    </div>
  );
}

const meta = {
  id: "tasks-task-chat-tool-progress",
  title: "Tasks and conversations/Task creation and lifecycle/Tasks/Tool progress",
  component: ToolProgressPreview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "A long connected-app tool call shows the provider's progress while it runs: a filling bar when the total is known, a quiet sweep otherwise, the latest status line as plain text, and elapsed time. The row drops it when the call completes.",
      },
    },
    paperclip: {
      capabilities: ["tasks/discussion", "runs-adapters/runs"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Production tool row with fixed progress. Live progress arrives from MCP notifications/progress through the run's live events.",
    },
  },
} satisfies Meta<typeof ToolProgressPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RunningWithTotal: Story = { name: "01 · Running, total known", args: { state: "total" } };
export const RunningWithoutTotal: Story = { name: "02 · Running, total unknown", args: { state: "no-total" } };
export const Done: Story = { name: "03 · Done", args: { state: "done" } };
