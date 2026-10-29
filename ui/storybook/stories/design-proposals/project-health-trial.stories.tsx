import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ProjectHealthTrial } from "../../support/design-proposals/ProjectHealthTrial";
import { projectHealthProjectIds } from "../../support/design-proposals/project-health-trial-data";

const meta = {
  id: "design-project-health-trial",
  title: "Design proposals/AI Generated Test Pages/Project health trial",
  component: ProjectHealthTrial,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/projects"],
    docs: { description: { component: "Independent desktop reuse trial using only Design Proposals references. Shared shell, sidebar, metrics, cards, flyouts, inputs, task summaries and empty states; local project aggregation, name/description search and selection. Active means in progress. Needs attention uses the shared task-view predicate: blocked or in review. Summary totals always describe the selected organization, independent of filters. Selecting a card shows its six most recently updated tasks. Changing search, view or organization clears selection. Fixtures include long names, an empty project and an empty organization. No production route, API, permission or persistence coverage." } },
    paperclip: {
      capabilities: ["projects/lifecycle", "projects/task-context"],
      home: "design-proposals",
      status: "proposed",
      exception: "Independent Project health composition trial staged under Design Proposals; existing references and shared implementations are preserved.",
      implementation: "prototype",
      boundary: "fixtures",
      notes: "Uses DesignPageShell, DesignSidebar, MetricCard, Card, Button, Badge, Input, shared flyout primitives, TaskSummaryList/TaskRowGroup and EmptyState. Project search/filter/selection and counts are local; attention reuses matchesTaskListView. TaskListToolbar/useTaskListCollection cannot express project views, so only their primitive composition is repeated. Project status uses neutral Badge text because no proposed project-health status component is defined. Sidebar menus, command palette and New Task mount existing fixture-backed components; destination pages and real project creation are outside this trial. Pane preferences use isolated trial keys. Desktop dark-mode scope only.",
    },
  },
} satisfies Meta<typeof ProjectHealthTrial>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const SelectedProject: Story = { args: { initialProjectId: projectHealthProjectIds.onboarding } };
export const LongProjectName: Story = { args: { initialProjectId: projectHealthProjectIds.international } };
export const NeedsAttention: Story = { args: { initialView: "attention" } };
export const EmptyProject: Story = { args: { initialProjectId: projectHealthProjectIds.partners } };
export const NoResults: Story = { args: { initialQuery: "lunar greenhouse" } };
export const EmptyOrganization: Story = { args: { emptyOrganization: true } };

export const Interactions: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await step("Project selection shows only its recent tasks", async () => {
      await userEvent.click(await canvas.findByRole("button", { name: "View recent tasks for Customer onboarding" }));
      await expect(canvas.getByRole("list", { name: "Recent tasks for Customer onboarding" })).toBeVisible();
      await expect(canvas.getByRole("button", { name: "View recent tasks for Customer onboarding" })).toHaveAttribute("aria-pressed", "true");
    });
    await step("Search is case insensitive and clears stale selection", async () => {
      await userEvent.type(canvas.getByRole("textbox", { name: "Search projects" }), "INTERNATIONAL");
      await expect(within(canvas.getByRole("list", { name: "Project cards" })).getAllByRole("button")).toHaveLength(1);
      await expect(canvas.queryByRole("list", { name: "Recent tasks for Customer onboarding" })).not.toBeInTheDocument();
      await userEvent.click(canvas.getByRole("button", { name: "Clear search" }));
    });
    await step("Attention filter uses blocked and review tasks and composes with search", async () => {
      await userEvent.click(canvas.getByRole("button", { name: "Project view: All projects" }));
      await userEvent.click(await page.findByRole("menuitemradio", { name: "Needs attention" }));
      await expect(within(canvas.getByRole("list", { name: "Project cards" })).getAllByRole("button")).toHaveLength(2);
      await userEvent.type(canvas.getByRole("textbox", { name: "Search projects" }), "Knowledge");
      await expect(canvas.getByText("No projects match this view")).toBeVisible();
      await userEvent.click(canvas.getByRole("button", { name: "Clear filters" }));
      await expect(canvas.getByRole("button", { name: "Project view: All projects" })).toBeVisible();
      await expect(within(canvas.getByRole("list", { name: "Project cards" })).getAllByRole("button")).toHaveLength(6);
    });
    await step("Empty projects offer a next step and closing restores focus", async () => {
      const emptyProject = canvas.getByRole("button", { name: "View recent tasks for Partner integrations" });
      emptyProject.focus();
      await userEvent.keyboard("{Enter}");
      await expect(canvas.getByText("No tasks yet")).toBeVisible();
      await userEvent.click(within(canvas.getByRole("region", { name: "Recent tasks content" })).getByRole("button", { name: "Browse projects" }));
      await expect(emptyProject).toHaveFocus();
      await expect(canvas.getByText("Select a project")).toBeVisible();
    });
    await step("An unmatched search recovers to all projects", async () => {
      await userEvent.type(canvas.getByRole("textbox", { name: "Search projects" }), "lunar greenhouse");
      await expect(canvas.getByText("No projects match this view")).toBeVisible();
      await userEvent.click(canvas.getByRole("button", { name: "Clear filters" }));
      await expect(canvas.getByRole("textbox", { name: "Search projects" })).toHaveFocus();
      await userEvent.click(canvas.getByRole("button", { name: "View recent tasks for Customer onboarding" }));
    });
  },
};
