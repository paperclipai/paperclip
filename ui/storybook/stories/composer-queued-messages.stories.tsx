import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { IssueQueuedCommentEntry, IssueQueuedCommentQueue } from "@paperclipai/shared";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatQueuedMessages } from "@/components/task-chat/TaskChatQueuedMessages";
import { composerAgentAppearance, composerAgents } from "../prototypes/composer-model-picker/fixtures";

const agentMap = new Map(composerAgents.map((agent) => [agent.id, {
  id: agent.id,
  name: agent.name,
  appearance: composerAgentAppearance(agent.id),
}]));

function queuedEntry(body: string, id: string, position: number): IssueQueuedCommentEntry {
  return {
    comment: {
      id,
      companyId: "storybook",
      issueId: "composer-queue-story",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "storybook-user",
      body,
      presentation: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    position,
    canEdit: true,
    canDiscard: true,
  };
}

const initialEntries = [
  queuedEntry("Check the mobile layout after this pass.", "queued-1", 0),
  queuedEntry("Then update the accessibility notes.", "queued-2", 1),
];

type QueueStoryProps = {
  protocol: IssueQueuedCommentQueue["protocol"];
  steeringDisposition: IssueQueuedCommentQueue["steeringDisposition"];
  initialEdit: boolean;
  mobile: boolean;
};

function QueuedComposer({ protocol, steeringDisposition, initialEdit, mobile }: QueueStoryProps) {
  const [entries, setEntries] = useState(initialEntries);
  const [editingId, setEditingId] = useState<string | null>(initialEdit ? "queued-1" : null);
  const [sent, setSent] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const queue: IssueQueuedCommentQueue = {
    issueId: "composer-queue-story",
    queueId: "queue-story",
    state: "deferred",
    targetRunId: running ? "active-run" : null,
    revision: "story-revision",
    protocol,
    steeringDisposition,
    entries,
  };

  function remove(id: string) {
    setEntries((current) => current.filter((entry) => entry.comment.id !== id)
      .map((entry, position) => ({ ...entry, position })));
  }

  return (
    <main className={`flex min-h-screen flex-col bg-background text-foreground ${mobile ? "p-4" : "p-6"}`}>
      <div className={`mx-auto flex w-full flex-1 flex-col ${mobile ? "max-w-sm" : "max-w-3xl"}`}>
        <header className="border-b border-border pb-4">
          <p className="text-xs text-muted-foreground">PAP-204 · Codie is working</p>
          <h1 className="mt-1 text-base font-semibold">Steering and queued messages</h1>
        </header>
        <div className="flex-1 space-y-3 py-6 text-sm">
          <p className="rounded-lg bg-card px-4 py-3">I’m updating the composer and checking the responsive layout.</p>
          {sent.map((body, index) => <p key={index} className="ml-auto max-w-fit rounded-lg bg-secondary px-4 py-3">{body}</p>)}
          {notice ? <p role="status" className="text-muted-foreground">{notice}</p> : null}
        </div>
        <div className="relative isolate flex flex-col">
          {entries.length ? <TaskChatQueuedMessages
            queue={queue}
            onEdit={setEditingId}
            onReorder={async (ids) => setEntries((current) => ids.map((id, position) => ({
              ...current.find((entry) => entry.comment.id === id)!, position,
            })))}
            onSteer={async (id) => { remove(id); setNotice("Message steered into the active turn."); }}
            onInterrupt={async () => { setRunning(false); setNotice("The active turn was interrupted."); }}
            onDiscard={async (id) => { remove(id); setNotice("Queued message discarded."); }}
          /> : null}
          <div className="relative z-10">
            <TaskChatComposer
              onAdd={async (body) => {
                if (running) {
                  setEntries((current) => [...current, queuedEntry(body, `queued-${Date.now()}`, current.length)]);
                  setNotice("Message queued for the next turn.");
                } else {
                  setSent((current) => [...current, body]);
                }
              }}
              workMode="standard"
              onStop={running ? async () => setRunning(false) : undefined}
              queuedEdit={editingId ? {
                commentId: editingId,
                body: entries.find((entry) => entry.comment.id === editingId)?.comment.body ?? "",
              } : null}
              onSaveQueuedEdit={async (id, body) => {
                setEntries((current) => current.map((entry) => entry.comment.id === id
                  ? { ...entry, comment: { ...entry.comment, body } }
                  : entry));
                setEditingId(null);
              }}
              onCancelQueuedEdit={() => setEditingId(null)}
              enableReassign
              reassignOptions={composerAgents.map((agent) => ({ id: `agent:${agent.id}`, label: agent.name }))}
              currentAssigneeValue="agent:codex"
              agentMap={agentMap}
              mobile={mobile}
            />
          </div>
        </div>
      </div>
    </main>
  );
}

const meta = {
  title: "Composer/Steering and queued messages",
  component: QueuedComposer,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "The production queued-message strip sits above the production composer. Steer, edit, reorder, discard, and legacy interrupt can be tried locally." } },
  },
  args: { protocol: "paperclip_runner_v1", steeringDisposition: "available", initialEdit: false, mobile: false },
} satisfies Meta<typeof QueuedComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const QueuedWhileRunning: Story = {};
export const SteerIntoActiveTurn: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(page.getByTestId("task-chat-queued-steer-queued-1"));
    await expect(page.queryByText("Check the mobile layout after this pass.")).not.toBeInTheDocument();
    await expect(page.getByText("Message steered into the active turn.")).toBeVisible();
  },
};
export const EditQueuedMessage: Story = { args: { initialEdit: true } };
export const LegacyInterrupt: Story = { args: { protocol: "legacy" } };
export const SteeringUnavailable: Story = { args: { steeringDisposition: "unsupported" } };
export const MobileQueue: Story = {
  args: { mobile: true },
  globals: { viewport: { value: "mobile", isRotated: false } },
};
