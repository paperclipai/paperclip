import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { CoordinatorSidebar } from "@/components/CoordinatorSidebar";
import { SidebarRecentTasks } from "@/components/SidebarRecentTasks";
import { recordRecentTask, getRecentTasksStorageKey } from "@/lib/recent-tasks";
import { prepareFixtureApi } from "../../support/capability-gaps/api";
import { storybookIssues } from "../../fixtures/paperclipData";
import type { Issue } from "@paperclipai/shared";

type Args = {
  classic: boolean;
  childOnly: boolean;
  empty: boolean;
  collapseSection: boolean;
  narrow: boolean;
  longTitles: boolean;
  focusChild: boolean;
};

const companyId = "company-storybook";
const userId = "user-board";
const parentTitle = "Ship the project workspace";
const childTitle = "Verify the saved workspace";
const liveIssueIds = new Set<string>();

function task(index: number, title: string, parentId: string | null = null): Issue {
  return {
    ...storybookIssues[0]!,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    companyId, identifier: `PAP-${100 + index}`, title, parentId,
    status: "todo", hiddenAt: null, archivedAt: null, conversationAgentId: null,
    createdAt: new Date("2026-11-01"), updatedAt: new Date("2026-11-01"), isUnreadForMe: false,
  };
}

function SidebarExample({ classic, narrow }: Args) {
  return (
    <div className={`coordinator-workspace h-screen ${narrow ? "w-60" : "w-72"}`}>
      {classic ? <SidebarRecentTasks companyId={companyId} liveIssueIds={liveIssueIds} /> : <CoordinatorSidebar />}
    </div>
  );
}

const meta = {
  id: "design-recent-subtasks",
  title: "Oversight and operation/Navigation, profile, and announcements/Sidebar Recents",
  component: SidebarExample,
  args: { classic: false, childOnly: false, empty: false, collapseSection: false, narrow: false, longTitles: false, focusChild: false },
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/issues/PAP-100"], paperclip: {
    capabilities: ["navigation-preferences/preferences", "tasks/organize"], status: "current", implementation: "production", boundary: "fixtures",
    notes: "Standard and Classic sidebars render real navigation components with simulated summary responses and browser-local visit history. The fixtures cover flat task order, independent unread state, canceled tasks, and archive filtering.",
  } },
  beforeEach: ({ args }) => {
    const parent = task(0, parentTitle);
    const child = task(1, args.longTitles ? `${childTitle} and confirm the account returns to its last project` : childTitle, parent.id);
    child.isUnreadForMe = true;
    const completed = { ...task(2, "Review the company dashboard"), status: "done" as const };
    const cancelled = { ...task(3, "Canceled task"), status: "cancelled" as const };
    const archived = task(4, "Archived task");
    const recent = args.empty ? [] : args.childOnly ? [child] : [child, parent, completed, cancelled];
    const savedKey = getRecentTasksStorageKey(companyId, userId);
    const saved = localStorage.getItem(savedKey);
    localStorage.removeItem(savedKey);
    if (!args.empty) [archived, ...recent].forEach((row, index) => recordRecentTask(row, userId, 100 - index));
    const fixture = prepareFixtureApi([
      { path: `/api/companies/${companyId}/issues/summaries`, read: ({ url }) => [archived, ...recent]
        .filter(row => url.searchParams.get("ids")?.split(",").includes(row.id))
        .map(row => ({ ...row, externalConversationState: null, isParticipantForMe: true, isArchivedForMe: row.id === archived.id,
          subtaskCount: row.id === parent.id ? 2 : 0,
        })) },
      { path: `/api/companies/${companyId}/chats`, read: () => [] },
      { path: `/api/companies/${companyId}/projects`, read: () => [] },
      { path: `/api/companies/${companyId}/issues/chat-bootstrap`, read: () => ({ items: [] }) },
    ]);
    return () => {
      fixture.cleanup();
      if (saved === null) localStorage.removeItem(savedKey);
      else localStorage.setItem(savedKey, saved);
    };
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    if (args.empty) {
      await expect(canvas.queryByRole("region", { name: "Recents" })).toBeNull();
      return;
    }

    const child = await canvas.findByRole("link", { name: new RegExp(childTitle) });
    await expect(within(child).getByLabelText("Unread")).toBeVisible();
    if (args.childOnly) {
      await expect(canvas.getAllByRole("link", { name: /workspace/ })).toEqual([child]);
      await expect(child).toHaveAttribute("aria-current", "page");
    } else {
      const parent = canvas.getByRole("link", { name: parentTitle });
      await expect(within(parent).queryByLabelText("Unread")).toBeNull();
      await expect(child.compareDocumentPosition(parent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await expect(canvas.getByRole("link", { name: "Review the company dashboard" })).toBeVisible();
      await expect(canvas.getByRole("link", { name: "Canceled task" })).toBeVisible();
    }
    await expect(canvas.queryByRole("group", { name: /Subtasks of/ })).toBeNull();
    await expect(canvas.queryByRole("link", { name: "Archived task" })).toBeNull();

    if (args.focusChild) {
      child.focus();
      await expect(child).toHaveFocus();
    }
    if (args.collapseSection) {
      await userEvent.click(canvas.getByRole("button", { name: "Collapse Recents" }));
      await expect(canvas.queryByRole("link", { name: new RegExp(childTitle) })).toBeNull();
    }
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};
export const SelectedSubtask: Story = {
  args: { childOnly: true },
  parameters: { initialEntries: ["/PAP/issues/PAP-101"] },
};
export const LongTitles: Story = { args: { longTitles: true } };
export const Narrow: Story = { args: { narrow: true, longTitles: true } };
export const EmptyRecents: Story = { args: { empty: true } };
export const KeyboardFocus: Story = { args: { focusChild: true } };
export const SectionCollapsed: Story = { args: { collapseSection: true } };
export const Classic: Story = { args: { classic: true } };
