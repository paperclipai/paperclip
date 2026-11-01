import type { Meta, StoryObj } from "@storybook/react-vite";
import { TasksReproductionTrial } from "../../support/design-proposals/TasksReproductionTrial";

const meta = {
  id: "design-agent-task-list-trial",
  title: "Design proposals/AI Generated Test Pages/Tasks reproduction test",
  component: TasksReproductionTrial,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/issues"],
    paperclip: {
      capabilities: ["tasks/organize", "inbox-search/search"],
      status: "proposed",
      home: "design-proposals",
      exception: "Independent reproduction trial of the provisional Tasks reference; human visual approval and production adoption remain pending.",
      implementation: "production",
      boundary: "fixtures",
      notes: "Composes shared DesignPageShell, DesignSidebar, TaskListToolbar and TaskList without page-preview imports or custom visual markup. Reuses canonical organization/account menus, filters, board, composer and command palette. Search/view/filter matching, namespaced creator options and expansion use the same useTaskListCollection hook as the reference; only fixture data updates remain local. This is a repaired regression reference, not the untouched first submission; original evidence is retained separately. Boards use matching tasks, while the list includes ancestor context. Width and view preferences use isolated trial keys. Destination routes, backend persistence, mobile layout and production adoption are outside this trial.",
    },
  },
} satisfies Meta<typeof TasksReproductionTrial>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { parameters: { __id: "design-agent-task-list-trial" } };
