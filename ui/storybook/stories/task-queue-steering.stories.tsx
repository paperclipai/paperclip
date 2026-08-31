import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type {
  IssueComment,
  IssueQueuedCommentQueue,
  IssueQueuedCommentSteeringDisposition,
} from "@paperclipai/shared";
import { TaskChatThread } from "@/components/TaskChatThread";
import { normalizeIssueQueuedCommentQueue } from "@/lib/issue-queued-comment-queue";
import { storybookAgentMap } from "../fixtures/paperclipData";

const ISSUE_ID = "issue-queue-story";
const RUN_ID = "run-queue-story";
const USER_ID = "user-board";
const TS = new Date("2026-08-22T15:00:00.000Z");

function comment(id: string, body: string, minutes: number): IssueComment {
  return {
    id,
    companyId: "company-storybook",
    issueId: ISSUE_ID,
    authorType: "user",
    authorAgentId: null,
    authorUserId: USER_ID,
    body,
    presentation: null,
    metadata: null,
    createdAt: new Date(TS.getTime() + minutes * 60_000),
    updatedAt: new Date(TS.getTime() + minutes * 60_000),
  };
}

const priorComment = comment("comment-prior", "Build queueing and true same-turn steering.", -2);
const queuedComments = [
  comment("queued-one", "Keep the compact strip aligned with the task composer.", 1),
  comment("queued-two", "Add keyboard reorder and announce the new position.", 2),
  comment("queued-three", "Verify the mobile layout before shipping.", 3),
];

function queueFixture(
  entries = queuedComments,
  steeringDisposition: IssueQueuedCommentSteeringDisposition = "available",
): IssueQueuedCommentQueue {
  return normalizeIssueQueuedCommentQueue({
    issueId: ISSUE_ID,
    targetRunId: RUN_ID,
    revision: "queue-revision-1",
    protocol: "paperclip_runner_v1",
    steeringDisposition,
    entries: entries.map((queuedComment, position) => ({
      comment: queuedComment,
      position,
      canEdit: true,
      canDiscard: true,
    })),
  }, ISSUE_ID);
}

function QueueStory({
  initialEntries = queuedComments,
  steeringDisposition = "available",
  failReorder = false,
  failSteer = false,
  holdSteer = false,
  failEditStale = false,
  failDiscard = false,
  rawQueue,
  mobile = false,
}: {
  initialEntries?: IssueComment[];
  steeringDisposition?: IssueQueuedCommentSteeringDisposition;
  failReorder?: boolean;
  failSteer?: boolean;
  holdSteer?: boolean;
  failEditStale?: boolean;
  failDiscard?: boolean;
  rawQueue?: unknown;
  mobile?: boolean;
}) {
  const [queue, setQueue] = useState(() => rawQueue === undefined
    ? queueFixture(initialEntries, steeringDisposition)
    : normalizeIssueQueuedCommentQueue(rawQueue, ISSUE_ID));
  const [comments, setComments] = useState<IssueComment[]>([priorComment, ...initialEntries]);
  const agentMap = useMemo(() => {
    const next = new Map(storybookAgentMap);
    const codex = next.get("agent-codex");
    if (codex) next.set("agent-codex", { ...codex, adapterType: "paperclip_runner" });
    return next;
  }, []);

  const updateQueue = (nextEntries: IssueComment[]) => {
    setQueue((current) => normalizeIssueQueuedCommentQueue({
      ...current,
      revision: `${current.revision}:next`,
      entries: nextEntries.map((queuedComment, position) => ({
        comment: queuedComment,
        position,
        canEdit: true,
        canDiscard: true,
      })),
    }, ISSUE_ID));
  };

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <section className={mobile ? "mx-auto w-(--sz-390px)" : "mx-auto max-w-(--tc-shell-max-w)"}>
        <TaskChatThread
          comments={comments}
          issueId={ISSUE_ID}
          issueStatus="in_progress"
          issueAssigneeAgentId="agent-codex"
          agentMap={agentMap}
          currentUserId={USER_ID}
          userLabelMap={new Map([[USER_ID, "Riley Board"]])}
          issueBrief={{
            description: "Implement Codex-style queueing for the Paperclip Runner.",
            author: "human",
            authorName: "Riley Board",
            createdAt: TS,
            onSave: async () => undefined,
          }}
          activeRun={{
            id: RUN_ID,
            status: "running",
            invocationSource: "issue_comment",
            triggerDetail: "queued message story",
            startedAt: TS,
            finishedAt: null,
            createdAt: TS,
            agentId: "agent-codex",
            agentName: "Codex",
            adapterType: "paperclip_runner",
            issueId: ISSUE_ID,
            currentStatusMessage: "Working",
          }}
          queuedCommentQueue={queue}
          onAdd={async (body) => {
            const next = comment(`queued-${Date.now()}`, body, 4);
            setComments((current) => [...current, next]);
            updateQueue([...queue.entries.map((entry) => entry.comment), next]);
          }}
          onEditQueuedComment={async (commentId, body) => {
            if (failEditStale) {
              setComments((current) => current.filter((entry) => entry.id !== commentId));
              updateQueue(queue.entries
                .filter((entry) => entry.comment.id !== commentId)
                .map((entry) => entry.comment));
              throw {
                status: 409,
                body: { details: { code: "queued_comment_stale_target" } },
              };
            }
            const nextEntries = queue.entries.map((entry) => (
              entry.comment.id === commentId
                ? { ...entry.comment, body, updatedAt: new Date() }
                : entry.comment
            ));
            setComments((current) => current.map((entry) => (
              entry.id === commentId ? { ...entry, body, updatedAt: new Date() } : entry
            )));
            updateQueue(nextEntries);
          }}
          onReorderQueuedComments={async (orderedCommentIds) => {
            if (failReorder) throw new Error("revision_conflict");
            const byId = new Map(queue.entries.map((entry) => [entry.comment.id, entry.comment]));
            updateQueue(orderedCommentIds.flatMap((id) => byId.get(id) ?? []));
          }}
          onSteerQueuedComment={async (commentId) => {
            if (holdSteer) await new Promise<void>(() => undefined);
            if (failSteer) throw new Error("steering_timeout");
            updateQueue(queue.entries.filter((entry) => entry.comment.id !== commentId).map((entry) => entry.comment));
          }}
          onDiscardQueuedComment={async (commentId) => {
            if (failDiscard) throw new Error("queued_comment_revision_conflict");
            setComments((current) => current.filter((entry) => entry.id !== commentId));
            updateQueue(queue.entries.filter((entry) => entry.comment.id !== commentId).map((entry) => entry.comment));
          }}
          draftKey={`storybook:queue-steering:${mobile ? "mobile" : "desktop"}`}
        />
      </section>
    </main>
  );
}

const meta = {
  title: "Task Page/Queue & Steering",
  component: TaskChatThread,
  args: { comments: [], onAdd: async () => undefined },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TaskChatThread>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleQueuedMessage: Story = {
  render: () => <QueueStory initialEntries={[queuedComments[0]]} />,
};

export const MultipleQueuedMessages: Story = {
  render: () => <QueueStory />,
};

export const PointerReorder: Story = {
  render: () => <QueueStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const source = canvas.getByRole("button", { name: /Reorder queued message: Keep the compact strip/ });
    const target = canvas.getByRole("button", { name: /Reorder queued message: Add keyboard reorder/ });
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: source, coords: { x: sourceRect.x + 8, y: sourceRect.y + 8 } },
      { target, coords: { x: targetRect.x + 8, y: targetRect.y + targetRect.height - 2 } },
      { keys: "[/MouseLeft]", target, coords: { x: targetRect.x + 8, y: targetRect.y + targetRect.height - 2 } },
    ]);
    await waitFor(() => {
      const rows = [...canvasElement.querySelectorAll('[data-testid^="task-chat-queued-message-"]')];
      expect(rows[0]).toHaveTextContent("Add keyboard reorder");
    });
  },
};

export const KeyboardReorder: Story = {
  render: () => <QueueStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getByRole("button", { name: /Reorder queued message: Keep the compact strip/ });
    await userEvent.click(handle);
    await userEvent.keyboard("{Space}{ArrowDown}{Space}");
    await waitFor(() => {
      const rows = [...canvasElement.querySelectorAll('[data-testid^="task-chat-queued-message-"]')];
      expect(rows[0]).toHaveTextContent("Add keyboard reorder");
    });
  },
};

export const EditAndRestoreDraft: Story = {
  render: () => <QueueStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const editor = canvas.getByRole("textbox");
    await userEvent.type(editor, "Unsent composer draft");
    await userEvent.click(canvas.getByRole("button", { name: /Queued message actions: Keep the compact strip/ }));
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole("menuitem", { name: "Edit message" }));
    await expect(canvas.getByText("Editing queued message")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.getByRole("textbox")).toHaveTextContent("Unsent composer draft"));
    await expect(canvas.getByRole("textbox")).toHaveFocus();
  },
};

export const EditAndSave: Story = {
  render: () => <QueueStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Queued message actions: Keep the compact strip/ }));
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole("menuitem", { name: "Edit message" }));
    const editor = canvas.getByRole("textbox");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Keep the compact strip aligned and keyboard accessible.");
    await userEvent.click(canvas.getByRole("button", { name: "Save queued message" }));
    await waitFor(() => expect(canvas.getByTestId("task-chat-queued-message-queued-one"))
      .toHaveTextContent("aligned and keyboard accessible"));
  },
};

export const StaleEditRecovery: Story = {
  render: () => <QueueStory failEditStale />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Queued message actions: Keep the compact strip/ }));
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole("menuitem", { name: "Edit message" }));
    const editor = canvas.getByRole("textbox");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Queue this replacement without losing it.");
    await userEvent.click(canvas.getByRole("button", { name: "Save queued message" }));
    await expect(canvas.getByText("Queued message changed")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Queue as new message" }));
    await waitFor(() => expect(canvas.getByText("Queue this replacement without losing it.")).toBeInTheDocument());
  },
};

export const SteerAcknowledged: Story = {
  render: () => <QueueStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId("task-chat-queued-steer-queued-one"));
    await waitFor(() => expect(canvas.queryByTestId("task-chat-queued-message-queued-one")).not.toBeInTheDocument());
  },
};

export const SteeringUnsupported: Story = {
  render: () => <QueueStory steeringDisposition="unsupported" />,
};

export const SteeringTemporarilyUnavailable: Story = {
  render: () => <QueueStory steeringDisposition="temporarily_unavailable" />,
};

export const SteeringPending: Story = {
  render: () => <QueueStory holdSteer />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId("task-chat-queued-steer-queued-one"));
    await expect(canvas.getByTestId("task-chat-queued-steer-queued-one")).toBeDisabled();
    await expect(canvas.getByText("Steering queued message.")).toBeInTheDocument();
  },
};

export const SteeringFailed: Story = {
  render: () => <QueueStory failSteer />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId("task-chat-queued-steer-queued-one"));
    await waitFor(() => expect(canvas.getByTestId("task-chat-queued-message-queued-one")).toBeInTheDocument());
    await expect(canvas.getByText("Couldn’t steer. Message is still queued.")).toBeInTheDocument();
  },
};

export const SteeringStaleTurn: Story = {
  render: () => <QueueStory failSteer />,
  parameters: {
    docs: { description: { story: "The active provider turn settled before its steering acknowledgement." } },
  },
};

export const Trash: Story = {
  render: () => <QueueStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId("task-chat-queued-discard-queued-one"));
    await waitFor(() => expect(canvas.queryByTestId("task-chat-queued-message-queued-one")).not.toBeInTheDocument());
  },
};

export const ConcurrentRevisionFailure: Story = {
  render: () => <QueueStory failReorder />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getByRole("button", { name: /Reorder queued message: Keep the compact strip/ });
    await userEvent.click(handle);
    await userEvent.keyboard("{Space}{ArrowDown}{Space}");
    await waitFor(() => expect(canvas.getByText("Couldn’t reorder. Previous order restored."))
      .toBeInTheDocument());
    const rows = [...canvasElement.querySelectorAll('[data-testid^="task-chat-queued-message-"]')];
    expect(rows[0]).toHaveTextContent("Keep the compact strip");
  },
};

export const TrashFailed: Story = {
  render: () => <QueueStory failDiscard />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId("task-chat-queued-discard-queued-one"));
    await expect(canvas.getByTestId("task-chat-queued-message-queued-one")).toBeInTheDocument();
    await expect(canvas.getByText("Couldn’t discard. Message is still queued.")).toBeInTheDocument();
  },
};

export const OptimisticToCanonicalReplacement: Story = {
  render: () => <QueueStory initialEntries={[]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const editor = canvas.getByRole("textbox");
    await userEvent.type(editor, "Queue this while the run is active.");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(canvas.getByText("Queue this while the run is active.")).toBeInTheDocument());
    expect(canvasElement.textContent?.match(/Queue this while the run is active\./g)).toHaveLength(1);
  },
};

export const EmptyQueue: Story = {
  render: () => <QueueStory initialEntries={[]} />,
};

export const MalformedQueueData: Story = {
  render: () => <QueueStory initialEntries={[]} rawQueue={{
    issueId: ISSUE_ID,
    targetRunId: RUN_ID,
    revision: "malformed-revision",
    protocol: "paperclip_runner_v1",
    steeringDisposition: "available",
    entries: [
      null,
      { position: 0, comment: { id: "missing-body" } },
      { position: 1, canEdit: true, canDiscard: true, comment: queuedComments[0] },
      { position: 2, canEdit: true, canDiscard: true, comment: queuedComments[0] },
    ],
  }} />,
};

export const NotMessageOwner: Story = {
  render: () => <QueueStory rawQueue={{
    issueId: ISSUE_ID,
    targetRunId: RUN_ID,
    revision: "restricted-revision",
    protocol: "paperclip_runner_v1",
    steeringDisposition: "available",
    entries: [{
      position: 0,
      canEdit: false,
      canDiscard: false,
      comment: { ...queuedComments[0], authorUserId: "another-user" },
    }],
  }} />,
};

export const DesktopKitchenSink: Story = {
  render: () => <QueueStory />,
};

export const MobileKitchenSink: Story = {
  render: () => <QueueStory mobile />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
