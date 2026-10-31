import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentChatPrototype } from "../../prototypes/agent-chat/AgentChatPrototype";

const meta = {
  id: "design-explorations-agent-chat",
  title: "Tasks and conversations/Agent conversations and project handoff/Design explorations/Agent chat",
  component: AgentChatPrototype,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Production Layout, AgentChat, IssueDetail, transcript and side-panel components run against in-memory routes. The landing page is a local ChatEntryLanding composition; first-use/default-agent behavior is not production acceptance. Sends append locally. Some unhandled API paths return empty fixture data, so this suite does not verify API contracts or primary-agent preference behavior.",
      },
    },
    paperclip: {
      "capabilities": [
        "agent-chat/discovery",
        "agent-chat/history",
        "agent-chat/handoff"
      ],
      "status": "mixed",
      "implementation": "mixed",
      "boundary": "fixtures",
      "notes": "Production conversation/task routes with a local ChatEntryLanding. Default-agent behavior and fallback API responses remain outside current-product parity. ProjectCreated, ExistingProject, MultipleRepositories, ProjectWithoutRepository and ProjectCreationFailed show linked handoff results/navigation through shipped chat/task hosts. Tool execution and persistence are simulated."
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
