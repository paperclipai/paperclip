import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { McpDevicePage } from "@/pages/McpConnect";
import { installPublicMcpFixture } from "../fixtures/publicMcp";

const meta = {
  title: "Assistant connections/Device authorization", component: McpDevicePage,
  parameters: { layout: "padded", fixture: {}, docs: { description: { component: "Production device consent. The assistant's private device code stays in its credential client; only the human verification code appears here. These isolated fixtures issue no credentials." } } },
  args: { initialCode: "BCDF-GHJK" },
  beforeEach: ({ parameters }) => installPublicMcpFixture(parameters.fixture),
} satisfies Meta<typeof McpDevicePage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EnterCode: Story = { args: { initialCode: "" } };
export const ReviewAccess: Story = {};
export const SignIn: Story = { parameters: { fixture: { request: { requiresSignIn: true, companies: [] } } } };
export const Expired: Story = { parameters: { fixture: { deviceExpired: true } } };
export const Pending: Story = { parameters: { fixture: { pending: true } }, play: async ({ canvasElement }) => {
  const c = within(canvasElement); await userEvent.click(await c.findByRole("radio", { name: "Acme Research" }));
  await userEvent.click(c.getByRole("button", { name: "Connect organization" }));
  await expect(c.getByRole("button", { name: "Connecting…" })).toBeDisabled();
} };
export const Approved: Story = { play: async ({ canvasElement }) => {
  const c = within(canvasElement); await userEvent.click(await c.findByRole("radio", { name: "Acme Research" }));
  await userEvent.click(c.getByRole("button", { name: "Connect organization" }));
  await expect(await c.findByRole("heading", { name: "Access approved" })).toBeVisible();
} };
export const Denied: Story = { play: async ({ canvasElement }) => {
  const c = within(canvasElement); await userEvent.click(await c.findByRole("button", { name: "Cancel" }));
  await expect(await c.findByRole("heading", { name: "Connection declined" })).toBeVisible();
} };
