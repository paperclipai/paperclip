import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routines } from "@/pages/Routines";
import { Routines as ClassicRoutines } from "@/pages/Routines.production";
import { Routes, Route, useLocation } from "@/lib/router";
import { baseRoutine } from "../../fixtures/routineWebhooks";
import { storybookAgents, storybookProjects } from "../../fixtures/paperclipData";
import { prepareFixtureApi } from "../../support/capability-gaps/api";
import { routineViewStorageKey } from "@/lib/routine-list-view";

function RoutineListPage({ classic = false }: { classic?: boolean }) {
  const location = useLocation();
  return <main className="design-proposal-theme p-6"><a className="sr-only" data-testid="routine-view-location" href={`${location.pathname}${location.search}`}>Current routine view</a><Routes><Route path="/PAP/routines" element={classic ? <ClassicRoutines /> : <Routines />} /></Routes></main>;
}
const routines = [
  { ...baseRoutine, id: "weekly-review", title: "Weekly project review", projectId: storybookProjects[0].id, responsibleUserId: "user-board", lastRun: { triggeredAt: "2026-11-17T08:00:00Z", status: "completed" } },
  { ...baseRoutine, id: "nightly-triage", title: "Nightly task triage", assigneeAgentId: storybookAgents[1].id, projectId: storybookProjects[1].id, responsibleUserId: "person-alex", status: "paused", lastRun: null },
  { ...baseRoutine, id: "daily-summary", title: "Daily company summary", projectId: storybookProjects[0].id, responsibleUserId: "person-alex", lastRun: null },
];
const meta = {
  id: "routines-list-view",
  title: "Automation and structured work/Routines, schedules, and triggers/List controls and columns",
  component: RoutineListPage,
  parameters: {
    layout: "fullscreen", initialEntries: ["/PAP/routines"],
    paperclip: { capabilities: ["routines/management"], status: "current", implementation: "production", boundary: "fixtures", notes: "Both production Routines pages with real search, filter, sort, group, columns and local view persistence. API reads use fictional fixtures. Manual execution and routine creation are outside this story's acceptance scope." },
  },
  beforeEach: ({ parameters }) => {
    localStorage.removeItem(routineViewStorageKey("company-storybook", "user-board"));
    return prepareFixtureApi([
      { path: "/api/workspace-preferences/me", read: () => ({ userId: "user-board", coordinatorWorkspaceEnabled: false, updatedAt: null }) },
      { path: "/api/companies/company-storybook/routines", read: () => routines },
      { path: "/api/companies/company-storybook/folders", read: () => ({ folders: parameters.withFolders ? [{ id: "folder-review", name: "Reviews", kind: "routine", parentId: null, position: 0, itemCount: 0 }] : [], allCount: routines.length, unfiledCount: routines.length }) },
      { path: "/api/companies/company-storybook/user-directory", read: () => ({ users: [
        { principalId: "user-board", status: "active", user: { name: "Taylor Morgan", email: "taylor@example.test", image: null } },
        { principalId: "person-alex", status: "active", user: { name: "Alex Chen", email: "alex@example.test", image: null } },
      ] }) },
    ]).cleanup;
  },
} satisfies Meta<typeof RoutineListPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const LinkedFilters: Story = { parameters: { initialEntries: [`/PAP/routines?projects=${storybookProjects[0].id}&responsibleUsers=person-alex&statuses=active`] } };
export const Classic: Story = { args: { classic: true } };
export const ClassicSelection: Story = { args: { classic: true }, parameters: { withFolders: true } };

export const ClassicRuns: Story = { args: { classic: true }, parameters: { initialEntries: ["/PAP/routines?tab=runs"] } };
