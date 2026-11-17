import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { TaskChatRunnerActivityGroup } from "@/components/task-chat/TaskChatRunnerActivityGroup";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { TaskChatThinking } from "@/components/task-chat/TaskChatThinking";
import type {
  TaskChatActivityPhaseItem,
  TaskChatItem,
  TaskChatThinkingItem,
} from "@/components/task-chat/task-chat-model";

/**
 * Codex writes one bold headline per reasoning summary part and the runner
 * separates parts with a blank line. These parts mirror a real gpt-5.6-sol
 * run with `summary: "auto"`.
 */
const CODEX_PARTS = [
  "**Tracing the webhook retry path**\n\nThe delivery worker re-enqueues on any 5xx, so a slow 200 that times out client-side will be retried with the same event id.",
  "**Checking where the idempotency key lives**\n\n`deliveries.event_id` is indexed but not unique, which explains the duplicate rows in the report.",
  "**Verifying edge cases for concurrent retries**\n\nTwo workers can claim the same retry if the lease expires mid-request; a unique constraint plus `ON CONFLICT DO NOTHING` covers both paths.",
];

const CLAUDE_PROSE =
  "The user wants duplicate deliveries fixed without changing the public webhook contract. The worker retries on timeouts, and the event id is stable across retries, so making the insert idempotent on that id is the smallest safe change. I should add a regression test that simulates two concurrent retries.";

function thinking(id: string, parts: readonly string[], streaming: boolean, extra: Partial<TaskChatThinkingItem> = {}): TaskChatThinkingItem {
  return {
    id,
    kind: "thinking",
    lines: parts.join("\n\n").split("\n"),
    streaming,
    channel: "summary",
    ...extra,
  };
}

const readTool = {
  id: "tool-read-worker",
  kind: "tool" as const,
  name: "Read",
  rawName: "read_file",
  target: "server/src/services/webhook-delivery.ts",
  status: "completed" as const,
};

function livePhase(partCount: number): TaskChatActivityPhaseItem {
  return {
    id: "phase-live",
    kind: "activity_phase",
    summary: "Read 1 file",
    active: true,
    items: [readTool, thinking("reasoning-live", CODEX_PARTS.slice(0, partCount), true)],
  };
}

function Frame({ children, caption }: { children: React.ReactNode; caption?: string }) {
  return (
    <div className="flex max-w-xl flex-col gap-2">
      {caption ? <p className="text-xs text-muted-foreground">{caption}</p> : null}
      <div className="rounded-lg border border-border bg-background p-4">{children}</div>
    </div>
  );
}

/** A live run that is collapsed: the latest headline is the status line and replaces itself per part. */
function LiveCollapsedReview() {
  const [parts, setParts] = useState(1);
  const items: TaskChatItem[] = [readTool, thinking("reasoning-live", CODEX_PARTS.slice(0, parts), true)];
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <Frame caption="Collapsed live run: the newest summary headline is the status line.">
        <TaskChatRunnerTurn
          runId="storybook-reasoning-run"
          agentName="CodexRunner"
          items={items}
          status="running"
          startedAtMs={Date.now() - 18_000}
        />
      </Frame>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button
          type="button"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-foreground hover:bg-muted"
          onClick={() => setParts((value) => (value % CODEX_PARTS.length) + 1)}
          data-testid="advance-reasoning-part"
        >
          Next summary part
        </button>
        <span aria-live="polite">Part {parts} of {CODEX_PARTS.length}</span>
      </div>
    </div>
  );
}

function AllStatesGallery() {
  return (
    <div className="flex flex-col gap-6">
      <Frame caption="1. Live, collapsed: status line shows the newest headline.">
        <TaskChatRunnerActivityGroup item={livePhase(3)} />
      </Frame>
      <Frame caption="2. Live, expanded Thinking row: one bullet per summary part; the part being written is highlighted.">
        <TaskChatRunnerActivityGroup item={livePhase(3)} defaultExpanded />
      </Frame>
      <Frame caption="3. Finished run, expanded: the Thought row keeps the last headline; its detail lists every part.">
        <TaskChatRunnerActivityGroup item={{ ...livePhase(3), id: "phase-settled", active: false, items: [readTool, thinking("reasoning-settled", CODEX_PARTS, false)] }} defaultExpanded />
      </Frame>
      <Frame caption="4. Claude summarized thinking (no headlines): plain prose, unchanged.">
        <TaskChatThinking item={thinking("reasoning-claude", [CLAUDE_PROSE], false, { summaryLabel: "Thought for 6s" })} defaultOpen active={false} />
      </Frame>
    </div>
  );
}

const meta = {
  id: "tasks-task-chat-reasoning-summaries",
  title: "Tasks and conversations/Task creation and lifecycle/Tasks/Task chat reasoning summaries",
  component: AllStatesGallery,
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["tasks/discussion", "runs-adapters/runs"],
      implementation: "production",
      boundary: "fixtures",
      notes: "Reasoning text is provider-authored: Codex summary parts (summary: auto) and Claude summarized thinking. The UI only splits it into sections; it never writes reasoning text itself.",
    },
  },
} satisfies Meta<typeof AllStatesGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {
  play: async ({ canvasElement }) => {
    for (const id of ["reasoning-live", "reasoning-settled"])
      canvasElement.querySelector<HTMLButtonElement>(`[data-activity-item-id='${id}'] button`)?.click();
  },
};

export const LiveRunCollapsed: Story = {
  render: () => <LiveCollapsedReview />,
};
