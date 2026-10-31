import { userEvent, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentChatPrototype } from "../../prototypes/agent-chat/AgentChatPrototype";

const meta = {
  id: "design-explorations-chat-entry",
  title: "Tasks and conversations/Agent conversations and project handoff/Design explorations/Chat entry",
  component: AgentChatPrototype,
  parameters: { layout: "fullscreen", docs: { description: { component:
    "Historical chat-entry exploration: the local sidebar and landing composition keeps a first-created-agent default. The current product uses the personal primary-agent preference and recent-conversation rules. Shared layout, picker and conversation components remain useful here, but these entry/default rules are retained design history. Selecting and sending use in-memory fixtures; no real agents run. Use Primary Agent journeys for current default-selection examples."
  } },
    paperclip: {
      "capabilities": [
        "agent-chat/discovery",
        "agent-chat/history"
      ],
      "status": "historical",
      "implementation": "mixed",
      "boundary": "fixtures",
      "notes": "Retained first-created-agent sidebar/landing design predates personal primary-agent selection. Shared production conversation components remain useful.",
      "replacement": "ui/storybook/stories/agents/primary-agent/05-chat.stories.tsx"
    },
  },
  args: { entryScenario: "returning", scenario: "returning", contextInitiallyOpen: false },
  render: (args) => <AgentChatPrototype key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof AgentChatPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FirstUse: Story = { name: "01 · First use · Start here", args: { entryScenario: "first-use", scenario: "empty" } };
export const Returning: Story = { name: "02 · Returning · Starred and recent chats" };
export const AgentPicker: Story = { name: "03 · Chat with any agent", args: { entryScenario: "picker" } };
export const SearchByRole: Story = { name: "04 · Find someone by role", args: { entryScenario: "search" }, play: async ({ canvasElement }) => {
  const input = await within(canvasElement.ownerDocument.body).findByRole("combobox", { name: "Search agents by name or role" });
  await userEvent.type(input, "design");
} };
export const NoResults: Story = { name: "05 · No matches · Recover search", args: { entryScenario: "no-results" }, play: async ({ canvasElement }) => {
  const input = await within(canvasElement.ownerDocument.body).findByRole("combobox", { name: "Search agents by name or role" });
  await userEvent.type(input, "accountant");
} };
export const PausedAgent: Story = { name: "06 · Paused agent · Still discoverable", args: { entryScenario: "picker" }, play: async ({ canvasElement }) => {
  const input = await within(canvasElement.ownerDocument.body).findByRole("combobox", { name: "Search agents by name or role" });
  await userEvent.type(input, "operations");
} };
export const LargerTeam: Story = { name: "07 · Larger team · All agents stay reachable", args: { entryScenario: "large-team" } };
export const Light: Story = { name: "08 · Light theme", globals: { theme: "light" }, args: { entryScenario: "picker" } };
export const Mobile: Story = { name: "09 · Mobile · Choose an agent", globals: { viewport: { value: "mobile", isRotated: false } }, args: { entryScenario: "picker" } };
