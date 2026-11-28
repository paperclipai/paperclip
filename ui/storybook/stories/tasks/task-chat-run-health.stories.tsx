import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import type { TaskChatMcpStartupFailure } from "@/components/task-chat/TaskChatRunHealthBanner";
import type { TaskChatItem, TaskChatMessageItem } from "@/components/task-chat/task-chat-model";

const STARTED = Date.now() - 48_000;

const request: TaskChatMessageItem = {
  id: "request",
  kind: "message",
  author: "human",
  authorName: "Alex",
  isCurrentUser: true,
  text: "can you check why the webhook retries are sending duplicate deliveries to acme? started after yesterday's deploy",
  timestamp: "9:41 AM",
};

const PAPERCLIP_FAILED: TaskChatMcpStartupFailure = {
  id: "mcp:paperclip",
  serverName: "paperclip",
  reason: "handshaking with MCP server failed: connection closed: initialize response",
};
const GITHUB_FAILED: TaskChatMcpStartupFailure = {
  id: "mcp:github",
  serverName: "github",
  reason: "program not found: github-mcp-server",
};
const LINEAR_FAILED: TaskChatMcpStartupFailure = {
  id: "mcp:linear",
  serverName: "linear",
  reason: "request timed out after 10s",
};

const runningItems: TaskChatItem[] = [
  { id: "think", kind: "thinking", lines: ["Looking for the delivery worker and its retry path."], streaming: false, channel: "summary", transcriptIndex: 1 },
  { id: "rg", kind: "tool", name: "Search", rawName: "rg", target: "rg -n \"retryDelivery\" server/src", status: "completed" },
  { id: "read", kind: "tool", name: "Read", rawName: "read_file", target: "server/src/services/webhooks/delivery-worker.ts", status: "completed" },
  { id: "test", kind: "tool", name: "Bash", rawName: "bash", target: "pnpm vitest run server/src/services/webhooks", status: "in_progress" },
];

const answer: TaskChatMessageItem = {
  id: "answer",
  kind: "message",
  author: "agent",
  channel: "final",
  text: "I couldn't reach the Paperclip tools in this run, so I can't post the findings to the task or update its status. From the code: the retry path re-enqueues a delivery before the first attempt records its event id, so a slow first attempt and its retry both send. I've drafted an idempotency check on the event id; the fix is in `delivery-worker.ts`.",
};

const completedItems: TaskChatItem[] = [
  ...runningItems.map((item) => (item.kind === "tool" ? { ...item, status: "completed" as const } : item)),
  answer,
];

/** The task-chat item the transcript adapter builds from the runner's provider.notice. */
function noticeItem(failure: TaskChatMcpStartupFailure): TaskChatItem {
  const summary = `${failure.serverName} MCP server failed to start${failure.reason ? `: ${failure.reason}` : ""}`;
  return {
    id: `run-health:provider:${failure.id}`,
    kind: "protocol",
    surface: "provider_activity",
    family: "provider_notice",
    eventType: "provider.notice.recorded",
    status: "informational",
    title: "Provider notice",
    summary,
    details: [
      { label: "Severity", value: "warning" },
      { label: "Category", value: "mcp_server_startup_failed" },
      { label: "Scope", value: "session" },
      { label: "Summary", value: summary },
      { label: "server", value: failure.serverName, mono: false },
      ...(failure.reason ? [{ label: "reason", value: failure.reason, mono: false }] : []),
    ],
    steps: [],
    links: [],
    children: [],
  };
}

function Run({
  failures,
  status = "running",
  items = runningItems,
}: {
  failures: readonly TaskChatMcpStartupFailure[];
  status?: string;
  items?: TaskChatItem[];
}) {
  const terminal = status !== "running";
  return (
    <TaskChatRunnerTurn
      runId="run-health"
      agentName="Codex Engineer"
      items={[...failures.map(noticeItem), ...items]}
      status={status}
      startedAtMs={STARTED}
      finishedAtMs={terminal ? Date.now() : null}
    />
  );
}

function Task({ title, provisional = false, children }: { title: string; provisional?: boolean; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background p-4 text-foreground md:p-8">
      <div className="mx-auto flex max-w-(--tc-shell-max-w) flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className={provisional ? "truncate text-xl font-semibold text-muted-foreground" : "text-xl font-semibold"}>{title}</h1>
          {provisional ? <p className="text-xs text-muted-foreground">Provisional title from the first message</p> : null}
        </header>
        <TaskChatBubble item={request} animateEntry={false} />
        {children}
      </div>
    </div>
  );
}

function StateCard({ title, rule, children }: { title: string; rule: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{rule}</p>
      </div>
      <div className="rounded-lg border border-border bg-background p-4">{children}</div>
    </section>
  );
}

function AllStates() {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-10">
        <header>
          <h2 className="text-lg font-semibold">Run health</h2>
          <p className="text-sm text-muted-foreground">
            A one-line warning under the runner header when the harness could not start an MCP server. It comes from
            Codex <code className="font-mono text-xs">mcpServer/startupStatus/updated</code>, mapped to a user-facing{" "}
            <code className="font-mono text-xs">provider.notice</code>.
          </p>
        </header>
        <StateCard title="One server failed" rule="Server name, then the provider's reason, truncated to one line. Click to see the full reason.">
          <Run failures={[PAPERCLIP_FAILED]} />
        </StateCard>
        <StateCard title="Several servers failed" rule="One line names them all. Expanding lists each reason.">
          <Run failures={[PAPERCLIP_FAILED, GITHUB_FAILED, LINEAR_FAILED]} />
        </StateCard>
        <StateCard title="Run finished" rule="The warning stays on the turn after the run ends, so the agent's “I couldn't reach the tools” answer has its cause beside it.">
          <Run failures={[GITHUB_FAILED]} status="succeeded" items={completedItems} />
        </StateCard>
        <StateCard title="Healthy run" rule="No banner when every MCP server started.">
          <Run failures={[]} />
        </StateCard>
      </div>
    </div>
  );
}

const meta = {
  id: "tasks-task-chat-run-health",
  title: "Tasks and conversations/Task creation and lifecycle/Task chat/Run health",
  component: AllStates,
  parameters: {
    layout: "fullscreen",
    throwPlayFunctionExceptions: true,
    paperclip: {
      capabilities: ["tasks/discussion", "runs-adapters/runs"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Production runner turn fed the same provider-notice items the transcript adapter builds from a Codex mcpServer/startupStatus/updated failure. No runner, provider or API is involved.",
    },
  },
} satisfies Meta<typeof AllStates>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AllRunHealthStates: Story = {};

export const InTaskChat: Story = {
  render: () => (
    <Task title="Investigate duplicate webhook deliveries to Acme">
      <Run failures={[PAPERCLIP_FAILED]} />
    </Task>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const banner = await canvas.findByTestId("task-chat-run-health-banner");
    await expect(banner).toHaveTextContent("paperclip MCP server failed to start");
    const toggle = within(banner).getByRole("button");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText(/The agent ran without these tools/)).toBeVisible();
  },
};

export const ProvisionalTitleBeforeRename: Story = {
  render: () => (
    <Task title={request.text} provisional>
      <Run failures={[]} />
    </Task>
  ),
};

export const Mobile: Story = {
  render: InTaskChat.render,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
