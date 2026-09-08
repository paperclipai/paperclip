import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentSettingsPreview } from "../prototypes/agent-settings/AgentSettingsPreview";
const meta = {
  title: "Agents/Configuration refresh",
  component: AgentSettingsPreview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Design review of the full agent settings. Uses the existing navigation and functional tab components with isolated, mutable Storybook fixtures. No production data is changed.",
      },
    },
  },
  argTypes: {
    initialTab: {
      control: "select",
      options: [
        "overview",
        "instructions",
        "skills",
        "runtime",
        "secrets",
        "tools",
        "permissions",
        "api-keys",
        "revisions",
      ],
    },
    adapterType: {
      control: "select",
      options: [
        "claude_local",
        "codex_local",
        "opencode_local",
        "pi_local",
        "paperclip_runner",
      ],
    },
    testOutcome: { control: "select", options: ["pass", "fail"] },
  },
  render: (args) => (
    <AgentSettingsPreview key={JSON.stringify(args)} {...args} />
  ),
} satisfies Meta<typeof AgentSettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = { args: { initialTab: "overview" } };
export const Instructions: Story = { args: { initialTab: "instructions" } };
export const Skills: Story = { args: { initialTab: "skills" } };
export const Runtime: Story = {
  name: "Harness / Runtime",
  args: { initialTab: "runtime" },
};
export const CodexRuntime: Story = {
  args: { initialTab: "runtime", adapterType: "codex_local" },
};
export const OpenCodeRuntime: Story = {
  args: { initialTab: "runtime", adapterType: "opencode_local" },
};
export const PiRuntime: Story = {
  args: { initialTab: "runtime", adapterType: "pi_local" },
};
export const RunnerRuntime: Story = {
  args: { initialTab: "runtime", adapterType: "paperclip_runner" },
};
export const Secrets: Story = {
  name: "Secrets & variables",
  args: { initialTab: "secrets" },
};
export const Tools: Story = { args: { initialTab: "tools" } };
export const Permissions: Story = {
  name: "Permissions / Trust",
  args: { initialTab: "permissions" },
};
export const ApiKeys: Story = {
  name: "API Keys",
  args: { initialTab: "api-keys" },
};
export const Revisions: Story = { args: { initialTab: "revisions" } };
export const RuntimeTestFailure: Story = {
  args: { initialTab: "runtime", testOutcome: "fail" },
};
export const SaveFailure: Story = {
  args: { initialTab: "runtime", saveFails: true },
};
