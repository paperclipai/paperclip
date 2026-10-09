import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AssistantConnectionsPage } from "@/pages/McpConnect";
import { installPublicMcpFixture } from "../fixtures/publicMcp";
const meta = {
  title: "Assistant connections/Manage connections", component: AssistantConnectionsPage,
  parameters: { layout: "padded", initialEntries: ["/assistant-connections"], docs: { description: { component: "Production /assistant-connections page. Revocation changes only the in-memory story fixture." } } },
  beforeEach: ({ parameters }) => installPublicMcpFixture(parameters.fixture),
} satisfies Meta<typeof AssistantConnectionsPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connected: Story = {};
export const Empty: Story = { parameters: { fixture: { empty: true } } };
export const Loading: Story = { parameters: { fixture: { loading: true } } };
export const Unavailable: Story = { parameters: { fixture: { unavailable: true } } };
export const AlreadyRevoked: Story = { parameters: { fixture: { revoked: true } }, play: async ({ canvasElement }) => {
  await expect(await within(canvasElement).findByText("No assistant connections.")).toBeVisible();
} };
export const Revoke: Story = { play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await userEvent.click((await c.findAllByRole("button", { name: "Revoke connection" }))[0]);
  await waitFor(() => expect(c.queryByText("Dotta’s Codex connection")).not.toBeInTheDocument());
  await c.findByText("Dotta’s Claude connection");
  await expect(c.getAllByRole("button", { name: "Revoke connection" })).toHaveLength(1);
} };
export const RevokeFailed: Story = { parameters: { fixture: { mutationError: true } }, play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await userEvent.click((await c.findAllByRole("button", { name: "Revoke connection" }))[0]);
  await c.findByText("Could not save this change. Please try again.");
  await expect(c.getAllByRole("button", { name: "Revoke connection" })).toHaveLength(2);
} };
export const Revoking: Story = { parameters: { fixture: { pending: true } }, play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await userEvent.click((await c.findAllByRole("button", { name: "Revoke connection" }))[0]);
  for (const button of c.getAllByRole("button", { name: "Revoke connection" })) await expect(button).toBeDisabled();
} };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } }, parameters: { waitForViewport: true } };
