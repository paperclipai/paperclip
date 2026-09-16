import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskChatSystemNotice } from "@/components/task-chat/TaskChatSystemNotice";
import type { TaskChatMessageItem } from "@/components/task-chat/task-chat-model";

const workspaceReadyItem = {
  id: "workspace-ready",
  kind: "message",
  author: "system",
  text: [
    "## Workspace Ready",
    "",
    "- Strategy: `git_worktree`",
    "- Branch: `fix/workspace-ready-notice`",
    "- CWD: `/worktrees/workspace-ready-notice`",
  ].join("\n"),
  createdAtIso: new Date(Date.now() - 2 * 60_000).toISOString(),
  presentation: {
    kind: "system_notice",
    tone: "info",
    title: "Workspace ready · fix/workspace-ready-notice",
    detailsDefaultOpen: false,
    density: "compact",
  },
  metadata: {
    version: 1,
    sections: [
      {
        title: "Workspace",
        rows: [
          { type: "key_value", label: "Strategy", value: "git_worktree" },
          {
            type: "key_value",
            label: "Branch",
            value: "fix/workspace-ready-notice",
          },
          {
            type: "key_value",
            label: "CWD",
            value: "/worktrees/workspace-ready-notice",
          },
        ],
      },
    ],
  },
} satisfies TaskChatMessageItem;

function StoryFrame({ item }: { item: TaskChatMessageItem }) {
  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <TaskChatSystemNotice item={item} />
    </div>
  );
}

const meta = {
  title: "Product/Task chat/System notice",
  component: TaskChatSystemNotice,
  args: {
    item: workspaceReadyItem,
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Compact control-plane notice used for structured task-thread events. Expand the row to inspect workspace metadata without presenting it as an agent reply.",
      },
    },
  },
  render: ({ item }) => <StoryFrame item={item} />,
} satisfies Meta<typeof TaskChatSystemNotice>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WorkspaceReadyCollapsed: Story = {};

export const WorkspaceReadyExpanded: Story = {
  args: {
    item: {
      ...workspaceReadyItem,
      presentation: {
        ...workspaceReadyItem.presentation,
        detailsDefaultOpen: true,
      },
    },
  },
};
