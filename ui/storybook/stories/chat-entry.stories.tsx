import { userEvent, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentChatPrototype } from "../prototypes/agent-chat/AgentChatPrototype";

const meta = {
  title: "Design explorations/Chat entry",
  component: AgentChatPrototype,
  parameters: { layout: "fullscreen", docs: { description: { component:
    "Review-only proposal: Chats contains starred and recent conversations, with the first-created agent always present as a default entry. First use uses the same compact rows as returning chats. The aligned compose icon appears on hover or keyboard focus (and stays visible on touch). The picker shows search and agent results with roles and paused status. The sidebar, picker, layout, transcript, and composer are production components. Only the first-use landing page and data are Storybook fixtures. Selecting and sending use in-memory fixtures; no real agents run."
  } } },
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
