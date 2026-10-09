import { userEvent, within, expect } from "storybook/test";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentConversationSidebar } from "../prototypes/agent-chat-sidebar/AgentConversationSidebar";
import { sidebarAgents, sidebarPreviews, sidebarRoster } from "../prototypes/agent-chat-sidebar/fixtures";

function InteractiveSidebar(args: React.ComponentProps<typeof AgentConversationSidebar>) {
  const [activeId, setActiveId] = useState(args.activeId);
  const [agents, setAgents] = useState(args.agents);
  const selectAgent: NonNullable<typeof args.onSelect> = agent => {
    setActiveId(agent.id);
    setAgents(current => current.some(item => item.id === agent.id) ? current : [...current, agent]);
  };
  return <div className="h-dvh w-60 bg-background text-foreground"><AgentConversationSidebar {...args} agents={agents} activeId={activeId} onSelect={selectAgent} onAddChat={selectAgent} onBrowse={undefined} /></div>;
}
const meta = {
  title: "Design explorations/Agent chat sidebar/Components",
  component: AgentConversationSidebar,
  parameters: { layout: "fullscreen", docs: { description: { component:
    "Secondary agent navigation at the same width as the app's other contextual sidebars. Uses production AgentAvatar, Input, and Button. The entire row is a link; selection and search are interactive. Search matches agent name, title, and role. Escape clears the query. Browse all agents links to the existing agent directory in the page stories."
  } } },
  args: { agents: sidebarAgents, availableAgents: sidebarRoster(), activeId: "agent-codex", previews: sidebarPreviews },
  render: args => <InteractiveSidebar key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof AgentConversationSidebar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { name: "01 · Agent list · Interactive" };
export const Search: Story = { name: "02 · Search by role", args: { initialSearch: "research" } };
export const NoResults: Story = { name: "03 · No matches", args: { initialSearch: "accountant" } };
export const Loading: Story = { name: "04 · Loading", args: { agents: [], availableAgents: [], loading: true } };
export const NoAgents: Story = { name: "05 · No agents", args: { agents: [], availableAgents: [] } };
export const LargeTeam: Story = { name: "06 · Scrollable team", args: { agents: sidebarRoster("large-team"), availableAgents: sidebarRoster("large-team") } };
export const LongNames: Story = { name: "07 · Long names and paused agent", args: { agents: [
  { ...sidebarAgents[0], name: "Customer & Competitive Research", title: "Research across customers, markets, and competitors" },
  { ...sidebarAgents[1], status: "paused" },
  ...sidebarAgents.slice(2),
], previews: {} } };
export const Light: Story = { name: "08 · Light theme", globals: { theme: "light" } };
export const HistoryUnavailable: Story = {
  name: "10 · Partial history failure",
  args: { historyError: new Error("History unavailable") },
};

export const AddAndReopenChat: Story = {
  name: "09 · Add and reopen · One per agent",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "Add chat" }));
    await userEvent.type(await page.findByPlaceholderText("Search by name or role…"), "Product Designer");
    await userEvent.click(page.getByRole("option", { name: /Product Designer.*New chat/ }));
    await expect(await canvas.findByRole("link", { name: /Product Designer/ })).toHaveAttribute("aria-current", "page");
    await userEvent.click(canvas.getByRole("button", { name: "Add chat" }));
    await userEvent.type(await page.findByPlaceholderText("Search by name or role…"), "Product Designer");
    await userEvent.click(page.getByRole("option", { name: /Product Designer.*Open chat/ }));
    await expect(await canvas.findAllByRole("link", { name: /Product Designer/ })).toHaveLength(1);
  },
};
