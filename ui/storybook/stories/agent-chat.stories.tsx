import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentChatPrototype } from "../prototypes/agent-chat/AgentChatPrototype";

const meta = {
  title: "Design explorations/Agent chat",
  component: AgentChatPrototype,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Uses the actual production Layout (Sidebar, BreadcrumbBar, PropertiesPanel), TaskChatThread (TaskChatComposer, harness activity, thinking/tool disclosures, responses), and TaskSidePanel (plans, artifacts, subtasks). Agent shortcuts compose the existing sidebar rows and sections: starred agents first, then recent conversations, plus a See all link to the existing Agents page and a gear link to the existing agent configuration page. The task surfaces differ only in breadcrumb/title and initially open panel tabs. All data is fixture data; sends append locally and unsupported mutations fail explicitly.",
      },
    },
  },
  argTypes: {
    scenario: {
      control: "select",
      options: [
        "returning",
        "empty",
        "working",
        "paused",
        "error",
        "long",
        "new-session",
        "disabled",
        "project-created",
        "project-reused",
        "project-multi-repo",
        "project-no-repo",
        "project-failed",
      ],
    },
  },
  render: (args) => <AgentChatPrototype key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof AgentChatPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Returning: Story = {
  name: "01 · Pick up the conversation",
  args: { scenario: "returning" },
};
export const FirstConversation: Story = {
  name: "02 · First conversation",
  args: { scenario: "empty" },
};
export const Working: Story = {
  name: "03 · Agent is replying",
  args: { scenario: "working" },
};
export const Paused: Story = {
  name: "04 · Agent paused",
  args: { scenario: "paused" },
};
export const FailedSend: Story = {
  name: "05 · Failed send preserves draft",
  args: { scenario: "error" },
};
export const LongConversation: Story = {
  name: "06 · Long conversation",
  args: { scenario: "long" },
};
export const ConversationOnly: Story = {
  name: "07 · Context collapsed",
  args: { contextInitiallyOpen: false },
};
export const Light: Story = {
  name: "08 · Light",
  globals: { theme: "light" },
  args: { scenario: "returning" },
};

export const TaskComparison: Story = {
  name: "09 · Same components with task chrome",
  args: { taskComparison: true },
};

export const NewSession: Story = {
  name: "10 · New session preserves history",
  args: { scenario: "new-session" },
};
export const FeatureDisabled: Story = {
  name: "11 · Experiment disabled",
  args: { scenario: "disabled" },
};

export const ProjectCreated: Story = { name: "12 · Plan handed off to a project task", args: { scenario: "project-created" } };
export const MultipleRepositories: Story = { name: "13 · Project with multiple repositories", args: { scenario: "project-multi-repo" } };
export const ProjectWithoutRepository: Story = { name: "14 · Non-code project", args: { scenario: "project-no-repo" } };
export const ProjectCreationFailed: Story = { name: "15 · Failed project creation retains plan", args: { scenario: "project-failed" } };
export const ProjectLight: Story = { name: "16 · Project created · light", globals: { theme: "light" }, args: { scenario: "project-created" } };

export const ExistingProject: Story = { name: "17 · Hand off to an existing project", args: { scenario: "project-reused" } };
