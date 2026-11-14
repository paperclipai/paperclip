import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolRowsPreview } from "../../prototypes/tool-rows/ToolRowsPreview";

const meta = {
  id: "tasks-task-chat-tool-rows",
  title: "Tasks and conversations/Task creation and lifecycle/Tasks/Tool rows",
  component: ToolRowsPreview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Production runner activity group with Claude and Codex tool rows: verb icon, real subject, exit chip and duration. Runs of three or more completed reads fold into one row. A refused tool shows the reason.",
      },
    },
    paperclip: {
      "capabilities": [
        "tasks/discussion",
        "runs-adapters/runs"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Fixtures mirror real Claude (ACPX) and Codex (app-server) runs. The “today” columns reproduce the current mapping of the same calls."
    },
  },
} satisfies Meta<typeof ToolRowsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Compare: Story = { name: "01 · Today vs proposed" };
export const Live: Story = { name: "02 · Live rolling row", args: { mode: "live" } };
export const Proposed: Story = { name: "03 · Proposed only", args: { mode: "proposed" } };
export const Mobile: Story = { name: "04 · Narrow", args: { narrow: true } };
