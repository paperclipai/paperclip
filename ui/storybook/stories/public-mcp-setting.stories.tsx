import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { InstanceExperimentalSettings } from "@/pages/InstanceExperimentalSettings";
import { installPublicMcpFixture } from "../fixtures/publicMcp";
const meta = {
  title: "Assistant connections/Experimental setting", component: InstanceExperimentalSettings,
  parameters: { layout: "padded", initialEntries: ["/PAP/company/settings/instance/experimental"], docs: { description: { component: "The production Experimental page, including surrounding settings. Changes are local to this story." } } },
  beforeEach: ({ parameters }) => installPublicMcpFixture(parameters.fixture),
} satisfies Meta<typeof InstanceExperimentalSettings>;
export default meta;
type Story = StoryObj<typeof meta>;
const name = "Toggle assistant connections experimental setting";
export const DisabledByDefault: Story = { play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await expect(await c.findByRole("switch", { name })).not.toBeChecked();
  await expect(c.getByRole("switch", { name: "Toggle Paperclip Runner experimental setting" })).toBeChecked();
} };
export const Enabled: Story = { parameters: { fixture: { enabled: true } } };
export const ManagedByCloud: Story = { parameters: { fixture: { enabled: true, managed: true } }, play: async ({ canvasElement }) => {
  await expect(await within(canvasElement).findByRole("switch", { name })).toBeDisabled();
} };
export const ToggleOnAndOff: Story = { play: async ({ canvasElement }) => {
  const toggle = await within(canvasElement).findByRole("switch", { name });
  await userEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeEnabled());
  await expect(toggle).toBeChecked();
  await userEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeEnabled());
  await expect(toggle).not.toBeChecked();
} };
export const SaveFailedRollsBack: Story = { parameters: { fixture: { mutationError: true } }, play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  const toggle = await c.findByRole("switch", { name });
  await userEvent.click(toggle);
  await c.findByText("Could not save this change. Please try again.");
  await expect(toggle).not.toBeChecked();
} };
export const Saving: Story = { parameters: { fixture: { pending: true } }, play: async ({ canvasElement }) => {
  const toggle = await within(canvasElement).findByRole("switch", { name });
  await userEvent.click(toggle);
  await expect(toggle).toBeDisabled();
} };
export const Loading: Story = { parameters: { fixture: { loading: true } } };
export const Unavailable: Story = { parameters: { fixture: { unavailable: true } } };
