import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentScorecardsPanel } from "@/components/AgentScorecardsPanel";

// Renders the real board panel (server contract mocked via the global fetch
// fixture in .storybook/preview.tsx → resource "agent-scorecards").
//  - Populated: ranked agents + a paused poor performer + the
//    "Insufficient sample" group (incl. a 1/1 review record and a zero-activity
//    agent) — the BLO-10275 core acceptance criteria.
//  - Empty: no agent activity in the window.
const meta = {
  title: "Product/Agent Scorecards",
  component: AgentScorecardsPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentScorecardsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: { companyId: "company-storybook" },
};

export const Empty: Story = {
  args: { companyId: "company-empty" },
};
