import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ConnectorCard } from "@/pages/apps/Browse";
import type { ChatEndpoint } from "@/api/chatEndpoints";

const endpoint: ChatEndpoint = {
  id: "slack-active", companyId: "demo", provider: "slack", status: "active",
  assignedAgentId: "ceo", assignedAgentName: "CEO", providerAccountLabel: "Paperclip",
  allowUnlinkedPeople: false,
};

const meta = {
  title: "Connections/Chat connection actions",
  component: ConnectorCard,
  parameters: { layout: "padded" },
  args: {
    row: {
      key: "slack", slug: "slack", name: "Slack", brandKey: "slack",
      description: "Give agents Slack tools or let people start and continue Paperclip work from Slack.",
      entry: null, applications: [], connections: [],
      chatEndpoints: [endpoint, { ...endpoint, id: "slack-draft", status: "draft", assignedAgentName: "Carl" }],
    },
    userProfileById: new Map(), chatConnectorsEnabled: true,
    onNavigate: fn(), onRequestRemove: fn(),
  },
} satisfies Meta<typeof ConnectorCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveAndDraft: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Finish setup" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Manage CEO Slack connection" }));
    const body = within(document.body);
    await expect(body.getByRole("menuitem", { name: "Manage" })).toBeVisible();
    await userEvent.click(body.getByRole("menuitem", { name: "Remove connection" }));
    await expect(args.onRequestRemove).toHaveBeenCalledWith(expect.objectContaining({ kind: "chat", id: "slack-active" }));
    await userEvent.click(canvas.getByRole("button", { name: "Manage Carl Slack connection" }));
    await expect(body.getByRole("menuitem", { name: "Remove connection" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
  },
};
