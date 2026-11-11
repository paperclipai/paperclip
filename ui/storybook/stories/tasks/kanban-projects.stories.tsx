import type { Meta, StoryObj } from "@storybook/react-vite";
import { KanbanBoard } from "@/components/KanbanBoard";
import { storybookIssues, storybookProjects } from "../../fixtures/paperclipData";

const project = storybookProjects[0]!;
const longProject = {
  name: "A project with a long name that must stay inside the board card",
  color: null,
};

const meta = {
  id: "product-kanban-projects",
  title: "Tasks and conversations/Task creation and lifecycle/Product/Kanban projects",
  component: KanbanBoard,
  parameters: {
    paperclip: {
      capabilities: ["tasks/organize"],
      implementation: "production",
      boundary: "fixtures",
      notes: "Project badges enabled and disabled, compact cards, long neutral project names, and tasks without projects. This fixture does not prove live collection persistence or API access.",
    },
  },
  args: {
    issues: [
      { ...storybookIssues[0]!, id: "board-project", status: "todo", projectId: project.id },
      { ...storybookIssues[1]!, id: "board-long-project", status: "todo", projectId: "long-project" },
      { ...storybookIssues[2]!, id: "board-no-project", status: "todo", projectId: null },
    ],
    projectById: new Map([
      [project.id, { name: project.name, color: project.color }],
      ["long-project", longProject],
    ]),
    showProjects: true,
    collapsedStatuses: ["backlog", "done", "cancelled"],
    onUpdateIssue: () => undefined,
  },
  argTypes: {
    projectById: { control: false },
    onUpdateIssue: { control: false },
  },
} satisfies Meta<typeof KanbanBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectEnabled: Story = {};
export const CompactCards: Story = { args: { compactCards: true } };
export const ProjectDisabled: Story = { args: { showProjects: false } };
