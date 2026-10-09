import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { EmailEndpointSettings } from "@/pages/apps/chat/EmailEndpointSetup";
import type { EmailEndpointSummary } from "@paperclipai/shared";

const COMPANY = "company-storybook";
const ENDPOINT = "agentmail-settings-preview";
const meta = {
  title: "Connections/AgentMail settings",
  component: EmailEndpointSettings,
  parameters: { layout: "padded" },
  args: { endpointId: ENDPOINT, companyId: COMPANY, assignedAgentName: "Ralph" },
  beforeEach(context) {
    let inbox: EmailEndpointSummary = {
      id: ENDPOINT, companyId: COMPANY, connectionId: "preview-account", assignedAgentId: "ralph",
      address: "ralph@paperclip.example", status: "active", receiveMode: "websocket",
      lastSyncAt: "2026-10-02T12:40:00Z", lastError: null,
      ...context.parameters.inbox,
    };
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (url.pathname === `/api/companies/${COMPANY}/email/inboxes`) return Response.json([inbox]);
      if (url.pathname === `/api/email/inboxes/${ENDPOINT}/control`) {
        const { action } = JSON.parse(String(init?.body));
        inbox = { ...inbox, status: action === "pause" ? "paused" : action === "remove" ? "archived" : "active" };
        return Response.json(inbox);
      }
      if (url.pathname === `/api/email/inboxes/${ENDPOINT}/reconnect`) {
        const { receiveMode } = JSON.parse(String(init?.body));
        inbox = { ...inbox, status: "active", receiveMode, lastError: null };
        return Response.json(inbox);
      }
      return original(input, init);
    };
    return () => { window.fetch = original; };
  },
} satisfies Meta<typeof EmailEndpointSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Receiving: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const copyAddress = await canvas.findByRole("button", { name: "Copy email address" });
  await expect(copyAddress).toHaveTextContent("ralph@paperclip.example");
  await expect(canvas.getByRole("link", { name: "View inbox" })).toHaveAttribute(
    "href", "https://console.agentmail.to/dashboard/inboxes/ralph%40paperclip.example");
} };
export const Paused: Story = { parameters: { inbox: { status: "paused" } }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole("button", { name: "Resume" })).toBeVisible();
  await expect(canvas.queryByText(/Send an email to this address to start a task/)).not.toBeInTheDocument();
} };
export const AddressNotAssigned: Story = { parameters: { inbox: { status: "draft", address: null, lastSyncAt: null } }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole("heading", { name: "Email inbox" })).toBeVisible();
  await expect(canvas.queryByRole("button", { name: "Copy email address" })).not.toBeInTheDocument();
  await expect(canvas.queryByRole("link", { name: "View inbox" })).not.toBeInTheDocument();
  await expect(canvas.queryByText(/Send an email to this address to start a task/)).not.toBeInTheDocument();
} };
export const NeedsAttention: Story = { parameters: { inbox: { status: "revoked", lastError: "AgentMail rejected the API key. Reconnect this inbox with a valid key." } }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText("Access revoked")).toBeVisible();
  await expect(canvas.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
  await expect(canvas.getByLabelText("New API key")).toBeVisible();
} };
export const Webhook: Story = { parameters: { inbox: { receiveMode: "webhook", lastSyncAt: null } } };
export const LongAddress: Story = { parameters: { inbox: { address: "ralph-customer-support-and-operations@paperclip.example" } } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } }, parameters: { waitForViewport: true } };
export const Reconnect: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await canvas.findByRole("heading", { name: "ralph@paperclip.example" });
  const disclosure = canvas.getByText("Reconnect inbox", { selector: "summary" });
  await expect(canvas.queryByLabelText("New API key")).not.toBeVisible();
  await userEvent.click(disclosure);
  await expect(canvas.getByLabelText("New API key")).toBeVisible();
  await expect(canvas.getByRole("link", { name: /Get an AgentMail API key/ })).toHaveAttribute("href", "https://console.agentmail.to/dashboard/api-keys");
  await userEvent.type(canvas.getByLabelText("New API key"), "storybook-placeholder-key");
  await userEvent.click(canvas.getByRole("button", { name: "Reconnect inbox" }));
  await expect(await canvas.findByText("Inbox reconnected.")).toBeVisible();
} };
