// LET-504 — Storybook stories for the EAOS manual agent builder at
// `/eaos/agents/new`. Exposes each step as its own story so the design
// brief states (Identity → Model → Invocations → Tools → Skills →
// Knowledge) and the sticky-summary updates can be reviewed in
// isolation. Used for screenshot evidence at 1440px / 1920px.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentBuilderPage } from "@/eaos/agents/builder/AgentBuilderPage";

const meta: Meta<typeof AgentBuilderPage> = {
  title: "EAOS / Manual agent builder (/eaos/agents/new)",
  component: AgentBuilderPage,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-[960px] flex-col bg-background p-6 text-foreground">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AgentBuilderPage>;

export const Identity: Story = {
  args: { initialStep: "identity" },
};

export const Model: Story = {
  args: { initialStep: "model" },
};

export const Invocations: Story = {
  args: { initialStep: "invocations" },
};

export const Tools: Story = {
  args: { initialStep: "tools" },
};

export const Skills: Story = {
  args: { initialStep: "skills" },
};

export const Knowledge: Story = {
  args: { initialStep: "knowledge" },
};
