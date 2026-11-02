import type { Meta, StoryObj } from "@storybook/react-vite";
import { CoordinatorSidebar } from "@/components/CoordinatorSidebar";
import { CoordinatorTasks } from "@/pages/CoordinatorTasks";
import { DesignPageShell } from "@/components/DesignPageShell";
import { SidebarAccountMenu } from "@/components/SidebarAccountMenu";
import { initialItems } from "../../support/design-proposals/task-page-data";
import { DesignProposalAccess } from "../../support/design-proposals/DesignProposalAccess";
import { prepareFixtureApi } from "../../support/capability-gaps/api";
import { storybookIssueLabels } from "../../fixtures/paperclipData";

function CoordinatorTasksPreview() {
  return <DesignProposalAccess><div className="coordinator-workspace"><DesignPageShell title="Tasks"
    sidebar={<><CoordinatorSidebar /><div className="design-sidebar-account"><SidebarAccountMenu forceExpanded /></div></>}
    sidebarStorageKey="paperclip.storybook.coordinator-sidebar-width"><CoordinatorTasks /></DesignPageShell></div></DesignProposalAccess>;
}

const meta = {
  id: "coordinator-tasks-design",
  title: "Design proposals/Pages/Coordinator tasks",
  component: CoordinatorTasksPreview,
  parameters: {
    layout: "fullscreen", initialEntries: ["/PAP/issues"], designProposalTheme: false,
    paperclip: {
      capabilities: ["tasks/organize", "navigation-preferences/navigation", "inbox-search/decisions"],
      status: "proposed", home: "design-proposals",
      exception: "Coordinator experimental workspace in an isolated worktree, awaiting review.",
      implementation: "production", boundary: "fixtures",
      notes: "Mounts the actual CoordinatorSidebar and CoordinatorTasks with the shared proposed task table, toolbar and sidebar styles. Keeps Chat, Tasks, Needs You, More and Recents. Needs attention uses the canonical pending-decision feed and hydrates its task IDs; it does not infer attention from task status. DesignPageShell supplies fixture-only desktop chrome; the real Layout owns responsive shell and account placement. API results are synthetic and writes are unsupported; task-detail, New Task, agent execution and cross-surface resolution require the running app. No global proposal theme is enabled, matching the narrowly scoped production opt-in.",
    },
  },
  beforeEach: () => prepareFixtureApi([
    { path: /\/api\/companies\/[^/]+\/labels$/, method: "GET", read: () => storybookIssueLabels },
    { path: /\/api\/companies\/[^/]+\/issues$/, method: "GET", read: ({ url }) => {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return initialItems.map(item => item.issue).filter(issue => `${issue.title} ${issue.identifier}`.toLowerCase().includes(q));
    } },
    { path: /\/api\/issues\/[^/]+$/, method: "GET", read: ({ url }) => initialItems.find(item => item.issue.id === url.pathname.split("/").at(-1))?.issue },
    { path: /\/api\/companies\/[^/]+\/attention$/, method: "GET", read: () => ({
      companyId: "company-storybook", generatedAt: "2026-10-27T12:00:00Z", totalCount: 2, deskBadgeCount: 2, nextCursor: null, countsBySourceKind: { issue_thread_interaction: 2 },
      items: initialItems.slice(1, 3).map(({ issue }, index) => ({ id: `fixture-decision-${index}`, sourceKind: "issue_thread_interaction", subject: { kind: "interaction", id: `fixture-question-${index}` }, relatedIssue: { id: issue.id, title: issue.title, identifier: issue.identifier } })),
    }) },
    { path: /\/api\/companies\/[^/]+\/chats$/, method: "GET", read: () => [] },
  ]).cleanup,
} satisfies Meta<typeof CoordinatorTasksPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AllTasks: Story = {};
export const NeedsAttention: Story = { parameters: { initialEntries: ["/PAP/issues?view=needs_attention"] } };
export const NoResults: Story = { parameters: { initialEntries: ["/PAP/issues?q=unmatched-query"] } };
