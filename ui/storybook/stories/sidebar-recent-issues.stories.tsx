import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RecentIssue } from "@paperclipai/shared";
import { SidebarRecentIssues } from "@/components/SidebarRecentIssues";

const baseIssues: RecentIssue[] = [
  {
    id: "recent-1",
    identifier: "DEMO-101",
    title: "Match the recent tasks sidebar wireframe",
    status: "in_progress",
    lastInteractedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    kind: "commented",
    hasActiveRun: false,
    needsAttention: false,
    attentionHref: null,
  },
  {
    id: "recent-2",
    identifier: "DEMO-102",
    title: "Add per-user recent issue history",
    status: "done",
    lastInteractedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    kind: "edited",
    hasActiveRun: false,
    needsAttention: false,
    attentionHref: null,
  },
  {
    id: "recent-3",
    identifier: "DEMO-103",
    title: "Recent tasks sidebar, experimental",
    status: "in_review",
    lastInteractedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    kind: "document",
    hasActiveRun: false,
    needsAttention: false,
    attentionHref: null,
  },
];

const meta = {
  title: "Navigation/Sidebar Recent Issues",
  component: SidebarRecentIssues,
  decorators: [
    (Story) => (
      <div className="w-72 bg-background p-3">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "centered" },
  args: { issues: baseIssues, liveIssueIds: new Set<string>() },
} satisfies Meta<typeof SidebarRecentIssues>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ExpandedDefault: Story = {};

export const LiveRow: Story = {
  args: { liveIssueIds: new Set(["recent-1"]) },
};

export const NeedsAttentionRow: Story = {
  args: {
    issues: baseIssues.map((issue, index) => index === 0
      ? { ...issue, needsAttention: true, attentionHref: `/issues/${issue.identifier}#interaction-demo` }
      : issue),
  },
};

export const TerminalDimmedRow: Story = {
  args: {
    issues: baseIssues.map((issue, index) => index === 0 ? { ...issue, status: "cancelled" } : issue),
  },
};
