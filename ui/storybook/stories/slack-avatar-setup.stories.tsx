import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SlackAvatarStep } from "../prototypes/slack-avatar/SlackAvatarStep";

const meta = {
  title: "Connections/Slack/Add avatar",
  component: SlackAvatarStep,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Proposed optional step after verifying Slack, before linking your account. Downloads a real 512px Cliptoon PNG. Upload is manual in Slack; confirmation is user-reported. Navigation and Save & exit are local preview state, not production persistence." } },
  },
  args: { agentName: "CEO", appName: "ceo-paperclip" },
  render: (args) => <SlackAvatarStep key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof SlackAvatarStep>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DownloadAndUpload: Story = {};
export const Uploaded: Story = { args: { initialUploaded: true } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } } };
export const ConfirmAndReturn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "Download avatar" })).toHaveAttribute("download", "ceo-paperclip-avatar.png");
    await userEvent.click(canvas.getByRole("button", { name: "I’ve uploaded the avatar" }));
    await expect(canvas.getByRole("heading", { name: "Connect your Slack account" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Back to avatar step" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("You marked the avatar as uploaded");
  },
};
