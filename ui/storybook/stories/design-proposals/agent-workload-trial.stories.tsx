import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AgentWorkloadTrial } from "../../support/design-proposals/AgentWorkloadTrial";
import { workloadAgentIds } from "../../support/design-proposals/agent-workload-trial-data";

const meta = {
  id: "design-agent-workload-trial",
  title: "Design proposals/AI Generated Test Pages/Agent workload trial",
  component: AgentWorkloadTrial,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/agents"],
    docs: { description: { component: "Independent desktop workload composition using Design Proposals foundations, shell, sidebar, collection controls and narrow task summaries. Working means running; active tasks are in_progress and queued tasks are todo/backlog. Recent history excludes active and queued tasks to avoid duplication. Summary counts describe the full selected organization. Search matches every entered word across name, role and title and intersects the state filter. Selection opens a resizable contextual pane; Escape or Close dismisses it and restores card focus. Shared controls support maximize/restore. Six synthetic agents and 24 synthetic tasks include long names, busy/idle/paused states, an agent with no tasks and empty results. No agents are run, and no backend state changes are made." } },
    paperclip: {
      capabilities: ["agents/organization", "agents/lifecycle"],
      home: "design-proposals", status: "proposed",
      exception: "Independent Agent workload reuse trial staged for desktop dark-mode review with synthetic workload data.",
      implementation: "prototype", boundary: "fixtures",
      notes: "Composes DesignPageShell/DesignPageAside, DesignSidebar, MetricCard, AgentAvatar, AgentStatusCapsule, Card/Button, CollectionToolbar, ToolbarSearch, TabFilters, SidePanelWindowControls, TaskSummaryList/TaskRowGroup and EmptyState. Local code owns card layout, search/state predicates, task aggregation, selection, dismissal and focus handoff. The route-backed AgentsToolbar requires an unused creation action, so this single collection uses canonical search and radio-filter components directly through CollectionToolbar slots. Trial-local CSS enables the shared toolbar row to wrap when its pane narrows independently of the viewport; all geometry references existing tokens. Task rows retain shared status, navigation, timeAgo, marquee and container-query behavior without copied row markup. DESIGN.md names an Agents toolbar specimen that the current toolbar stories do not expose. Fixtures simulate all data; task destinations, agent execution, authorization and backend persistence are outside this trial. Pane widths use isolated trial keys.",
    },
  },
} satisfies Meta<typeof AgentWorkloadTrial>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const SelectedAgent: Story = { args: { initialAgentId: workloadAgentIds.mira } };
export const LongNames: Story = { args: { initialAgentId: workloadAgentIds.atlas } };
export const Paused: Story = { args: { initialFilter: "paused", initialAgentId: workloadAgentIds.rowan } };
export const NoTasks: Story = { args: { initialAgentId: workloadAgentIds.quinn } };
export const NoResults: Story = { args: { initialQuery: "lunar botanist" } };
export const EmptyOrganization: Story = { args: { emptyOrganization: true } };

export const Interactions: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const cards = () => within(canvas.getByRole("list", { name: "Agent cards" })).getAllByRole("button");
    const choose = (name: string) => canvas.getByRole("button", { name: `View workload for ${name}` });
    const state = (name: string) => canvas.getByRole("radio", { name });

    await step("Search words match name and role; all state filters intersect search", async () => {
      await expect(await canvas.findByRole("list", { name: "Agent cards" })).toBeVisible();
      await expect(cards()).toHaveLength(6);
      await userEvent.type(canvas.getByRole("textbox", { name: "Search agents" }), "MIRA product");
      await expect(cards()).toHaveLength(1);
      await expect(choose("Mira")).toBeVisible();
      await userEvent.click(state("Idle"));
      await expect(canvas.getByText("No agents match this view")).toBeVisible();
      await userEvent.click(canvas.getByRole("button", { name: "Clear filters" }));
      await expect(state("All")).toHaveAttribute("aria-checked", "true");
      await expect(canvas.getByRole("textbox", { name: "Search agents" })).toHaveFocus();
      for (const [label, count] of [["Working", 3], ["Idle", 2], ["Paused", 1]] as const) {
        await userEvent.click(state(label));
        await expect(cards()).toHaveLength(count);
      }
      await userEvent.click(state("All"));
    });
    await step("Keyboard filter navigation keeps a single selection", async () => {
      state("All").focus();
      await userEvent.keyboard("{ArrowRight}");
      await expect(state("Working")).toHaveFocus();
      await userEvent.keyboard(" ");
      await expect(state("Working")).toHaveAttribute("aria-checked", "true");
      await expect(cards()).toHaveLength(3);
      await userEvent.click(state("Working"));
      await expect(state("Working")).toHaveAttribute("aria-checked", "true");
      await userEvent.click(state("All"));
    });
    await step("Keyboard selection opens active and recent tasks; Escape restores focus", async () => {
      choose("Mira").focus();
      await userEvent.keyboard("{Enter}");
      await expect(canvas.getByRole("region", { name: "Agent tasks content" })).toHaveFocus();
      await expect(within(canvas.getByRole("list", { name: "Active tasks for Mira" })).getAllByRole("listitem")).toHaveLength(2);
      await expect(within(canvas.getByRole("list", { name: "Recent tasks for Mira" })).getAllByRole("listitem")).toHaveLength(3);
      await userEvent.keyboard("{Escape}");
      await expect(canvas.queryByRole("region", { name: "Agent tasks content" })).not.toBeInTheDocument();
      await expect(choose("Mira")).toHaveFocus();
    });
    await step("Pane resizing preserves shared narrow and wide row metadata", async () => {
      await userEvent.click(choose("Mira"));
      const handle = canvas.getByRole("separator", { name: "Resize right sidebar" });
      handle.focus();
      await userEvent.keyboard("{Home}");
      await waitFor(() => expect(Number(handle.getAttribute("aria-valuenow"))).toBe(Number(handle.getAttribute("aria-valuemin"))));
      const row = canvas.getByRole("list", { name: "Active tasks for Mira" }).querySelector("li")!;
      await expect(row.querySelector('[data-slot="task-row-identifier"]')).not.toBeVisible();
      await expect(row.querySelector('[data-slot="task-row-timestamp"]')).not.toBeVisible();
      const minimum = Number(handle.getAttribute("aria-valuemin"));
      const increment = parseFloat(getComputedStyle(handle).getPropertyValue("--design-page-aside-resize-step"));
      await userEvent.keyboard("{ArrowLeft}");
      await waitFor(() => expect(Number(handle.getAttribute("aria-valuenow"))).toBe(minimum + increment));
      await userEvent.keyboard("{End}");
      await waitFor(() => expect(Number(handle.getAttribute("aria-valuenow"))).toBe(Number(handle.getAttribute("aria-valuemax"))));
      await userEvent.dblClick(handle);
      await userEvent.click(canvas.getByRole("button", { name: "Maximize side panel" }));
      await expect(row.querySelector('[data-slot="task-row-timestamp"]')).toBeVisible();
      await expect(row.querySelector('[data-slot="task-row-identifier"]')).toBeVisible();
      await userEvent.click(canvas.getByRole("button", { name: "Restore side panel" }));
      await userEvent.click(canvas.getByRole("button", { name: "Close side panel" }));
      await expect(choose("Mira")).toHaveFocus();
    });
    await step("Taskless agent and unmatched search have recoverable empty states", async () => {
      await userEvent.click(choose("Quinn"));
      await expect(canvas.getByText("No tasks yet")).toBeVisible();
      await userEvent.click(canvas.getByRole("button", { name: "Back to agents" }));
      await expect(choose("Quinn")).toHaveFocus();
      await userEvent.type(canvas.getByRole("textbox", { name: "Search agents" }), "lunar botanist");
      await expect(canvas.getByText("No agents match this view")).toBeVisible();
      await userEvent.click(canvas.getByRole("button", { name: "Clear filters" }));
      await expect(cards()).toHaveLength(6);
      await userEvent.click(choose("Mira"));
    });
  },
};
