import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RequestConfirmationInteraction } from "@paperclipai/shared";
import { TaskChatThread } from "@/components/TaskChatThread";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import {
  pendingToolActionWriteInteraction,
  pendingToolActionDestructiveInteraction,
  runningToolActionInteraction,
  executedToolActionInteraction,
  failedToolActionInteraction,
  declinedToolActionInteraction,
  expiredToolActionInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import { within, userEvent } from "storybook/test";
import { toolsApi } from "@/api/tools";
import { issuesApi } from "@/api/issues";
import { ReviewQueueCard } from "@/pages/apps/ReviewQueueCard";
import type { ToolActionRequestListItem } from "@paperclipai/shared";
import { storybookAgentMap } from "../fixtures/paperclipData";

const readRequest: RequestConfirmationInteraction = {
  ...pendingToolActionWriteInteraction,
  requestedResolverPolicy: "human_only",
  effectiveResolverPolicy: "human_only",
  resolverPolicyProvenance: "explicit",
  effectiveResolverPolicySource: "requested",
  payload: {
    ...pendingToolActionWriteInteraction.payload,
    supersedeOnUserComment: false,
    allowDeclineReason: true,
    toolAction: {
      ...pendingToolActionWriteInteraction.payload.toolAction!,
      toolName: "notion.search",
      toolDisplayName: "Read recent pages",
      appDisplayName: "Notion",
      risk: "read",
      previewMarkdown:
        "Read the 10 most recently edited pages in your connected Notion workspace.",
      argumentsSummaryJson: '{"sort":"last_edited_time","page_size":10}',
      rememberActionScope:
        "This agent can read recent pages on this Notion connection, with different search options, within this project.",
    },
  },
};
const meta = {
  title: "Chat & Comments/Connection Reviews",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function TaskScreen({
  initial = [readRequest],
  fail = false,
  hold = false,
  concurrent = false,
}: {
  initial?: RequestConfirmationInteraction[];
  fail?: boolean;
  hold?: boolean;
  concurrent?: boolean;
}) {
  const [interactions, setInteractions] = useState(initial);
  const [errorOnce, setErrorOnce] = useState(fail);
  useEffect(() => {
    if (!concurrent) return;
    const timer = setTimeout(
      () =>
        setInteractions([
          {
            ...readRequest,
            ...executedToolActionInteraction,
            id: readRequest.id,
            resolvedByUserId: "another-reviewer",
          },
        ]),
      1800,
    );
    return () => clearTimeout(timer);
  }, [concurrent]);
  const update = (id: string, patch: Partial<RequestConfirmationInteraction>) =>
    setInteractions((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TaskChatThread
        comments={[]}
        timelineEvents={[]}
        interactions={interactions}
        agentMap={storybookAgentMap}
        issueStatus="in_review"
        enableLiveTranscriptPolling={false}
        currentUserId="storybook-board"
        onAdd={async () => {}}
        threadHeader={
          <div className="p-4">
            <h1 className="text-xl font-semibold">
              Find our recent Notion pages
            </h1>
            <p className="text-sm text-muted-foreground">
              {interactions.some((row) => row.status === "pending")
                ? "The agent needs your permission to continue."
                : "Connection review history"}
            </p>
          </div>
        }
        onAcceptInteraction={async (
          interaction,
          _keys,
          _options,
          rememberAction,
        ) => {
          if (hold) await new Promise(() => {});
          await new Promise((resolve) => setTimeout(resolve, 700));
          if (errorOnce) {
            setErrorOnce(false);
            throw new Error("Couldn’t save the decision. Please try again.");
          }
          const result = {
            version: 1 as const,
            outcome: "accepted" as const,
            toolAction: {
              version: 1 as const,
              status: "executing" as const,
              rememberedAction: rememberAction,
              updatedAt: new Date().toISOString(),
            },
          };
          update(interaction.id, {
            status: "accepted",
            result,
            resolvedByUserId: "storybook-board",
            resolvedAt: new Date(),
          });
          setTimeout(
            () =>
              update(interaction.id, {
                result: {
                  ...result,
                  toolAction: {
                    ...result.toolAction,
                    status: "executed",
                    resultSummary:
                      "Found 10 pages, including Roadmap and Meeting notes.",
                  },
                },
              }),
            1200,
          );
        }}
        onRejectInteraction={async (interaction, reason) => {
          if (hold) await new Promise(() => {});
          update(interaction.id, {
            status: "rejected",
            result: { version: 1, outcome: "rejected", reason },
            resolvedByUserId: "storybook-board",
            resolvedAt: new Date(),
          });
        }}
      />
    </div>
  );
}
export const InteractiveTask: Story = { render: () => <TaskScreen /> };
export const MultipleRequests: Story = {
  render: () => (
    <TaskScreen
      initial={[readRequest, pendingToolActionDestructiveInteraction]}
    />
  ),
};
export const RecoverableError: Story = { render: () => <TaskScreen fail /> };
export const AllStates: Story = {
  render: () => (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {[
        readRequest,
        pendingToolActionWriteInteraction,
        pendingToolActionDestructiveInteraction,
        runningToolActionInteraction,
        executedToolActionInteraction,
        failedToolActionInteraction,
        declinedToolActionInteraction,
        expiredToolActionInteraction,
        {
          ...readRequest,
          id: "cancelled-review",
          status: "cancelled" as const,
          result: {
            version: 1 as const,
            outcome: "skipped" as const,
            reason: "Task cancelled",
          },
        },
        {
          ...executedToolActionInteraction,
          id: "remembered-review",
          result: {
            ...executedToolActionInteraction.result!,
            toolAction: {
              ...executedToolActionInteraction.result!.toolAction!,
              rememberedAction: true,
            },
          },
        },
      ].map((interaction, index) => (
        <IssueThreadInteractionCard
          key={index}
          interaction={interaction}
          agentMap={storybookAgentMap}
          onAcceptInteraction={() => {}}
          onRejectInteraction={() => {}}
        />
      ))}
    </div>
  ),
};

const clickAction =
  (name: string) =>
  async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name }),
    );
  };
export const Dismissed: Story = {
  render: () => <TaskScreen />,
  play: clickAction("Dismiss Approve tool action"),
};
export const Reopened: Story = {
  render: () => <TaskScreen />,
  play: async (context) => {
    await clickAction("Dismiss Approve tool action")(context);
    await clickAction("Review request")(context);
  },
};
export const Approving: Story = {
  render: () => <TaskScreen hold />,
  play: clickAction("Approve & run"),
};
export const SavingPermission: Story = {
  render: () => <TaskScreen hold />,
  play: async (context) => {
    await clickAction("Approval options")(context);
    await userEvent.click(await within(context.canvasElement.ownerDocument.body).findByRole("menuitem", { name: "Always allow" }));
  },
};
export const Declining: Story = {
  render: () => <TaskScreen hold />,
  play: clickAction("Decline"),
};
export const ApiFailure: Story = {
  render: () => <TaskScreen fail />,
  play: clickAction("Approve & run"),
};
export const ResolvedElsewhere: Story = {
  render: () => <TaskScreen concurrent />,
};
export const Narrow: Story = {
  render: () => (
    <div className="max-w-sm">
      <TaskScreen />
    </div>
  ),
};
export const ExpandedDetails: Story = {
  name: "Approval options",
  render: () => <TaskScreen />,
  play: clickAction("Approval options"),
};
export const Approved: Story = {
  render: () => (
    <TaskScreen
      initial={[
        {
          ...runningToolActionInteraction,
          result: {
            version: 1,
            outcome: "accepted",
            toolAction: {
              version: 1,
              status: "approved",
              updatedAt: new Date().toISOString(),
            },
          },
        },
      ]}
    />
  ),
};
export const Executing: Story = {
  render: () => <TaskScreen initial={[runningToolActionInteraction]} />,
};
export const Succeeded: Story = {
  render: () => <TaskScreen initial={[executedToolActionInteraction]} />,
};
export const ResultDetails: Story = {
  render: () => <TaskScreen initial={[{
    ...executedToolActionInteraction,
    result: {
      ...executedToolActionInteraction.result!,
      toolAction: {
        ...executedToolActionInteraction.result!.toolAction!,
        resultSummary: JSON.stringify({ pages: [{ title: "Roadmap" }, { title: "Meeting notes" }] }),
      },
    },
  }]} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Show result details" }));
  },
};
export const ExecutionFailed: Story = {
  render: () => <TaskScreen initial={[failedToolActionInteraction]} />,
};
export const Declined: Story = {
  render: () => <TaskScreen initial={[declinedToolActionInteraction]} />,
};
export const DeclinedWithoutReason: Story = {
  render: () => (
    <TaskScreen
      initial={[
        {
          ...declinedToolActionInteraction,
          result: { version: 1, outcome: "rejected" },
        },
      ]}
    />
  ),
};
export const Expired: Story = {
  render: () => <TaskScreen initial={[expiredToolActionInteraction]} />,
};
export const Cancelled: Story = {
  render: () => (
    <TaskScreen
      initial={[
        {
          ...readRequest,
          status: "cancelled",
          result: { version: 1, outcome: "skipped", reason: "Task cancelled" },
        },
      ]}
    />
  ),
};
export const PermissionSaved: Story = {
  render: () => (
    <TaskScreen
      initial={[
        {
          ...executedToolActionInteraction,
          result: {
            ...executedToolActionInteraction.result!,
            toolAction: {
              ...executedToolActionInteraction.result!.toolAction!,
              rememberedAction: true,
            },
          },
        },
      ]}
    />
  ),
};

function QueueScreen({ empty = false }: { empty?: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const list = toolsApi.listActionRequests;
    const approve = toolsApi.approveActionRequest;
    const decline = toolsApi.declineActionRequest;
    const interactions = issuesApi.listInteractions;
    let pending = !empty;
    const item = {
      request: {
        id: readRequest.payload.toolAction!.actionRequestId,
        issueId: readRequest.issueId,
        interactionId: readRequest.id,
        status: "pending",
        createdAt: new Date(),
      },
      toolTitle: "Read recent pages",
      toolName: "notion.search",
      connectionId: "notion-connection",
      applicationName: "Notion",
      requestedByAgentId: readRequest.createdByAgentId,
    } as ToolActionRequestListItem;
    toolsApi.listActionRequests = async () => ({
      actionRequests: pending ? [item] : [],
    });
    toolsApi.approveActionRequest = async () => {
      pending = false;
      return { ...item.request, status: "executed" };
    };
    toolsApi.declineActionRequest = async () => {
      pending = false;
      return { ...item.request, status: "rejected" };
    };
    issuesApi.listInteractions = async () => [readRequest];
    setReady(true);
    return () => {
      toolsApi.listActionRequests = list;
      toolsApi.approveActionRequest = approve;
      toolsApi.declineActionRequest = decline;
      issuesApi.listInteractions = interactions;
    };
  }, [empty]);
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Connection reviews</h1>
      {ready ? <ReviewQueueCard emptyState="reassure" /> : null}
    </div>
  );
}
export const ConnectionsQueue: Story = { render: () => <QueueScreen /> };
export const ConnectionsEmpty: Story = { render: () => <QueueScreen empty /> };
