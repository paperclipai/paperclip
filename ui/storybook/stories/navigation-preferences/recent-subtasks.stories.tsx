import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { CoordinatorSidebar } from "@/components/CoordinatorSidebar";
import { SidebarRecentTasks } from "@/components/SidebarRecentTasks";
import { recordRecentTask, getRecentTasksStorageKey } from "@/lib/recent-tasks";
import { prepareFixtureApi } from "../../support/capability-gaps/api";
import { storybookIssues } from "../../fixtures/paperclipData";
import type { Issue } from "@paperclipai/shared";

type Scenario = "expanded" | "collapsed" | "ten" | "many" | "all" | "selected" | "beyond-ten" | "statuses" | "independent" | "long" | "narrow" | "leaf" | "empty" | "loading" | "failure" | "stale" | "keyboard" | "section-collapsed" | "parent-unread" | "classic";
type Args = { scenario: Scenario };
const companyId = "company-storybook";
const userId = "user-board";
const parentTitle = "Ship the project workspace";
function task(index: number, title: string, parentId: string | null = null): Issue {
  return { ...storybookIssues[0]!, id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, companyId,
    identifier: `PAP-${100 + index}`, title, status: "todo", parentId, hiddenAt: null, conversationAgentId: null,
    createdAt: new Date("2026-11-01"), updatedAt: new Date("2026-11-01"), isUnreadForMe: false };
}
function SidebarExample({ scenario }: Args) {
  return <div className={`coordinator-workspace h-screen ${scenario === "narrow" ? "w-60" : "w-72"}`}>
    {scenario === "classic" ? <SidebarRecentTasks companyId={companyId} liveIssueIds={new Set()} /> : <CoordinatorSidebar />}
  </div>;
}

const meta = {
  id: "design-recent-subtasks",
  title: "Oversight and operation/Navigation, profile, and announcements/Sidebar subtasks",
  component: SidebarExample,
  args: { scenario: "expanded" },
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/issues/PAP-100"], paperclip: {
    capabilities: ["navigation-preferences/preferences", "tasks/organize"], status: "current", implementation: "production", boundary: "fixtures",
    notes: "Live standard and Classic sidebar components with HTTP summary/child fixtures. Covers independent unread state, authorized-count display, ten-row paging, selected-child visibility, folding and read errors. Server route tests cover private/company boundaries and real unread/read receipts. Browser fixture navigation does not mount task detail or prove a live deployment.",
  } },
  beforeEach: ({ args }) => {
    const parent = task(0, args.scenario === "long" ? `${parentTitle} and verify every account can return to its saved project context` : parentTitle);
    parent.isUnreadForMe = args.scenario === "parent-unread";
    const size = ["many", "all", "beyond-ten"].includes(args.scenario) ? 14 : args.scenario === "ten" ? 10 : 3;
    const children = Array.from({ length: size }, (_, index) => {
      const child = task(index + 1, args.scenario === "long" ? `Subtask ${index + 1}: Keep the saved workspace and all task navigation labels readable in a narrow sidebar` : `Subtask ${index + 1}`, parent.id);
      child.isUnreadForMe = args.scenario !== "parent-unread" && index !== 0;
      if (args.scenario === "statuses") child.status = (["in_progress", "in_review", "blocked"] as const)[index % 3]!;
      return child;
    });
    const second = task(30, "Prepare the release notes");
    const secondChildren = [task(31, "Review the change list", second.id)];
    const leaf = task(40, "Review the company dashboard");
    const roots = args.scenario === "empty" ? [] : args.scenario === "leaf" ? [leaf]
      : args.scenario === "independent" ? [parent, second, leaf] : [parent, leaf];
    const activeChild = args.scenario === "beyond-ten" ? children[11] : args.scenario === "selected" ? children[1] : undefined;
    const rows = [...roots, ...children, ...secondChildren];
    const savedKey = getRecentTasksStorageKey(companyId, userId);
    const saved = localStorage.getItem(savedKey);
    localStorage.removeItem(savedKey);
    roots.forEach((row, index) => recordRecentTask(row, userId, 100 - index));
    // Exercise deduplication for a child which is also in local recent history.
    if (roots.length && args.scenario !== "leaf") recordRecentTask(activeChild ?? children[0]!, userId, 200);
    const fixture = prepareFixtureApi([
      { path: `/api/companies/${companyId}/issues/summaries`, read: ({ url }) => rows.filter(row => url.searchParams.get("ids")?.split(",").includes(row.id)).map(row => {
        const subtasks = row.id === parent.id ? children : row.id === second.id ? secondChildren : [];
        return { ...row, externalConversationState: null, subtaskCount: subtasks.length, unreadSubtaskCount: subtasks.filter(child => child.isUnreadForMe).length };
      }) },
      { path: `/api/companies/${companyId}/issues`, state: args.scenario === "loading" ? "loading" : args.scenario === "failure" ? "failure" : "ready", read: ({ url }) => {
        const subtasks = url.searchParams.get("parentId") === second.id ? secondChildren : children;
        const after = url.searchParams.get("afterId");
        const start = after ? subtasks.findIndex(child => child.id === after) + 1 : 0;
        return args.scenario === "stale" ? [] : subtasks.slice(start, start + 10);
      } },
      { path: `/api/companies/${companyId}/chats`, read: () => [] },
      { path: `/api/companies/${companyId}/projects`, read: () => [] },
      { path: `/api/companies/${companyId}/issues/chat-bootstrap`, read: () => ({ items: [] }) },
    ]);
    return () => { fixture.cleanup(); if (saved === null) localStorage.removeItem(savedKey); else localStorage.setItem(savedKey, saved); };
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    if (args.scenario === "empty") { await expect(canvas.queryByText("Recents")).toBeNull(); return; }
    if (args.scenario === "leaf") { await expect(canvas.findByText("Review the company dashboard")).resolves.toBeVisible(); return; }
    const fold = await canvas.findByRole("button", { name: new RegExp(`Collapse subtasks of ${parentTitle}`) });
    if (args.scenario === "collapsed" || args.scenario === "independent") await userEvent.click(fold);
    if (args.scenario === "all") await userEvent.click(await canvas.findByRole("button", { name: /Show more/ }));
    if (args.scenario === "keyboard") { fold.focus(); await expect(fold).toHaveFocus(); }
    if (args.scenario === "section-collapsed") await userEvent.click(await canvas.findByRole("button", { name: "Collapse Recents" }));
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Expanded: Story = {};
export const Collapsed: Story = { args: { scenario: "collapsed" } };
export const ExactlyTen: Story = { args: { scenario: "ten" } };
export const MoreThanTen: Story = { args: { scenario: "many" } };
export const AllSubtasks: Story = { args: { scenario: "all" } };
export const SelectedSubtask: Story = { args: { scenario: "selected" }, parameters: { initialEntries: ["/PAP/issues/PAP-102"] } };
export const SelectedBeyondTen: Story = { args: { scenario: "beyond-ten" }, parameters: { initialEntries: ["/PAP/issues/PAP-112"] } };
export const MixedStatuses: Story = { args: { scenario: "statuses" } };
export const IndependentGroups: Story = { args: { scenario: "independent" } };
export const LongTitles: Story = { args: { scenario: "long" } };
export const Narrow: Story = { args: { scenario: "narrow" } };
export const NoSubtasks: Story = { args: { scenario: "leaf" } };
export const EmptyRecents: Story = { args: { scenario: "empty" } };
export const Loading: Story = { args: { scenario: "loading" } };
export const LoadFailed: Story = { args: { scenario: "failure" } };
export const NoChildrenAvailable: Story = { args: { scenario: "stale" } };
export const KeyboardFocus: Story = { args: { scenario: "keyboard" } };
export const SectionCollapsed: Story = { args: { scenario: "section-collapsed" } };
export const ParentUnreadChildrenRead: Story = { args: { scenario: "parent-unread" } };
export const Classic: Story = { args: { scenario: "classic" } };
