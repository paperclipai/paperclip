import type { Meta, StoryObj } from "@storybook/react-vite";
import { TasksReproductionTrial2 } from "../../support/design-proposals/TasksReproductionTrial2";

const meta = {
  id: "design-agent-task-list-trial-2",
  title: "Design proposals/AI Generated Test Pages/Tasks reproduction test 2",
  component: TasksReproductionTrial2,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/issues"],
    paperclip: {
      capabilities: ["tasks/organize", "inbox-search/search"],
      home: "design-proposals",
      status: "proposed",
      exception: "Independent second reproduction trial of the proposed desktop Tasks page, pending human visual approval.",
      implementation: "prototype",
      boundary: "fixtures",
      notes: "Independent page composition using DesignPageShell, DesignSidebar, TaskListToolbar, TaskList, KanbanBoard, canonical dialogs and useTaskListCollection. Reuses the shared fixed task data and owner-access fixture. Search, creator identities, filters, views and expansion are delegated to the shared controller; list columns and sorting remain owned by TaskList. View and sidebar preferences use trial-specific storage keys. Navigation and mutations are fixtures; backend behavior and mobile design are outside this trial.",
    },
  },
} satisfies Meta<typeof TasksReproductionTrial2>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
