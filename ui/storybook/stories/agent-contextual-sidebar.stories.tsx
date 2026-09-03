import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentContextualSidebar } from "@/components/AgentContextualSidebar";

const meta = {
  title: "Navigation/Agent Contextual Sidebar",
  component: AgentContextualSidebar,
  parameters: { layout: "fullscreen" },
  args: {
    agentRef: "codexcoder",
    agentId: "agent-codex",
    agentName: "Codex Coder",
  },
  decorators: [
    (Story) => (
      <div className="h-screen w-72 border-r border-border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentContextualSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullInformationArchitecture: Story = {};
