import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { Issue } from "@paperclipai/shared";
import {
  TaskDetailReferencesPanel,
  TaskDetailSubtasksPanel,
} from "@/components/task-detail/TaskDetailRelationsPanel";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { TaskChatBlockerLinks } from "@/components/task-chat/TaskChatBlockerLinks";
import type { TaskChatItem } from "@/components/task-chat/task-chat-model";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function taskFixture(overrides: Pick<Issue, "id" | "identifier" | "title" | "status"> & Partial<Issue>): Issue {
  return {
    companyId: "company-paperclip",
    priority: "medium",
    ...overrides,
  } as Issue;
}

function TaskDetailPanelFixture({
  initialTab = "subtasks",
  state = "active",
}: {
  initialTab?: "subtasks" | "references";
  state?: "active" | "blocked" | "complete";
}) {
  const [tab, setTab] = useState<string>(initialTab);
  const subtaskItems = state === "blocked"
    ? [taskFixture({
        id: "blocked",
        identifier: "PAP-203",
        title: "Review narrow-width overflow behavior",
        status: "blocked",
        blockerAttention: {
          state: "needs_attention",
          reason: "attention_required",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 0,
          stalledBlockerCount: 0,
          attentionBlockerCount: 1,
          sampleBlockerIdentifier: "PAP-119",
          sampleStalledBlockerIdentifier: null,
          terminalBlocker: {
            id: "root-blocker",
            identifier: "PAP-119",
            title: "Approve the shared navigation contract",
          },
        },
      })]
    : state === "complete"
      ? [
          taskFixture({ id: "one", identifier: "PAP-201", title: "Confirm information architecture", status: "done" }),
          taskFixture({ id: "two", identifier: "PAP-202", title: "Build shared panel navigation", status: "done" }),
        ]
      : [
          taskFixture({ id: "one", identifier: "PAP-201", title: "Confirm information architecture", status: "done" }),
          taskFixture({ id: "two", identifier: "PAP-202", title: "Build shared panel navigation", status: "in_progress" }),
          taskFixture({ id: "three", identifier: "PAP-203", title: "Review narrow-width overflow behavior", status: "todo" }),
        ];

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="mx-auto flex w-full max-w-md flex-col border border-border bg-background"
    >
      <div className="flex h-14 items-center border-b border-border px-4">
        <TabsList variant="line" className="w-full justify-start gap-1 p-0">
          <TabsTrigger value="subtasks">Subtasks</TabsTrigger>
          <TabsTrigger value="references">References</TabsTrigger>
        </TabsList>
      </div>
      <div className="p-5">
        <TabsContent value="subtasks">
          <TaskDetailSubtasksPanel
            items={subtaskItems}
            onAddSubtask={() => {}}
          />
        </TabsContent>
        <TabsContent value="references">
          <TaskDetailReferencesPanel
            referenced={[
              { id: "out", identifier: "PAP-118", title: "Task detail research notes", status: "done" },
            ]}
            mentionedIn={[
              { id: "in", identifier: "PAP-240", title: "Holistic UI regression review", status: "todo" },
            ]}
          />
        </TabsContent>
      </div>
    </Tabs>
  );
}

const blockedThreadItems: TaskChatItem[] = [
  { id: "request", kind: "message", author: "human", text: "Ship the task-detail navigation cleanup.", timestamp: "9:00 AM" },
  { id: "workspace", kind: "message", author: "system", text: "Workspace ready. The isolated worktree is available.", createdAtIso: "2026-08-31T16:01:00.000Z" },
  { id: "plan", kind: "marker", variant: "turn_boundary", label: "Plan created", detail: "rev 1 — see the Plan tab" },
  { id: "reply", kind: "message", author: "agent", authorName: "UI Builder", text: "The panel is ready for review.", timestamp: "9:05 AM" },
];

function TaskDetailBlockedThreadFixture() {
  const directBlocker = {
    id: "blocker",
    identifier: "PAP-118",
    title: "Approve the shared navigation contract",
    status: "in_review" as const,
    priority: "high" as const,
    assigneeAgentId: "agent-reviewer",
    assigneeUserId: null,
  };
  const rootBlocker = {
    id: "root",
    identifier: "PAP-101",
    title: "Resolve the information architecture decision",
    status: "todo" as const,
    priority: "high" as const,
    assigneeAgentId: null,
    assigneeUserId: "user-product",
  };
  return (
    <div className="mx-auto w-full max-w-2xl border border-border bg-background">
      <TaskChatThreadView
        items={blockedThreadItems}
        header={(
          <TaskChatBlockerLinks
            directBlocker={directBlocker}
            ultimateBlocker={rootBlocker}
            placement="top"
          />
        )}
        tail={(
          <TaskChatBlockerLinks
            directBlocker={directBlocker}
            ultimateBlocker={rootBlocker}
            placement="bottom"
          />
        )}
        scroll={false}
      />
    </div>
  );
}

const meta = {
  title: "Product/Task detail/Foundation",
  component: TaskDetailPanelFixture,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Task-detail relation navigation keeps subtask progress, references, and inbound mentions in the contextual right panel instead of competing with the conversation column.",
      },
    },
  },
} satisfies Meta<typeof TaskDetailPanelFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RelationsPanel: Story = {};

export const BlockedNextAction: Story = {
  args: { state: "blocked" },
};

export const CompletedSubtasks: Story = {
  args: { state: "complete" },
};

export const References: Story = {
  args: { initialTab: "references" },
};

export const LongBlockedThread: Story = {
  render: () => <TaskDetailBlockedThreadFixture />,
};
