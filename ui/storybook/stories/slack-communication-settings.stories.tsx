import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SlackAvatarSettingsPreview } from "../prototypes/slack-avatar/SlackAvatarSettingsPreview";

const meta = {
  title: "Connections/Slack/Communication in Settings",
  component: SlackAvatarSettingsPreview,
  parameters: { layout: "fullscreen", docs: { description: { component: "Production communication field in a Settings fixture. Saves use local story state; instructions apply to new tasks. Reply detail and progress are built-in behavior." } } },
} satisfies Meta<typeof SlackAvatarSettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithInstructions: Story = { args: { initialInstructions: "Use our product names and explain technical terms for a nontechnical audience." } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } } };
export const SaveAndRetry: Story = {
  args: { failFirstSave: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole("textbox", { name: "Additional communication instructions" });
    await userEvent.type(field, "Use customer-facing product names.");
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await expect(canvas.getByRole("alert")).toHaveTextContent("Couldn’t save instructions");
    await expect(field).toHaveValue("Use customer-facing product names.");
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Saved. Applies to new tasks.");
    await expect(canvas.getByRole("button", { name: "Save instructions" })).toBeDisabled();
  },
};
