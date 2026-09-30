import { userEvent, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentChatPrototype } from "../prototypes/agent-chat/AgentChatPrototype";

const meta = {
  title: "Design explorations/Agent chat sidebar/Pages",
  component: AgentChatPrototype,
  parameters: { layout: "fullscreen", docs: { description: { component:
    "The production chat sidebar and pages inside the real Paperclip Layout, including the existing transcript, composer, and context panel. Click Chat to see the landing page, search by name or role, or use + to start or reopen an agent conversation. Each agent has one conversation; sends stay in this Storybook's in-memory fixtures."
  } } },
  args: { sidebarScenario: "conversation", scenario: "returning", contextInitiallyOpen: false },
  render: args => <AgentChatPrototype key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof AgentChatPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = { name: "01 · Conversation · Start here" };
export const ChatLanding: Story = { name: "02 · Click Chat · Choose an agent", args: { sidebarScenario: "landing", scenario: "empty" } };
export const FirstMessage: Story = { name: "03 · First conversation", args: { scenario: "empty" } };
export const LargerTeam: Story = { name: "04 · Larger team · Scroll and search", args: { sidebarScenario: "large-team" } };
export const ContextPanel: Story = { name: "05 · Existing plan panel", args: { contextInitiallyOpen: true } };
export const Light: Story = { name: "06 · Light theme", globals: { theme: "light" } };
export const Mobile: Story = { name: "07 · Mobile · Agents in navigation drawer", parameters: { waitForViewport: true }, globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileLanding: Story = { name: "08 · Mobile · Choose an agent", args: { sidebarScenario: "landing", scenario: "empty" }, parameters: { waitForViewport: true }, globals: { viewport: { value: "mobile", isRotated: false } } };

export const AddChat: Story = {
  name: "09 · Add chat · One per agent",
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Add chat" }));
  },
};
