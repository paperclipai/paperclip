import { expect, userEvent, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentChatPrototype } from "../../prototypes/agent-chat/AgentChatPrototype";

const meta = {
  id: "design-explorations-agent-chat-sidebar-pages",
  title: "Tasks and conversations/Agent conversations and project handoff/Design explorations/Agent chat sidebar/Pages",
  component: AgentChatPrototype,
  parameters: { layout: "fullscreen", docs: { description: { component:
    "The production chat sidebar and pages inside the real Paperclip Layout, including the existing transcript, composer, and context panel. Click Chat to see the landing page, search by name or role, or use + to start or reopen an agent conversation. Each agent has one conversation; sends stay in this Storybook's in-memory fixtures."
  } },
    paperclip: {
      "capabilities": [
        "agent-chat/discovery",
        "agent-chat/history"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Wrapper mounts production Layout and AgentChat; conversation selection and sends use in-memory routes. Directory name is not prototype evidence."
    },
  },
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

export const UnreadSwitcher: Story = {
  name: "10 · Switch agents · Unread chats",
  args: { coordinator: true, unreadMessageCounts: { "chat-analyst": 3, "chat-writer": 12 } },
  parameters: { paperclip: { capabilities: ["agent-chat/discovery", "agent-chat/history"], status: "current", implementation: "production", boundary: "fixtures", notes: "Production header switcher and chat page with per-agent numeric unread counts from the shared chat-list fixture. Does not prove backend read-state persistence or live delivery." } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: /Switch agent\. Currently/ }));
    await expect(await page.findByLabelText("3 unread messages from Analyst")).toHaveTextContent("3");
    await expect(await page.findByLabelText("12 unread messages from Writer")).toHaveTextContent("12");
    await expect(page.queryByLabelText("1 unread message from Researcher")).toBeNull();
  },
};
export const UnreadSwitcherLight: Story = { ...UnreadSwitcher, name: "11 · Switch agents · Unread · Light", globals: { theme: "light" } };
export const UnreadSwitcherMobile: Story = { ...UnreadSwitcher, name: "12 · Switch agents · Unread · Mobile", globals: { viewport: { value: "mobile", isRotated: false } } };

export const UnreadAddChat: Story = {
  name: "13 · Add chat · Unread counts",
  args: { unreadMessageCounts: { "chat-analyst": 3, "chat-writer": 12 } },
  parameters: { paperclip: { capabilities: ["agent-chat/discovery", "agent-chat/history"], implementation: "production", boundary: "fixtures", notes: "Production secondary sidebar Add chat picker with numeric unread counts. API data is simulated." } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Add chat" }));
    await expect(await page.findByLabelText("3 unread messages from Analyst")).toHaveTextContent("3");
    await expect(await page.findByLabelText("12 unread messages from Writer")).toHaveTextContent("12");
  },
};
